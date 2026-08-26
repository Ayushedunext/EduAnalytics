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
 * The prototype's fourth tile is student attendance, and until 2026-08-21 the
 * ERP extract held no attendance at all (AUDIT_REPORT C20), so it was reported
 * in `blocked_metrics` with its reason rather than dropped or shown as 0%. The
 * table has since arrived and the tile is computed — but the mechanism stays,
 * because the reasons a tile cannot be filled outlived the one that prompted it:
 * a session without `students.read` cannot see it, and a school where nobody has
 * taken the register has nothing to show. Both are named on screen. A dashboard
 * that quietly renders three tiles where four were designed is the
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
import { cacheGet, cacheKey, cacheSet } from '../cache/result-cache.js';
import { config } from '../config.js';
import { buildDashboard, isDashboardId, type DashboardId } from './dashboards.js';

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
  /**
   * Attendance for the tile, by month.
   *
   * Three things in this statement are not obvious and all three are forced by
   * the data (mcp-server/src/schema/erp-v1.ts documents each):
   *
   *   1. It groups on `attendancedate`, never on `academicyearname`. That column
   *      is stamped with the CURRENT academic year rather than the year the row
   *      falls in, so grouping by it would file August 2024 under 2026-27.
   *   2. It de-duplicates to one row per student-day first. The table is not
   *      unique on (student, date) — one student carries six rows for a single
   *      day in the delivered extract — so counting rows would count that day
   *      six times.
   *   3. It reads `statusname`, not `statusid`, because the ids mean different
   *      things in the two attendance tables.
   *
   * The three-month floor is a cost decision, not a semantic one. Home is the
   * one screen every user loads, this tile is about now, and without a floor the
   * statement groups a school's entire attendance history to render a single
   * month. `CURDATE()` is acceptable here for the same reason it is refused in
   * the reports (mcp-server/src/reports/catalog.ts, AS_OF_DATE): a tile labelled
   * with the month it shows is not a figure anyone will print and reconcile
   * later.
   */
  attendanceByMonth:
    "SELECT LEFT(a.attendancedate, 7) AS ym, COUNT(*) AS marked, " +
    "SUM(CASE WHEN a.statusname = 'Present' THEN 1 ELSE 0 END) AS present " +
    'FROM (SELECT MAX(id) AS id FROM student_attendance_data_set ' +
    "WHERE attendancedate >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 3 MONTH), '%Y-%m-01') " +
    'GROUP BY studentid, attendancedate) k ' +
    'JOIN student_attendance_data_set a ON a.id = k.id ' +
    'GROUP BY LEFT(a.attendancedate, 7)',
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
 * One dashboard's lead CHART, for the Home overview.
 *
 * `widget` is the FIRST chart-typed widget (bar/line/donut) of that
 * dashboard's own spec, never a KPI and never a table — Home's own KPI strip
 * above already carries the numbers, so a second row of number-only tiles
 * would say nothing a preview card needs to. Every builder in
 * services/dashboards.ts pushes its headline chart before its secondary ones
 * (services/dashboards.ts, e.g. `bar-department` before `bar-stafftype`), so
 * taking the first chart widget in the spec's own order is the same
 * "never re-pick by inspecting values" rule the KPI strip already follows —
 * just applied one type over. Falls back to the lead KPI only for a dashboard
 * whose only widgets ARE KPIs for this school selection (e.g. Admissions with
 * no chartable breakdown yet); `null` only when the dashboard has no widgets
 * at all, which `buildDashboard` itself already treats as a failure below.
 * `status: 'blocked'` covers both "no permission" and "no data": either way
 * there is nothing to preview, and the reason travels so the card can say why
 * rather than rendering empty.
 */
export interface HomePreview {
  readonly id: DashboardId;
  readonly title: string;
  readonly icon: string;
  readonly widget: Widget | null;
  readonly status: 'ok' | 'blocked';
  readonly reason?: string;
}

export interface HomePreviews {
  readonly previews: readonly HomePreview[];
}

/**
 * Live previews for the Home overview — one lead widget per dashboard this
 * session can actually open.
 *
 * Deliberately a SEPARATE call from `buildHomeSummary`, not folded into it: the
 * KPI strip above answers from 4 lightweight aggregate queries, and Home is the
 * one screen every user loads on every visit (docs/09 §3's dashboard-cold
 * budget is 0.5-2s). Fetching six dashboards' worth of predefined queries in
 * that same request would make the FIRST paint of Home pay for all of them.
 * Splitting the call lets the KPI strip render immediately and the preview
 * cards fill in as this resolves, with a skeleton in between (docs/10 §1,
 * "feels instant").
 *
 * No new SQL, no new cache: each dashboard is fetched through the exact same
 * `buildDashboard` the standalone report page uses, so it is the same vetted
 * statement, the same permission check, and the same Redis cache entry
 * (services/dashboards.ts) — a school's Fee Collection preview and its Fee
 * Collection dashboard are never two different numbers for the same period,
 * and after the first load of either, the other is a cache hit.
 */
export async function buildHomePreviews(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  academicYear: string;
  asOfDate: string;
  correlationId: string;
}): Promise<HomePreviews> {
  const eligible = DASHBOARDS.filter(
    (card): card is DashboardCard & { id: DashboardId } =>
      card.status === 'available' && isDashboardId(card.id),
  );

  const previews = await Promise.all(
    eligible.map(async (card): Promise<HomePreview> => {
      try {
        const result = await buildDashboard({
          session: args.session,
          schoolIds: args.schoolIds,
          reportId: card.id,
          academicYear: args.academicYear,
          asOfDate: args.asOfDate,
          correlationId: args.correlationId,
        });
        const chart = result.spec.widgets.find(
          (w) => w.type === 'bar' || w.type === 'line' || w.type === 'donut',
        );
        return {
          id: card.id,
          title: card.title,
          icon: card.icon,
          widget: chart ?? result.spec.widgets[0] ?? null,
          status: 'ok',
        };
      } catch (err) {
        /**
         * One dashboard's failure (no permission, no data, a degraded school)
         * must not blank the other five — same partial-failure reasoning as the
         * fan-outs above (ADR-011), one level up: here the "fan-out" is across
         * dashboards rather than schools.
         */
        return {
          id: card.id,
          title: card.title,
          icon: card.icon,
          widget: null,
          status: 'blocked',
          reason:
            err instanceof PlatformError ? err.message : 'This dashboard could not be loaded.',
        };
      }
    }),
  );

  return { previews };
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
    /**
     * `coming`, not `blocked`, since 2026-08-21: the data exists now, so what
     * stands between this card and a screen is the rollup store rather than the
     * ERP team. Different problem, different owner, different card state — the
     * distinction this type exists to make.
     */
    group: 'director',
    status: 'coming',
    reason: 'Cross-school aggregates are served from the rollup store (ADR-010, Phase 2)',
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
    blurb: 'Monthly trend, class-wise rate, marking coverage, students below 75%',
    icon: '✅',
    group: 'school',
    /**
     * Available since 2026-08-21. `available` means the report is built and
     * reachable — NOT that every school has attendance to show. A school where
     * nobody has marked the register opens the dashboard and is told so by name
     * (services/dashboards.ts, buildAttendance); that is a fact about a school,
     * and putting it on a catalog card would state it about the platform.
     */
    status: 'available',
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
    blurb: 'Route ridership by route, stop and class',
    icon: '🚌',
    group: 'school',
    /**
     * `available` since 2026-08-26, on an UNVERIFIED schema
     * (mcp-server/src/schema/erp-v1.ts) — the table's existence was known, its
     * columns were not, and the dashboard's own on-screen notes say so
     * (services/dashboards.ts). This card's job is to say the report is
     * reachable, not to vouch for the numbers; that caveat belongs on the
     * dashboard itself, where it is.
     */
    status: 'available',
  },
  {
    id: 'library-textbooks',
    title: 'Library & Textbooks',
    blurb: 'Issues by month, low-stock alerts, overdues',
    icon: '📚',
    group: 'school',
    // Same caveat as Transport Analytics above: available on an unverified schema.
    status: 'available',
  },
  {
    id: 'principal-snapshot',
    title: "Principal's Snapshot",
    blurb: 'Enrollment, fees, staff, admissions and attendance in one page',
    icon: '🏫',
    group: 'school',
    status: 'available',
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

  /**
   * Same tier ① as the dashboards (docs/09 §4), and the same [MANDATORY]
   * permission-class component in the key (docs/08 §5): Home shows a fee total
   * and a staff count, and which of those a session may read at all is
   * role-dependent.
   *
   * Home is worth caching for a reason the dashboards do not have: it is the
   * landing screen, so it is the one page every user of a school loads, and it
   * fans out to three schools before anything else can happen.
   */
  const key = cacheKey({
    kind: 'home',
    schoolIds: args.schoolIds,
    permissionClass: args.session.permission_class,
    filters: {},
  });

  const hit = await cacheGet<HomeSummary>(key);
  if (hit !== null) {
    return { ...hit, spec: { ...hit.spec, meta: { ...hit.spec.meta, served_from: 'cache' } } };
  }

  const { students, staff, outstanding, attendance } = await withMcp(
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
      const [students, staff, outstanding, attendance] = await Promise.all([
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
        mcp.call<RunMultiResult>('run_multi', {
          school_ids: [...args.schoolIds],
          sql: METRIC_SQL.attendanceByMonth,
        }),
      ]);
      return { students, staff, outstanding, attendance };
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
  const attendanceOutcome = outcomeOf(attendance);

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

  /**
   * Student attendance, for the most recent month anyone marked.
   *
   * The prototype calls this tile "MTD" and it is deliberately NOT called that
   * here. MTD claims the current calendar month, and the month this shows is
   * whichever month the data last has — those coincide in a school marking the
   * register daily and diverge in exactly the school someone needs to notice.
   * The label carries the month it actually covers, so the tile cannot be read
   * as being about a period it is not (the same reasoning that made the academic
   * year an echoed value rather than an assumption, above).
   *
   * The rate is present student-days over MARKED student-days, matching the
   * Attendance Analytics dashboard exactly (services/dashboards.ts explains why
   * that denominator and no other). Two screens showing the same metric by two
   * definitions is a trust problem even when both are defensible.
   */
  const attendanceMonth = latestMonth(attendance.rows);
  if (attendanceOutcome.available && attendanceMonth !== null) {
    const marked = sumForMonth(attendance.rows, attendanceMonth, 'marked');
    const present = sumForMonth(attendance.rows, attendanceMonth, 'present');
    if (marked > 0) {
      widgets.push({
        id: 'kpi-attendance',
        type: 'kpi',
        label: `Student attendance · ${monthLabel(attendanceMonth)}`,
        value: `${((present / marked) * 100).toFixed(1)}%`,
        tone: present / marked < 0.75 ? 'warning' : 'neutral',
      });
    }
  } else if (!attendanceOutcome.available) {
    blocked.push({
      label: 'Student attendance',
      reason: attendanceOutcome.reason ?? 'Not available for this session',
      kind: attendanceOutcome.kind,
    });
  } else {
    /**
     * The query ran and found nothing. That is a real and actionable state —
     * nobody has taken the register — and it is not the same as having no
     * permission or having no such data in the ERP, which is why it gets its own
     * words rather than either of theirs.
     */
    blocked.push({
      label: 'Student attendance',
      reason: 'No attendance has been marked for these schools in the last three months',
      kind: 'no_data',
    });
  }

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

  const summary: HomeSummary = {
    spec: parsed.data,
    academic_year: academicYear,
    blocked_metrics: blocked,
    dashboards: DASHBOARDS,
    degraded_schools: degradedFrom([students, staff, outstanding, attendance]),
  };

  /**
   * Cached only when nothing was degraded — a school that was briefly
   * unreachable must not be reported as unreachable for the whole TTL.
   *
   * `blocked_metrics` is NOT a reason to skip the cache: attendance having no
   * source is a stable fact about the ERP extract, not a transient failure, and
   * it will be just as true in ten minutes.
   */
  if (summary.degraded_schools.length === 0) {
    await cacheSet(key, summary, config.CACHE_TTL_SECONDS);
  }

  return summary;
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

/**
 * The most recent month present in the rows, `YYYY-MM`, which sorts as text.
 *
 * The latest month the DATA has, not the current calendar month, and the tile
 * says which one it found. A school that stopped marking in June should see June
 * labelled June — not an empty tile for August that reads as a system fault.
 */
function latestMonth(rows: readonly Record<string, unknown>[]): string | null {
  const months = rows
    .map((row) => row['ym'])
    .filter((value): value is string => typeof value === 'string' && value !== '');
  if (months.length === 0) return null;
  return [...months].sort().reverse()[0] ?? null;
}

/**
 * One field of one month, summed across the schools that answered.
 *
 * Numerator and denominator are summed SEPARATELY and divided by the caller,
 * never averaged from per-school rates: a 200-student school and a
 * 4,000-student one do not weigh the same, and a mean of their percentages says
 * they do.
 */
function sumForMonth(
  rows: readonly Record<string, unknown>[],
  month: string,
  field: string,
): number {
  return rows.reduce(
    (total, row) => (row['ym'] === month ? total + toNumber(row[field]) : total),
    0,
  );
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** `2026-07` -> `Jul 2026`, for a label a person reads rather than sorts. */
function monthLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match === null) return value;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return name === undefined ? value : `${name} ${String(match[1])}`;
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
