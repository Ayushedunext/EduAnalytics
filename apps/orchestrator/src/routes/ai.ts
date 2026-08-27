/**
 * POST /api/ai/ask — Ask AI (ADR-030, docs/05).
 *
 * Gated on `ai_status === 'active'` (Invariant 5) — checked here, on every
 * request, independent of what the UI shows; the three locked entry points in
 * the SPA are cosmetic on top of this.
 *
 * Streams newline-delimited JSON status/result/error events over a chunked
 * response. Not WebSocket, despite docs/05 §2's original wording — no WS/SSE
 * infrastructure exists anywhere in this codebase, and `EventSource` cannot
 * carry a POST body, so a plain chunked response avoids a new dependency
 * entirely (docs/05 §2 has been corrected to describe this).
 *
 * A GET would be side-effect-free by contract (ADR-029 clause 3) and CSRF-
 * exempt; this is a POST because it spends the org's own AI budget, which is
 * exactly the kind of request CSRF exists to protect regardless of what it
 * writes to our own database.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { widgetSchema } from '@sap/chart-spec';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { resolveRequestedSchools } from '../middleware/scope.js';
import { readAiStatus } from '../services/ai-config.js';
import { runAskAi, type AskAiEvent, type RefineSeedContext } from '../services/ai-chat.js';
import { getRefineContext } from '../services/custom-reports.js';

export const aiRouter = Router();

const MAX_QUESTION_LENGTH = 2000;

/**
 * "✎ Refine" on an Ask AI answer that has not been saved yet — same seed
 * shape `RefineSeedContext` already carries for a SAVED report (below), just
 * sourced from the client's own last turn instead of a `getRefineContext` DB
 * lookup. This is not a new trust boundary: every field here is an exact
 * echo of what THIS SAME session's own previous `result` event already sent
 * the client (its own `spec.title`, `queries`, `spec.widgets`) — nothing a
 * tampered body could turn into cross-tenant access, since no id is looked
 * up and nothing here is read from another session's data. It is still
 * validated at the shape level (CODING_GUIDELINES's "validate at system
 * boundaries"): a malformed body is a client bug, not silently tolerated.
 */
const inlineSeedSchema = z.object({
  report_name: z.string().min(1).max(255),
  queries: z.array(z.object({ key: z.string().min(1), sql: z.string().min(1) })).min(1),
  widgets: z.array(widgetSchema).min(1),
});

aiRouter.post('/api/ai/ask', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = req.session;
    if (session === undefined) {
      throw new PlatformError({
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Please open Analytics from the ERP menu.',
        correlationId: req.correlationId,
      });
    }

    /** Invariant 5: re-checked here regardless of the client's own belief about it. */
    const status = await readAiStatus(session.org_id);
    if (status !== 'active') {
      throw new PlatformError({
        code: ERROR_CODES.AI_NOT_ACTIVE,
        message: 'AI reports are not set up for this organization.',
        correlationId: req.correlationId,
      });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = typeof body['question'] === 'string' ? body['question'].trim() : '';
    if (question === '' || question.length > MAX_QUESTION_LENGTH) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `Ask a question of up to ${String(MAX_QUESTION_LENGTH)} characters.`,
        correlationId: req.correlationId,
      });
    }

    const schoolIds = await resolveRequestedSchools(req);

    /**
     * "✎ Refine with AI" (docs/06 §1) — an optional `report_id` seeds this
     * turn with an existing report's current definition instead of starting
     * blank. `getRefineContext` is owner-gated on its own (404s a report
     * this session cannot see, 403s one it does not own), so a tampered
     * `report_id` fails the same way any other cross-tenant report access
     * attempt does, before a single token is spent.
     */
    const reportId = typeof body['report_id'] === 'string' && body['report_id'] !== '' ? body['report_id'] : undefined;
    const refining: { seedContext: RefineSeedContext; refiningReportId?: string } | undefined =
      reportId !== undefined
        ? await getRefineContext({
            session,
            correlationId: req.correlationId,
            id: reportId,
            requestedSchoolIds: schoolIds,
          }).then((ctx) => ({
            seedContext: { reportName: ctx.reportName, queries: ctx.queries, widgets: ctx.widgets },
            refiningReportId: reportId,
          }))
        : // "✎ Refine" on a not-yet-saved Ask AI answer: the same seed shape,
          // echoed straight from the client's own last turn (see the schema
          // comment above) instead of a report-id lookup.
          (() => {
            if (body['seed'] === undefined) return undefined;
            const parsed = inlineSeedSchema.safeParse(body['seed']);
            if (!parsed.success) {
              throw new PlatformError({
                code: ERROR_CODES.VALIDATION_FAILED,
                message: 'That refinement request was malformed.',
                correlationId: req.correlationId,
              });
            }
            return {
              seedContext: {
                reportName: parsed.data.report_name,
                queries: parsed.data.queries,
                widgets: parsed.data.widgets,
              },
            };
          })();

    res.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
    });

    const send = (event: AskAiEvent): void => {
      res.write(JSON.stringify(event) + '\n');
    };

    try {
      await runAskAi({
        session,
        schoolIds,
        question,
        correlationId: req.correlationId,
        onEvent: send,
        ...(refining ?? {}),
      });
    } catch (err) {
      /**
       * A failure reaching this point already has a real chunked response in
       * flight, so it cannot become an HTTP status the way `errorHandler`
       * gives every other route — the event stream IS this route's error
       * channel, and it must end with one even when nothing else went right.
       */
      const platformError =
        err instanceof PlatformError
          ? err
          : new PlatformError({
              code: ERROR_CODES.INTERNAL,
              message: 'Ask AI could not answer that question.',
              diagnostics: { reason: err instanceof Error ? err.message : String(err) },
              correlationId: req.correlationId,
            });
      send({ type: 'error', code: platformError.code, message: platformError.message });
    } finally {
      res.end();
    }
  })().catch(next);
});
