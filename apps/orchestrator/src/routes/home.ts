/**
 * GET /api/home — the Home screen's data.
 *
 * Contract: docs/10 §2 (Home) · ADR-016 (predefined path; no AI tokens spent) ·
 * CODING_GUIDELINES §6 (resource-oriented under /api; report data returns
 * chart-spec).
 *
 * Scope is resolved by the orchestrator's own check first (middleware/scope.ts,
 * ADR-007 layer 1) and re-checked independently at the MCP layer. A `school_ids`
 * query parameter can only NARROW within the session; it can never widen it, and
 * an id outside the token is a 403 plus an audit row at both layers.
 *
 * Deliberately a GET with no side effects, per ADR-029 clause 3 — GET/HEAD
 * endpoints are side-effect-free by contract, which is what lets the CSRF token
 * be required only on mutating requests.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { resolveRequestedSchools } from '../middleware/scope.js';
import { buildHomePreview, buildHomeSummary } from '../services/home.js';
import { isDashboardId } from '../services/dashboards.js';
import { ACADEMIC_YEAR, AS_OF_DATE, isRealDate, today } from './report.js';

export const homeRouter = Router();

homeRouter.get('/api/home', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = req.session;
    if (session === undefined) {
      throw new PlatformError({
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Please open Analytics from the ERP menu.',
        correlationId: req.correlationId,
      });
    }

    const schoolIds = await resolveRequestedSchools(req);

    const summary = await buildHomeSummary({
      session,
      schoolIds,
      correlationId: req.correlationId,
    });

    res.json(summary);
  })().catch(next);
});

/**
 * GET /api/home/preview/:id — ONE live dashboard-preview card on Home.
 *
 * -- Why per dashboard, and not all of them in one response -------------------
 * This was `/api/home/previews`, which built every available dashboard and
 * returned them together. That made the screen only as fast as its slowest
 * card: against the real extract, `enrollment-overview` was ready in 146 ms and
 * sat invisible for another 6.5 s while the fee scans finished, because one
 * `Promise.all` cannot answer early.
 *
 * One dashboard per request means each card renders when its own data lands.
 * The SPA fires them together (apps/web/src/App.tsx) and fills the grid as they
 * arrive; the browser's own per-origin concurrency is the only queue, and every
 * request is cheap now that a preview fetches one query rather than a whole
 * dashboard (services/home.ts, `buildHomePreview`).
 *
 * Still a second, deliberately separate call from `/api/home`: it needs the
 * academic year that response worked out, and the KPI strip must not wait on
 * any of this. `academic_year` is validated for SHAPE here rather than trusted,
 * same reasoning as `/api/report/:id` — it is bound as a parameter either way,
 * but a malformed value would silently match no rows everywhere at once instead
 * of failing loudly.
 *
 * A dashboard that cannot be previewed answers 200 with `status: 'blocked'` and
 * a reason, not an error status: the card has something honest to say, and one
 * unavailable dashboard is not a failed request (ADR-011). An id that is not a
 * previewable dashboard at all IS an error — that is a caller bug, not a state.
 */
homeRouter.get('/api/home/preview/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = req.session;
    if (session === undefined) {
      throw new PlatformError({
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Please open Analytics from the ERP menu.',
        correlationId: req.correlationId,
      });
    }

    const rawId = req.params['id'];
    const reportId = typeof rawId === 'string' ? rawId : '';
    if (!isDashboardId(reportId)) {
      throw new PlatformError({
        code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
        message: 'That dashboard does not exist.',
        correlationId: req.correlationId,
      });
    }

    const rawYear = req.query['academic_year'];
    const academicYear = typeof rawYear === 'string' ? rawYear : '';
    if (!ACADEMIC_YEAR.test(academicYear)) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'academic_year must look like "2026-27".',
        correlationId: req.correlationId,
      });
    }

    const rawAsOf = req.query['as_of'];
    const asOfDate = typeof rawAsOf === 'string' && rawAsOf !== '' ? rawAsOf : today();
    if (!AS_OF_DATE.test(asOfDate) || !isRealDate(asOfDate)) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'as_of must be a real date, YYYY-MM-DD.',
        correlationId: req.correlationId,
      });
    }

    const schoolIds = await resolveRequestedSchools(req);

    const preview = await buildHomePreview({
      session,
      schoolIds,
      reportId,
      academicYear,
      asOfDate,
      correlationId: req.correlationId,
    });

    res.json(preview);
  })().catch(next);
});
