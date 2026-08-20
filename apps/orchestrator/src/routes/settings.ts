/**
 * Settings — AI configuration (org) and messaging channels (school).
 *
 * Contract source: docs/10 §2 rows "Settings — AI (org)" and "Settings —
 * Messaging channels (school)" · docs/05 §5 (the 3-step wizard, admin-only) ·
 * ADR-017 · ADR-024 · docs/08 §7 (config changes are audited).
 *
 * -- The key goes one way ------------------------------------------------------
 * A key can be written and never read back. `GET` returns `key_hint`
 * (`sk-ant-…1G4a`) and nothing else key-derived; there is no endpoint, for any
 * role, that returns the stored key. That is what makes ADR-017's "platform
 * operators cannot read tenant keys in plaintext" true of the API surface and
 * not just of the database.
 *
 * -- Admin-only is enforced in the service, not here ---------------------------
 * `saveApiKey` and `disableAi` check the role themselves (services/ai-config.ts),
 * so a future caller cannot reach them by a route that forgot. This module still
 * REPORTS `can_configure` on GET, because the SPA has to know whether to render
 * the form or "contact your admin" — a display decision made from a server
 * answer, never a client-side role check of its own.
 *
 * -- Mutations are POST/PUT, so CSRF applies -----------------------------------
 * The CSRF middleware is mounted ahead of every /api route and exempts only
 * GET/HEAD (ADR-029 clause 3), so the double-submit token protects every
 * endpoint below that changes anything.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ERROR_CODES, PlatformError, effectiveScope } from '@sap/shared';
import { orgName, schoolNames, servableSchoolIds } from '../db/registry.js';
import {
  AI_MODELS,
  DEFAULT_MODEL,
  isAiModelId,
  type AiModelId,
} from '../services/anthropic.js';
import {
  CONTACT_ADMIN,
  canConfigureAi,
  disableAi,
  readAiConfig,
  saveApiKey,
} from '../services/ai-config.js';
import { disconnectChannel, isChannelId, readChannels } from '../services/channels.js';

export const settingsRouter = Router();

function requireSession(req: Request) {
  const session = req.session;
  if (session === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.SESSION_INVALID,
      message: 'Please open Analytics from the ERP menu.',
      correlationId: req.correlationId,
    });
  }
  return session;
}

async function scopeOf(session: { school_ids: readonly string[] }) {
  const { effective } = effectiveScope(session.school_ids, await servableSchoolIds());
  return schoolNames(effective);
}

settingsRouter.get('/api/settings', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const scope = await scopeOf(session);

    res.json({
      org_id: session.org_id,
      org_name: await orgName(session.org_id),
      school_count: scope.length,
      ai: await readAiConfig(session.org_id),
      /**
       * The server's answer to "may this person configure AI?", which the SPA
       * renders rather than deciding. `contact_admin` travels with it so the
       * wording is the platform's, identical on screen and in the 403 body.
       */
      can_configure: canConfigureAi(session.role),
      contact_admin: CONTACT_ADMIN,
      models: Object.values(AI_MODELS),
      channels: await readChannels(scope),
    });
  })().catch(next);
});

/**
 * PUT because saving a key is idempotent by nature: the same key, model and cap
 * sent twice leaves the org in the same state, and an admin who double-clicks
 * "Test & Save" should get one activated org, not two of anything.
 */
settingsRouter.put('/api/settings/ai', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    /**
     * [MANDATORY] CODING_GUIDELINES §3: request bodies are `unknown` until
     * validated. The key is read as a string and passed straight to the vault —
     * it is never interpolated into a log line, an error, or a response.
     */
    const apiKey = typeof body['api_key'] === 'string' ? body['api_key'] : '';
    if (apiKey === '') {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Paste your Anthropic API key to continue.',
        correlationId: req.correlationId,
      });
    }

    const rawModel = typeof body['model'] === 'string' ? body['model'] : DEFAULT_MODEL;
    if (!isAiModelId(rawModel)) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Choose one of the offered models.',
        details: { allowed: Object.keys(AI_MODELS).join(', ') },
        correlationId: req.correlationId,
      });
    }
    const model: AiModelId = rawModel;

    const cap = Number(body['monthly_query_cap'] ?? 1500);

    const result = await saveApiKey({
      orgId: session.org_id,
      actorSub: session.sub,
      role: session.role,
      apiKey,
      model,
      monthlyQueryCap: cap,
      correlationId: req.correlationId,
    });

    /**
     * 200 with an `error` string, not a 4xx, when the PROVIDER rejected the key.
     * The request was well-formed and the platform did exactly what was asked;
     * what failed is a fact about the org's Anthropic account, and the screen
     * needs to render it beside a form that still holds their other choices.
     * Reserving HTTP errors for OUR failures keeps the SPA's error handling
     * honest (§6).
     */
    res.json({ ai: result.config, error: result.error });
  })().catch(next);
});

settingsRouter.post(
  '/api/settings/ai/disable',
  (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const session = requireSession(req);
      const config = await disableAi({
        orgId: session.org_id,
        actorSub: session.sub,
        role: session.role,
        correlationId: req.correlationId,
      });
      res.json({ ai: config, error: null });
    })().catch(next);
  },
);

settingsRouter.post(
  '/api/settings/channels/:schoolId/:channel/disconnect',
  (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const session = requireSession(req);

      const rawSchool = req.params['schoolId'];
      const schoolId = typeof rawSchool === 'string' ? rawSchool : '';
      const rawChannel = req.params['channel'];
      const channel = typeof rawChannel === 'string' ? rawChannel : '';

      if (!isChannelId(channel)) {
        throw new PlatformError({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'That is not a messaging channel this product supports.',
          correlationId: req.correlationId,
        });
      }

      /**
       * Scope layer 1 (ADR-007), applied to a platform-database row because the
       * row is ABOUT a school: a session may only touch channels for schools its
       * launch token carries.
       */
      const scope = await scopeOf(session);
      if (!scope.some((s) => s.school_id === schoolId)) {
        throw new PlatformError({
          code: ERROR_CODES.SCOPE_VIOLATION,
          message: 'That school is not in your access scope.',
          correlationId: req.correlationId,
        });
      }

      await disconnectChannel({
        schoolId,
        channel,
        actorSub: session.sub,
        orgId: session.org_id,
        role: session.role,
        correlationId: req.correlationId,
      });

      res.json({ channels: await readChannels(scope) });
    })().catch(next);
  },
);
