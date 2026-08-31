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
  type KpiPart,
  type Widget,
} from '@sap/chart-spec';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import type { SessionClaims } from '../auth/session.js';
import { withMcp, type RunMultiResult } from '../mcp/client.js';
import { schoolNames } from '../db/registry.js';
import { cacheGet, cacheKey, cacheSet, refreshInBackground } from '../cache/result-cache.js';
import { config } from '../config.js';
import {
  DASHBOARD_DRILL_QUERY,
  DASHBOARD_LEAD_QUERY,
  buildDashboard,
  drillPathFor,
  isDashboardId,
  type DashboardId,
} from './dashboards.js';

/**
 * Vetted SQL. Read-only, catalog tables only, no placeholders, no tenant filter
 * — the MCP server injects scope and the row cap itself (docs/04 §3).
 */
const METRIC_SQL = {
  /**
   * Students per year, split by gender for the tile's breakdown.
   *
   * `gender` joins the GROUP BY rather than becoming a second statement: the
   * scan is the same scan, and one extra grouping column is far cheaper than a
   * second pass over the table. Every caller of these rows already sums `n`
   * across whatever else is in them (`sumForYear`), so the total is unchanged
   * by the finer grouping.
   */
  studentsByYear:
    'SELECT academicyearname AS ay, gender, COUNT(*) AS n FROM students_data_set ' +
    'WHERE deactivation_date IS NULL GROUP BY academicyearname, gender',
  /**
   * Staff, split by the ERP's `stafftype` for the tile's breakdown.
   *
   * What that column actually holds is the whole difficulty, and it is handled
   * in `staffParts` rather than here: the SQL reports the column faithfully and
   * the classification is done where it can be explained and tested.
   */
  activeStaff:
    'SELECT stafftype, COUNT(*) AS n FROM employees_data_set ' +
    'WHERE deactivation_date IS NULL GROUP BY stafftype',
  /**
   * The fee book per year: demand raised, received, and still owed.
   *
   * -- Why `WHERE balance_amount > 0` had to go --------------------------------
   * The statement used to filter to rows with a positive balance, which is
   * correct when outstanding is the only figure wanted and WRONG the moment
   * `paid` is: a fully-settled instalment has a zero balance, so the filter
   * excluded precisely the payments that make up most of the collected total.
   * Keeping it would have reported collections that only counted money received
   * from students who still owe something.
   *
   * `n` is therefore computed with a CASE rather than by filtering rows, and it
   * is the SAME number the filtered statement produced: positive balances only.
   * Credits from overpaying students stay out of arrears instead of quietly
   * cancelling another student's debt (the tile says so on screen).
   *
   * The wider scan costs no more in practice. `fee_compile_data_set` carries no
   * usable index for this predicate (mcp-server/src/reports/catalog.ts), so the
   * filtered form was already a full scan — the WHERE discarded rows after
   * reading them rather than avoiding any read.
   */
  feesByYear:
    'SELECT academicyearname AS ay, ROUND(SUM(total_payable_amount)) AS payable, ' +
    'ROUND(SUM(paid_amount)) AS paid, ' +
    'ROUND(SUM(CASE WHEN balance_amount > 0 THEN balance_amount ELSE 0 END)) AS n ' +
    'FROM fee_compile_data_set GROUP BY academicyearname',
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
  /**
   * Every card in the catalog. Still the whole list, because the SIDEBAR
   * renders from it (Sidebar.tsx) and it is also the set a custom report can be
   * cloned from (`listReportSources`).
   */
  readonly dashboards: readonly DashboardCard[];
  /**
   * Which of them the Dashboard GRID draws, in the order it draws them.
   *
   * Sent as ids rather than left for the SPA to filter, for the same reason the
   * card statuses are: what the overview leads with is a decision this service
   * makes, and a second copy of the rule in the browser is a second copy that
   * can disagree. The SPA renders the order it is given.
   */
  readonly grid: readonly string[];
  /** Schools that failed within a fan-out. Annotated, never swallowed (ADR-011). */
  readonly degraded_schools: readonly { school_id: string; message: string }[];
}

/**
 * One dashboard's lead CHART, for the Home overview.
 *
 * `widget` is the chart `DASHBOARD_LEAD_QUERY` names for that dashboard
 * (services/dashboards.ts) — a bar/line/donut, never a KPI and never a table.
 * Home's own KPI strip above already carries the numbers, so the preview's job
 * is to be the thing the strip cannot be: a shape.
 *
 * `status: 'blocked'` covers "no permission", "no data" and "could not be
 * read": either way there is nothing to preview, and the reason travels so the
 * card can say why rather than rendering empty.
 */
export interface HomePreview {
  readonly id: DashboardId;
  readonly title: string;
  readonly icon: string;
  readonly widget: Widget | null;
  readonly status: 'ok' | 'blocked';
  readonly reason?: string;
}

/**
 * The charts the Dashboard grid draws, in the order it draws them.
 *
 * -- Why a curated list and not "everything available" -----------------------
 * The grid used to be every `available` dashboard, which is nine cards and
 * growing. Nine charts under four summary cards is not an overview; it is the
 * sidebar again, drawn larger, and a screen that shows everything ranks nothing.
 * This names the six a reader is meant to scan first, and the rest stay one
 * click away in the sidebar and in the strip below the grid.
 *
 * -- The order is the ranking -------------------------------------------------
 * Money first, because it is what a Director and an Accountant both open the
 * page for; then the two headcount-and-presence charts; then staff and
 * transport, which are read less often. Catalog order would have led with
 * Enrollment for no better reason than that it was built first.
 *
 * -- What "6" is and is not ---------------------------------------------------
 * Six is a product decision, not a technical limit. Four of these have a
 * curated drill path today (`DRILL_PATHS`); Staff Overview and Transport do not
 * yet, and draw their lead chart inert until they grow one. That gap is
 * deliberately visible rather than papered over: a card that cannot be drilled
 * must not pretend it can, so `drillable` on the widget decides it and nothing
 * on this list overrides that.
 */
const DASHBOARD_GRID: readonly DashboardId[] = [
  'fee-collection',
  'fee-defaulters',
  'attendance-analytics',
  'enrollment-overview',
  'staff-overview',
  'transport-analytics',
];

/**
 * The grid's cards, in grid order, filtered to what this build can actually
 * serve.
 *
 * The `status === 'available'` check is not redundant with the list above. The
 * list is a product decision about what the screen leads with; availability is
 * a fact about the build and the ERP extract, decided in `DASHBOARDS`. A
 * dashboard demoted to `coming` or `blocked` must drop out of the grid without
 * anyone remembering to edit two places.
 */
export function previewableDashboards(): readonly (DashboardCard & { id: DashboardId })[] {
  const byId = new Map(DASHBOARDS.map((card) => [card.id, card]));
  return DASHBOARD_GRID.flatMap((id) => {
    const card = byId.get(id);
    return card !== undefined && card.status === 'available' && isDashboardId(card.id)
      ? [card as DashboardCard & { id: DashboardId }]
      : [];
  });
}

/**
 * Everything the grid does NOT draw, for the strip beneath it.
 *
 * Three kinds land here and they are not alike: dashboards that are built and
 * simply not on the grid, ones whose serving path is not written yet
 * (`coming`), and ones the ERP extract has no data for (`blocked`). The first
 * kind is reachable RIGHT NOW, so the strip has to let it be opened rather than
 * showing it greyed beside things that cannot be — which is what the SPA does
 * with the `status` each card already carries.
 */
export function otherDashboards(): readonly DashboardCard[] {
  const onGrid = new Set<string>(DASHBOARD_GRID);
  return DASHBOARDS.filter((card) => !onGrid.has(card.id));
}

/**
 * ONE dashboard's live preview for the Home overview.
 *
 * -- Why one, and not all nine ------------------------------------------------
 * This used to build every available dashboard in full and keep each one's
 * first chart. Measured against the real extract that was 45 queries to produce
 * 9 widgets, 6.7 s for a single school, and — because a school gets three
 * connections (ADR-013) — the cost landed on dashboards that had not earned it:
 * `transport-analytics` reads a 0-row table and still took 6.2 s of that, doing
 * nothing but waiting behind the fee scans.
 *
 * So a preview now asks for the ONE query behind the chart it draws
 * (`DASHBOARD_LEAD_QUERY`), and the endpoint answers for ONE dashboard, so a
 * card appears the moment its own data lands instead of every card waiting for
 * the slowest. Nine cheap requests, not one expensive one.
 *
 * -- What deliberately did NOT change -----------------------------------------
 * Still the same `buildDashboard`, the same vetted `run_predefined` statement,
 * the same double scope check and the same masking — a preview is a narrower
 * REQUEST, never a shortcut past any rail. `query_keys` names one of the
 * report's own pre-vetted queries and nothing else (docs/06 §3's per-widget
 * clone mechanism, mcp-server/src/tools/run-predefined.ts).
 *
 * The one thing that does change is which cache entry it lands in: a preview
 * has its own key (services/dashboards.ts) precisely so a one-widget answer can
 * never be served to the full dashboard page. That costs the old behaviour
 * where loading Home warmed the dashboards — worth it, because the previous
 * "sharing" was only ever free when Home had already paid for all 45 queries.
 */
export async function buildHomePreview(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  reportId: DashboardId;
  academicYear: string;
  asOfDate: string;
  correlationId: string;
}): Promise<HomePreview> {
  const card = previewableDashboards().find((c) => c.id === args.reportId);
  if (card === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'That dashboard has no preview.',
      correlationId: args.correlationId,
    });
  }

  try {
    /**
     * The DRILL-ENTRY chart where the report has one, and the lead chart where
     * it does not.
     *
     * The grid's cards are meant to be descended into (ADR-020: school →
     * quarter → class), so the card must draw the chart that HAS that path —
     * level 1, one bar per school — rather than whatever the report's own page
     * happens to open with. For Fee Collection those are different charts fed
     * by different statements: the page leads with receipts by month, the drill
     * starts from demand by school.
     *
     * A report with no `DRILL_PATHS` entry keeps its lead chart and renders
     * inert. That is the honest state, not a placeholder: Staff Overview and
     * Transport have no curated path yet, and a card that drew a clickable
     * chart over a path that does not exist would refuse the click it invited.
     */
    const path = drillPathFor(card.id);
    let queryKey: string;
    if (path === undefined) {
      queryKey = DASHBOARD_LEAD_QUERY[card.id];
    } else {
      const drillQuery = DASHBOARD_DRILL_QUERY[card.id];
      /**
       * [MANDATORY] CODING_GUIDELINES §10. A path with no drill query declared
       * is a table that has drifted, and the failure it would otherwise produce
       * is the success-shaped kind: the card falls back to the lead chart and
       * renders a NON-drillable chart under a report advertising three levels.
       * Refused here, where it names the missing table, rather than on screen.
       */
      if (drillQuery === undefined) {
        throw new PlatformError({
          code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
          message: 'That dashboard could not be previewed.',
          diagnostics: { report_id: card.id, missing: 'DASHBOARD_DRILL_QUERY' },
          correlationId: args.correlationId,
        });
      }
      queryKey = drillQuery;
    }

    const result = await buildDashboard({
      session: args.session,
      schoolIds: args.schoolIds,
      reportId: card.id,
      academicYear: args.academicYear,
      asOfDate: args.asOfDate,
      correlationId: args.correlationId,
      queryKeys: [queryKey],
    });

    /**
     * Where a drill path exists the widget is chosen BY ID, not by type. That
     * one statement can feed more than one widget — `by_component` builds both
     * Fee Collection's school bars and its fee-head table — so "the first
     * bar/line/donut" is no longer a reliable way to find the drill entry, and
     * picking the wrong one would hand the card a chart with no `drill_dim`.
     *
     * Without a path, the old rule stands: prefer the chart over a KPI, because
     * the summary strip above already carries the numbers and the card's job is
     * to be the thing the strip cannot be — a shape.
     */
    const widget =
      path === undefined
        ? result.spec.widgets.find((w) => w.type === 'bar' || w.type === 'line' || w.type === 'donut')
        : result.spec.widgets.find((w) => w.id === path.widget_id);

    return {
      id: card.id,
      title: card.title,
      icon: card.icon,
      widget: widget ?? result.spec.widgets[0] ?? null,
      status: 'ok',
    };
  } catch (err) {
    /**
     * One dashboard's failure (no permission, no data, a degraded school) must
     * not blank the other eight — the same partial-failure reasoning as the
     * fan-outs above (ADR-011), one level up. Each card is now its own request,
     * so this is what keeps a 200 with a stated reason from becoming a 500 that
     * the SPA would render as a dead card.
     */
    return {
      id: card.id,
      title: card.title,
      icon: card.icon,
      widget: null,
      status: 'blocked',
      reason: err instanceof PlatformError ? err.message : 'This dashboard could not be loaded.',
    };
  }
}

/**
 * The dashboard catalog, with each card's honest state.
 *
 * The set and the wording follow the UX prototype (docs/11 Artifacts) so the
 * screen matches what was designed; the STATUS of each is decided here, on the
 * server, from what the platform can actually serve today. A card's availability
 * is not a UI opinion — the SPA renders what this says.
 *
 * Exported because it is also the catalog of what a NEW custom report can be
 * built from (`listReportSources` in custom-reports.ts, docs/06 §3). One list
 * for both: a card that is `coming` or `blocked` on Home cannot be a report
 * source either, and two tables would eventually disagree about which.
 */
export const DASHBOARDS: readonly DashboardCard[] = [
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
    /**
     * Served now, rebuilt behind the response once stale (cache/result-cache.ts).
     * The KPI strip wants this more than any dashboard does: `outstandingByYear`
     * is a full scan of `fee_compile_data_set`, and this is the screen every user
     * lands on, so without it exactly one user per TTL waits out that scan before
     * seeing anything at all.
     */
    if (hit.stale) {
      refreshInBackground(key, async () =>
        buildHomeSummary({ ...args, correlationId: `${args.correlationId}:refresh` }),
      );
    }
    return {
      ...hit.value,
      spec: { ...hit.value.spec, meta: { ...hit.value.spec.meta, served_from: 'cache' } },
    };
  }

  const { students, staff, fees, attendance } = await withMcp(
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
      const [students, staff, fees, attendance] = await Promise.all([
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
          sql: METRIC_SQL.feesByYear,
        }),
        mcp.call<RunMultiResult>('run_multi', {
          school_ids: [...args.schoolIds],
          sql: METRIC_SQL.attendanceByMonth,
        }),
      ]);
      return { students, staff, fees, attendance };
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
  const feesOutcome = outcomeOf(fees);
  const attendanceOutcome = outcomeOf(attendance);

  /**
   * The academic year comes from whichever metric could be read. Deriving it
   * from students alone meant a session without `students.read` lost the year
   * and therefore silently lost the FEES figure too — one missing permission
   * cascading into an unrelated wrong number.
   */
  const academicYear =
    (studentsOutcome.available ? latestYear(students.rows) : null) ??
    (feesOutcome.available ? latestYear(fees.rows) : null);

  const widgets: Widget[] = [];
  const blocked: BlockedMetric[] = [];

  if (studentsOutcome.available) {
    widgets.push({
      id: 'kpi-students',
      type: 'kpi',
      label: `Students · ${String(scope.length)} school${scope.length > 1 ? 's' : ''}`,
      value: formatCount(sumForYear(students.rows, academicYear)),
      tone: 'neutral',
      /**
       * The gender mix, in the ERP's OWN words.
       *
       * The part labels are whatever `students_data_set.gender` holds,
       * title-cased — never a fixed Boys/Girls pair mapped onto them. A school
       * recording "M"/"F", or a third value, or nothing at all, is reported as
       * it is, so a category this platform did not anticipate cannot be quietly
       * folded into one it did.
       */
      ...breakdownOf(
        mixParts(
          students.rows.filter((row) => row['ay'] === academicYear),
          'gender',
          'n',
          formatCount,
        ),
      ),
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
      ...breakdownOf(staffParts(staff.rows)),
    });
  } else {
    blocked.push({
      label: 'Staff on roll',
      reason: staffOutcome.reason ?? 'Not available for this session',
      kind: staffOutcome.kind,
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
        /**
         * "Present days", not "Present". These are student-DAYS over the month
         * the tile names — the very denominator the rate above is built from —
         * and a part labelled "Present" under a monthly figure reads as a
         * headcount for today. The two differ by roughly the number of school
         * days in the month.
         *
         * Absent is DERIVED as marked − present rather than counted separately,
         * because that is exactly what the rate's denominator makes it: a day
         * nobody marked is in neither part. That is the same caveat Attendance
         * Analytics carries, and the reason both lead with a rate over marked
         * days rather than over working days — the extract names no school
         * calendar, so working days are not knowable here.
         */
        breakdown: [
          { label: 'Present days', value: formatCount(present) },
          { label: 'Absent days', value: formatCount(marked - present) },
        ],
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
   * Fees: the year's whole demand, split into collected and still owed.
   *
   * -- Why the headline moved from outstanding to total ------------------------
   * This tile used to lead with the outstanding balance alone. A bare "₹19.4L
   * outstanding" cannot be read without the size of the book it came from: it is
   * alarming against a ₹25L demand and unremarkable against ₹19Cr. Leading with
   * the demand and naming collected and pending underneath supplies the only
   * context that makes the figure mean anything, and it costs no extra query —
   * all three amounts come from columns the one scan was already reading.
   *
   * -- The parts need not add to the total, and that is deliberate -------------
   * `payable` is the demand raised, `paid` what was received against it, and
   * `pending` the POSITIVE balances only (`feesByYear`). Where a student has
   * overpaid, that credit is left out of pending rather than netted off against
   * another student's arrears, so collected + pending can exceed the demand
   * slightly. Netting would understate what is actually owed, and arrears are
   * the number a bursar acts on.
   */
  if (feesOutcome.available && academicYear !== null) {
    const payable = sumForYear(fees.rows, academicYear, 'payable');
    const paid = sumForYear(fees.rows, academicYear, 'paid');
    const pending = sumForYear(fees.rows, academicYear);
    widgets.push({
      id: 'kpi-fees',
      type: 'kpi',
      label: `Total fees · ${academicYear}`,
      value: formatRupees(payable),
      /**
       * The tile stays neutral and the PENDING part carries the warning. Every
       * school has something pending at any moment, so an amber edge on the
       * whole tile would be permanently lit — a signal that never varies is not
       * a signal, and it would drown out the tiles where amber means something
       * happened.
       */
      tone: 'neutral',
      breakdown: [
        { label: 'Collected', value: formatRupees(paid), tone: 'positive' },
        {
          label: 'Pending',
          value: formatRupees(pending),
          tone: pending > 0 ? 'warning' : 'positive',
        },
      ],
    });
  } else {
    blocked.push({
      label: 'Total fees',
      reason: feesOutcome.reason ?? 'Not available for this session',
      kind: feesOutcome.kind,
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
    title: 'Dashboard',
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
    grid: previewableDashboards().map((card) => card.id),
    degraded_schools: degradedFrom([students, staff, fees, attendance]),
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

/**
 * One field of one academic year, summed across the schools that answered.
 *
 * `field` defaults to `n`, the count/amount every one of these statements
 * carries, so the fee statement's extra `payable` and `paid` columns are read
 * through the same function rather than a parallel one that could drift from it.
 */
function sumForYear(
  rows: readonly Record<string, unknown>[],
  year: string | null,
  field = 'n',
): number {
  if (year === null) return 0;
  return rows.reduce((total, row) => (row['ay'] === year ? total + toNumber(row[field]) : total), 0);
}

/**
 * `{ breakdown }` when there are parts to show, and nothing at all when there
 * are not.
 *
 * Spread into the widget rather than assigned, because `breakdown` is optional
 * in the schema and `exactOptionalPropertyTypes` means an explicit `undefined`
 * is not the same as an absent key. The same shape `dashboards.ts` uses for a
 * bar's optional `series`.
 */
function breakdownOf(parts: readonly KpiPart[]): { breakdown?: KpiPart[] } {
  return parts.length >= 2 ? { breakdown: [...parts] } : {};
}

/**
 * A total's parts, taken from the data's OWN category labels.
 *
 * Nothing here knows what a gender or a category is called. Rows are grouped by
 * whatever string the column holds, ranked by size, and the top ones are
 * reported under their own names — so a school recording "M"/"F", or "MALE"/
 * "FEMALE", or a third value this platform has never seen, is described rather
 * than translated. A blank is "Not recorded", which is a real answer and not
 * the same as absent.
 *
 * Fewer than two parts returns none: a single-part "breakdown" is a second
 * label for the total, and the schema refuses it for that reason.
 *
 * Beyond three, the tail collapses into "Other" rather than being truncated
 * away. The parts stop being a complete account of the total the moment a
 * category is silently dropped, and a reader cannot see that it happened.
 */
function mixParts(
  rows: readonly Record<string, unknown>[],
  labelField: string,
  valueField: string,
  format: (value: number) => string,
): KpiPart[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const raw = String(row[labelField] ?? '').trim();
    const label = raw === '' ? 'Not recorded' : titleCase(raw);
    totals.set(label, (totals.get(label) ?? 0) + toNumber(row[valueField]));
  }

  const ranked = [...totals]
    .filter(([, value]) => value > 0)
    .sort(([, a], [, b]) => b - a);
  if (ranked.length < 2) return [];
  if (ranked.length <= 3) {
    return ranked.map(([label, value]) => ({ label, value: format(value) }));
  }

  const rest = ranked.slice(2).reduce((total, [, value]) => total + value, 0);
  return [
    ...ranked.slice(0, 2).map(([label, value]) => ({ label, value: format(value) })),
    { label: 'Other', value: format(rest) },
  ];
}

/**
 * Employment types this ERP spells out in words, and what they mean.
 *
 * Matched as substrings of the upper-cased value because the extract is not
 * consistent about form — "CONFIRMATION", "CONTRACTUAL", "PROBATION" and
 * "PART TIME" all appear, and a school is free to add another tomorrow.
 */
const PERMANENT_TYPE = /CONFIRM|PERMANENT|REGULAR/;
const IMPERMANENT_TYPE = /CONTRACT|PROBATION|TEMPORARY|TEMP\b|ADHOC|AD[ -]HOC|GUEST|PART[ -]?TIME|TRAINEE|INTERN|PROVISION/;

/**
 * Staff split into permanent, not permanent, and the ones the ERP will not say.
 *
 * -- Why this is not a two-way split -----------------------------------------
 * `employees_data_set.stafftype` holds CONFIRMATION / CONTRACTUAL / PROBATION
 * alongside opaque codes — S0011, S004AD — 19 distinct values across three
 * schools (mcp-server/src/reports/catalog.ts, `by_stafftype`). The words
 * classify themselves. The codes do not, and no mapping for them has been
 * confirmed by anyone.
 *
 * Forcing the codes into one bucket or the other would produce two numbers that
 * look authoritative and are guesses, which is the exact failure this file keeps
 * warning about: a wrong answer wearing the shape of a right one. Dropping them
 * is no better — the parts would then quietly fail to account for the headcount
 * printed directly above them.
 *
 * So they get named. "Unclassified" is a third part, visible on the tile, and a
 * school whose codes dominate can SEE that its employment split is unknown
 * rather than being told a confident fiction. If a mapping is ever confirmed,
 * this is the one place that changes and the part disappears on its own.
 */
function staffParts(rows: readonly Record<string, unknown>[]): KpiPart[] {
  let permanent = 0;
  let impermanent = 0;
  let unclassified = 0;

  for (const row of rows) {
    const type = String(row['stafftype'] ?? '').trim().toUpperCase();
    const count = toNumber(row['n']);
    if (PERMANENT_TYPE.test(type)) permanent += count;
    else if (IMPERMANENT_TYPE.test(type)) impermanent += count;
    else unclassified += count;
  }

  /**
   * Nothing self-described: the column is entirely codes for these schools, so
   * there is no split to report and the tile shows the headcount alone. Three
   * parts reading 0 / 0 / everything is not information.
   */
  if (permanent === 0 && impermanent === 0) return [];

  return [
    { label: 'Permanent', value: formatCount(permanent) },
    { label: 'Not permanent', value: formatCount(impermanent) },
    ...(unclassified > 0
      ? [{ label: 'Unclassified', value: formatCount(unclassified) }]
      : []),
  ];
}

/** `FEMALE` -> `Female`, `ad-hoc` -> `Ad-Hoc`. Labels are read, not sorted. */
function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());
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
