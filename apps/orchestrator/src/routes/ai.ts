/**
 * POST /api/ai/ask — Ask AI (ADR-030, docs/05).
 * POST /api/ai/insights — Insights, the per-chart plain-language explanation
 * (docs/10 §1.6, services/ai-insights.ts).
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
import { buildChartInsight, type InsightTarget } from '../services/ai-insights.js';
import { getRefineContext } from '../services/custom-reports.js';
import { ACADEMIC_YEAR, AS_OF_DATE, isRealDate, today } from './report.js';

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

/**
 * POST /api/ai/insights — "explain this chart to me".
 *
 * A POST for the same reason `/api/ai/ask` is one despite writing nothing to
 * our own database: it spends the org's own AI budget, which is exactly what
 * CSRF protects regardless of what it stores (ADR-029 clause 3 reasoning).
 *
 * A plain JSON response rather than the ask route's event stream. There are no
 * intermediate steps worth showing — no schema read, no planning, no query —
 * so a stream would be a progress bar over a single call, and the panel is
 * better off saying "reading this chart…" and then showing the answer.
 *
 * Gated on `ai_status === 'active'` here, on every request, independent of
 * whatever the UI believes (Invariant 5). The menu's lock is cosmetic on top
 * of this check, exactly like Ask AI's three entry points.
 */
const insightTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('overview'),
    /**
     * The widgets this CARD draws, each with the slot it comes from. Several,
     * because half the Dashboard's cards are arrangements of several widgets
     * and two of them read two slots — see `InsightTarget` (ai-insights.ts).
     * Capped so a body cannot ask for an unbounded fan-out of slot builds.
     */
    parts: z
      .array(z.object({ slot: z.string().min(1).max(64), widget_id: z.string().min(1).max(128) }))
      .min(1)
      .max(8),
  }),
  z.object({ kind: z.literal('report'), report_id: z.string().min(1).max(128), widget_id: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('custom'), report_id: z.string().min(1).max(128), widget_id: z.string().min(1).max(128) }),
]);

aiRouter.post('/api/ai/insights', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = req.session;
    if (session === undefined) {
      throw new PlatformError({
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Please open Analytics from the ERP menu.',
        correlationId: req.correlationId,
      });
    }

    /** Invariant 5, re-checked here regardless of the client's own belief about it. */
    const status = await readAiStatus(session.org_id);
    if (status !== 'active') {
      throw new PlatformError({
        code: ERROR_CODES.AI_NOT_ACTIVE,
        message: 'AI reports are not set up for this organization.',
        correlationId: req.correlationId,
      });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = insightTargetSchema.safeParse(body['target']);
    if (!parsed.success) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Name the chart to explain.',
        correlationId: req.correlationId,
      });
    }

    const rawYear = body['academic_year'];
    const academicYear = typeof rawYear === 'string' ? rawYear : '';
    if (!ACADEMIC_YEAR.test(academicYear)) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'academic_year must look like "2026-27".',
        correlationId: req.correlationId,
      });
    }

    const rawAsOf = body['as_of'];
    const asOfDate = typeof rawAsOf === 'string' && rawAsOf !== '' ? rawAsOf : today();
    if (!AS_OF_DATE.test(asOfDate) || !isRealDate(asOfDate)) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'as_of must be a real date, YYYY-MM-DD.',
        correlationId: req.correlationId,
      });
    }

    const rawCompare = body['compare_year'];
    const compareYear = typeof rawCompare === 'string' && ACADEMIC_YEAR.test(rawCompare) ? rawCompare : undefined;

    /**
     * Scope from the token, never from the body — the chart is rebuilt under
     * the same constraint the screen drew it under (Invariant 2), and the
     * model is handed a digest of that and nothing else.
     */
    const schoolIds = await resolveRequestedSchools(req);

    const target: InsightTarget =
      parsed.data.kind === 'overview'
        ? { kind: 'overview', parts: parsed.data.parts.map((p) => ({ slot: p.slot, widgetId: p.widget_id })) }
        : { kind: parsed.data.kind, reportId: parsed.data.report_id, widgetId: parsed.data.widget_id };

    const insight = await buildChartInsight({
      session,
      schoolIds,
      target,
      academicYear,
      asOfDate,
      ...(compareYear === undefined ? {} : { compareYear }),
      correlationId: req.correlationId,
    });

    res.json(insight);
  })().catch(next);
});
