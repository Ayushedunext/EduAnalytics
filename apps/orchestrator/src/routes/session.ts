/**
 * GET /api/session -- who is this, and what may they see?
 *
 * The SPA's first call after launch. It returns identity, role and the school
 * SCOPE WITH NAMES, resolved server-side from the registry.
 *
 * The names matter more than they look: docs/10 §3 makes "scope is always on
 * screen" binding -- the picker chip, the line under every report title and the
 * scope printed on PDFs all read from here. Resolving them server-side means the
 * SPA never invents or supplies a school identity, which keeps CODING_GUIDELINES
 * §8 true at the UI boundary as well as the data one.
 *
 * `dropped` carries schools in the token that the registry cannot currently
 * serve, so the SPA can show the notice docs/02 §6 requires instead of quietly
 * presenting a smaller trust than the user has.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { ERROR_CODES, PlatformError, effectiveScope } from '@sap/shared';
import { orgName, schoolNames, servableSchoolIds } from '../db/registry.js';
import { canConfigureAi, readAiStatus } from '../services/ai-config.js';

export const sessionRouter = Router();

sessionRouter.get('/api/session', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = req.session;
    if (session === undefined) {
      throw new PlatformError({
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Please open Analytics from the ERP menu.',
        correlationId: req.correlationId,
      });
    }

    const { effective, dropped } = effectiveScope(session.school_ids, await servableSchoolIds());

    res.json({
      user: { name: session.name, role: session.role },
      org_id: session.org_id,
      /** The registry's name for the org, so no screen has to display an id. */
      org_name: await orgName(session.org_id),
      scope: await schoolNames(effective),
      default_school: session.default_school,
      /** Domain permissions, so the SPA can render locked states honestly. */
      perms: session.perms,
      /**
       * Schools present in the token but not currently servable. Surfaced, never
       * silently filtered (docs/02 §6, CODING_GUIDELINES §10).
       */
      dropped_from_scope: dropped,
      /**
       * The org's real gating state, read from the key vault (ADR-017). The SPA
       * renders locked-not-hidden states (docs/10 §3) from it, and those locks
       * stay cosmetic: every `/api/ai/*` endpoint re-checks this server-side,
       * so a client that lies to itself about the value gains nothing
       * (Invariant 5).
       */
      ai_status: await readAiStatus(session.org_id),
      /**
       * Whether THIS user can fix an unconfigured org. docs/10 §2: an admin is
       * offered "Set up now →" and everyone else "ask your administrator" —
       * two different sentences for two different people, decided on the server
       * because the client does not get to interpret roles.
       */
      can_configure_ai: canConfigureAi(session.role),
    });
  })().catch(next);
});
