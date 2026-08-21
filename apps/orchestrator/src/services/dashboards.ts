/**
 * Predefined dashboards — the deterministic serving path.
 *
 * Contract source: docs/06 §2 (predefined catalog; vetted parameterised SQL,
 * zero AI tokens) · ADR-016 (predefined and AI are separate paths) · ADR-015
 * (the answer leaves here as chart-spec) · ADR-019 / Invariant 6 (every report
 * exposes its definition and its SQL).
 *
 * -- The split with the MCP server -------------------------------------------
 * The MCP server owns the SQL (apps/mcp-server/src/reports/catalog.ts): a caller
 * names a report and filter values and cannot supply a statement. This module
 * owns PRESENTATION — which result set becomes which widget, what the panel is
 * called, which chips the logic panel shows. Neither half can do the other's
 * job, which is the point: a presentation bug cannot become a data-access bug.
 *
 * -- Merging across schools ---------------------------------------------------
 * A Director may select several schools. Each returns its own result sets, and
 * they are summed here by their grouping key. This is honest for counts and
 * amounts, which is all these dashboards show; it would NOT be honest for
 * averages or percentages, and none are computed by summation here for exactly
 * that reason. Cross-school aggregation proper is the Rollup Store's job
 * (ADR-010) — this is the fan-out fallback ADR-011 describes, and it is capped
 * at 25 schools by the MCP layer.
 */

import { chartSpecSchema, type ChartSpec, type Widget } from '@sap/chart-spec';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import type { SessionClaims } from '../auth/session.js';
import { withMcp } from '../mcp/client.js';
import { schoolNames } from '../db/registry.js';
import { cacheGet, cacheKey, cacheSet } from '../cache/result-cache.js';
import { config } from '../config.js';

/** What `run_predefined` returns. Parsed, never trusted as a domain type (§3). */
interface PredefinedResult {
  report_id: string;
  title: string;
  source: string;
  params: Record<string, unknown>;
  as_of: string;
  schools: {
    school_id: string;
    status: 'ok' | 'failed';
    error?: { code: string; message: string };
    queries?: {
      key: string;
      description: string;
      sql: string;
      status: 'ok' | 'failed';
      columns?: string[];
      rows?: Record<string, unknown>[];
      truncated?: boolean;
      masked_columns?: string[];
      error?: { code: string; message: string };
    }[];
  }[];
}

/** docs/06 §3: the Logic panel's contents. Invariant 6 makes this mandatory. */
export interface ReportLogic {
  readonly source: string;
  readonly scope: readonly { school_id: string; school_name: string }[];
  readonly filters: readonly { label: string; value: string }[];
  readonly group_by: readonly string[];
  readonly charts: readonly string[];
  readonly queries: readonly { key: string; description: string; sql: string }[];
  /** Stated on screen, not just true in the code (docs/06 §3). */
  readonly notes: readonly string[];
}

export interface DashboardResult {
  readonly spec: ChartSpec;
  readonly logic: ReportLogic;
  /** Panels that failed while others succeeded. Named, never blank (ADR-011). */
  readonly degraded: readonly { key: string; message: string }[];
  readonly degraded_schools: readonly { school_id: string; message: string }[];
}

export const DASHBOARD_IDS = [
  'enrollment-overview',
  'fee-collection',
  'fee-defaulters',
  'staff-overview',
  'admissions-funnel',
] as const;
export type DashboardId = (typeof DASHBOARD_IDS)[number];

export function isDashboardId(value: string): value is DashboardId {
  return (DASHBOARD_IDS as readonly string[]).includes(value);
}

/**
 * Which filters each report takes.
 *
 * A report is refused outright if it is handed a filter it does not declare
 * (mcp-server/src/tools/run-predefined.ts), and that refusal is deliberate: a
 * silently ignored filter would show a pill on screen that narrows nothing. So
 * the caller has to know which filters apply, and the honest reason they differ
 * is in the data — `employees_data_set` has no academic year at all, because
 * staff are not enrolled in one.
 *
 * Keyed by report id so adding a report is a table entry, not a new branch
 * (docs/11 §1: the catalog is data, not screens).
 */
const REPORT_FILTERS: Record<DashboardId, { academicYear: boolean; asOf: boolean }> = {
  'enrollment-overview': { academicYear: true, asOf: false },
  'fee-collection': { academicYear: true, asOf: false },
  'fee-defaulters': { academicYear: true, asOf: true },
  'staff-overview': { academicYear: false, asOf: true },
  'admissions-funnel': { academicYear: true, asOf: false },
};

/** Everything a builder is allowed to know about the request it is answering. */
interface BuildContext {
  readonly year: string;
  readonly asOf: string;
  readonly scope: readonly { school_id: string; school_name: string }[];
}

export async function buildDashboard(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  reportId: DashboardId;
  academicYear: string;
  /** The date "overdue" and "on roll" are measured against (YYYY-MM-DD). */
  asOfDate: string;
  correlationId: string;
}): Promise<DashboardResult> {
  const scope = await schoolNames(args.schoolIds);
  if (scope.length === 0) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'None of the selected schools are available for analytics right now.',
      correlationId: args.correlationId,
    });
  }

  const filters = REPORT_FILTERS[args.reportId];
  const params: Record<string, string> = {};
  if (filters.academicYear) params['academic_year'] = args.academicYear;
  if (filters.asOf) params['as_of_date'] = args.asOfDate;

  /**
   * Tier ① (docs/09 §4). The key carries the school set, the bound filters AND
   * the session's permission class — [MANDATORY] docs/08 §5, because masking is
   * role-dependent and a key without it would serve a Principal's unmasked
   * defaulter list to an accountant.
   */
  const key = cacheKey({
    kind: `report:${args.reportId}`,
    schoolIds: args.schoolIds,
    permissionClass: args.session.permission_class,
    filters: params,
  });

  const hit = await cacheGet<DashboardResult>(key);
  if (hit !== null) {
    /**
     * The spec says where the answer came from, and on a hit that is the cache
     * — ADR-028's three tiers are only honest if the label changes with them.
     * `as_of` is deliberately NOT refreshed: the data really is from the moment
     * of the underlying read, and docs/03 assumption 2 accepts replica lag only
     * on condition that it is labelled.
     */
    return { ...hit, spec: { ...hit.spec, meta: { ...hit.spec.meta, served_from: 'cache' } } };
  }

  const result = await withMcp(args.session, args.correlationId, args.schoolIds, async (mcp) =>
    mcp.call<PredefinedResult>('run_predefined', {
      report_id: args.reportId,
      school_ids: [...args.schoolIds],
      params,
    }),
  );

  const merged = new Merged(result);
  const context: BuildContext = { year: args.academicYear, asOf: args.asOfDate, scope };

  const built = BUILDERS[args.reportId](merged, context);

  /**
   * A dashboard where nothing could be read is a failure, not an empty report.
   * Rendering an empty page here would show a school as having no students at
   * all — the success-shaped failure CODING_GUIDELINES §10 warns about, and the
   * exact bug this codebase already shipped once on the Home summary.
   */
  if (built.widgets.length === 0) {
    throw new PlatformError({
      code: merged.allDenied()
        ? ERROR_CODES.PERMISSION_DENIED
        : ERROR_CODES.TENANT_UNAVAILABLE,
      message: merged.allDenied()
        ? 'This session does not have permission to view this report.'
        : 'This report could not be produced for the selected schools right now.',
      diagnostics: { report_id: args.reportId, failures: merged.failures() },
      correlationId: args.correlationId,
    });
  }

  const spec: ChartSpec = {
    spec_version: 1,
    title: result.title,
    widgets: built.widgets,
    meta: {
      scope,
      generated_at: new Date().toISOString(),
      as_of: result.as_of,
      /** Three tiers exist (ADR-028); only the replica is built, so say so. */
      served_from: 'replica',
      report_id: result.report_id,
    },
  };

  const parsed = chartSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new PlatformError({
      code: ERROR_CODES.INVALID_CHART_SPEC,
      message: 'The dashboard could not be rendered.',
      diagnostics: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
      correlationId: args.correlationId,
    });
  }

  const outcome: DashboardResult = {
    spec: parsed.data,
    logic: {
      source: result.source,
      scope,
      /**
       * The filters shown are the ones actually BOUND, not the ones the screen
       * happens to have a control for. A pill claiming "AY 2026-27" on a report
       * that never filtered by year is a lie the logic panel exists to prevent
       * (Invariant 6).
       */
      filters: [
        ...(filters.academicYear ? [{ label: 'Academic year', value: args.academicYear }] : []),
        ...(filters.asOf ? [{ label: 'As of', value: args.asOfDate }] : []),
      ],
      group_by: built.groupBy,
      charts: built.widgets.map((w) => w.type),
      queries: merged.definitions(),
      notes: [
        ...built.notes,
        'Scope is injected from your launch token. It is shown read-only here and cannot be widened from this screen.',
        'Every statement runs SELECT-only on a read replica, is capped at 5,000 rows and 10 seconds, and is recorded in the audit trail.',
        'The tenant filter and the row cap are added by the server; they are not part of the statement above.',
      ],
    },
    degraded: merged.failures(),
    degraded_schools: merged.schoolFailures(),
  };

  /**
   * Only a COMPLETE answer is cached.
   *
   * A dashboard where one panel timed out or one school was unreachable is
   * correct to render (ADR-011) and wrong to keep: caching it would freeze a
   * transient failure for the whole TTL, so a school that came back thirty
   * seconds later would still be reported as unreachable to everyone who asks
   * for the next ten minutes. Partial answers stay cheap to retry.
   */
  if (outcome.degraded.length === 0 && outcome.degraded_schools.length === 0) {
    await cacheSet(key, outcome, config.CACHE_TTL_SECONDS);
  }

  return outcome;
}

// -- Dashboards ---------------------------------------------------------------

interface DashboardBuild {
  widgets: Widget[];
  groupBy: string[];
  notes: string[];
}

/**
 * One builder per report, resolved from the id.
 *
 * A map rather than a chain of `if`s because docs/11 §1 is explicit that "the
 * dashboard catalog is implemented as a registry from the first dashboard, not
 * retrofitted after the fourth" — adding Attendance when its table lands should
 * be a catalog entry plus an entry here, and nothing else.
 */
const BUILDERS: Record<DashboardId, (merged: Merged, ctx: BuildContext) => DashboardBuild> = {
  'enrollment-overview': buildEnrollment,
  'fee-collection': buildFeeCollection,
  'fee-defaulters': buildFeeDefaulters,
  'staff-overview': buildStaffOverview,
  'admissions-funnel': buildAdmissionsFunnel,
};

function buildEnrollment(merged: Merged, { year }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];

  const byClass = merged.sumBy('by_class', 'classname', ['students'], 'seq');
  const byGender = merged.sumBy('by_gender', 'gender', ['students']);
  const byCategory = merged.sumBy('by_category', 'category', ['students']);
  const bySection = merged.sumBy('by_section', 'classname|sectionname', ['students'], 'seq');

  const total = byClass.reduce((sum, row) => sum + num(row['students']), 0);
  if (byClass.length > 0) {
    widgets.push({
      id: 'kpi-total',
      type: 'kpi',
      label: `Students on roll · ${year}`,
      value: count(total),
      tone: 'neutral',
    });
  }

  const girls = byGender.find((r) => String(r['gender']).toLowerCase().startsWith('girl'));
  const boys = byGender.find((r) => String(r['gender']).toLowerCase().startsWith('boy'));
  if (girls !== undefined && boys !== undefined) {
    const g = num(girls['students']);
    const b = num(boys['students']);
    widgets.push({
      id: 'kpi-ratio',
      type: 'kpi',
      label: 'Girls : Boys',
      value: `${count(g)} : ${count(b)}`,
      tone: 'neutral',
    });
  }

  if (byClass.length > 0) {
    widgets.push({
      id: 'bar-class',
      type: 'bar',
      title: 'Strength by class',
      x: 'classname',
      y: 'students',
      data: byClass.map((r) => ({ classname: String(r['classname']), students: num(r['students']) })),
    });
  }

  if (byGender.length > 0) {
    widgets.push({
      id: 'donut-gender',
      type: 'donut',
      title: 'Gender mix',
      label_field: 'gender',
      value_field: 'students',
      data: byGender.map((r) => ({ gender: String(r['gender']), students: num(r['students']) })),
    });
  }

  if (byCategory.length > 0) {
    widgets.push({
      id: 'donut-category',
      type: 'donut',
      title: 'Category mix',
      label_field: 'category',
      value_field: 'students',
      data: byCategory.map((r) => ({
        category: label(r['category']),
        students: num(r['students']),
      })),
    });
  }

  if (bySection.length > 0) {
    widgets.push({
      id: 'table-section',
      type: 'table',
      title: 'Class and section',
      columns: [
        { field: 'classname', label: 'Class' },
        { field: 'sectionname', label: 'Section' },
        { field: 'students', label: 'Students', align: 'right' },
      ],
      rows: bySection.map((r) => ({
        classname: String(r['classname']),
        sectionname: label(r['sectionname']),
        students: num(r['students']),
      })),
    });
  }

  return { widgets, groupBy: ['class', 'section', 'gender', 'category'], notes: [] };
}

function buildFeeCollection(merged: Merged, { year }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];

  const byMonth = merged.sumBy('by_month', 'fee_month', ['collected'], 'mo');
  const byClass = merged.sumBy('by_class', 'classname', ['collected'], 'seq');
  const byMode = merged.sumBy('by_mode', 'paymenttype', ['collected']);
  const byComponent = merged.sumBy('by_component', 'componentname', ['payable', 'paid', 'balance']);

  if (byComponent.length > 0) {
    /**
     * Totals are the column sums of the fee-head breakdown, not a separate
     * query. Same table, same filter, so the numbers are identical — and on a
     * table with no usable index, the second scan they would have cost is
     * measured in seconds (apps/mcp-server/src/reports/catalog.ts).
     */
    const payable = byComponent.reduce((t, r) => t + num(r['payable']), 0);
    const paid = byComponent.reduce((t, r) => t + num(r['paid']), 0);
    const balance = byComponent.reduce((t, r) => t + num(r['balance']), 0);
    widgets.push(
      {
        id: 'kpi-paid',
        type: 'kpi',
        label: `Realised · ${year}`,
        value: rupees(paid),
        tone: 'positive',
      },
      { id: 'kpi-payable', type: 'kpi', label: 'Demand raised', value: rupees(payable), tone: 'neutral' },
      {
        id: 'kpi-balance',
        type: 'kpi',
        label: 'Outstanding',
        value: rupees(balance),
        tone: balance > 0 ? 'warning' : 'neutral',
      },
      {
        id: 'kpi-rate',
        type: 'kpi',
        label: 'Realisation',
        // Computed from summed totals, not averaged across schools — averaging
        // percentages would weight a 200-pupil school like a 4,000-pupil one.
        value: payable > 0 ? `${((paid / payable) * 100).toFixed(1)}%` : '—',
        tone: 'neutral',
      },
    );
  }

  if (byMonth.length > 0) {
    widgets.push({
      id: 'line-month',
      type: 'line',
      title: 'Receipts by month',
      x: 'fee_month',
      y: 'collected',
      data: byMonth.map((r) => ({
        fee_month: String(r['fee_month']),
        collected: num(r['collected']),
      })),
    });
  }

  if (byClass.length > 0) {
    widgets.push({
      id: 'bar-class',
      type: 'bar',
      title: 'Receipts by class',
      x: 'classname',
      y: 'collected',
      data: byClass.map((r) => ({
        classname: String(r['classname']),
        collected: num(r['collected']),
      })),
    });
  }

  if (byMode.length > 0) {
    widgets.push({
      id: 'donut-mode',
      type: 'donut',
      title: 'Payment modes',
      label_field: 'paymenttype',
      value_field: 'collected',
      data: byMode.map((r) => ({
        paymenttype: label(r['paymenttype']),
        collected: num(r['collected']),
      })),
    });
  }

  if (byComponent.length > 0) {
    widgets.push({
      id: 'table-component',
      type: 'table',
      title: 'Demand versus realisation by fee head',
      columns: [
        { field: 'componentname', label: 'Fee head' },
        { field: 'payable', label: 'Demand', align: 'right' },
        { field: 'paid', label: 'Collected', align: 'right' },
        { field: 'balance', label: 'Outstanding', align: 'right' },
      ],
      rows: byComponent.map((r) => ({
        componentname: label(r['componentname']),
        payable: num(r['payable']),
        paid: num(r['paid']),
        balance: num(r['balance']),
      })),
    });
  }

  return {
    widgets,
    groupBy: ['month', 'class', 'payment mode', 'fee head'],
    /**
     * Stated because the two figures will not tie exactly, and a reader who
     * spots that without being told will reasonably distrust both. Demand and
     * receipts are different ledgers: a receipt can be recorded against a
     * different period from the demand it settles.
     */
    notes: [
      'The KPI tiles come from the fee demand ledger (what was owed and settled). The month, class and payment-mode charts come from the receipt ledger (what was banked, and when). The two will not tie exactly.',
    ],
  };
}

/**
 * Fee Defaulters (aging 30/60/90) — docs/06 §2, Phase 1.
 *
 * The KPI tiles read from the `totals` result set rather than from the sum of
 * the aging bands, and the reason is worth stating: one child owes across
 * several fee heads and several bands, so adding up per-band student counts
 * would count that child three times. Amounts sum; people do not.
 */
function buildFeeDefaulters(merged: Merged, { asOf, scope }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];

  const totals = merged.sumAll('totals', ['defaulters', 'overdue']);
  const aging = merged.sumBy('aging', 'bucket', ['students', 'outstanding'], 'seq');
  const byClass = merged.sumBy('by_class', 'classname', ['students', 'outstanding'], 'seq');
  const byComponent = merged.sumBy('by_component', 'componentname', ['students', 'outstanding']);

  if (totals !== null) {
    const defaulters = num(totals['defaulters']);
    const overdue = num(totals['overdue']);
    widgets.push(
      {
        id: 'kpi-overdue',
        type: 'kpi',
        label: `Overdue as of ${asOf}`,
        value: rupees(overdue),
        tone: overdue > 0 ? 'warning' : 'positive',
      },
      {
        id: 'kpi-defaulters',
        type: 'kpi',
        label: 'Students with overdue fees',
        value: count(defaulters),
        tone: 'neutral',
      },
      {
        id: 'kpi-average',
        type: 'kpi',
        label: 'Average per student',
        // Not shown as ₹0 when there are no defaulters: dividing by zero and
        // printing the result is how a clean school looks like a broken query.
        value: defaulters > 0 ? rupees(overdue / defaulters) : '—',
        tone: 'neutral',
      },
    );
  }

  /**
   * Bands 2–5 are the escalation; 0 and 1 are context (see the `aging` query).
   * Selected by the band ORDINAL, never by matching the label text, so renaming
   * a band in the catalog cannot silently empty a tile or a chart.
   */
  const overdueBands = aging.filter((r) => num(r['seq']) >= 2);
  const beyond90 = aging
    .filter((r) => num(r['seq']) === 5)
    .reduce((total, r) => total + num(r['outstanding']), 0);
  const notYetDue = aging
    .filter((r) => num(r['seq']) === 1)
    .reduce((total, r) => total + num(r['outstanding']), 0);

  if (aging.length > 0) {
    widgets.push(
      {
        id: 'kpi-90plus',
        type: 'kpi',
        label: 'Overdue beyond 90 days',
        value: rupees(beyond90),
        tone: beyond90 > 0 ? 'negative' : 'positive',
      },
      {
        /**
         * On the tiles rather than in the aging chart, and that is a readability
         * decision with a real cost if it goes the other way: in a mid-year
         * school the not-yet-due demand is two orders of magnitude larger than
         * anything overdue, so plotting it beside the bands renders all four
         * escalation bars as invisible slivers. It is a KPI here and a row in
         * the table below, so nothing is hidden — it just stops flattening the
         * chart it is not part of.
         */
        id: 'kpi-not-due',
        type: 'kpi',
        label: 'Not yet due',
        value: rupees(notYetDue),
        tone: 'neutral',
      },
    );
  }

  if (overdueBands.length > 0) {
    widgets.push({
      id: 'bar-aging',
      type: 'bar',
      title: 'Overdue by age of the debt',
      x: 'bucket',
      y: 'outstanding',
      data: overdueBands.map((r) => ({
        bucket: label(r['bucket']),
        outstanding: num(r['outstanding']),
      })),
    });
  }

  if (aging.length > 0) {
    widgets.push({
      id: 'table-aging',
      type: 'table',
      // Every band, including the two the chart leaves out. The chart is for
      // reading the escalation; the table is the complete account.
      title: 'Aging bands',
      columns: [
        { field: 'bucket', label: 'Band' },
        { field: 'students', label: 'Students', align: 'right' },
        { field: 'outstanding', label: 'Outstanding', align: 'right' },
      ],
      rows: aging.map((r) => ({
        bucket: label(r['bucket']),
        students: num(r['students']),
        outstanding: num(r['outstanding']),
      })),
    });
  }

  if (byClass.length > 0) {
    widgets.push({
      id: 'bar-class',
      type: 'bar',
      title: 'Overdue by class',
      x: 'classname',
      y: 'outstanding',
      data: byClass.map((r) => ({
        classname: label(r['classname']),
        outstanding: num(r['outstanding']),
      })),
    });
  }

  if (byComponent.length > 0) {
    widgets.push({
      id: 'table-component',
      type: 'table',
      title: 'Overdue by fee head',
      columns: [
        { field: 'componentname', label: 'Fee head' },
        { field: 'students', label: 'Students', align: 'right' },
        { field: 'outstanding', label: 'Outstanding', align: 'right' },
      ],
      rows: byComponent.map((r) => ({
        componentname: label(r['componentname']),
        students: num(r['students']),
        outstanding: num(r['outstanding']),
      })),
    });
  }

  /**
   * The named list. Each school returns its own top 50, so a multi-school view
   * merges them and re-ranks — which is correct for "the largest balances in the
   * trust", and is why the school column appears as soon as there is more than
   * one of them: a name without a school is not actionable.
   */
  const named = merged.concatRows('top_defaulters');
  if (named.length > 0) {
    const masked = merged.maskedColumns('top_defaulters');
    const names = new Map(scope.map((s) => [s.school_id, s.school_name]));
    const multi = scope.length > 1;
    const rows = named
      .map(({ school_id, row }) => ({
        school: names.get(school_id) ?? school_id,
        enrollmentno: label(row['enrollmentno']),
        studentname: label(row['studentname']),
        classname: `${label(row['classname'])}-${label(row['sectionname'])}`,
        days_overdue: num(row['days_overdue']),
        outstanding: num(row['outstanding']),
      }))
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 50);

    widgets.push({
      id: 'table-defaulters',
      type: 'table',
      /**
       * The cap is in the title rather than in the `truncated` flag, because
       * they mean different things: `truncated` says the row cap cut the answer
       * short (docs/04 §3 rail 4), while this list is trimmed BY DESIGN to the
       * top 50. Flagging a deliberate top-N as truncation would teach readers to
       * ignore the flag that matters.
       */
      title: 'Largest individual balances (top 50)',
      columns: [
        ...(multi ? [{ field: 'school', label: 'School' } as const] : []),
        {
          field: 'studentname',
          label: 'Student',
          ...(masked.has('studentname') ? { masked: true } : {}),
        },
        {
          field: 'enrollmentno',
          label: 'Enrolment no.',
          ...(masked.has('enrollmentno') ? { masked: true } : {}),
        },
        { field: 'classname', label: 'Class' },
        { field: 'days_overdue', label: 'Days overdue', align: 'right' },
        { field: 'outstanding', label: 'Outstanding', align: 'right' },
      ],
      rows,
    });
  }

  return {
    widgets,
    groupBy: ['aging band', 'class', 'fee head', 'student'],
    notes: [
      `A student is counted as a defaulter when a fee period ended on or before ${asOf} and a balance remains. Dues not yet due are shown as their own band and are excluded from every "overdue" figure.`,
      /**
       * The limit of the as-of date, said plainly. Someone will backdate this
       * report expecting June's position, and the demand ledger cannot give it
       * to them — better to say so than to let a plausible number be misread.
       */
      'The fee ledger holds current balances, so the as-of date decides what counts as overdue and how deep the band is. It does not rebuild the ledger as it stood on that date: a payment made last week is already reflected here.',
      'Student names and enrolment numbers are masked for sessions without student-data permission; the amounts are not.',
    ],
  };
}

/**
 * Staff Overview — docs/06 §2, Phase 1.
 *
 * No academic-year filter, because `employees_data_set` has no academic year:
 * staff join on a date and leave on one (mcp-server/src/reports/catalog.ts). The
 * screen says so rather than showing a pill that does nothing.
 */
function buildStaffOverview(merged: Merged, { asOf }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];

  const movement = merged.sumAll('movement', ['on_roll', 'joined_12m', 'left_12m']);
  const byDepartment = merged.sumBy('by_department', 'departmentname', ['staff']);
  const byDesignation = merged.sumBy('by_designation', 'designationname', ['staff']);
  const byType = merged.sumBy('by_stafftype', 'stafftype', ['staff']);
  const byGender = merged.sumBy('by_gender', 'gender', ['staff']);
  const reasons = merged.sumBy('leavers_by_reason', 'reason_for_leaving', ['leavers']);

  if (movement !== null) {
    const onRoll = num(movement['on_roll']);
    const joined = num(movement['joined_12m']);
    const left = num(movement['left_12m']);
    widgets.push(
      {
        id: 'kpi-on-roll',
        type: 'kpi',
        label: `Staff on roll as of ${asOf}`,
        value: count(onRoll),
        tone: 'neutral',
      },
      { id: 'kpi-joined', type: 'kpi', label: 'Joined (12 months)', value: count(joined), tone: 'positive' },
      { id: 'kpi-left', type: 'kpi', label: 'Left (12 months)', value: count(left), tone: 'warning' },
      {
        id: 'kpi-attrition',
        type: 'kpi',
        /**
         * Leavers as a share of everyone on the payroll at any point in the
         * window (`on roll now` + `left during it`). Deliberately the simplest
         * defensible definition rather than an opening/closing average, because
         * a rate nobody can reproduce from the tiles beside it is a rate nobody
         * should act on. Computed from summed totals across schools, never by
         * averaging each school's rate — that would weight a 20-person school
         * like a 200-person one.
         */
        label: 'Attrition (12 months)',
        value: onRoll + left > 0 ? `${((left / (onRoll + left)) * 100).toFixed(1)}%` : '—',
        tone: 'neutral',
      },
    );
  }

  if (byDepartment.length > 0) {
    widgets.push({
      id: 'bar-department',
      type: 'bar',
      title: 'Headcount by department',
      x: 'departmentname',
      y: 'staff',
      data: byDepartment.map((r) => ({
        departmentname: label(r['departmentname']),
        staff: num(r['staff']),
      })),
    });
  }

  if (byType.length > 0) {
    /**
     * A bar, and titled "employment type", because that is what the column
     * holds: CONFIRMATION / CONTRACTUAL / PROBATION plus opaque codes, 19
     * distinct values in the real extract. A donut labelled "teaching versus
     * non-teaching" was both the wrong shape (19 slices) and the wrong claim —
     * `employees_data_set` cannot separate teaching staff without a mapping
     * nobody has confirmed (the same finding as services/home.ts's staff KPI).
     */
    widgets.push({
      id: 'bar-stafftype',
      type: 'bar',
      title: 'Headcount by employment type',
      x: 'stafftype',
      y: 'staff',
      data: byType.map((r) => ({ stafftype: label(r['stafftype']), staff: num(r['staff']) })),
    });
  }

  if (byGender.length > 0) {
    widgets.push({
      id: 'donut-gender',
      type: 'donut',
      title: 'Gender mix',
      label_field: 'gender',
      value_field: 'staff',
      data: byGender.map((r) => ({ gender: label(r['gender']), staff: num(r['staff']) })),
    });
  }

  if (byDesignation.length > 0) {
    widgets.push({
      id: 'table-designation',
      type: 'table',
      title: 'Headcount by designation',
      columns: [
        { field: 'designationname', label: 'Designation' },
        { field: 'staff', label: 'Staff', align: 'right' },
      ],
      rows: byDesignation
        .sort((a, b) => num(b['staff']) - num(a['staff']))
        .map((r) => ({ designationname: label(r['designationname']), staff: num(r['staff']) })),
    });
  }

  if (reasons.length > 0) {
    widgets.push({
      id: 'table-reasons',
      type: 'table',
      title: 'Why staff left, last 12 months',
      columns: [
        { field: 'reason_for_leaving', label: 'Reason' },
        { field: 'leavers', label: 'Staff', align: 'right' },
      ],
      rows: reasons
        .sort((a, b) => num(b['leavers']) - num(a['leavers']))
        .map((r) => ({ reason_for_leaving: label(r['reason_for_leaving']), leavers: num(r['leavers']) })),
    });
  }

  return {
    widgets,
    groupBy: ['department', 'designation', 'employment type', 'gender', 'reason for leaving'],
    notes: [
      'Staff records carry no academic year, so this report is not filtered by one. Everything here is measured as of the date above: on roll means joined on or before it and not yet left.',
      'There is no teaching versus non-teaching split here because the ERP data cannot support one: designations are free text and the staff-type column mixes employment types with internal codes. Headcount is reported for everyone, by department and by employment type, rather than published as a teacher count that would be quietly wrong.',
      'The 15 largest designations are listed; smaller ones are summarised in the department chart rather than dropped from it.',
    ],
  };
}

/**
 * Admissions Funnel — docs/06 §2, taken into Phase 1 (docs/11 §1).
 *
 * The stages are inferred from which number the ERP issued a candidate, because
 * the table carries no stage column (mcp-server/src/reports/catalog.ts). Said on
 * screen, not just in a comment: a funnel is exactly the kind of chart whose
 * definition changes what it means.
 */
function buildAdmissionsFunnel(merged: Merged, { year }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];

  const funnel = merged.sumAll('funnel', [
    'candidates',
    'enquiries',
    'registrations',
    'applications',
    'admissions',
  ]);
  const byClass = merged.sumBy('by_class', 'classname', ['candidates', 'admissions'], 'seq');
  const byStatus = merged.sumBy('by_status', 'candidate_statusid', ['candidates']);
  const byGender = merged.sumBy('by_gender', 'gender', ['candidates', 'admissions']);

  if (funnel !== null) {
    const candidates = num(funnel['candidates']);
    const admissions = num(funnel['admissions']);
    widgets.push(
      {
        id: 'kpi-candidates',
        type: 'kpi',
        label: `Candidates · ${year}`,
        value: count(candidates),
        tone: 'neutral',
      },
      { id: 'kpi-admitted', type: 'kpi', label: 'Admitted', value: count(admissions), tone: 'positive' },
      {
        id: 'kpi-conversion',
        type: 'kpi',
        label: 'Enquiry to admission',
        value: candidates > 0 ? `${((admissions / candidates) * 100).toFixed(1)}%` : '—',
        tone: 'neutral',
      },
    );

    widgets.push({
      id: 'bar-funnel',
      type: 'bar',
      title: 'Candidates reaching each stage',
      x: 'stage',
      y: 'candidates',
      data: [
        { stage: 'Enquiry', candidates: num(funnel['enquiries']) },
        { stage: 'Registration', candidates: num(funnel['registrations']) },
        { stage: 'Application', candidates: num(funnel['applications']) },
        { stage: 'Admission', candidates: admissions },
      ],
    });
  }

  if (byClass.length > 0) {
    widgets.push(
      {
        id: 'bar-class',
        type: 'bar',
        title: 'Candidates by class applied for',
        x: 'classname',
        y: 'candidates',
        data: byClass.map((r) => ({
          classname: label(r['classname']),
          candidates: num(r['candidates']),
        })),
      },
      {
        id: 'table-class',
        type: 'table',
        title: 'Conversion by class',
        columns: [
          { field: 'classname', label: 'Class' },
          { field: 'candidates', label: 'Candidates', align: 'right' },
          { field: 'admissions', label: 'Admitted', align: 'right' },
          { field: 'conversion', label: 'Conversion', align: 'right' },
        ],
        rows: byClass.map((r) => {
          const candidates = num(r['candidates']);
          const admissions = num(r['admissions']);
          return {
            classname: label(r['classname']),
            candidates,
            admissions,
            conversion: candidates > 0 ? `${((admissions / candidates) * 100).toFixed(1)}%` : '—',
          };
        }),
      },
    );
  }

  if (byGender.length > 0) {
    widgets.push({
      id: 'donut-gender',
      type: 'donut',
      title: 'Candidates by gender',
      label_field: 'gender',
      value_field: 'candidates',
      data: byGender.map((r) => ({ gender: label(r['gender']), candidates: num(r['candidates']) })),
    });
  }

  if (byStatus.length > 0) {
    widgets.push({
      id: 'table-status',
      type: 'table',
      title: "Candidates by the ERP's own status",
      columns: [
        { field: 'candidate_statusid', label: 'Status id' },
        { field: 'candidates', label: 'Candidates', align: 'right' },
      ],
      rows: byStatus
        .sort((a, b) => num(b['candidates']) - num(a['candidates']))
        .map((r) => ({
          candidate_statusid: label(r['candidate_statusid']),
          candidates: num(r['candidates']),
        })),
    });
  }

  return {
    widgets,
    groupBy: ['stage', 'class', 'status', 'gender'],
    notes: [
      'The stages are read from the numbers the ERP issued each candidate — an enquiry number means the enquiry stage was reached, an admission number means admitted. The table has no stage column and no stage dates, so this is a reading of the data rather than a field in it.',
      'Status ids are shown as ids because no status lookup was supplied with this dataset. Compare them against the inferred stages above rather than assuming the two agree.',
    ],
  };
}

// -- Merging ------------------------------------------------------------------

class Merged {
  constructor(private readonly result: PredefinedResult) {}

  private queriesFor(key: string) {
    return this.result.schools
      .filter((s) => s.status === 'ok')
      .flatMap((s) => s.queries ?? [])
      .filter((q) => q.key === key);
  }

  /**
   * Sum numeric fields, grouped by one key (or several joined with `|`).
   * `orderField` keeps a school's own ordering column — class sequence, month
   * number — because sorting class names as text puts X before IX.
   */
  sumBy(
    key: string,
    groupBy: string,
    sumFields: string[],
    orderField?: string,
  ): Record<string, unknown>[] {
    const keys = groupBy.split('|');
    const acc = new Map<string, Record<string, unknown>>();

    for (const query of this.queriesFor(key)) {
      if (query.status !== 'ok') continue;
      for (const row of query.rows ?? []) {
        const id = keys.map((k) => String(row[k] ?? '')).join(' ');
        let entry = acc.get(id);
        if (entry === undefined) {
          entry = {};
          for (const k of keys) entry[k] = row[k];
          if (orderField !== undefined) entry[orderField] = num(row[orderField]);
          for (const f of sumFields) entry[f] = 0;
          acc.set(id, entry);
        }
        for (const f of sumFields) entry[f] = num(entry[f]) + num(row[f]);
      }
    }

    const rows = [...acc.values()];
    if (orderField !== undefined) {
      rows.sort((a, b) => num(a[orderField]) - num(b[orderField]));
    } else if (sumFields[0] !== undefined) {
      /**
       * Restore the ordering the merge destroyed.
       *
       * Every one of these statements ends `ORDER BY <measure> DESC`, but the
       * merge accumulates into a Map and hands back INSERTION order — which is
       * whichever school answered first. The effect on screen is a bar chart
       * whose longest bar sits second or ninth, and a reader scanning for the
       * biggest department has to read all twenty labels to find it.
       *
       * Ordinal axes are exempt: they pass an `orderField` because class and
       * month have a right order that is not "biggest first".
       */
      const measure = sumFields[0];
      rows.sort((a, b) => num(b[measure]) - num(a[measure]));
    }
    return rows;
  }

  /**
   * Rows kept as rows, tagged with the school they came from.
   *
   * The counterpart to `sumBy`: a list of named students is not summable — two
   * schools' top-50 lists are two lists, not one list of totals — so the caller
   * gets them side by side and decides the ranking. The school id travels with
   * each row because a child's name without a school is not actionable in a
   * trust view.
   */
  concatRows(key: string): { school_id: string; row: Record<string, unknown> }[] {
    const out: { school_id: string; row: Record<string, unknown> }[] = [];
    for (const school of this.result.schools) {
      if (school.status !== 'ok') continue;
      for (const query of school.queries ?? []) {
        if (query.key !== key || query.status !== 'ok') continue;
        for (const row of query.rows ?? []) out.push({ school_id: school.school_id, row });
      }
    }
    return out;
  }

  /**
   * Columns rail 6 masked, for any school.
   *
   * Unioned rather than intersected: if one school's rows came back masked, the
   * column is masked on screen for the whole table. Showing a column as clear
   * because SOME school could read it would mislabel the masked rows beside it.
   */
  maskedColumns(key: string): Set<string> {
    const masked = new Set<string>();
    for (const query of this.queriesFor(key)) {
      for (const name of query.masked_columns ?? []) masked.add(name);
    }
    return masked;
  }

  /** A single-row result set summed across schools. */
  sumAll(key: string, sumFields: string[]): Record<string, unknown> | null {
    const totals: Record<string, unknown> = {};
    let seen = false;
    for (const query of this.queriesFor(key)) {
      if (query.status !== 'ok') continue;
      for (const row of query.rows ?? []) {
        seen = true;
        for (const f of sumFields) totals[f] = num(totals[f]) + num(row[f]);
      }
    }
    return seen ? totals : null;
  }

  /** One definition per query key, for the Logic panel (Invariant 6). */
  definitions(): { key: string; description: string; sql: string }[] {
    const seen = new Map<string, { key: string; description: string; sql: string }>();
    for (const school of this.result.schools) {
      for (const query of school.queries ?? []) {
        if (!seen.has(query.key)) {
          seen.set(query.key, { key: query.key, description: query.description, sql: query.sql });
        }
      }
    }
    return [...seen.values()];
  }

  /** Panels that failed everywhere. A panel that worked somewhere still renders. */
  failures(): { key: string; message: string }[] {
    const total = new Map<string, number>();
    const failed = new Map<string, { count: number; message: string }>();
    for (const school of this.result.schools) {
      for (const query of school.queries ?? []) {
        total.set(query.key, (total.get(query.key) ?? 0) + 1);
        if (query.status === 'failed') {
          const entry = failed.get(query.key);
          failed.set(query.key, {
            count: (entry?.count ?? 0) + 1,
            message: query.error?.message ?? 'could not be produced',
          });
        }
      }
    }
    return [...failed]
      .filter(([key, entry]) => entry.count === total.get(key))
      .map(([key, entry]) => ({ key, message: entry.message }));
  }

  schoolFailures(): { school_id: string; message: string }[] {
    return this.result.schools
      .filter((s) => s.status === 'failed')
      .map((s) => ({ school_id: s.school_id, message: s.error?.message ?? 'temporarily unreachable' }));
  }

  /** True when every failure was a refusal — a permissions answer, not an outage. */
  allDenied(): boolean {
    const errors = this.result.schools.flatMap((s) => [
      ...(s.error === undefined ? [] : [s.error]),
      ...(s.queries ?? []).flatMap((q) => (q.error === undefined ? [] : [q.error])),
    ]);
    return errors.length > 0 && errors.every((e) => e.code === ERROR_CODES.PERMISSION_DENIED);
  }
}

// -- Formatting (server-side, per ADR-015/021) --------------------------------

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Blank labels are real in this dataset; "—" beats an unlabelled slice. */
function label(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text === '' ? '—' : text;
}

function count(value: number): string {
  return new Intl.NumberFormat('en-IN').format(Math.round(value));
}

function rupees(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 10_000_000) return `₹${(rounded / 10_000_000).toFixed(1)}Cr`;
  if (Math.abs(rounded) >= 100_000) return `₹${(rounded / 100_000).toFixed(1)}L`;
  return `₹${new Intl.NumberFormat('en-IN').format(rounded)}`;
}
