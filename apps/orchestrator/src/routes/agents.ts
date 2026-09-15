/**
 * Workflow Agents API — the fleet view, the builder, publish, and test-run.
 *
 * Contract source: docs/07 (all sections) · ADR-022 through ADR-025 · ADR-034.
 *
 * Scope enforcement here follows the same pattern routes/settings.ts uses for
 * channels: an agent's `school_ids` is data ABOUT schools living in the
 * platform database, so every read/write is checked against the session's own
 * scope (ADR-007's layer-1 check applied to a platform-DB row rather than a
 * school-DB query) even though no MCP call is involved in most of these
 * endpoints.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ERROR_CODES, PlatformError, effectiveScope } from '@sap/shared';
import { schoolNames, servableSchoolIds } from '../db/registry.js';
import {
  createAgent,
  enqueueImmediateEvaluation,
  getAgent,
  getRunSteps,
  listAgentRuns,
  publishAgent,
  readAgentsHome,
  setAgentActive,
  testRunAgent,
  updateAgentDraft,
} from '../services/agents.js';

export const agentsRouter = Router();

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

function param(req: Request, name: string): string {
  const raw = req.params[name];
  return typeof raw === 'string' ? raw : '';
}

function assertSchoolsInScope(schoolIds: readonly string[], scope: readonly { school_id: string }[], correlationId: string) {
  const allowed = new Set(scope.map((s) => s.school_id));
  const outside = schoolIds.filter((id) => !allowed.has(id));
  if (outside.length > 0) {
    throw new PlatformError({
      code: ERROR_CODES.SCOPE_VIOLATION,
      message: 'One or more selected schools are outside your access scope.',
      correlationId,
    });
  }
}

agentsRouter.get('/api/agents', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const scope = await scopeOf(session);
    res.json(await readAgentsHome(session.org_id, scope));
  })().catch(next);
});

agentsRouter.post('/api/agents', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const name = typeof body['name'] === 'string' && body['name'] !== '' ? body['name'] : 'Untitled agent';
    const schoolIds = Array.isArray(body['school_ids']) ? body['school_ids'].filter((v): v is string => typeof v === 'string') : [];
    const templateId = typeof body['template_id'] === 'string' ? body['template_id'] : undefined;

    if (schoolIds.length === 0) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Choose at least one school to deploy this agent to.',
        correlationId: req.correlationId,
      });
    }

    const scope = await scopeOf(session);
    assertSchoolsInScope(schoolIds, scope, req.correlationId);

    const agent = await createAgent({ orgId: session.org_id, actorSub: session.sub, name, schoolIds, ...(templateId === undefined ? {} : { templateId }) });
    res.json({ agent });
  })().catch(next);
});

agentsRouter.get('/api/agents/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const id = param(req, 'id');
    const agent = await getAgent(session.org_id, id, req.correlationId);
    assertSchoolsInScope(agent.school_ids, await scopeOf(session), req.correlationId);
    res.json({ agent });
  })().catch(next);
});

agentsRouter.put('/api/agents/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const id = param(req, 'id');
    const body = (req.body ?? {}) as Record<string, unknown>;

    const graph = (body['graph'] ?? {}) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'] : undefined;
    const schoolIds = Array.isArray(body['school_ids']) ? body['school_ids'].filter((v): v is string => typeof v === 'string') : undefined;

    const scope = await scopeOf(session);
    if (schoolIds !== undefined) assertSchoolsInScope(schoolIds, scope, req.correlationId);

    await updateAgentDraft({
      orgId: session.org_id,
      agentId: id,
      correlationId: req.correlationId,
      graph,
      ...(name === undefined ? {} : { name }),
      ...(schoolIds === undefined ? {} : { schoolIds }),
    });
    res.json({ agent: await getAgent(session.org_id, id, req.correlationId) });
  })().catch(next);
});

agentsRouter.post('/api/agents/:id/publish', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const id = param(req, 'id');
    const agent = await publishAgent({
      orgId: session.org_id,
      agentId: id,
      actorSub: session.sub,
      role: session.role,
      perms: session.perms,
      correlationId: req.correlationId,
    });
    res.json({ agent });
  })().catch(next);
});

agentsRouter.post('/api/agents/:id/activate', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const id = param(req, 'id');
    await setAgentActive({ orgId: session.org_id, agentId: id, actorSub: session.sub, active: true, correlationId: req.correlationId });
    res.json({ agent: await getAgent(session.org_id, id, req.correlationId) });
  })().catch(next);
});

agentsRouter.post('/api/agents/:id/pause', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const id = param(req, 'id');
    await setAgentActive({ orgId: session.org_id, agentId: id, actorSub: session.sub, active: false, correlationId: req.correlationId });
    res.json({ agent: await getAgent(session.org_id, id, req.correlationId) });
  })().catch(next);
});

agentsRouter.post('/api/agents/:id/test-run', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const id = param(req, 'id');
    res.json(await testRunAgent({ orgId: session.org_id, agentId: id, session, correlationId: req.correlationId }));
  })().catch(next);
});

/** Manual trigger — the palette's "▶️ Manual" trigger type (docs/07 §2). */
agentsRouter.post('/api/agents/:id/run-now', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const id = param(req, 'id');
    const agent = await getAgent(session.org_id, id, req.correlationId);
    assertSchoolsInScope(agent.school_ids, await scopeOf(session), req.correlationId);
    if (agent.status !== 'active') {
      throw new PlatformError({ code: ERROR_CODES.VALIDATION_FAILED, message: 'Publish and turn on this agent first.', correlationId: req.correlationId });
    }
    await enqueueImmediateEvaluation(id);
    res.json({ queued: true });
  })().catch(next);
});

agentsRouter.get('/api/agents/:id/runs', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const id = param(req, 'id');
    res.json({ runs: await listAgentRuns(session.org_id, id, req.correlationId) });
  })().catch(next);
});

agentsRouter.get('/api/agents/:id/runs/:runId/steps', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const id = param(req, 'id');
    const runId = param(req, 'runId');
    res.json({ steps: await getRunSteps(session.org_id, id, runId, req.correlationId) });
  })().catch(next);
});
