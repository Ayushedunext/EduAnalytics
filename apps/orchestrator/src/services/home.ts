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
  DASHBOARD_PREVIEW,
  buildDashboard,
  drillPathFor,
  isDashboardId,
  previewKindFor,
  type DashboardId,
} from './dashboards.js';
import { MODULES, type ModuleCard, type ModuleId } from './modules.js';

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
   * The floor is a cost decision, not a semantic one. Home is the one screen
   * every user loads, and without a floor the statement groups a school's entire
   * attendance history to render a single month. `CURDATE()` is acceptable here
   * for the same reason it is refused in the reports (mcp-server/src/reports/
   * catalog.ts, AS_OF_DATE): a tile labelled with the month it shows is not a
   * figure anyone will print and reconcile later.
   *
   * -- Why the floor is two academic years and not three months (2026-09-03) ---
   * The floor used to be `CURDATE() - 3 MONTH`, which is a window pinned to
   * TODAY. Every other tile on this strip is pinned to the academic year in the
   * topbar, and the moment that became a control the strip was mixing two time
   * bases: at AY 2026-27 the fee tile showed the year's book while attendance
   * showed "the last three calendar months", and a school whose register stops
   * in April read as a school that has never marked attendance at all.
   *
   * The floor is now 1 April of the PREVIOUS academic year, computed from
   * `CURDATE()` alone — no value is interpolated into this statement, which
   * `run_multi` forbids outright (it takes no placeholders). Two years is what
   * makes the tile answer for both years a reader realistically has selected:
   * the current one and the one before it, which is the same span the reports'
   * "Compare with" control assumes anybody cares about. Months are then filtered
   * to the SELECTED year in `home.ts`, so the tile follows the topbar.
   *
   * A year older than the floor is reported as being outside what this tile
   * covers — never as "no attendance was marked", which would be this file
   * asserting something it did not look for.
   */
  attendanceByMonth:
    "SELECT LEFT(a.attendancedate, 7) AS ym, COUNT(*) AS marked, " +
    "SUM(CASE WHEN a.statusname = 'Present' THEN 1 ELSE 0 END) AS present " +
    'FROM (SELECT MAX(id) AS id FROM student_attendance_data_set ' +
    "WHERE attendancedate >= CONCAT(YEAR(CURDATE()) - IF(MONTH(CURDATE()) < 4, 2, 1), '-04-01') " +
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

/**
 * One metric whose figure covers fewer schools than the reader selected.
 *
 * See `HomeSummary.partial_metrics` for what this is for and why the answer is
 * to annotate rather than to change the number.
 */
export interface PartialMetric {
  /** The tile's own label, so the notice and the tile name the same thing. */
  readonly label: string;
  /**
   * The schools NOT in the figure, by display name.
   *
   * Names, where `degraded_schools` carries ids. The difference is who the line
   * is for: a degraded school is a fault report, and an id is what someone
   * grepping a log needs. This one is read by a director looking at a total and
   * asking which of their schools is in it, and "stmarksmb" does not answer that
   * question for the person asking it.
   */
  readonly schools: readonly string[];
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
  /**
   * Which subject areas this report belongs to (services/modules.ts) — the
   * Module Wise Analysis screen's grouping, held on the CARD rather than in a
   * second table keyed by report id.
   *
   * On the card because a module membership is a fact ABOUT the report, and the
   * card is already where every other such fact lives. A parallel
   * `MODULE_REPORTS` map would be a second list to remember: a report added
   * there and not here, or here and not there, produces a module tile whose
   * count disagrees with what opens inside it, and nothing would fail until a
   * school noticed. Being a field makes it total by TYPE — a new card does not
   * compile without one — and test/modules.test.ts holds the rest.
   *
   * More than one is allowed, and used: Trend Analysis charts six years of fee
   * collection AND twelve of enrollment, so it is genuinely a Fees report and a
   * Student report, and Staff Attendance is read both by whoever runs the staff
   * roll and by whoever watches presence. A report appearing in two modules is
   * the same report, opened from two doors — never a copy.
   */
  readonly modules: readonly ModuleId[];
}

/**
 * One card on the Dashboard grid: which report, and what shape its chart is.
 *
 * A pair rather than a bare id because the two are one decision — see
 * `HomeSummary.grid` and `DASHBOARD_PREVIEW` (services/dashboards.ts).
 */
export interface GridCard {
  /** The card's own id -- what the SPA asks `/api/home/preview/:key` for. */
  readonly key: string;
  /** The REPORT it opens. Two cards may share this (see `DASHBOARD_GRID`). */
  readonly id: string;
  readonly kind: 'bar' | 'line' | 'donut';
}

export interface HomeSummary {
  readonly spec: ChartSpec;
  readonly academic_year: string | null;
  /**
   * Every academic year the SELECTED schools hold data for, newest first — the
   * options behind the topbar's year control (docs/10 §2).
   *
   * -- Why the list is derived and not configured ------------------------------
   * The same rule `academic_year` already follows: the year comes from the data,
   * never from a constant. A hardcoded list ("the last five years") would offer
   * a school a year it has nothing for and hide one it does — and this product
   * serves 1,500+ schools that went live in different years, so there is no list
   * that is right for all of them.
   *
   * -- Why it costs no extra query ---------------------------------------------
   * `studentsByYear` and `feeBookByYear` already GROUP BY the academic year and
   * are already being read for the KPI strip. The years are sitting in rows this
   * function has in hand; taking the union of them is arithmetic, not I/O. That
   * matters more than usual here because Invariant 1 makes every avoidable query
   * against a school database a cost the ERP does not have to pay.
   *
   * -- Why the UNION of two metrics, not the students alone --------------------
   * They genuinely disagree, and each is right about its own subject. A school
   * that has raised next year's fee demand but not yet rolled its students over
   * has fee data for a year its roll has never heard of, which is exactly what
   * the local development extract looks like today. Offering only the years the
   * ROLL knows would make next year's money unreachable from the one control
   * that exists to reach it. `academic_year` — the year the page OPENS on — is
   * unchanged and still prefers the roll: a default is a claim about which year
   * a reader means, and the roll is the better evidence for that than a demand
   * raised in advance.
   *
   * Empty when neither metric could be read, in which case `academic_year` is
   * `null` too and the control has nothing to offer rather than one made-up
   * entry.
   */
  readonly academic_years: readonly string[];
  readonly blocked_metrics: readonly BlockedMetric[];
  /**
   * Metrics whose figure covers only SOME of the selected schools, and which
   * schools are missing from it.
   *
   * -- The bug this exists for -------------------------------------------------
   * The academic year is one value for the whole selection, resolved as the
   * newest year ANY school in it has. Schools roll their student roll over at
   * different times, so a trust of three schools routinely has one school
   * already in the new year and two still in the old one. The strip then
   * resolved to the new year, summed the one school that had it, and printed
   * "Students · 3 schools — 1,760" while 4,801 children in the other two
   * contributed nothing. Every part of that tile was individually defensible and
   * the number was wrong by a factor of four.
   *
   * This is the success-shaped failure of CODING_GUIDELINES §10 in its purest
   * form: not a crash, not a blank, a confident total in the same typeface as
   * the true ones. It is invisible on a staging extract where every school has
   * been rolled over together, and it is guaranteed to appear across 1,500+
   * schools that roll over whenever they each get round to it.
   *
   * -- Why annotate rather than change the number ------------------------------
   * The alternatives are worse. Falling back to the newest year they ALL share
   * would hide the new year from the school that has it — punishing the school
   * that is up to date. Summing whatever each school's own latest year holds
   * would add 2026-27 to 2024-25 and call the result a year. The figure shown is
   * a real figure for a real year; what was missing was any statement of who it
   * covers, which is the same fix ADR-011 already applies to a school that could
   * not be reached (`degraded_schools`) — annotate, never quietly shrink.
   *
   * Empty in the ordinary case where every school has the year, so a selection
   * that is fully covered says nothing at all.
   */
  readonly partial_metrics: readonly PartialMetric[];
  /**
   * Every card in the catalog. Still the whole list, because the SIDEBAR
   * renders from it (Sidebar.tsx) and it is also the set a custom report can be
   * cloned from (`listReportSources`).
   */
  readonly dashboards: readonly DashboardCard[];
  /**
   * Which of them the Dashboard GRID draws, in the order it draws them, each
   * with the KIND of chart its card will hold.
   *
   * Sent by the server rather than left for the SPA to filter or infer, for the
   * same reason the card statuses are: what the overview leads with is a
   * decision this service makes, and a second copy of the rule in the browser is
   * a second copy that can disagree. The SPA renders the order it is given.
   *
   * The `kind` travels because the grid is a BENTO: a trend takes a wider slot
   * than a ring (tokens.css `.pgallery`), and the slot has to be sized before
   * the chart is there to measure. Every card is its own request, so a grid that
   * waited to find out would lay eight equal skeletons and then reflow the page
   * under the reader as each one landed. It is still one decision in one place —
   * `DASHBOARD_PREVIEW` names the chart and its kind together, so the card's
   * width and the card's contents cannot disagree about what it is.
   */
  readonly grid: readonly GridCard[];
  /**
   * The Module Wise Analysis tiles, in the order the screen draws them, each
   * carrying the ids of the reports inside it (`servedModules`).
   *
   * Sent with Home rather than fetched by the module screen on its own. It is
   * static metadata derived from the catalog two fields above — no query, no
   * scope, nothing a second round trip would learn — and travelling together is
   * what keeps the sidebar, the tiles and the report cards reading one answer
   * about what this build can open.
   */
  readonly modules: readonly ModuleCard[];
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
  /**
   * The card this answers for. Equal to `id` for every card except a second
   * view of a report already on the grid (`DASHBOARD_GRID`), which is exactly
   * why the SPA keys its previews map by this and not by `id`.
   */
  readonly key: string;
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
 * -- The count is a product decision, and every card on it drills ------------
 * Eight today: the six this list opened with, plus Staff Attendance and Fee by
 * Student once they existed. There is no technical limit here — what there IS, and what
 * test/home-previews.test.ts holds as [MANDATORY], is that every id on this
 * list has a `DRILL_PATHS` entry AND a `DASHBOARD_DRILL_QUERY` entry. A card
 * drawing a chart nobody can click lies about what happens when you click it,
 * so a dashboard joins this list when it can be descended, not before.
 */
export interface GridSlot {
  /**
   * What the SPA asks for, and what the previews map is keyed by. Equal to
   * `report` for every card except the ones that draw a SECOND view of a report
   * already on the grid.
   */
  readonly key: string;
  readonly report: DashboardId;
  /**
   * `drill-entry` pins the card to the report's level-1 chart (one bar per
   * school, `DASHBOARD_DRILL_QUERY`) instead of the chart `DASHBOARD_PREVIEW`
   * names for it. Absent means the report's own default.
   */
  readonly chart?: 'drill-entry';
}

/**
 * The cards the Dashboard grid draws, in the order it draws them.
 *
 * -- Why a curated list and not "everything available" -----------------------
 * The grid used to be every `available` dashboard, which is nine cards and
 * growing. Nine charts under four summary cards is not an overview; it is the
 * sidebar again, drawn larger, and a screen that shows everything ranks nothing.
 * This names what a reader is meant to scan first, and the rest stay one click
 * away in the sidebar and in the strip below the grid.
 *
 * -- The order is the ranking -------------------------------------------------
 * Money first, because it is what a Director and an Accountant both open the
 * page for; then the two headcount-and-presence charts; then staff and
 * transport, which are read less often. Catalog order would have led with
 * Enrollment for no better reason than that it was built first.
 *
 * -- A report may appear TWICE (2026-09-03) -----------------------------------
 * This was a list of report ids, one card each. It is a list of SLOTS now,
 * because the two fee reports have two things worth seeing and the grid was
 * being made to choose. Fee Collection's receipts curve answers "is the year on
 * track"; its demand/collected/pending bars answer "which school is behind", and
 * that second chart is also the one a reader DRILLS -- school, then quarter, then
 * class, in place on the card (ADR-020). Showing one meant losing the other, and
 * on the two reports this product is opened for most that is the wrong trade.
 *
 * A slot is not a new report and costs nothing extra beyond its own single
 * scan: both fee slots name statements Fee Collection and Fee Defaulters
 * already run for their own pages. The two cards share a title, because they
 * are two views of ONE report and both open it -- what distinguishes them is
 * the chart's own title under the head, which is the widget's, from the spec.
 *
 * [MANDATORY] `key` is unique across this list, and a `drill-entry` slot only
 * names a report that HAS a drill path; test/home-previews.test.ts holds both.
 * A duplicate key would collide in the SPA's previews map and silently draw one
 * card's chart in the other's slot.
 */
export const DASHBOARD_GRID: readonly GridSlot[] = [
  { key: 'fee-collection', report: 'fee-collection' },
  { key: 'fee-collection--by-school', report: 'fee-collection', chart: 'drill-entry' },
  { key: 'fee-defaulters', report: 'fee-defaulters' },
  { key: 'fee-defaulters--by-school', report: 'fee-defaulters', chart: 'drill-entry' },
  { key: 'fee-by-student', report: 'fee-by-student' },
  { key: 'attendance-analytics', report: 'attendance-analytics' },
  { key: 'staff-attendance', report: 'staff-attendance' },
  { key: 'enrollment-overview', report: 'enrollment-overview' },
  { key: 'staff-overview', report: 'staff-overview' },
  { key: 'transport-analytics', report: 'transport-analytics' },
];

/**
 * The chart kind a slot's card will hold -- the declared one, or `bar` for a
 * card drawing a drill entry, which is one bar per school by construction.
 */
export function slotKind(slot: GridSlot): 'bar' | 'line' | 'donut' {
  return slot.chart === 'drill-entry' ? 'bar' : previewKindFor(slot.report);
}

/** A grid slot by its key, for the preview route. */
export function gridSlot(key: string): GridSlot | undefined {
  return DASHBOARD_GRID.find((slot) => slot.key === key);
}

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
export function previewableDashboards(): readonly (DashboardCard & {
  id: DashboardId;
  slot: GridSlot;
})[] {
  const byId = new Map(DASHBOARDS.map((card) => [card.id, card]));
  return DASHBOARD_GRID.flatMap((slot) => {
    const card = byId.get(slot.report);
    return card !== undefined && card.status === 'available' && isDashboardId(card.id)
      ? [{ ...(card as DashboardCard & { id: DashboardId }), slot }]
      : [];
  });
}

/**
 * The catalog as it is SERVED: the menu, the strip, and everything the SPA is
 * allowed to know exists.
 *
 * -- Only what this build can actually open (2026-09-01) ---------------------
 * docs/10 §3's "locked ≠ hidden" is about GATED features: a padlock is a
 * signpost to Settings, and hiding it hides the setting that would open it.
 * That argument does not carry to a card nobody can open from any screen, under
 * any role, with any key. Those come in two kinds and both are withheld:
 *
 *   `coming`  — the serving path is not built. Group Overview, Cross-School
 *               Attendance and School Comparison wait on the rollup store
 *               (ADR-010); Workflow Agents waits on the agent runtime
 *               (ADR-022). Both are still being decided, so there is no date to
 *               give and nothing an admin can do.
 *   `blocked` — the ERP extract carries no such data (AUDIT_REPORT C20). Exam
 *               Performance is the one today. It needs an extract change from
 *               the ERP team, which is not something the school reading the
 *               menu can start.
 *
 * A menu is a list of places you can go. Five rows that go nowhere teach a
 * school to skim past the menu, which costs more than the discoverability the
 * ⛔ was buying — and the reasons themselves survive in `DASHBOARDS` below,
 * where the people who can act on them read them.
 *
 * The CARDS stay, reasons and ADR references intact, and that is the point:
 * when a serving path lands or an extract arrives, its card flips to
 * `available` and reappears here on its own — no list to remember, nothing to
 * re-add. `blocked_metrics` is untouched by this: a KPI tile reading "—  no
 * data" explains a number the strip is visibly missing, which is a different
 * thing from a menu row promising a screen.
 */
export function servedDashboards(): readonly DashboardCard[] {
  return DASHBOARDS.filter((card) => card.status === 'available');
}

/**
 * The Module Wise Analysis tiles, assembled from the two halves that describe
 * them: `MODULES` (services/modules.ts) names the seven subject areas, and each
 * card above says which it belongs to.
 *
 * -- Why a tile can be served with nothing behind it -------------------------
 * `servedDashboards` withholds a report nobody can open, because a menu row is
 * a promise of a screen (docs/10 §3). A module tile is not that promise: the
 * seven are a description of the school's world, fixed, and dropping one leaves
 * a reader to conclude that exams were forgotten. So a module whose every report
 * is withheld is served as `empty`, carrying the withheld reports' OWN reasons —
 * "No exam data exists in the ERP extract" is a fact the school needs and cannot
 * read anywhere else once the report card stopped being served. It does not
 * click, so it promises nothing.
 *
 * The reasons are quoted, never written here. They live on the cards, which is
 * where the extract and rollup-store owners maintain them, and the day an extract
 * lands the tile fills in on its own — the same "flip one status" property that
 * `servedDashboards` has.
 *
 * -- Why a module with neither is dropped -------------------------------------
 * A module id that no card claims at all has nothing to show AND nothing to say.
 * It cannot happen today (test/modules.test.ts holds every module to at least one
 * card) and if it ever does, an empty tile with no reason is worse than no tile.
 */
export function servedModules(): readonly ModuleCard[] {
  return MODULES.flatMap((module): ModuleCard[] => {
    const claimed = DASHBOARDS.filter((card) => card.modules.includes(module.id));
    const open = claimed.filter((card) => card.status === 'available');

    if (open.length > 0) {
      return [{ ...module, report_ids: open.map((card) => card.id), status: 'available' as const }];
    }

    /**
     * De-duplicated because two withheld cards in one module routinely share a
     * reason — the four `coming` ones all name the rollup store — and a tile
     * repeating "Needs the rollup store (ADR-010, Phase 2)" twice reads as a
     * rendering bug rather than as two reports waiting on one thing.
     */
    const reasons = [...new Set(claimed.map((card) => card.reason).filter((r): r is string => r !== undefined))];
    if (reasons.length === 0) return [];

    return [{ ...module, report_ids: [], status: 'empty' as const, reason: reasons.join(' · ') }];
  });
}


/**
 * Everything the grid does NOT draw, for the strip beneath it.
 *
 * One kind lands here now: dashboards that are BUILT and simply not among the
 * eight the grid leads with. They are reachable right now, so every chip in the
 * strip is a real click. It held two other kinds until `servedDashboards`
 * stopped serving them, and losing them is what turned the strip from a mix of
 * live links and dead labels into one list of places to go.
 */
export function otherDashboards(): readonly DashboardCard[] {
  const onGrid = new Set<string>(DASHBOARD_GRID.map((slot) => slot.report));
  return servedDashboards().filter((card) => !onGrid.has(card.id));
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
  /**
   * A grid SLOT key, or a bare dashboard id.
   *
   * The grid may hold two cards for one report (`DASHBOARD_GRID`), so the thing
   * a caller asks for is a card rather than a report. A bare dashboard id is
   * still valid and is what the Module screen sends: no slot matches, and the
   * report's own default preview is built, exactly as before.
   */
  slotKey: string;
  academicYear: string;
  asOfDate: string;
  correlationId: string;
}): Promise<HomePreview> {
  const slot = gridSlot(args.slotKey);
  const reportIdRaw = slot?.report ?? args.slotKey;
  /**
   * Any SERVED dashboard, not just the eight the Dashboard grid leads with
   * (widened 2026-09-01 for Module Wise Analysis).
   *
   * The old check was `previewableDashboards()`, and it was right while the grid
   * was the only caller: asking for a card the grid does not draw was a caller
   * bug. A module screen draws every report in its module — Admissions Funnel,
   * Library & Textbooks, the Principal's Snapshot — and those are `available`
   * reports a reader can already open in full, so refusing them a preview would
   * have meant two kinds of card inside one module: live charts for the gridded
   * ones and dead tiles for the rest, for a reason no reader could see.
   *
   * Nothing else about a preview changes, and the widening is safe for a reason
   * that was already load-bearing: `DASHBOARD_LEAD_QUERY` is total over
   * `DASHBOARD_IDS` ([MANDATORY], test/home-previews.test.ts), so every report
   * here has one vetted statement to ask for, and the no-path branch below
   * already draws that lead chart inert. The GRID is untouched — it is still the
   * curated eight, still ranked by the server, and still holds every card on it
   * to a drill path.
   *
   * What stays refused is a WITHHELD dashboard: `exam-performance` and the four
   * `coming` cards have no screen to preview, and asking for one is still a
   * caller bug rather than a state a card can describe.
   */
  const card = servedDashboards().find((c) => c.id === reportIdRaw);
  if (card === undefined || !isDashboardId(card.id)) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'That dashboard has no preview.',
      correlationId: args.correlationId,
    });
  }
  const reportId: DashboardId = card.id;

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
    /**
     * A `drill-entry` slot deliberately declines the report's declared preview:
     * it exists to put the level-1 chart back on the grid BESIDE that preview
     * (`DASHBOARD_GRID`), so taking the declared one would draw the same card
     * twice.
     */
    const preview = slot?.chart === 'drill-entry' ? undefined : DASHBOARD_PREVIEW[reportId];
    const path = drillPathFor(reportId);
    let queryKey: string;
    if (preview !== undefined) {
      /**
       * A card the grid gives a chart of its OWN (`DASHBOARD_PREVIEW`) — a
       * trend, a ring, a bucket bar — rather than the by-school bars every
       * drill path starts from. Wins over the drill entry deliberately: the
       * table exists precisely to override it, and the report still drills on
       * its own page.
       */
      queryKey = preview.query;
    } else if (path === undefined) {
      queryKey = DASHBOARD_LEAD_QUERY[reportId];
    } else {
      const drillQuery = DASHBOARD_DRILL_QUERY[reportId];
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
          diagnostics: { report_id: reportId, missing: 'DASHBOARD_DRILL_QUERY' },
          correlationId: args.correlationId,
        });
      }
      queryKey = drillQuery;
    }

    const result = await buildDashboard({
      session: args.session,
      schoolIds: args.schoolIds,
      reportId: reportId,
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
    /**
     * By ID in both of the first two cases, because one statement can feed more
     * than one widget — `by_component` builds Fee Collection's school bars AND
     * its fee-head table — so "the first bar/line/donut" is not a reliable way
     * to find a specific chart, and picking the wrong one hands the card a
     * chart with no `drill_dim` or, worse, the wrong subject drawn convincingly.
     *
     * Without either, the old rule stands: prefer the chart over a KPI, because
     * the summary strip above already carries the numbers and the card's job is
     * to be the thing the strip cannot be — a shape.
     */
    const wanted = preview?.widget_id ?? path?.widget_id;
    const widget =
      wanted === undefined
        ? result.spec.widgets.find((w) => w.type === 'bar' || w.type === 'line' || w.type === 'donut')
        : result.spec.widgets.find((w) => w.id === wanted);

    return {
      key: args.slotKey,
      id: reportId,
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
      key: args.slotKey,
      id: reportId,
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
    modules: ['general'],
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
    modules: ['attendance'],
  },
  {
    id: 'workflow-agents',
    title: 'Workflow Agents',
    blurb: 'Automate alerts: absence, fees, library — build your own flows',
    icon: '⚡',
    group: 'director',
    status: 'coming',
    reason: 'The agent runtime is a later phase (ADR-022)',
    modules: ['general'],
  },
  {
    id: 'school-comparison',
    title: 'School Comparison',
    blurb: 'Any metric side-by-side across your schools',
    icon: '⚖️',
    group: 'director',
    status: 'coming',
    reason: 'Needs the rollup store (ADR-010, Phase 2)',
    modules: ['general'],
  },
  {
    id: 'trend-analysis',
    title: 'Trend Analysis',
    blurb: 'Six years of collection, twelve of enrollment, and where each is heading',
    icon: '📈',
    /**
     * `school`, for the reason Comparative Analysis gives one card below: the
     * `director` half of the menu is reserved for the screens ADR-010 puts
     * behind the rollup store, all of which are still `coming`. This report is
     * served by the same per-school fan-out as every other one (ADR-011) and
     * reads as well for a single school as for twenty — a school looking at its
     * own six-year collection curve is the common case, not the exception.
     */
    group: 'school',
    status: 'available',
    /**
     * Both, and not by indecision: the report charts six years of fee COLLECTION
     * and twelve of ENROLLMENT on one page. Filing it under Fees alone would hide
     * the enrollment curve from the module whose whole subject it is.
     */
    modules: ['fees', 'student'],
  },
  {
    id: 'fee-comparative',
    title: 'Comparative Analysis',
    blurb: 'Recovery this year against last, school by school, instalment by instalment',
    icon: '📊',
    /**
     * `school`, not `director`, even though the page a reader sees is a
     * school-by-school comparison.
     *
     * The group decides which half of the menu a card sits in, and the
     * `director` half is reserved for the screens ADR-010 puts behind the rollup
     * store — Group Overview, School Comparison, Cross-School Attendance — all
     * of which are still `coming`. This report is not one of those: it is served
     * by the same per-school fan-out every other report uses (ADR-011), it works
     * for a single school as readily as for twenty, and listing it beside four
     * cards that cannot be opened would suggest it cannot be either.
     */
    group: 'school',
    status: 'available',
    modules: ['fees'],
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
    modules: ['fees'],
  },
  {
    id: 'fee-defaulters',
    title: 'Fee Defaulters',
    blurb: 'Overdue by 30/60/90 bands, by class and fee head, largest balances',
    icon: '⏳',
    group: 'school',
    status: 'available',
    modules: ['fees'],
  },
  {
    id: 'fee-by-student',
    title: 'Fee by Student',
    blurb: 'What each student owes over the whole year, by school, quarter and class',
    icon: '🧾',
    group: 'school',
    /**
     * Names children, and says so. `students`'s identity columns are masked at
     * the MCP layer for a session without `students.read` (rail 6, docs/08
     * §4.5) -- `fees.read` alone sees the amounts against `[masked]`. That is
     * the platform's existing policy applied, not a rule this card invents.
     */
    status: 'available',
    /**
     * Fees only. It is keyed BY student, but what it reports is money owed, and a
     * Student module that opened onto a dues ledger would be answering the fee
     * question from the wrong door.
     */
    modules: ['fees'],
  },
  {
    id: 'staff-overview',
    title: 'Staff Overview',
    blurb: 'Headcount by department and employment type, joiners and attrition',
    icon: '👥',
    group: 'school',
    status: 'available',
    modules: ['staff'],
  },
  {
    id: 'staff-attendance',
    title: 'Staff Attendance',
    blurb: 'Present and absent staff-days by school, quarter and department',
    icon: '🗂️',
    group: 'school',
    /**
     * `available` since 2026-08-31. docs/11 §2 had recorded staff attendance as
     * deliberately NOT a dashboard — the table was catalogued so Ask AI could
     * reach it, but the only staff-attendance entry in docs/06 §2's catalog was
     * the Director's Cross-School Attendance, which needs the rollup store.
     * Building a school-level one was therefore a new catalog entry rather than
     * an implementation of an existing one, which is a decision; it has been
     * taken and docs/11 records the amendment.
     */
    status: 'available',
    /**
     * Read by two different people for two different reasons — whoever runs the
     * staff roll, and whoever watches presence across the school. One report,
     * two doors.
     */
    modules: ['staff', 'attendance'],
  },
  {
    id: 'admissions-funnel',
    title: 'Admissions Funnel',
    blurb: 'Enquiry → registration → application → admission, and where it leaks',
    icon: '📝',
    group: 'school',
    status: 'available',
    modules: ['student'],
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
    modules: ['attendance'],
  },
  {
    id: 'exam-performance',
    title: 'Exam Performance',
    blurb: 'Term averages, subject distribution, toppers',
    icon: '🏅',
    group: 'school',
    status: 'blocked',
    reason: 'No exam data exists in the ERP extract',
    /**
     * The only report in its module, and withheld — which is why the Exam tile
     * renders `empty` with this card's own reason rather than vanishing
     * (services/modules.ts).
     */
    modules: ['exam'],
  },
  {
    id: 'enrollment-overview',
    title: 'Enrollment Overview',
    blurb: 'Class mix, YoY growth, gender ratio',
    icon: '🎓',
    group: 'school',
    status: 'available',
    modules: ['student'],
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
    modules: ['transport'],
  },
  {
    id: 'library-textbooks',
    title: 'Library & Textbooks',
    blurb: 'Issues by month, low-stock alerts, overdues',
    icon: '📚',
    group: 'school',
    // Same caveat as Transport Analytics above: available on an unverified schema.
    status: 'available',
    modules: ['general'],
  },
  {
    id: 'principal-snapshot',
    title: "Principal's Snapshot",
    blurb: 'Enrollment, fees, staff, admissions and attendance in one page',
    icon: '🏫',
    group: 'school',
    status: 'available',
    /**
     * General, not all five of the modules it reports on. A one-page snapshot
     * that appeared inside Fees, Staff, Attendance and Student would pad every
     * module with the same card and tell a reader nothing about which one they
     * are in.
     */
    modules: ['general'],
  },
];

export async function buildHomeSummary(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  /**
   * The year the reader picked in the topbar, if they picked one.
   *
   * Absent means "resolve it from the data", which is what this function always
   * did and still does. Present means the strip is rebuilt for that year — the
   * tiles have to follow the control, or the page contradicts itself: the grid's
   * preview cards already take the year as a parameter, so a strip that stayed
   * on the derived year would put next year's charts under last year's totals
   * with nothing on screen admitting the two were different.
   *
   * Validated for SHAPE at the route and for MEMBERSHIP here: a year the data
   * has no rows for falls back to the derived one rather than summing nothing
   * into a confident `0` (see `requestedYear` below).
   */
  academicYear?: string | undefined;
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
    /**
     * The requested year is part of the key, because it changes every figure in
     * the response. Omitted when there is none, so the default request keeps the
     * key it has always had and a deploy does not cold-start the landing screen
     * for every school at once.
     */
    filters: args.academicYear === undefined ? {} : { academic_year: args.academicYear },
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
  const derivedYear =
    (studentsOutcome.available ? latestYear(students.rows) : null) ??
    (feesOutcome.available ? latestYear(fees.rows) : null);

  /**
   * The years the control offers. See `HomeSummary.academic_years` for why this
   * is the union of the two metrics rather than the one the default comes from.
   *
   * `academicYear` is in here by construction whenever it is not null — it is
   * the maximum of one of the two sets being unioned — so the control can never
   * open showing a value that is not one of its own options.
   */
  const academicYears = yearsIn([
    ...(studentsOutcome.available ? students.rows : []),
    ...(feesOutcome.available ? fees.rows : []),
  ]);

  /**
   * The year this strip is actually built for.
   *
   * A requested year is honoured only if the data HAS it. That check is not
   * defensive tidiness — it is the difference between a tile that says nothing
   * and a tile that lies. `sumForYear` over a year with no rows returns 0, and 0
   * renders in the same confident typeface as every true number on the page,
   * which is the exact bug the tests at the top of test/home-summary.ts exist
   * for. The SPA only offers years from `academic_years`, so this should never
   * fire from our own UI; it fires for a stale bookmark, a hand-edited URL, or a
   * school whose data moved between the page loading and the request landing.
   */
  const academicYear =
    args.academicYear !== undefined && academicYears.includes(args.academicYear)
      ? args.academicYear
      : derivedYear;

  const widgets: Widget[] = [];
  const blocked: BlockedMetric[] = [];

  /**
   * Whether a metric has anything to say about the year on screen.
   *
   * Separate from `outcomeOf` and answering a different question: that one asks
   * whether the query was allowed to RUN, this one asks whether the answer
   * covers the year being shown. Both must hold before a figure is drawn, and
   * only the first used to be checked — which was invisible while the year was
   * always derived FROM one of these metrics, and became reachable the moment a
   * reader could pick a year for themselves.
   *
   * The case this is really for is the ordinary one: a school that has raised
   * next year's fee demand before rolling its student roll over. Ask for next
   * year and the roll has nothing — so the tile says so, naming the year, rather
   * than reporting that the school has no children.
   */
  const hasRowsForYear = (rows: readonly Record<string, unknown>[]): boolean =>
    academicYear !== null && rows.some((row) => row['ay'] === academicYear);

  const studentsForYear = studentsOutcome.available && hasRowsForYear(students.rows);
  const feesForYear = feesOutcome.available && hasRowsForYear(fees.rows);

  /**
   * Which selected schools are NOT in a metric's figure for the year on screen.
   *
   * Every row from `run_multi` is tagged with its `school_id` (ADR-011,
   * tools/run-multi.ts), so this needs no extra column, no change to the vetted
   * SQL and no second query — the evidence was already in the rows being summed.
   * A school contributes nothing when it has no row for this year at all, which
   * is the ordinary "has not rolled its roll over yet" case.
   *
   * Note this asks about the YEAR, not about zero. A school with a genuine zero
   * for the year IS in the figure and is not listed here: it answered, and its
   * answer was none. Conflating "answered nothing" with "was not asked about
   * this year" would put a school on a caveat line that has no business there.
   */
  const schoolsMissingYear = (rows: readonly Record<string, unknown>[]): string[] => {
    if (academicYear === null) return [];
    const present = new Set<string>();
    for (const row of rows) {
      if (row['ay'] === academicYear) present.add(String(row['school_id'] ?? ''));
    }
    return scope.filter((s) => !present.has(s.school_id)).map((s) => s.school_name);
  };

  const studentsMissing = studentsForYear ? schoolsMissingYear(students.rows) : [];
  const feesMissing = feesForYear ? schoolsMissingYear(fees.rows) : [];
  const partial: PartialMetric[] = [];

  /** What a tile says when its query ran fine and the chosen year is simply empty. */
  const noRowsReason = (subject: string): string =>
    `No ${subject} recorded for ${academicYear ?? 'this year'}.`;

  if (studentsForYear) {
    widgets.push({
      id: 'kpi-students',
      type: 'kpi',
      /**
       * The count of schools in the LABEL is the count that contributed, never
       * the count selected.
       *
       * The notice above the strip names which are missing, but the tile has to
       * be honest standing alone: it is the thing that gets screenshotted, read
       * across a room, and quoted in a meeting, and "3 schools" over a
       * one-school figure is wrong in every one of those settings even when a
       * caveat is sitting above it.
       */
      label:
        studentsMissing.length === 0
          ? `Students · ${String(scope.length)} school${scope.length > 1 ? 's' : ''}`
          : `Students · ${String(scope.length - studentsMissing.length)} of ${String(scope.length)} schools`,
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
    if (studentsMissing.length > 0) partial.push({ label: 'Students', schools: studentsMissing });
  } else if (studentsOutcome.available) {
    // The query ran; this year simply has no roll yet. A different fact from a
    // refusal, so it is reported as `no_data` and says which year it means.
    blocked.push({ label: 'Students', reason: noRowsReason('students'), kind: 'no_data' });
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
  const attendanceMonth = latestMonth(attendance.rows, academicYear);
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
     * The query ran and this year has no marked month in it. That is a real and
     * actionable state — nobody has taken the register — and it is not the same
     * as having no permission or no such data in the ERP, which is why it gets
     * its own words rather than either of theirs.
     *
     * The two reasons below are a distinction this tile has to draw honestly.
     * The statement reaches back two academic years and no further (see
     * `attendanceByMonth`), so for an older year the truthful answer is that the
     * tile did not look — not that nothing was marked. Saying "no attendance was
     * marked in 2019-20" on the strength of a query that never covered 2019-20
     * would be this file asserting a fact it does not have, which is the same
     * error as summing an absent year into a confident zero.
     */
    blocked.push({
      label: 'Student attendance',
      reason:
        academicYear !== null && !withinAttendanceReach(academicYear)
          ? `This tile covers the current and previous academic year; open Attendance Analytics for ${academicYear}`
          : `No attendance has been marked for these schools in ${academicYear ?? 'this year'}`,
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
  if (feesForYear && academicYear !== null) {
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
    /**
     * Realisation — collected over demand, as a rate.
     *
     * The tile above already carries both halves of this fraction, so why a
     * fifth tile: because a rate is the thing a bursar acts on and reading it
     * off two rupee figures is arithmetic the reader should not be doing at a
     * glance. ₹48.8Cr against ₹92.0Cr is 53%, and nobody sees that instantly.
     * It is the same measure the Fee Collection dashboard leads with, computed
     * the same way, so the two screens cannot disagree.
     *
     * From SUMMED totals, never an average of per-school rates — averaging
     * percentages weights a 200-pupil school like a 4,000-pupil one.
     *
     * `tone: 'neutral'`, matching the Fee Collection tile. A threshold for "good
     * realisation" is a judgement that varies by school, by month and by how
     * much of the year has elapsed, and this service has no basis for one — a
     * tile that turned amber below a number invented here would be asserting a
     * standard nobody set.
     */
    if (payable > 0) {
      widgets.push({
        id: 'kpi-realisation',
        type: 'kpi',
        label: 'Fee realisation',
        value: formatPct(paid / payable),
        tone: 'neutral',
      });
    }
    if (feesMissing.length > 0) partial.push({ label: 'Total fees', schools: feesMissing });
  } else if (feesOutcome.available) {
    // Same distinction the students tile draws: the fee query ran, and this year
    // has no demand raised against it yet.
    blocked.push({ label: 'Total fees', reason: noRowsReason('fees'), kind: 'no_data' });
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
    academic_years: academicYears,
    blocked_metrics: blocked,
    partial_metrics: partial,
    dashboards: servedDashboards(),
    grid: previewableDashboards().map((card) => ({
      key: card.slot.key,
      id: card.id,
      kind: slotKind(card.slot),
    })),
    modules: servedModules(),
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
  return yearsIn(rows)[0] ?? null;
}

/**
 * The distinct academic years present in a set of statement rows, newest first.
 *
 * Sorted as TEXT, which is correct for the labels the ERP writes and is the same
 * comparison `latestYear` has always made: `2024-25` < `2025-26` < `2026-27`
 * lexically as well as chronologically, because the leading four digits are a
 * fixed-width year. It holds for the long spelling (`2024-2025`) too. What it
 * would not survive is a school labelling a year some third way, and the honest
 * answer there is that the label is the ERP's to define — inventing a parser for
 * shapes nobody has seen would be guessing at data rather than reporting it.
 */
function yearsIn(rows: readonly Record<string, unknown>[]): string[] {
  const years = new Set<string>();
  for (const row of rows) {
    const value = row['ay'];
    if (typeof value === 'string' && value !== '') years.add(value);
  }
  return [...years].sort().reverse();
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
function latestMonth(
  rows: readonly Record<string, unknown>[],
  /**
   * The academic year the strip is showing, or null to take the latest month
   * from whatever came back.
   *
   * Constrained since 2026-09-03. The statement fetches two academic years so
   * the tile can answer for either (see `attendanceByMonth`), which means the
   * newest month in the rows is not necessarily in the year the reader picked —
   * and a tile reading "Student attendance · Apr 2026" under a topbar saying
   * 2025-26 is the mislabelling the year control was built to end.
   */
  academicYear: string | null,
): string | null {
  const window = academicYear === null ? null : academicYearMonths(academicYear);
  const months = rows
    .map((row) => row['ym'])
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .filter((ym) => window === null || (ym >= window.from && ym <= window.to));
  if (months.length === 0) return null;
  return [...months].sort().reverse()[0] ?? null;
}

/**
 * Whether a year is inside the span `attendanceByMonth` actually fetches: the
 * current academic year and the one before it.
 *
 * Derived the same way the SQL's floor is — April starts the year — so the two
 * cannot drift apart. It exists so the tile can say "I did not look at that
 * year" instead of "nothing was marked that year", which are different claims
 * and only one of them is true.
 */
function withinAttendanceReach(academicYear: string, now = new Date()): boolean {
  const start = Number(academicYear.slice(0, 4));
  if (!Number.isInteger(start)) return true;
  const currentStart = now.getMonth() + 1 < 4 ? now.getFullYear() - 1 : now.getFullYear();
  return start >= currentStart - 1;
}

/**
 * An academic year as a pair of `YYYY-MM` bounds, inclusive.
 *
 * April to March, the same boundary `academicYearWindow` uses in
 * services/dashboards.ts and the same one every quarter in the product is cut
 * on — so the tile and the Attendance Analytics dashboard cover exactly the
 * same months. Two screens showing one metric over two different periods is a
 * trust problem even when both are defensible.
 *
 * A label this cannot read yields null, and the caller then falls back to the
 * latest month it has rather than showing nothing: an unparseable year is this
 * function's problem, not a reason to hide a figure that exists.
 */
function academicYearMonths(academicYear: string): { from: string; to: string } | null {
  const start = Number(academicYear.slice(0, 4));
  if (!Number.isInteger(start)) return null;
  return { from: `${String(start)}-04`, to: `${String(start + 1)}-03` };
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
/** A rate as a display string, to one decimal — the product's one spelling of a percentage. */
function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

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
