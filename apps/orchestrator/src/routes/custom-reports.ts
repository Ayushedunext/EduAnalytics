/**
 * `/api/reports/*` — custom reports: clone-to-edit and AI-saved (ADR-018).
 *
 * Contract source: docs/06 §1/§3 · CODING_GUIDELINES §6 (resource-oriented
 * routing) · the same request shape `routes/report.ts` already establishes
 * for predefined dashboards (session check → `resolveRequestedSchools` →
 * validate → service call → audit → respond) — this router does not invent a
 * second convention.
 *
 * Kept as its OWN file rather than added to `report.ts`: predefined reports
 * are read-only by construction (`GET /api/report/:id` and its PDF sibling
 * are the whole surface); custom reports are a CRUD resource with versioning,
 * and mixing the two would make one file answer two different questions
 * about what a "report" route is allowed to do.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { chartSpecDraftSchema } from '@sap/chart-spec';
import { z } from 'zod';
import { resolveRequestedSchools } from '../middleware/scope.js';
import { renderReportPdf } from '../services/pdf.js';
import { orgName, schoolNames } from '../db/registry.js';
import { auditSink } from '../db/audit.js';
import {
  applyRefinement,
  cloneReport,
  deleteReport,
  duplicateReport,
  listMyReports,
  listReportSources,
  listReportVersions,
  rollbackReport,
  saveAiReport,
  setReportVisibility,
  updateReportSql,
  updateReportVisual,
  viewReport,
} from '../services/custom-reports.js';

export const customReportsRouter = Router();

function sessionOf(req: Request) {
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

function badRequest(message: string, correlationId: string): never {
  throw new PlatformError({ code: ERROR_CODES.VALIDATION_FAILED, message, correlationId });
}

customReportsRouter.get('/api/reports', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    res.json({ reports: await listMyReports(session) });
  })().catch(next);
});

/**
 * What a new custom report can be built from ("＋ New custom report", docs/06
 * §3). Registered BEFORE `/api/reports/:id` on purpose: Express matches in
 * declaration order, and the parameterised route would otherwise swallow
 * `sources` as a report id and 404 it.
 */
customReportsRouter.get('/api/reports/sources', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    // Called for its throw: an unauthenticated caller gets the same refusal
    // here as on every other route, before any catalog is disclosed.
    sessionOf(req);
    res.json({ sources: listReportSources() });
  })().catch(next);
});

const cloneBodySchema = z.object({
  base_report_id: z.string().min(1),
  name: z.string().min(1).max(255),
  academic_year: z.string().min(1),
  as_of: z.string().min(1).optional(),
  /** Per-widget clone (docs/06 §3): clone just this one chart. */
  widget_id: z.string().min(1).optional(),
  /** Time-grouping override — only meaningful together with `widget_id`. */
  bucket: z.enum(['week', 'month', 'quarter', 'year']).optional(),
});

customReportsRouter.post('/api/reports/clone', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const parsed = cloneBodySchema.safeParse(req.body);
    if (!parsed.success) badRequest('A report name and academic year are required to clone a report.', req.correlationId);
    const schoolIds = await resolveRequestedSchools(req);

    const view = await cloneReport({
      session,
      correlationId: req.correlationId,
      baseReportId: parsed.data.base_report_id,
      name: parsed.data.name,
      schoolIds,
      academicYear: parsed.data.academic_year,
      asOfDate: parsed.data.as_of ?? new Date().toISOString().slice(0, 10),
      ...(parsed.data.widget_id === undefined ? {} : { widgetScope: parsed.data.widget_id }),
      ...(parsed.data.bucket === undefined ? {} : { bucket: parsed.data.bucket }),
    });
    res.status(201).json(view);
  })().catch(next);
});

const fromAiBodySchema = z.object({
  name: z.string().min(1).max(255),
  queries: z.array(z.object({ key: z.string().min(1), sql: z.string().min(1) })).min(1),
  draft: chartSpecDraftSchema,
});

/**
 * "Save as report" from Ask AI. The SQL is not trusted from the client as
 * final — `saveAiReport` re-runs it through the same guarded MCP path any
 * execution takes (CODING_GUIDELINES §7: no code path may skip a step) before
 * anything is persisted, so a tampered request body fails loudly rather than
 * saving an unsafe or non-functioning report.
 */
customReportsRouter.post('/api/reports/from-ai', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const parsed = fromAiBodySchema.safeParse(req.body);
    if (!parsed.success) badRequest('A name, at least one query and a chart draft are required.', req.correlationId);
    const schoolIds = await resolveRequestedSchools(req);

    const view = await saveAiReport({
      session,
      correlationId: req.correlationId,
      name: parsed.data.name,
      schoolIds,
      queries: parsed.data.queries,
      draft: parsed.data.draft,
    });
    res.status(201).json(view);
  })().catch(next);
});

customReportsRouter.get('/api/reports/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') badRequest('A report id is required.', req.correlationId);
    const schoolIds = await resolveRequestedSchools(req);

    const view = await viewReport({ session, correlationId: req.correlationId, id, requestedSchoolIds: schoolIds });
    res.json(view);
  })().catch(next);
});

const duplicateBodySchema = z.object({ name: z.string().min(1).max(255) });

/**
 * "⧉ Clone" on a row of My Reports — a private copy of a report you can
 * already see. `POST /api/reports/clone` is the other, unrelated door: that
 * one clones a PREDEFINED dashboard by its catalog id and refuses anything
 * else, which is why duplicating a custom report needs its own route rather
 * than a looser check on that one.
 */
customReportsRouter.post('/api/reports/:id/duplicate', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') badRequest('A report id is required.', req.correlationId);
    const parsed = duplicateBodySchema.safeParse(req.body);
    if (!parsed.success) badRequest('A name is required for the copy.', req.correlationId);

    const view = await duplicateReport({
      session,
      correlationId: req.correlationId,
      id,
      name: parsed.data.name,
    });
    res.status(201).json(view);
  })().catch(next);
});

const visualBodySchema = z.object({
  academic_year: z.string().min(1),
  as_of: z.string().min(1).optional(),
  chart_overrides: z.record(z.enum(['bar', 'line'])).optional(),
});

customReportsRouter.put('/api/reports/:id/visual', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') badRequest('A report id is required.', req.correlationId);
    const parsed = visualBodySchema.safeParse(req.body);
    if (!parsed.success) badRequest('An academic year is required.', req.correlationId);

    const view = await updateReportVisual({
      session,
      correlationId: req.correlationId,
      id,
      academicYear: parsed.data.academic_year,
      asOfDate: parsed.data.as_of ?? new Date().toISOString().slice(0, 10),
      ...(parsed.data.chart_overrides === undefined ? {} : { chartOverrides: parsed.data.chart_overrides }),
    });
    res.json(view);
  })().catch(next);
});

const sqlBodySchema = z.object({
  queries: z.array(z.object({ key: z.string().min(1), sql: z.string().min(1) })).min(1),
  draft: chartSpecDraftSchema,
});

customReportsRouter.put('/api/reports/:id/sql', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') badRequest('A report id is required.', req.correlationId);
    const parsed = sqlBodySchema.safeParse(req.body);
    if (!parsed.success) badRequest('At least one query and a chart draft are required.', req.correlationId);

    const view = await updateReportSql({
      session,
      correlationId: req.correlationId,
      id,
      queries: parsed.data.queries,
      draft: parsed.data.draft,
    });
    res.json(view);
  })().catch(next);
});

const refineBodySchema = z.object({
  queries: z.array(z.object({ key: z.string().min(1), sql: z.string().min(1) })).min(1),
  draft: chartSpecDraftSchema,
});

/**
 * "Apply" in the Ask AI side panel (docs/06 §1's "✎ Refine with AI") — the
 * SQL tab stays hand-edit-only for `raw_sql` reports (`PUT .../sql` above,
 * unchanged); this endpoint is the AI-authored path, and it alone may
 * materialize a predefined clone (`mode: 'template'`) into literal SQL
 * (`services/custom-reports.ts`'s `applyRefinement`).
 */
customReportsRouter.put('/api/reports/:id/refine', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') badRequest('A report id is required.', req.correlationId);
    const parsed = refineBodySchema.safeParse(req.body);
    if (!parsed.success) badRequest('At least one query and a chart draft are required.', req.correlationId);

    const view = await applyRefinement({
      session,
      correlationId: req.correlationId,
      id,
      queries: parsed.data.queries,
      draft: parsed.data.draft,
    });
    res.json(view);
  })().catch(next);
});

customReportsRouter.get('/api/reports/:id/versions', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') badRequest('A report id is required.', req.correlationId);

    const versions = await listReportVersions({ session, correlationId: req.correlationId, id });
    res.json({
      versions: versions.map((v) => ({ version: v.version, edited_by: v.edited_by, edited_at: v.edited_at })),
    });
  })().catch(next);
});

const rollbackBodySchema = z.object({ version: z.number().int().positive() });

customReportsRouter.post('/api/reports/:id/rollback', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') badRequest('A report id is required.', req.correlationId);
    const parsed = rollbackBodySchema.safeParse(req.body);
    if (!parsed.success) badRequest('A version number is required.', req.correlationId);

    const view = await rollbackReport({ session, correlationId: req.correlationId, id, toVersion: parsed.data.version });
    res.json(view);
  })().catch(next);
});

const visibilityBodySchema = z.object({ shared_flag: z.enum(['private', 'school', 'trust']) });

customReportsRouter.put('/api/reports/:id/visibility', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') badRequest('A report id is required.', req.correlationId);
    const parsed = visibilityBodySchema.safeParse(req.body);
    if (!parsed.success) badRequest('A visibility value is required.', req.correlationId);

    await setReportVisibility({ session, correlationId: req.correlationId, id, sharedFlag: parsed.data.shared_flag });
    res.status(204).end();
  })().catch(next);
});

customReportsRouter.delete('/api/reports/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = sessionOf(req);
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') badRequest('A report id is required.', req.correlationId);

    await deleteReport({ session, correlationId: req.correlationId, id });
    res.status(204).end();
  })().catch(next);
});

customReportsRouter.get(
  '/api/reports/:id/export.pdf',
  (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const session = sessionOf(req);
      const id = req.params['id'];
      if (typeof id !== 'string' || id === '') badRequest('A report id is required.', req.correlationId);
      const includeLogic = req.query['logic'] === '1' || req.query['logic'] === 'true';
      const schoolIds = await resolveRequestedSchools(req);

      const view = await viewReport({ session, correlationId: req.correlationId, id, requestedSchoolIds: schoolIds });
      const scope = await schoolNames(view.spec.meta.scope.map((s) => s.school_id));
      const pdf = await renderReportPdf({
        dashboard: { spec: view.spec, logic: view.logic, degraded: view.degraded, degraded_schools: view.degraded_schools },
        title: view.spec.title,
        orgName: await orgName(session.org_id),
        scopeLine: scope.map((s) => s.school_name).join(' · '),
        includeLogic,
      });

      /**
       * [MANDATORY] docs/08 §7 / CODING_GUIDELINES §13: "Export — user, report,
       * format" is a chokepoint event, same as `routes/report.ts`'s predefined
       * export. Written after a successful render, same reasoning as there: a
       * failed export produced no document.
       */
      await auditSink.write({
        kind: 'report.exported',
        at: new Date().toISOString(),
        actor_sub: session.sub,
        org_id: session.org_id,
        correlation_id: req.correlationId,
        report_id: id,
        school_ids: view.spec.meta.scope.map((s) => s.school_id),
        format: 'pdf',
      });

      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', `attachment; filename="${filename(view.name)}"`);
      res.setHeader('cache-control', 'private, no-store');
      res.end(Buffer.from(pdf));
    })().catch(next);
  },
);

function filename(name: string): string {
  const safe = name.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'report';
  return `${safe}-${new Date().toISOString().slice(0, 10)}.pdf`;
}
