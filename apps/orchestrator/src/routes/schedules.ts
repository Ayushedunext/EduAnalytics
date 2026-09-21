/**
 * Schedules API — "send me this report, on these days, at this time, here".
 *
 * Contract source: ADR-037 · docs/06 §7 · docs/10 §2 ("Schedule").
 *
 * This is the endpoint `apps/web/src/schedules.ts` was written against before
 * it existed — its module doc says so in as many words ("the moment
 * `/api/schedules` exists, the functions below become its client"). The shapes
 * below therefore mirror what that module already stores, minus the two things
 * a client must never own: the scope (captured server-side from the verified
 * token) and the identity (the session's).
 *
 * -- Where the checks are ------------------------------------------------------
 * Ownership, scope capture and validation all live in `services/schedules.ts`,
 * not here, so a future caller — a bulk import, an ERP-driven setup — cannot
 * reach them through a route that forgot. This module parses the request and
 * nothing else, the same division routes/settings.ts keeps for the AI key.
 *
 * -- Mutations are POST/PUT/DELETE, so CSRF applies ----------------------------
 * The CSRF middleware is mounted ahead of every /api route and exempts only
 * GET/HEAD (ADR-029 clause 3). "Send now" is a POST for that reason as much as
 * for REST tidiness: it causes an email to leave the building, and a GET that
 * did so could be fired by an image tag.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  sendScheduleNow,
  setSchedulePaused,
  updateSchedule,
  type NewScheduleInput,
} from '../services/schedules.js';

export const schedulesRouter = Router();

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

function param(req: Request, name: string): string {
  const raw = req.params[name];
  return typeof raw === 'string' ? raw : '';
}

/**
 * The request body, read defensively.
 *
 * Every field is taken as `unknown` and narrowed here; the service then
 * validates the VALUES (days in range, a real time, a real address, a report
 * that exists). Two layers on purpose — CODING_GUIDELINES §10 puts validation
 * at every trust boundary, and "it arrived as JSON" is a statement about
 * syntax, never about content.
 *
 * `school_ids` is accepted and is NOT authoritative: the service intersects it
 * with the session's token scope and stores the intersection (§8).
 */
function parseBody(req: Request): NewScheduleInput {
  const body: Record<string, unknown> = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};

  const bad = (message: string): never => {
    throw new PlatformError({ code: ERROR_CODES.VALIDATION_FAILED, message, correlationId: req.correlationId });
  };

  const reportId = body['report_id'];
  if (typeof reportId !== 'string' || reportId === '') bad('Choose a report to schedule.');

  const reportKind = body['report_kind'] === 'custom' ? 'custom' : 'predefined';
  const reportTitle = typeof body['report_title'] === 'string' && body['report_title'] !== '' ? body['report_title'] : 'Report';

  const days = Array.isArray(body['days']) ? (body['days'] as unknown[]).filter((d): d is number => typeof d === 'number') : [];
  const time = body['time'];
  if (typeof time !== 'string') bad('Choose a time.');

  const channel = body['channel'] === 'whatsapp' ? 'whatsapp' : 'email';
  const recipient = body['recipient'];
  if (typeof recipient !== 'string') bad('Enter where this report should be delivered.');

  const schoolIds = Array.isArray(body['school_ids'])
    ? (body['school_ids'] as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];

  return {
    reportId: reportId as string,
    reportKind,
    reportTitle,
    days,
    time: time as string,
    channel,
    recipient: recipient as string,
    schoolIds,
  };
}

schedulesRouter.get('/api/schedules', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    res.json({ schedules: await listSchedules(session) });
  })().catch(next);
});

schedulesRouter.post('/api/schedules', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const schedule = await createSchedule({
      session,
      correlationId: req.correlationId,
      input: parseBody(req),
    });
    res.status(201).json({ schedule });
  })().catch(next);
});

schedulesRouter.put('/api/schedules/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const schedule = await updateSchedule({
      session,
      correlationId: req.correlationId,
      id: param(req, 'id'),
      input: parseBody(req),
    });
    res.json({ schedule });
  })().catch(next);
});

schedulesRouter.post('/api/schedules/:id/pause', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    const body: Record<string, unknown> = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};
    await setSchedulePaused({
      session,
      correlationId: req.correlationId,
      id: param(req, 'id'),
      /** Absent means pause — the button that sends nothing is the pause button. */
      paused: body['paused'] !== false,
    });
    res.status(204).end();
  })().catch(next);
});

schedulesRouter.delete('/api/schedules/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    await deleteSchedule({ session, correlationId: req.correlationId, id: param(req, 'id') });
    res.status(204).end();
  })().catch(next);
});

/**
 * POST /api/schedules/:id/send-now — the same delivery path, on demand.
 *
 * 202, not 200: the delivery is queued and runs in the worker, because it
 * renders a PDF and that takes seconds a request should not hold. The reader
 * learns the outcome the same way they learn a scheduled one — the row's last
 * delivery, refreshed.
 */
schedulesRouter.post('/api/schedules/:id/send-now', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = requireSession(req);
    await sendScheduleNow({ session, correlationId: req.correlationId, id: param(req, 'id') });
    res.status(202).json({ queued: true });
  })().catch(next);
});
