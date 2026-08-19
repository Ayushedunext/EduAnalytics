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

export const DASHBOARD_IDS = ['enrollment-overview', 'fee-collection'] as const;
export type DashboardId = (typeof DASHBOARD_IDS)[number];

export function isDashboardId(value: string): value is DashboardId {
  return (DASHBOARD_IDS as readonly string[]).includes(value);
}

export async function buildDashboard(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  reportId: DashboardId;
  academicYear: string;
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

  const result = await withMcp(args.session, args.correlationId, args.schoolIds, async (mcp) =>
    mcp.call<PredefinedResult>('run_predefined', {
      report_id: args.reportId,
      school_ids: [...args.schoolIds],
      params: { academic_year: args.academicYear },
    }),
  );

  const merged = new Merged(result);

  const built =
    args.reportId === 'enrollment-overview'
      ? buildEnrollment(merged, args.academicYear)
      : buildFeeCollection(merged, args.academicYear);

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

  return {
    spec: parsed.data,
    logic: {
      source: result.source,
      scope,
      filters: [{ label: 'Academic year', value: args.academicYear }],
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
}

// -- Dashboards ---------------------------------------------------------------

interface DashboardBuild {
  widgets: Widget[];
  groupBy: string[];
  notes: string[];
}

function buildEnrollment(merged: Merged, year: string): DashboardBuild {
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

function buildFeeCollection(merged: Merged, year: string): DashboardBuild {
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
    if (orderField !== undefined) rows.sort((a, b) => num(a[orderField]) - num(b[orderField]));
    return rows;
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
