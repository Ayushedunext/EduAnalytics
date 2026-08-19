/**
 * The Home summary — the first screen a user sees after launch.
 *
 * Contract source: docs/10 §2 (screen inventory) · ADR-016 (predefined and AI
 * are separate serving paths; this is the predefined one and spends no AI
 * tokens) · ADR-015 / CODING_GUIDELINES §6 (report data leaves this service as
 * chart-spec, never raw rows for the client to reshape).
 *
 * -- Why the SQL carries no parameters ---------------------------------------
 * The MCP guard rejects placeholders in `run_query`/`run_multi` (docs/04 §2
 * gives neither tool a params argument), and CODING_GUIDELINES §9 forbids
 * concatenating values into SQL. Both hold at once only if the vetted SQL needs
 * no values — so these statements group by academic year and the year is chosen
 * HERE, in JavaScript, from the result. Filtering to a year in SQL would have
 * meant interpolating a value, and "it came from the database" is not a reason
 * to skip that rule any more than "it came from the ERP sync" is (@sap/shared
 * identifiers.ts). Bound parameters arrive properly with `run_predefined`.
 *
 * -- Why a metric that cannot be computed is named, not omitted ---------------
 * There is no attendance data in the ERP extract at all (AUDIT_REPORT C20), so
 * the prototype's "student attendance MTD" tile has no source. It is reported in
 * `blocked_metrics` with its reason rather than dropped or shown as 0%. A
 * dashboard that quietly renders three tiles where four were designed is the
 * success-shaped failure CODING_GUIDELINES §10 calls the worst bug class here,
 * and 0% attendance would be actively false. Same reasoning as
 * `dropped_from_scope` on /api/session (docs/02 §6).
 */

import {
  chartSpecSchema,
  type ChartSpec,
  type Widget,
} from '@sap/chart-spec';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import type { SessionClaims } from '../auth/session.js';
import { withMcp, type RunMultiResult } from '../mcp/client.js';
import { schoolNames } from '../db/registry.js';

/**
 * Vetted SQL. Read-only, catalog tables only, no placeholders, no tenant filter
 * — the MCP server injects scope and the row cap itself (docs/04 §3).
 */
const METRIC_SQL = {
  studentsByYear:
    'SELECT academicyearname AS ay, COUNT(*) AS n FROM students_data_set ' +
    'WHERE deactivation_date IS NULL GROUP BY academicyearname',
  activeStaff:
    'SELECT COUNT(*) AS n FROM employees_data_set WHERE deactivation_date IS NULL',
  outstandingByYear:
    'SELECT academicyearname AS ay, ROUND(SUM(balance_amount)) AS n ' +
    'FROM fee_compile_data_set WHERE balance_amount > 0 GROUP BY academicyearname',
} as const;

export interface BlockedMetric {
  readonly label: string;
  readonly reason: string;
  /**
   * Why it is missing, because the two need different words on screen and lead
   * to different actions. `no_data` means the ERP holds no such data at all
   * (AUDIT_REPORT C20) -- nobody here can fix that. `not_permitted` means this
   * session's `perms[]` do not cover the domain (docs/08 §4.5) -- a different
   * user, or a different token, would see it.
   */
  readonly kind: 'no_data' | 'not_permitted';
}

export interface DashboardCard {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly icon: string;
  readonly group: 'director' | 'school';
  /**
   * `available` — built and reachable. `coming` — the serving path exists in the
   * roadmap but not yet in code. `blocked` — the DATA does not exist, which is a
   * different problem with a different owner, and the two must not look alike to
   * an admin deciding what to chase.
   */
  readonly status: 'available' | 'coming' | 'blocked';
  readonly reason?: string;
}

export interface HomeSummary {
  readonly spec: ChartSpec;
  readonly academic_year: string | null;
  readonly blocked_metrics: readonly BlockedMetric[];
  readonly dashboards: readonly DashboardCard[];
  /** Schools that failed within a fan-out. Annotated, never swallowed (ADR-011). */
  readonly degraded_schools: readonly { school_id: string; message: string }[];
}

/**
 * The dashboard catalog, with each card's honest state.
 *
 * The set and the wording follow the UX prototype (docs/11 Artifacts) so the
 * screen matches what was designed; the STATUS of each is decided here, on the
 * server, from what the platform can actually serve today. A card's availability
 * is not a UI opinion — the SPA renders what this says.
 */
const DASHBOARDS: readonly DashboardCard[] = [
  {
    id: 'group-overview',
    title: 'Group Overview',
    blurb: 'Strength & gender across schools, staff, fees at a glance',
    icon: '🌐',
    group: 'director',
    status: 'coming',
    reason: 'Cross-school aggregates are served from the rollup store (ADR-010, Phase 2)',
  },
  {
    id: 'cross-school-attendance',
    title: 'Cross-School Attendance',
    blurb: 'Students & teachers, by school, with monthly trend',
    icon: '🗓️',
    group: 'director',
    status: 'blocked',
    reason: 'No attendance data exists in the ERP extract',
  },
  {
    id: 'workflow-agents',
    title: 'Workflow Agents',
    blurb: 'Automate alerts: absence, fees, library — build your own flows',
    icon: '⚡',
    group: 'director',
    status: 'coming',
    reason: 'The agent runtime is a later phase (ADR-022)',
  },
  {
    id: 'school-comparison',
    title: 'School Comparison',
    blurb: 'Any metric side-by-side across your schools',
    icon: '⚖️',
    group: 'director',
    status: 'coming',
    reason: 'Needs the rollup store (ADR-010, Phase 2)',
  },
  {
    id: 'fee-collection',
    title: 'Fee Collection',
    /**
     * Defaulters used to be listed here, from the UX prototype. They are their
     * own dashboard now (docs/11 §1), and a card promising something another
     * card actually delivers sends people to the wrong screen.
     */
    blurb: 'Collected vs due, class-wise, payment modes',
    icon: '₹',
    group: 'school',
    status: 'available',
  },
  {
    id: 'fee-defaulters',
    title: 'Fee Defaulters',
    blurb: 'Overdue by 30/60/90 bands, by class and fee head, largest balances',
    icon: '⏳',
    group: 'school',
    status: 'available',
  },
  {
    id: 'staff-overview',
    title: 'Staff Overview',
    blurb: 'Headcount by department and employment type, joiners and attrition',
    icon: '👥',
    group: 'school',
    status: 'available',
  },
  {
    id: 'admissions-funnel',
    title: 'Admissions Funnel',
    blurb: 'Enquiry → registration → application → admission, and where it leaks',
    icon: '📝',
    group: 'school',
    status: 'available',
  },
  {
    id: 'attendance-analytics',
    title: 'Attendance Analytics',
    blurb: 'Daily %, trends, chronic absentee list',
    icon: '✅',
    group: 'school',
    status: 'blocked',
    reason: 'No attendance data exists in the ERP extract',
  },
  {
    id: 'exam-performance',
    title: 'Exam Performance',
    blurb: 'Term averages, subject distribution, toppers',
    icon: '🏅',
    group: 'school',
    status: 'blocked',
    reason: 'No exam data exists in the ERP extract',
  },
  {
    id: 'enrollment-overview',
    title: 'Enrollment Overview',
    blurb: 'Class mix, YoY growth, gender ratio',
    icon: '🎓',
    group: 'school',
    status: 'available',
  },
  {
    id: 'transport-analytics',
    title: 'Transport Analytics',
    blurb: 'Route ridership & capacity utilisation',
    icon: '🚌',
    group: 'school',
    status: 'blocked',
    reason: 'No transport data exists in the ERP extract',
  },
  {
    id: 'library-textbooks',
    title: 'Library & Textbooks',
    blurb: 'Issues, overdues, low-stock alerts',
    icon: '📚',
    group: 'school',
    status: 'blocked',
    reason: 'No library data exists in the ERP extract',
  },
];

export async function buildHomeSummary(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  correlationId: string;
}): Promise<HomeSummary> {
  const scope = await schoolNames(args.schoolIds);
  if (scope.length === 0) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'None of the selected schools are available for analytics right now.',
      correlationId: args.correlationId,
    });
  }

  const { students, staff, outstanding } = await withMcp(
    args.session,
    args.correlationId,
    args.schoolIds,
    async (mcp) => {
      /**
       * Three fan-outs, run together. ADR-011 caps concurrency INSIDE each
       * fan-out (~10 schools at a time); these are three independent queries, so
       * running them in parallel costs one round trip instead of three and does
       * not widen that cap.
       */
      const [students, staff, outstanding] = await Promise.all([
        mcp.call<RunMultiResult>('run_multi', {
          school_ids: [...args.schoolIds],
          sql: METRIC_SQL.studentsByYear,
        }),
        mcp.call<RunMultiResult>('run_multi', {
          school_ids: [...args.schoolIds],
          sql: METRIC_SQL.activeStaff,
        }),
        mcp.call<RunMultiResult>('run_multi', {
          school_ids: [...args.schoolIds],
          sql: METRIC_SQL.outstandingByYear,
        }),
      ]);
      return { students, staff, outstanding };
    },
  );

  /**
   * The current academic year: the latest one the data itself reports. Chosen
   * from the students result rather than configured, so a school that has rolled
   * over to a new session is reflected without a deployment. The labels sort
   * correctly as strings in this ERP's `YYYY-YY` format; a different format
   * would need an explicit ordering, which is why the year is echoed in the
   * response for the UI to display rather than assumed.
   */
  /**
   * A metric whose fan-out produced no successful school is UNAVAILABLE, not
   * zero.
   *
   * This is the whole bug class this file keeps warning about, and it bit here
   * first: an accountant holds `fees.read` and not `students.read`, so the
   * student query is refused for every school (docs/08 §4.5), `run_multi`
   * annotates the refusal per school and returns no rows, and summing no rows
   * gives 0. "0 students" is not a smaller truth than 9,627 — it is a false one,
   * and it looks exactly like a real answer. So availability is decided from
   * whether any school actually answered, never from the total.
   */
  const studentsOutcome = outcomeOf(students);
  const staffOutcome = outcomeOf(staff);
  const outstandingOutcome = outcomeOf(outstanding);

  /**
   * The academic year comes from whichever metric could be read. Deriving it
   * from students alone meant a session without `students.read` lost the year
   * and therefore silently lost the FEES figure too — one missing permission
   * cascading into an unrelated wrong number.
   */
  const academicYear =
    (studentsOutcome.available ? latestYear(students.rows) : null) ??
    (outstandingOutcome.available ? latestYear(outstanding.rows) : null);

  const widgets: Widget[] = [];
  const blocked: BlockedMetric[] = [];

  if (studentsOutcome.available) {
    widgets.push({
      id: 'kpi-students',
      type: 'kpi',
      label: `Students · ${String(scope.length)} school${scope.length > 1 ? 's' : ''}`,
      value: formatCount(sumForYear(students.rows, academicYear)),
      tone: 'neutral',
    });
  } else {
    blocked.push({
      label: 'Students',
      reason: studentsOutcome.reason ?? 'Not available for this session',
      kind: studentsOutcome.kind,
    });
  }

  if (staffOutcome.available) {
    widgets.push({
      id: 'kpi-staff',
      /**
       * "Staff", not "Teachers" as the prototype has it. `employees_data_set`
       * carries `designationname` as free text ("PRT", "TGT", "ENGLISH TEACHER",
       * "CLASS ASSISTANT", "MAINTENANCE STAFF") and `stafftype` as opaque codes
       * ("S0011", "S004AD"), so teaching staff cannot be separated from the rest
       * without a mapping nobody has confirmed. Counting everyone and labelling
       * it honestly beats publishing a teacher count that is quietly wrong.
       */
      type: 'kpi',
      label: 'Staff on roll',
      value: formatCount(sumAll(staff.rows)),
      tone: 'neutral',
    });
  } else {
    blocked.push({
      label: 'Staff on roll',
      reason: staffOutcome.reason ?? 'Not available for this session',
      kind: staffOutcome.kind,
    });
  }

  if (outstandingOutcome.available && academicYear !== null) {
    const amount = sumForYear(outstanding.rows, academicYear);
    widgets.push({
      id: 'kpi-outstanding',
      type: 'kpi',
      label: 'Fees outstanding',
      value: formatRupees(amount),
      tone: amount > 0 ? 'warning' : 'neutral',
    });
  } else {
    blocked.push({
      label: 'Fees outstanding',
      reason: outstandingOutcome.reason ?? 'Not available for this session',
      kind: outstandingOutcome.kind,
    });
  }

  /** No source anywhere in the ERP extract, for anyone (AUDIT_REPORT C20). */
  blocked.push({
    label: 'Student attendance MTD',
    reason: 'No attendance data exists in the ERP extract',
    kind: 'no_data',
  });

  /**
   * The chart-spec schema requires at least one widget, and rightly so — a spec
   * with nothing in it is not a report. A session that can read none of these
   * metrics is a real state (a token with no analytics perms at all), and it
   * fails loudly here rather than producing an empty page that looks like an
   * outage.
   */
  if (widgets.length === 0) {
    throw new PlatformError({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: 'This session does not have permission to view any of the home metrics.',
      diagnostics: { blocked: blocked.map((b) => b.label) },
      correlationId: args.correlationId,
    });
  }

  const spec: ChartSpec = {
    spec_version: 1,
    title: 'Home',
    widgets,
    meta: {
      scope,
      generated_at: new Date().toISOString(),
      as_of: students.as_of,
      /**
       * docs/03 §4: exactly three result-serving tiers. This answered from the
       * replica — there is no Redis result cache in the build yet, and no rollup
       * store, so claiming either would be a lie the logic panel would repeat.
       */
      served_from: 'replica',
    },
  };

  /**
   * [MANDATORY] CODING_GUIDELINES §10: LLM output is validated before it reaches
   * the renderer. This spec has no model anywhere near it (ADR-016 keeps the
   * predefined path AI-free), and it is validated anyway — the renderer's
   * contract is the schema, not the honesty of whoever built the object, and a
   * predefined path that skipped validation is how the two paths drift.
   */
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
    academic_year: academicYear,
    blocked_metrics: blocked,
    dashboards: DASHBOARDS,
    degraded_schools: degradedFrom([students, staff, outstanding]),
  };
}

/**
 * Did this metric produce an answer at all?
 *
 * `run_multi` reports partial failure per school (ADR-011), which is right for a
 * replica that is briefly unreachable. It is NOT right to read "every school
 * refused" as "the total is zero": a uniform refusal is categorical, not
 * partial. This tells the two apart, and preserves WHY, so the screen can say
 * "you do not have permission" rather than printing a zero.
 */
function outcomeOf(result: RunMultiResult): {
  available: boolean;
  reason?: string;
  kind: 'no_data' | 'not_permitted';
} {
  if (result.schools_succeeded > 0) return { available: true, kind: 'no_data' };
  const failure = result.per_school.find((entry) => entry.status === 'failed');
  const denied = failure?.error?.code === 'PERMISSION_DENIED';
  return {
    available: false,
    ...(failure?.error?.message === undefined ? {} : { reason: failure.error.message }),
    kind: denied ? 'not_permitted' : 'no_data',
  };
}

/** Per-school failures inside a fan-out, surfaced rather than absorbed (ADR-011). */
function degradedFrom(
  results: readonly RunMultiResult[],
): { school_id: string; message: string }[] {
  const seen = new Map<string, string>();
  for (const result of results) {
    for (const entry of result.per_school) {
      if (entry.status !== 'failed' || seen.has(entry.school_id)) continue;
      /**
       * A permission refusal is not a degraded school. It says nothing about
       * whether the replica is healthy, and reporting it as "could not be
       * reached" would send an accountant chasing an outage that does not exist.
       * It is already reported, accurately, in `blocked_metrics`.
       */
      if (entry.error?.code === 'PERMISSION_DENIED') continue;
      seen.set(entry.school_id, entry.error?.message ?? 'temporarily unreachable');
    }
  }
  return [...seen].map(([school_id, message]) => ({ school_id, message }));
}

function latestYear(rows: readonly Record<string, unknown>[]): string | null {
  const years = rows
    .map((row) => row['ay'])
    .filter((value): value is string => typeof value === 'string' && value !== '');
  if (years.length === 0) return null;
  return [...years].sort().reverse()[0] ?? null;
}

function sumForYear(rows: readonly Record<string, unknown>[], year: string | null): number {
  if (year === null) return 0;
  return rows.reduce((total, row) => (row['ay'] === year ? total + toNumber(row['n']) : total), 0);
}

function sumAll(rows: readonly Record<string, unknown>[]): number {
  return rows.reduce((total, row) => total + toNumber(row['n']), 0);
}

/** MySQL returns DECIMAL/BIGINT aggregates as strings in some driver paths. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Formatting happens here, not in the SPA.
 *
 * The chart-spec contract says a KPI's `value` is "a pre-formatted display
 * string because currency and number formatting are locale decisions made once,
 * server-side, so the screen and the PDF cannot format the same number
 * differently" (ADR-015/021). Indian digit grouping and the lakh/crore scale are
 * exactly such a decision.
 */
function formatCount(value: number): string {
  return new Intl.NumberFormat('en-IN').format(Math.round(value));
}

function formatRupees(value: number): string {
  const rounded = Math.round(value);
  if (rounded >= 10_000_000) return `₹${(rounded / 10_000_000).toFixed(1)}Cr`;
  if (rounded >= 100_000) return `₹${(rounded / 100_000).toFixed(1)}L`;
  return `₹${new Intl.NumberFormat('en-IN').format(rounded)}`;
}
