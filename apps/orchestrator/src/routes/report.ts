/**
 * GET /api/report/:id — a predefined dashboard.
 *
 * Contract: CODING_GUIDELINES §6 (resource-oriented under /api; report data
 * returns chart-spec) · docs/06 §2 · ADR-016 (this is the deterministic path and
 * spends no AI tokens) · ADR-019 (the response carries the logic panel, because
 * Invariant 6 makes it part of the report rather than an extra).
 *
 * Scope is checked here (ADR-007 layer 1) and again at the MCP layer. The
 * `academic_year` filter is a VALUE, validated for shape and then bound as a
 * parameter all the way down — it is never concatenated into SQL, and the
 * statement it binds into is the platform's, not the caller's
 * (CODING_GUIDELINES §9 [MANDATORY]).
 *
 * A GET, and side-effect-free by contract (ADR-029 clause 3) — which is what
 * lets CSRF tokens be required only on mutating requests. Note that ADR-020's
 * drill endpoint is a POST for the same reason in reverse: it carries a drill
 * context and is audited as a distinct event.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { resolveRequestedSchools } from '../middleware/scope.js';
import { buildDashboard, isDashboardId } from '../services/dashboards.js';
import { auditSink } from '../db/audit.js';

export const reportRouter = Router();

/**
 * The ERP writes academic years as `2026-27`. Validated for shape before it
 * travels, not because a bound parameter could inject — it could not — but
 * because a malformed filter would silently match no rows and render an empty
 * dashboard that looks like a school with no data (§10).
 */
const ACADEMIC_YEAR = /^\d{4}-\d{2}$/;

reportRouter.get('/api/report/:id', (req: Request, res: Response, next: NextFunction): void => {
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
        code: ERROR_CODES.REPORT_NOT_FOUND,
        message: 'That report does not exist.',
        correlationId: req.correlationId,
      });
    }

    const rawYear = req.query['academic_year'];
    const academicYear = typeof rawYear === 'string' ? rawYear : '';
    if (!ACADEMIC_YEAR.test(academicYear)) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Choose an academic year to view this report.',
        details: { expected: 'YYYY-YY' },
        correlationId: req.correlationId,
      });
    }

    const schoolIds = await resolveRequestedSchools(req);

    const dashboard = await buildDashboard({
      session,
      schoolIds,
      reportId,
      academicYear,
      correlationId: req.correlationId,
    });

    /**
     * [MANDATORY] docs/08 §7 / CODING_GUIDELINES §13: "Report/dashboard view —
     * user, school-set, report id, filters" is a chokepoint event. Written here
     * rather than in the service because it records the VIEW, which is a
     * property of someone opening a page, not of a query running.
     */
    await auditSink.write({
      kind: 'report.viewed',
      at: new Date().toISOString(),
      actor_sub: session.sub,
      org_id: session.org_id,
      correlation_id: req.correlationId,
      report_id: reportId,
      school_ids: schoolIds,
      filters: { academic_year: academicYear },
    });

    res.json(dashboard);
  })().catch(next);
});
