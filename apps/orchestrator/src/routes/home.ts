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
import { buildHomePreviews, buildHomeSummary } from '../services/home.js';
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
 * GET /api/home/previews — the live dashboard-preview cards on Home.
 *
 * A second, deliberately separate call from `/api/home` (services/home.ts,
 * `buildHomePreviews`): it needs the academic year `/api/home` already worked
 * out, so the SPA calls this one right after, and Home's KPI strip is not held
 * up waiting for it. `academic_year` is still validated for shape here rather
 * than trusted, same reasoning as `/api/report/:id` (this file's sibling
 * route) — it is bound as a parameter either way, but a malformed value would
 * silently match no rows everywhere at once instead of failing loudly.
 */
homeRouter.get('/api/home/previews', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = req.session;
    if (session === undefined) {
      throw new PlatformError({
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Please open Analytics from the ERP menu.',
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

    const previews = await buildHomePreviews({
      session,
      schoolIds,
      academicYear,
      asOfDate,
      correlationId: req.correlationId,
    });

    res.json(previews);
  })().catch(next);
});
