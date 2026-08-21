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
import { renderReportPdf } from '../services/pdf.js';
import { orgName, schoolNames } from '../db/registry.js';
import { auditSink } from '../db/audit.js';

export const reportRouter = Router();

/**
 * The ERP writes academic years as `2026-27`. Validated for shape before it
 * travels, not because a bound parameter could inject — it could not — but
 * because a malformed filter would silently match no rows and render an empty
 * dashboard that looks like a school with no data (§10).
 */
const ACADEMIC_YEAR = /^\d{4}-\d{2}$/;

/**
 * The as-of date: what "overdue" and "on roll" are measured against.
 *
 * Optional, defaulting to today, because most readers want today's position and
 * should not have to say so. Supplying it is what makes a report reproducible —
 * the same date gives the same aging bands next month, which is the property a
 * printed PDF needs (docs/06 §5).
 *
 * Validated for shape AND for existence: `2026-02-31` matches the pattern and is
 * not a date, and MySQL would compare against it happily enough to return
 * something that looks like an answer.
 */
const AS_OF_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** Today, as the reports mean it: a calendar date, not an instant. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The parts of a report request both the JSON and the PDF route need.
 *
 * Extracted so the export cannot drift from the view: a PDF that validated its
 * academic year differently, or skipped the scope resolution, would be a second
 * door into the same data with its own bugs. Both routes ask the same questions
 * in the same order and get the same refusals.
 */
async function parseReportRequest(req: Request) {
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

  const rawAsOf = req.query['as_of'];
  const asOfDate = typeof rawAsOf === 'string' && rawAsOf !== '' ? rawAsOf : today();
  if (!AS_OF_DATE.test(asOfDate) || !isRealDate(asOfDate)) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'The "as of" date must be a calendar date.',
      details: { expected: 'YYYY-MM-DD' },
      correlationId: req.correlationId,
    });
  }

  const schoolIds = await resolveRequestedSchools(req);

  return { session, reportId, academicYear, asOfDate, schoolIds };
}

reportRouter.get('/api/report/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const { session, reportId, academicYear, asOfDate, schoolIds } = await parseReportRequest(req);

    const dashboard = await buildDashboard({
      session,
      schoolIds,
      reportId,
      academicYear,
      asOfDate,
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
      /**
       * Both filters are recorded whichever report was asked for, including the
       * one that report ignores. The audit trail answers "what did this person
       * see?", and the resolved as-of date is what makes a defaulter list
       * reconstructible months later — a defaulted-to-today value that was never
       * written down is not reconstructible at all.
       */
      filters: { academic_year: academicYear, as_of: asOfDate },
    });

    res.json(dashboard);
  })().catch(next);
});


/**
 * GET /api/report/:id/export.pdf — the official document (ADR-021, docs/06 §5).
 *
 * The spec is REBUILT here rather than accepted from the caller. A PDF carries
 * the school's name, the platform's branding and a generated-on stamp; it will
 * be forwarded, printed and filed long after the session that made it. An
 * endpoint that rendered a spec from the request body would let anyone POST
 * arbitrary numbers and receive them back looking official — so the numbers in
 * the file are always ones this service read for this request. The result cache
 * (tier ①) makes that re-read cheap for anything recently viewed.
 *
 * A GET, and side-effect-free by contract: it changes nothing, so a link can
 * open it and CSRF does not apply (ADR-029 clause 3). The audit write is a
 * RECORD of the read, not a change to any state a caller can influence.
 */
reportRouter.get(
  '/api/report/:id/export.pdf',
  (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const { session, reportId, academicYear, asOfDate, schoolIds } = await parseReportRequest(req);

      /** docs/06 §5: the logic summary prints as an appendix, on request. */
      const includeLogic = req.query['logic'] === '1' || req.query['logic'] === 'true';

      const dashboard = await buildDashboard({
        session,
        schoolIds,
        reportId,
        academicYear,
        asOfDate,
        correlationId: req.correlationId,
      });

      const scope = await schoolNames(schoolIds);
      const pdf = await renderReportPdf({
        dashboard,
        title: dashboard.spec.title,
        orgName: await orgName(session.org_id),
        scopeLine: scope.map((s) => s.school_name).join(' · '),
        includeLogic,
      });

      /**
       * [MANDATORY] docs/08 §7: "Export — user, report, format". docs/06 §5
       * calls the same record Export History. Written AFTER a successful
       * render: a failed export produced no document, and logging one would put
       * a file in the history that nobody can produce.
       */
      await auditSink.write({
        kind: 'report.exported',
        at: new Date().toISOString(),
        actor_sub: session.sub,
        org_id: session.org_id,
        correlation_id: req.correlationId,
        report_id: reportId,
        school_ids: schoolIds,
        format: 'pdf',
      });

      res.setHeader('content-type', 'application/pdf');
      /**
       * `attachment` with a dated filename: these end up in a downloads folder
       * beside each other, and "report.pdf" three times is a filing problem the
       * server can prevent for free.
       */
      res.setHeader(
        'content-disposition',
        `attachment; filename="${filename(reportId, asOfDate)}"`,
      );
      /** Never cached by a proxy: the content is school data (docs/08 §3). */
      res.setHeader('cache-control', 'private, no-store');
      res.end(Buffer.from(pdf));
    })().catch(next);
  },
);

function filename(reportId: string, asOfDate: string): string {
  return `${reportId}-${asOfDate}.pdf`;
}
