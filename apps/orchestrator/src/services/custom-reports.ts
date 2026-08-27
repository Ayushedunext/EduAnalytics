/**
 * Custom reports — clone-to-edit and AI-saved reports (ADR-018/019).
 *
 * Contract: docs/06 §1 and §3 · AUDIT_REPORT A8 (school_scope semantics) and
 * C17 (re-run semantics), both resolved this session — see the two notes
 * inline below where they bind.
 *
 * -- Two ways a def_json runs, one execution surface for callers -------------
 * `def_json.mode` decides HOW a report executes, independent of `source_kind`
 * (how it was CREATED, which never changes):
 *
 *   'template' — a clone of a predefined report. Executes through the exact
 *   same `run_predefined` vetted path `services/dashboards.ts` uses, with the
 *   clone's OWN stored filter values in place of the request's. Presentation
 *   reuses `BUILDERS`/`Merged` from dashboards.ts unchanged — a cloned
 *   report's chart is the same code path as its original, not a re-derived
 *   copy of it, so the two can never quietly drift apart in how they read the
 *   same rows.
 *
 *   'raw_sql' — an AI-saved report, or any report once its SQL tab has been
 *   used. Executes literal SQL through `run_query`/`run_multi`, guarded by
 *   the exact same AST validator every AI-generated statement passes through
 *   (sql/guard.ts, via the MCP server) — "hand-edited SQL" is not a separate,
 *   weaker path (ADR-019/CODING_GUIDELINES §7).
 *
 * MVP scope, stated rather than silently dropped: the SQL tab is
 * hand-EDITABLE only for reports already in 'raw_sql' mode (AI-saved reports,
 * from the start). A predefined clone's SQL tab is real and shown — the same
 * `:param`-templated statement the Logic panel always displayed — but is
 * read-only; turning a clone into a freely-editable raw statement needs a
 * "materialize current values into literal SQL" step this slice does not
 * build. Editing a clone today means editing its declared FILTER VALUES
 * (updateReportVisual), which is the safe, vetted-SQL-preserving edit surface
 * docs/06 §3 calls the "visual editor".
 */

import { z } from 'zod';
import {
  chartSpecDraftSchema,
  type ChartSpec,
  type ChartSpecDraft,
  type Widget,
} from '@sap/chart-spec';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import type { SessionClaims } from '../auth/session.js';
import { withMcp } from '../mcp/client.js';
import { schoolNames } from '../db/registry.js';
import { cacheGet, cacheKey, cacheSet } from '../cache/result-cache.js';
import { config } from '../config.js';
import { auditSink } from '../db/audit.js';
import {
  BUILDERS,
  Merged,
  REPORT_FILTERS,
  WIDGET_BUCKET_OPTIONS,
  WIDGET_QUERY_KEYS,
  isDashboardId,
  resolveReportParams,
  type DashboardId,
  type PredefinedResult,
  type ReportLogic,
} from './dashboards.js';
import { DASHBOARDS } from './home.js';
import { hydrate, buildAskAiLogic } from './ai-chat.js';
import type { CachedResult } from './ai-tools.js';
import {
  getReportDefinition,
  getVersion,
  insertReportDefinition,
  listReportDefinitions,
  listVersions,
  saveNewVersion,
  setVisibility as setVisibilityRow,
  softDeleteReportDefinition,
  type ReportDefinitionRow,
  type ReportDefinitionVersionRow,
} from '../db/report-definitions.js';

// -- The def_json contract ----------------------------------------------------

const templateDefSchema = z
  .object({
    mode: z.literal('template'),
    base_report_id: z.string().min(1),
    params: z.record(z.union([z.string(), z.number()])),
    /** Presentation-only: swapping a bar for a line (or back) draws the same rows differently. Never a SQL change. */
    chart_overrides: z.record(z.enum(['bar', 'line'])).optional(),
    /**
     * Per-widget clone (docs/06 §3): when set, this definition is a clone of
     * ONE widget from `base_report_id`, not the whole dashboard — the widget
     * id, validated at write time against `WIDGET_QUERY_KEYS` (dashboards.js)
     * so a stored definition can never name a widget the base report does
     * not have.
     */
    widget_scope: z.string().min(1).optional(),
    /** Time-grouping override for `widget_scope`'s query (see catalog.ts's `variants`). Meaningless without `widget_scope`, validated together. */
    bucket: z.enum(['week', 'month', 'quarter', 'year']).optional(),
  })
  .strict();

const rawSqlDefSchema = z
  .object({
    mode: z.literal('raw_sql'),
    /** Literal-valued SELECTs — no placeholders, matching run_query/run_multi's own contract. */
    queries: z.array(z.object({ key: z.string().min(1), sql: z.string().min(1) }).strict()).min(1),
    draft: chartSpecDraftSchema,
  })
  .strict();

const reportDefSchema = z.discriminatedUnion('mode', [templateDefSchema, rawSqlDefSchema]);
type TemplateDef = z.infer<typeof templateDefSchema>;
type RawSqlDef = z.infer<typeof rawSqlDefSchema>;
type ReportDef = z.infer<typeof reportDefSchema>;

/** [MANDATORY] CODING_GUIDELINES §3: our own stored JSON is still parsed, not cast. */
function parseReportDef(raw: unknown, correlationId: string): ReportDef {
  const parsed = reportDefSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlatformError({
      code: ERROR_CODES.INTERNAL,
      message: 'This report definition is corrupted and could not be read.',
      diagnostics: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
      correlationId,
    });
  }
  return parsed.data;
}

// -- Scope (AUDIT_REPORT A8, resolved this session) ---------------------------

/**
 * Effective scope = the definition's stored `school_scope` ∩ the VIEWER's own
 * token scope (already narrowed by `resolveRequestedSchools`) — never the
 * stored scope alone. This is what lets a trust-shared report open correctly
 * for a single-school Principal: they see and query only their one school,
 * never the author's other schools, and the Logic panel below shows exactly
 * this effective set, never the author's original one (avoiding a leak of
 * school names the viewer has no scope to see).
 */
function effectiveScope(
  row: Pick<ReportDefinitionRow, 'school_scope'>,
  requestedSchoolIds: readonly string[],
  correlationId: string,
): string[] {
  const stored = new Set(row.school_scope);
  const effective = requestedSchoolIds.filter((id) => stored.has(id));
  if (effective.length === 0) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'None of the schools this report covers are in your current scope.',
      correlationId,
    });
  }
  return effective;
}

// -- Access control -------------------------------------------------------

function assertVisible(row: ReportDefinitionRow, session: SessionClaims, correlationId: string): void {
  if (row.org_id !== session.org_id) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'That report does not exist.',
      correlationId,
    });
  }
  if (row.owner_sub === session.sub || row.shared_flag !== 'private') return;
  throw new PlatformError({
    code: ERROR_CODES.REPORT_DEFINITION_FORBIDDEN,
    message: 'This report is private to another user.',
    correlationId,
  });
}

function assertOwner(row: ReportDefinitionRow, session: SessionClaims, correlationId: string): void {
  if (row.owner_sub === session.sub) return;
  throw new PlatformError({
    code: ERROR_CODES.REPORT_DEFINITION_FORBIDDEN,
    message: 'Only the owner of this report can make this change.',
    correlationId,
  });
}

/**
 * ADMIN-gated: promoting to school/trust visibility. Uses the existing
 * scalar `role` claim — the full `perms[]` RBAC carrier (AUDIT_REPORT A3/C1)
 * is a separate, larger open item and not a blocker here, since `ADMIN` is
 * already a defined role value (docs/02 §3).
 */
function assertCanPromote(session: SessionClaims, correlationId: string): void {
  if (session.role === 'ADMIN') return;
  throw new PlatformError({
    code: ERROR_CODES.PERMISSION_DENIED,
    message: 'Only an admin can share a report beyond your own view of it.',
    correlationId,
  });
}

// -- Result shape ---------------------------------------------------------

export interface CustomReportSummary {
  readonly id: string;
  readonly name: string;
  readonly source_kind: ReportDefinitionRow['source_kind'];
  readonly base_report_id: string | null;
  /**
   * The base dashboard's DISPLAY title ("Fee Collection"), resolved from the
   * one catalog Home renders from. Sent instead of leaving the SPA to
   * title-case `base_report_id` itself: an id is not a name, and a client that
   * invents one drifts from the catalog the moment a title is reworded
   * (CODING_GUIDELINES §8). `null` for AI-saved reports, which clone nothing.
   */
  readonly base_report_title: string | null;
  /** Resolved names, not ids — the My Reports list shows a Scope column (docs/06 §3). */
  readonly school_scope: readonly { school_id: string; school_name: string }[];
  readonly current_version: number;
  readonly shared_flag: ReportDefinitionRow['shared_flag'];
  readonly is_owner: boolean;
  readonly updated_at: string;
}

/**
 * One thing a NEW custom report can be built from (docs/06 §3's "＋ New custom
 * report"). Deliberately the same predefined dashboards Home already lists,
 * not a second catalog of hand-written source SQL: the real query knowledge
 * lives in the MCP report catalog and the `dashboards.ts` builders, and a
 * parallel table of sources would be that knowledge copied — free to drift,
 * and drifting silently (CODING_GUIDELINES §1).
 *
 * Creating from one of these therefore goes through the SAME `cloneReport`
 * path the dashboard "⧉ Clone & customise" button uses, including its
 * run-once-before-persisting check. "From scratch" here means "without having
 * to go and find the dashboard first", not "by a second mechanism".
 */
export interface ReportSource {
  readonly report_id: string;
  readonly title: string;
  readonly blurb: string;
  readonly icon: string;
  readonly group: 'director' | 'school';
  /** Which filters this source declares — the create form offers exactly these (REPORT_FILTERS). */
  readonly filters: { readonly academic_year: boolean; readonly as_of: boolean };
}

export interface CustomReportView {
  readonly id: string;
  readonly name: string;
  readonly source_kind: ReportDefinitionRow['source_kind'];
  readonly base_report_id: string | null;
  readonly shared_flag: ReportDefinitionRow['shared_flag'];
  readonly mode: ReportDef['mode'];
  readonly current_version: number;
  readonly is_owner: boolean;
  readonly can_promote: boolean;
  readonly spec: ChartSpec;
  readonly logic: ReportLogic;
  readonly degraded: readonly { key: string; message: string }[];
  readonly degraded_schools: readonly { school_id: string; message: string }[];
}

// -- Execution: template mode -----------------------------------------------

interface TemplateRunOutcome {
  readonly spec: ChartSpec;
  readonly logic: ReportLogic;
  readonly degraded: { key: string; message: string }[];
  readonly degraded_schools: { school_id: string; message: string }[];
  readonly sqlText: string;
}

async function runTemplateMode(args: {
  session: SessionClaims;
  correlationId: string;
  reportName: string;
  def: TemplateDef;
  effectiveSchoolIds: readonly string[];
}): Promise<TemplateRunOutcome> {
  const baseId = args.def.base_report_id;
  if (!isDashboardId(baseId)) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'The predefined report this clone was based on no longer exists.',
      correlationId: args.correlationId,
    });
  }
  const baseReportId: DashboardId = baseId;
  const scope = await schoolNames(args.effectiveSchoolIds);

  /**
   * Per-widget clone (docs/06 §3): a `widget_scope` def asks `run_predefined`
   * for only the one query that widget needs (`query_keys`), never the
   * whole report's queries — cheaper, and it also means `BUILDERS` below
   * naturally produces exactly that one widget, since every OTHER widget's
   * `merged.sumBy` call reads a query key that was never fetched.
   */
  const queryKey = args.def.widget_scope === undefined ? undefined : WIDGET_QUERY_KEYS[baseReportId]?.[args.def.widget_scope];
  if (args.def.widget_scope !== undefined && queryKey === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'This chart can no longer be cloned on its own.',
      correlationId: args.correlationId,
    });
  }

  const result = await withMcp(
    args.session,
    args.correlationId,
    args.effectiveSchoolIds,
    async (mcp) =>
      mcp.call<PredefinedResult>('run_predefined', {
        report_id: baseReportId,
        school_ids: [...args.effectiveSchoolIds],
        params: args.def.params,
        ...(queryKey === undefined ? {} : { query_keys: [queryKey] }),
      }),
  );

  const merged = new Merged(result);
  const academicYear = typeof args.def.params['academic_year'] === 'string' ? args.def.params['academic_year'] : '';
  const asOfDate =
    typeof args.def.params['as_of_date'] === 'string' ? args.def.params['as_of_date'] : new Date().toISOString().slice(0, 10);
  const built = BUILDERS[baseReportId](merged, { year: academicYear, asOf: asOfDate, scope });

  const scopedWidgets =
    args.def.widget_scope === undefined ? built.widgets : built.widgets.filter((w) => w.id === args.def.widget_scope);

  if (scopedWidgets.length === 0) {
    throw new PlatformError({
      code: merged.allDenied() ? ERROR_CODES.PERMISSION_DENIED : ERROR_CODES.TENANT_UNAVAILABLE,
      message: merged.allDenied()
        ? 'This session does not have permission to view this report.'
        : 'This report could not be produced for the selected schools right now.',
      correlationId: args.correlationId,
    });
  }

  const widgets: Widget[] = scopedWidgets
    .map((w) => applyChartOverride(w, args.def.chart_overrides))
    .map((w) => (args.def.bucket === undefined ? w : retitleForBucket(w, args.def.bucket)));

  const spec: ChartSpec = {
    spec_version: 1,
    title: args.reportName,
    widgets,
    meta: {
      scope,
      generated_at: new Date().toISOString(),
      as_of: result.as_of,
      served_from: 'replica',
    },
  };

  const { filterChips } = resolveReportParams(baseReportId, { academicYear, asOfDate });
  const definitions = merged.definitions();

  return {
    spec,
    logic: {
      source: result.source,
      scope,
      filters: filterChips,
      group_by: built.groupBy,
      charts: widgets.map((w) => w.type),
      queries: definitions,
      notes: [
        ...built.notes,
        args.def.widget_scope === undefined
          ? `This is your own customised copy of "${result.title}". Edits here never change the original.`
          : `This is your own copy of one chart from "${result.title}". Edits here never change the original dashboard or its other charts.`,
        'Scope is injected from your launch token, intersected with this report’s saved scope. It is shown read-only here and cannot be widened from this screen.',
      ],
    },
    degraded: merged.failures(),
    degraded_schools: merged.schoolFailures(),
    sqlText: definitions.map((d) => `-- ${d.key}: ${d.description}\n${d.sql}`).join('\n\n'),
  };
}

/**
 * bar<->line only (docs above): both share every cartesian field, so the swap is
 * exhaustive and safe. Anything else is returned unchanged.
 *
 * The drill fields travel TOGETHER. `drillable` without `drill_dim` is an
 * invalid widget (spec.ts, `checkWidgetInvariants`), so carrying one across the
 * swap and dropping the other would turn a chart-type override into an
 * unrenderable report. A grouped bar's `series` is deliberately NOT carried:
 * `line.series` is a field name that splits one measure into several lines, and
 * `bar.series` is a list of measures drawn side by side — the same word for two
 * different things, and copying one into the other would produce a line chart
 * split on a column that does not exist.
 */
function applyChartOverride(widget: Widget, overrides: Record<string, 'bar' | 'line'> | undefined): Widget {
  const target = overrides?.[widget.id];
  if (target === undefined || (widget.type !== 'bar' && widget.type !== 'line')) return widget;
  if (widget.type === target) return widget;
  const shared = {
    id: widget.id,
    ...(widget.title === undefined ? {} : { title: widget.title }),
    x: widget.x,
    y: widget.y,
    data: widget.data,
    ...(widget.drillable === undefined ? {} : { drillable: widget.drillable }),
    ...(widget.drill_context === undefined ? {} : { drill_context: widget.drill_context }),
    ...(widget.drill_dim === undefined ? {} : { drill_dim: widget.drill_dim }),
    ...(widget.drill_value_field === undefined
      ? {}
      : { drill_value_field: widget.drill_value_field }),
  };
  return target === 'bar' ? { ...shared, type: 'bar' } : { ...shared, type: 'line' };
}

/**
 * "Receipts by month" -> "Receipts by week" for a bucketed single-widget
 * clone. Every bucketable widget's base title says "by month" (the only
 * grouping a predefined dashboard ever shows), so replacing that word is
 * exhaustive for the widgets `WIDGET_BUCKET_OPTIONS` actually lists — a
 * widget without "month" in its title is not offered a bucket in the first
 * place (services/custom-reports.ts's `cloneReport`).
 */
function retitleForBucket(widget: Widget, bucket: 'week' | 'month' | 'quarter' | 'year'): Widget {
  if (widget.title === undefined || bucket === 'month') return widget;
  return { ...widget, title: widget.title.replace(/\bmonth\b/i, bucket) };
}

// -- Execution: raw_sql mode -------------------------------------------------

interface RawSqlRunOutcome {
  readonly spec: ChartSpec;
  readonly logic: ReportLogic;
  readonly sqlText: string;
}

async function runRawSqlMode(args: {
  session: SessionClaims;
  correlationId: string;
  reportName: string;
  def: RawSqlDef;
  effectiveSchoolIds: readonly string[];
}): Promise<RawSqlRunOutcome> {
  const scope = await schoolNames(args.effectiveSchoolIds);

  const entries = await Promise.all(
    args.def.queries.map(async (q): Promise<[string, CachedResult]> => {
      const [soleSchoolId] = args.effectiveSchoolIds;
      const outcome = await withMcp(args.session, args.correlationId, args.effectiveSchoolIds, async (mcp) =>
        args.effectiveSchoolIds.length === 1 && soleSchoolId !== undefined
          ? mcp.call<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }>('run_query', {
              school_id: soleSchoolId,
              sql: q.sql,
            })
          : mcp.call<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }>('run_multi', {
              school_ids: [...args.effectiveSchoolIds],
              sql: q.sql,
            }),
      );
      return [q.key, { ...outcome, sql: q.sql }];
    }),
  );
  const cache = new Map(entries);

  const spec = hydrate({ ...args.def.draft, title: args.reportName }, cache, scope, args.correlationId);

  return {
    spec,
    logic: buildAskAiLogic(scope, spec, args.def.queries, [
      'This report was saved from an Ask AI answer. Re-run always re-executes this exact statement — it keeps working even if your organisation’s AI key is locked, because nothing here calls the model again.',
      'Scope is injected from your launch token, intersected with this report’s saved scope.',
    ]),
    sqlText: args.def.queries.map((q) => `-- ${q.key}\n${q.sql}`).join('\n\n'),
  };
}

// -- Public operations --------------------------------------------------------

export async function listMyReports(session: SessionClaims): Promise<CustomReportSummary[]> {
  const rows = await listReportDefinitions({ orgId: session.org_id, ownerSub: session.sub });

  /**
   * Scope names come from the registry, and the registry is cached in-process
   * (db/registry.ts), so this is one lookup for the whole list rather than a
   * query per row. A stored `school_scope` id with no registry row — a school
   * decommissioned since the report was saved — simply drops out of the
   * resolved list, the same degradation `schoolNames` applies everywhere else
   * (docs/02 §6: the session degrades for that school, it does not fail).
   */
  const scopes = await Promise.all(rows.map((r) => schoolNames(r.school_scope)));

  return rows.map((r, i) => ({
    id: r.id,
    name: r.name,
    source_kind: r.source_kind,
    base_report_id: r.base_report_id,
    base_report_title: r.base_report_id === null ? null : dashboardTitle(r.base_report_id),
    school_scope: scopes[i] ?? [],
    current_version: r.current_version,
    shared_flag: r.shared_flag,
    is_owner: r.owner_sub === session.sub,
    updated_at: r.updated_at,
  }));
}

/**
 * The base dashboard's display title, from the catalog Home renders.
 *
 * Falls back to the raw id rather than a prettified guess: an id on screen is
 * a worse label and a TRUE one, and it is the visible symptom of a report
 * whose base has been retired from the catalog — which is worth seeing
 * (CODING_GUIDELINES §8).
 */
function dashboardTitle(baseReportId: string): string {
  return DASHBOARDS.find((d) => d.id === baseReportId)?.title ?? baseReportId;
}

/**
 * What a new custom report can be built from — the `available` dashboards,
 * with the filters each one declares.
 *
 * No session gating here beyond what the catalog itself says, and that is not
 * an oversight: this list only names sources. Whether THIS session may
 * actually read one is decided when it runs, by `cloneReport` → the MCP
 * layer's own permission and scope checks (Invariant 2), which is the check
 * that has to hold anyway. Filtering the menu as well would be a second,
 * weaker copy of it.
 */
export function listReportSources(): ReportSource[] {
  return DASHBOARDS.filter((d) => d.status === 'available' && isDashboardId(d.id)).map((d) => {
    const filters = REPORT_FILTERS[d.id as DashboardId];
    return {
      report_id: d.id,
      title: d.title,
      blurb: d.blurb,
      icon: d.icon,
      group: d.group,
      filters: { academic_year: filters.academicYear, as_of: filters.asOf },
    };
  });
}

/**
 * "⧉ Clone" on a row of My Reports — duplicate a custom report the viewer can
 * already see, as a private copy they own.
 *
 * Distinct from `cloneReport` above, which clones a PREDEFINED dashboard and
 * refuses anything else. This one copies a stored definition verbatim
 * (`def_json`, `sql_text`, `school_scope`, and the `source_kind`/
 * `base_report_id` lineage), so the copy keeps executing by exactly the same
 * mode as its original — a raw_sql AI-saved report duplicates into a raw_sql
 * one, a template clone into a template one. Nothing is re-derived, so there
 * is no path here that could turn one mode into the other by accident.
 *
 * The copy is always `private` and always owned by whoever pressed the button,
 * never by the original's owner: duplicating a colleague's shared report must
 * not silently hand them a report they did not make, nor re-publish it to the
 * org at the original's visibility (docs/08 blast-radius).
 */
export async function duplicateReport(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
  name: string;
}): Promise<CustomReportView> {
  const row = await getRowOrThrow(args.id, args.correlationId);
  /**
   * Visible, not owned: you may duplicate a report shared with you. This is
   * the same visibility gate `viewReport` applies, deliberately NOT the
   * stricter `assertOwner` the edit paths use — copying what you are already
   * allowed to read grants no access you did not have.
   */
  assertVisible(row, args.session, args.correlationId);

  const def = parseReportDef(row.def_json, args.correlationId);
  const created = await insertReportDefinition({
    orgId: args.session.org_id,
    ownerSub: args.session.sub,
    name: args.name,
    baseReportId: row.base_report_id,
    sourceKind: row.source_kind,
    schoolScope: row.school_scope,
    defJson: def,
    sqlText: row.sql_text,
  });

  await auditSink.write({
    kind: 'report_definition.changed',
    at: new Date().toISOString(),
    actor_sub: args.session.sub,
    org_id: args.session.org_id,
    correlation_id: args.correlationId,
    report_id: created.id,
    school_ids: created.school_scope,
    action: 'duplicated',
    /** The row this was copied FROM — without it the trail cannot answer where a copy came from. */
    base_report_id: args.id,
    version: 1,
  });

  return viewReport({
    session: args.session,
    correlationId: args.correlationId,
    id: created.id,
    requestedSchoolIds: created.school_scope,
  });
}

export async function cloneReport(args: {
  session: SessionClaims;
  correlationId: string;
  baseReportId: string;
  name: string;
  schoolIds: readonly string[];
  academicYear: string;
  asOfDate: string;
  /** Per-widget clone (docs/06 §3): clone just this one widget id, not the whole dashboard. */
  widgetScope?: string;
  /** Time-grouping override — only valid together with `widgetScope`, and only for a widget that declares options. */
  bucket?: 'week' | 'month' | 'quarter' | 'year';
}): Promise<CustomReportView> {
  if (!isDashboardId(args.baseReportId)) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_NOT_FOUND,
      message: 'That report cannot be cloned.',
      correlationId: args.correlationId,
    });
  }
  if (args.widgetScope !== undefined && WIDGET_QUERY_KEYS[args.baseReportId]?.[args.widgetScope] === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_NOT_FOUND,
      message: 'That chart cannot be cloned on its own.',
      correlationId: args.correlationId,
    });
  }
  if (
    args.bucket !== undefined &&
    (args.widgetScope === undefined ||
      !(WIDGET_BUCKET_OPTIONS[args.baseReportId]?.[args.widgetScope] ?? []).includes(args.bucket))
  ) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'This chart does not support that time grouping.',
      correlationId: args.correlationId,
    });
  }
  const { params } = resolveReportParams(args.baseReportId, {
    academicYear: args.academicYear,
    asOfDate: args.asOfDate,
  });
  const def: TemplateDef = {
    mode: 'template',
    base_report_id: args.baseReportId,
    params: { ...params, ...(args.bucket === undefined ? {} : { bucket: args.bucket }) },
    ...(args.widgetScope === undefined ? {} : { widget_scope: args.widgetScope }),
    ...(args.bucket === undefined ? {} : { bucket: args.bucket }),
  };

  // Runs it once so the save fails loudly if the filter values do not work,
  // rather than persisting a clone nobody can open (§10: fail loud).
  const run = await runTemplateMode({
    session: args.session,
    correlationId: args.correlationId,
    reportName: args.name,
    def,
    effectiveSchoolIds: args.schoolIds,
  });

  const row = await insertReportDefinition({
    orgId: args.session.org_id,
    ownerSub: args.session.sub,
    name: args.name,
    baseReportId: args.baseReportId,
    sourceKind: 'predefined_clone',
    schoolScope: args.schoolIds,
    defJson: def,
    sqlText: run.sqlText,
  });

  await auditSink.write({
    kind: 'report_definition.changed',
    at: new Date().toISOString(),
    actor_sub: args.session.sub,
    org_id: args.session.org_id,
    correlation_id: args.correlationId,
    report_id: row.id,
    school_ids: args.schoolIds,
    action: 'cloned',
    base_report_id: args.baseReportId,
    version: 1,
  });

  return toView(row, def, run, args.session);
}

export async function saveAiReport(args: {
  session: SessionClaims;
  correlationId: string;
  name: string;
  schoolIds: readonly string[];
  queries: readonly { key: string; sql: string }[];
  draft: ChartSpecDraft;
}): Promise<CustomReportView> {
  const def: RawSqlDef = { mode: 'raw_sql', queries: [...args.queries], draft: args.draft };
  const run = await runRawSqlMode({
    session: args.session,
    correlationId: args.correlationId,
    reportName: args.name,
    def,
    effectiveSchoolIds: args.schoolIds,
  });

  const row = await insertReportDefinition({
    orgId: args.session.org_id,
    ownerSub: args.session.sub,
    name: args.name,
    baseReportId: null,
    sourceKind: 'ai_saved',
    schoolScope: args.schoolIds,
    defJson: def,
    sqlText: run.sqlText,
  });

  await auditSink.write({
    kind: 'report_definition.changed',
    at: new Date().toISOString(),
    actor_sub: args.session.sub,
    org_id: args.session.org_id,
    correlation_id: args.correlationId,
    report_id: row.id,
    school_ids: args.schoolIds,
    action: 'saved_from_ai',
    version: 1,
  });

  return {
    id: row.id,
    name: row.name,
    source_kind: row.source_kind,
    base_report_id: row.base_report_id,
    shared_flag: row.shared_flag,
    mode: def.mode,
    current_version: row.current_version,
    is_owner: true,
    can_promote: args.session.role === 'ADMIN',
    spec: run.spec,
    logic: run.logic,
    degraded: [],
    degraded_schools: [],
  };
}

interface ViewOutcome {
  readonly spec: ChartSpec;
  readonly logic: ReportLogic;
  readonly degraded: { key: string; message: string }[];
  readonly degraded_schools: { school_id: string; message: string }[];
}

export async function viewReport(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
  requestedSchoolIds: readonly string[];
}): Promise<CustomReportView> {
  const row = await getRowOrThrow(args.id, args.correlationId);
  assertVisible(row, args.session, args.correlationId);
  const def = parseReportDef(row.def_json, args.correlationId);
  const effective = effectiveScope(row, args.requestedSchoolIds, args.correlationId);

  const key = cacheKey({
    kind: `report:custom:${row.id}:${String(row.current_version)}`,
    schoolIds: effective,
    permissionClass: args.session.permission_class,
    filters: def.mode === 'template' ? def.params : {},
  });
  const hit = await cacheGet<ViewOutcome>(key);

  let outcome: ViewOutcome;
  if (hit !== null) {
    /**
     * Deliberately NOT stale-while-revalidate, unlike the predefined dashboards
     * and the Home summary (cache/result-cache.ts).
     *
     * This function writes a `report.viewed` audit row below, and the refresh
     * hook takes a closure that re-enters its caller — so refreshing here would
     * record a view that nobody made, in the one table whose value is that it
     * says what actually happened (docs/08 §7, CODING_GUIDELINES §125). Splitting
     * the read out from the audit write to make it eligible is a reasonable
     * change; doing it silently as part of a performance pass is not. The
     * predefined path has no such problem because `buildDashboard` and
     * `buildHomeSummary` write no audit at all — their `report.viewed` rows are
     * written a layer up, in routes/report.ts, which the refresh never re-enters.
     *
     * These entries still get the LONGER retention every entry now has, so this
     * is no worse than before; it simply does not get the extra win.
     */
    outcome = {
      ...hit.value,
      spec: { ...hit.value.spec, meta: { ...hit.value.spec.meta, served_from: 'cache' } },
    };
  } else if (def.mode === 'template') {
    const run = await runTemplateMode({
      session: args.session,
      correlationId: args.correlationId,
      reportName: row.name,
      def,
      effectiveSchoolIds: effective,
    });
    outcome = { spec: run.spec, logic: run.logic, degraded: run.degraded, degraded_schools: run.degraded_schools };
    if (outcome.degraded.length === 0 && outcome.degraded_schools.length === 0) {
      await cacheSet(key, outcome, config.CACHE_TTL_SECONDS);
    }
  } else {
    const run = await runRawSqlMode({
      session: args.session,
      correlationId: args.correlationId,
      reportName: row.name,
      def,
      effectiveSchoolIds: effective,
    });
    outcome = { spec: run.spec, logic: run.logic, degraded: [], degraded_schools: [] };
    await cacheSet(key, outcome, config.CACHE_TTL_SECONDS);
  }

  await auditSink.write({
    kind: 'report.viewed',
    at: new Date().toISOString(),
    actor_sub: args.session.sub,
    org_id: args.session.org_id,
    correlation_id: args.correlationId,
    report_id: row.id,
    school_ids: effective,
    filters: def.mode === 'template' ? def.params : {},
  });

  return {
    id: row.id,
    name: row.name,
    source_kind: row.source_kind,
    base_report_id: row.base_report_id,
    shared_flag: row.shared_flag,
    mode: def.mode,
    current_version: row.current_version,
    is_owner: row.owner_sub === args.session.sub,
    can_promote: args.session.role === 'ADMIN',
    ...outcome,
  };
}

export async function updateReportVisual(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
  academicYear: string;
  asOfDate: string;
  chartOverrides?: Record<string, 'bar' | 'line'>;
}): Promise<CustomReportView> {
  const row = await getRowOrThrow(args.id, args.correlationId);
  assertOwner(row, args.session, args.correlationId);
  const existing = parseReportDef(row.def_json, args.correlationId);
  if (existing.mode !== 'template') {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'This report’s SQL was hand-edited; change it from the SQL tab instead.',
      correlationId: args.correlationId,
    });
  }

  const existingBaseId = existing.base_report_id;
  if (!isDashboardId(existingBaseId)) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'The predefined report this clone was based on no longer exists.',
      correlationId: args.correlationId,
    });
  }

  /**
   * Params are RE-DERIVED here from (academic year, as-of date), never
   * accepted as a raw bag from the client — the same reasoning `cloneReport`
   * already follows. A client-supplied params object could name a filter the
   * base report never declared, or omit one `run_predefined` requires; going
   * through `resolveReportParams` keeps the derivation logic (including the
   * academic-year date window) in exactly one place.
   */
  const { params } = resolveReportParams(existingBaseId, {
    academicYear: args.academicYear,
    asOfDate: args.asOfDate,
  });
  /**
   * A widget-scoped clone (docs/06 §3) stays widget-scoped across an academic
   * -year/as-of edit — this endpoint only ever changes filter VALUES, never
   * what the clone is a clone OF. `bucket` rides back into `params` the same
   * way `cloneReport` puts it there, since `resolveReportParams` only knows
   * about the filters every report declares, not this widget-only one.
   */
  const next: TemplateDef = {
    mode: 'template',
    base_report_id: existingBaseId,
    params: { ...params, ...(existing.bucket === undefined ? {} : { bucket: existing.bucket }) },
    ...(args.chartOverrides === undefined ? {} : { chart_overrides: args.chartOverrides }),
    ...(existing.widget_scope === undefined ? {} : { widget_scope: existing.widget_scope }),
    ...(existing.bucket === undefined ? {} : { bucket: existing.bucket }),
  };

  const run = await runTemplateMode({
    session: args.session,
    correlationId: args.correlationId,
    reportName: row.name,
    def: next,
    effectiveSchoolIds: row.school_scope,
  });

  const updated = await saveNewVersion({
    id: row.id,
    defJson: next,
    sqlText: run.sqlText,
    editedBy: args.session.sub,
  });

  await auditSink.write({
    kind: 'report_definition.changed',
    at: new Date().toISOString(),
    actor_sub: args.session.sub,
    org_id: args.session.org_id,
    correlation_id: args.correlationId,
    report_id: row.id,
    school_ids: row.school_scope,
    action: 'updated_visual',
    version: updated.current_version,
  });

  return toView(updated, next, run, args.session);
}

export async function updateReportSql(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
  queries: readonly { key: string; sql: string }[];
  draft: ChartSpecDraft;
}): Promise<CustomReportView> {
  const row = await getRowOrThrow(args.id, args.correlationId);
  assertOwner(row, args.session, args.correlationId);
  const existing = parseReportDef(row.def_json, args.correlationId);
  if (existing.mode !== 'raw_sql') {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message:
        'Hand-editing SQL is available for AI-saved reports today. A predefined clone’s filters are edited from the visual editor.',
      correlationId: args.correlationId,
    });
  }

  const next: RawSqlDef = { mode: 'raw_sql', queries: [...args.queries], draft: args.draft };
  const run = await runRawSqlMode({
    session: args.session,
    correlationId: args.correlationId,
    reportName: row.name,
    def: next,
    effectiveSchoolIds: row.school_scope,
  });

  const updated = await saveNewVersion({
    id: row.id,
    defJson: next,
    sqlText: run.sqlText,
    editedBy: args.session.sub,
  });

  await auditSink.write({
    kind: 'report_definition.changed',
    at: new Date().toISOString(),
    actor_sub: args.session.sub,
    org_id: args.session.org_id,
    correlation_id: args.correlationId,
    report_id: row.id,
    school_ids: row.school_scope,
    action: 'updated_sql',
    version: updated.current_version,
  });

  return {
    id: updated.id,
    name: updated.name,
    source_kind: updated.source_kind,
    base_report_id: updated.base_report_id,
    shared_flag: updated.shared_flag,
    mode: next.mode,
    current_version: updated.current_version,
    is_owner: true,
    can_promote: args.session.role === 'ADMIN',
    spec: run.spec,
    logic: run.logic,
    degraded: [],
    degraded_schools: [],
  };
}

// -- ✎ Refine with AI (docs/06 §1, ADR-033's explicitly-deferred action) -----

export interface RefineContext {
  readonly reportName: string;
  readonly schoolIds: readonly string[];
  readonly queries: readonly { key: string; sql: string }[];
  readonly widgets: readonly Widget[];
}

/**
 * What `routes/ai.ts` seeds a Refine turn with — the report's CURRENT
 * answer, freshly re-run (never a stale cached copy handed to the model as
 * fact). Owner-only: only the owner can later `applyRefinement`, and
 * spending the org's AI budget refining a report you cannot save changes
 * to would be a confusing dead end, not a real capability.
 */
export async function getRefineContext(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
  requestedSchoolIds: readonly string[];
}): Promise<RefineContext> {
  const row = await getRowOrThrow(args.id, args.correlationId);
  assertOwner(row, args.session, args.correlationId);
  const view = await viewReport({
    session: args.session,
    correlationId: args.correlationId,
    id: args.id,
    requestedSchoolIds: args.requestedSchoolIds,
  });
  return {
    reportName: view.name,
    schoolIds: view.spec.meta.scope.map((s) => s.school_id),
    queries: view.logic.queries.map((q) => ({ key: q.key, sql: q.sql })),
    widgets: view.spec.widgets,
  };
}

/**
 * Persists an AI-proposed answer as the report's next version — "Apply" in
 * the Ask AI side panel. Unlike `updateReportSql`, this accepts a report
 * currently in EITHER mode: an AI-proposed answer is always literal SQL
 * (`run_query`/`run_multi` accept no placeholders at all), so applying one
 * IS the "materialize a predefined clone into literal SQL" step docs/06 §1
 * named as unbuilt — built here, scoped tightly to a statement the guard
 * already validated when the model ran it during the turn that produced it.
 * `updateReportSql`'s own mode restriction is untouched: hand-typing SQL
 * into the SQL tab still cannot do this, on purpose (docs/06 §1's MVP-scope
 * note) — only an AI-authored statement can cross that line, through this
 * function alone.
 */
export async function applyRefinement(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
  queries: readonly { key: string; sql: string }[];
  draft: ChartSpecDraft;
}): Promise<CustomReportView> {
  const row = await getRowOrThrow(args.id, args.correlationId);
  assertOwner(row, args.session, args.correlationId);

  const next: RawSqlDef = { mode: 'raw_sql', queries: [...args.queries], draft: args.draft };
  const run = await runRawSqlMode({
    session: args.session,
    correlationId: args.correlationId,
    reportName: row.name,
    def: next,
    effectiveSchoolIds: row.school_scope,
  });

  const updated = await saveNewVersion({
    id: row.id,
    defJson: next,
    sqlText: run.sqlText,
    editedBy: args.session.sub,
  });

  await auditSink.write({
    kind: 'report_definition.changed',
    at: new Date().toISOString(),
    actor_sub: args.session.sub,
    org_id: args.session.org_id,
    correlation_id: args.correlationId,
    report_id: row.id,
    school_ids: row.school_scope,
    action: 'refined_with_ai',
    version: updated.current_version,
  });

  return {
    id: updated.id,
    name: updated.name,
    source_kind: updated.source_kind,
    base_report_id: updated.base_report_id,
    shared_flag: updated.shared_flag,
    mode: next.mode,
    current_version: updated.current_version,
    is_owner: true,
    can_promote: args.session.role === 'ADMIN',
    spec: run.spec,
    logic: run.logic,
    degraded: [],
    degraded_schools: [],
  };
}

export async function listReportVersions(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
}): Promise<ReportDefinitionVersionRow[]> {
  const row = await getRowOrThrow(args.id, args.correlationId);
  assertVisible(row, args.session, args.correlationId);
  return listVersions(row.id);
}

export async function rollbackReport(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
  toVersion: number;
}): Promise<CustomReportView> {
  const row = await getRowOrThrow(args.id, args.correlationId);
  assertOwner(row, args.session, args.correlationId);
  const target = await getVersion(row.id, args.toVersion);
  if (target === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_VERSION_NOT_FOUND,
      message: 'That version no longer exists.',
      correlationId: args.correlationId,
    });
  }
  const def = parseReportDef(target.def_json, args.correlationId);

  const updated = await saveNewVersion({
    id: row.id,
    defJson: def,
    sqlText: target.sql_text,
    editedBy: args.session.sub,
  });

  await auditSink.write({
    kind: 'report_definition.changed',
    at: new Date().toISOString(),
    actor_sub: args.session.sub,
    org_id: args.session.org_id,
    correlation_id: args.correlationId,
    report_id: row.id,
    school_ids: row.school_scope,
    action: 'rolled_back',
    version: updated.current_version,
  });

  return viewReport({
    session: args.session,
    correlationId: args.correlationId,
    id: row.id,
    requestedSchoolIds: row.school_scope,
  });
}

export async function setReportVisibility(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
  sharedFlag: 'private' | 'school' | 'trust';
}): Promise<void> {
  const row = await getRowOrThrow(args.id, args.correlationId);
  assertOwner(row, args.session, args.correlationId);
  if (args.sharedFlag !== 'private') assertCanPromote(args.session, args.correlationId);

  await setVisibilityRow(row.id, args.sharedFlag);

  /** docs/08 §7 already names this subject (config.changed). */
  await auditSink.write({
    kind: 'config.changed',
    at: new Date().toISOString(),
    actor_sub: args.session.sub,
    org_id: args.session.org_id,
    correlation_id: args.correlationId,
    subject: 'report_visibility',
    action: `set to ${args.sharedFlag}`,
    summary: `"${row.name}" is now ${args.sharedFlag}`,
  });
}

export async function deleteReport(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
}): Promise<void> {
  const row = await getRowOrThrow(args.id, args.correlationId);
  assertOwner(row, args.session, args.correlationId);
  if (row.shared_flag !== 'private') {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Make this report private again before deleting it.',
      correlationId: args.correlationId,
    });
  }

  await softDeleteReportDefinition(row.id);

  await auditSink.write({
    kind: 'report_definition.changed',
    at: new Date().toISOString(),
    actor_sub: args.session.sub,
    org_id: args.session.org_id,
    correlation_id: args.correlationId,
    report_id: row.id,
    school_ids: row.school_scope,
    action: 'deleted',
    version: row.current_version,
  });
}

// -- Shared helpers -------------------------------------------------------

async function getRowOrThrow(id: string, correlationId: string): Promise<ReportDefinitionRow> {
  const row = await getReportDefinition(id);
  if (row === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'That report does not exist.',
      correlationId,
    });
  }
  return row;
}

function toView(
  row: ReportDefinitionRow,
  def: ReportDef,
  run: { spec: ChartSpec; logic: ReportLogic; degraded?: { key: string; message: string }[]; degraded_schools?: { school_id: string; message: string }[] },
  session: SessionClaims,
): CustomReportView {
  return {
    id: row.id,
    name: row.name,
    source_kind: row.source_kind,
    base_report_id: row.base_report_id,
    shared_flag: row.shared_flag,
    mode: def.mode,
    current_version: row.current_version,
    is_owner: row.owner_sub === session.sub,
    can_promote: session.role === 'ADMIN',
    spec: run.spec,
    logic: run.logic,
    degraded: run.degraded ?? [],
    degraded_schools: run.degraded_schools ?? [],
  };
}
