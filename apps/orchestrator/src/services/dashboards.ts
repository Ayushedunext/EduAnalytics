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
import { cacheGet, cacheKey, cacheSet, refreshInBackground } from '../cache/result-cache.js';
import { config } from '../config.js';

/** What `run_predefined` returns. Parsed, never trusted as a domain type (§3). */
export interface PredefinedResult {
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
  'attendance-analytics',
  'principal-snapshot',
  'transport-analytics',
  'library-textbooks',
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
export const REPORT_FILTERS: Record<
  DashboardId,
  { academicYear: boolean; asOf: boolean; dateWindow: boolean }
> = {
  'enrollment-overview': { academicYear: true, asOf: false, dateWindow: false },
  'fee-collection': { academicYear: true, asOf: false, dateWindow: false },
  'fee-defaulters': { academicYear: true, asOf: true, dateWindow: false },
  'staff-overview': { academicYear: false, asOf: true, dateWindow: false },
  'admissions-funnel': { academicYear: true, asOf: false, dateWindow: false },
  /**
   * Attendance binds BOTH, against two different tables, because neither table
   * can answer for the other. The year goes to `students_data_set` to count who
   * was on roll; the window goes to `student_attendance_data_set`, whose own
   * year column is stamped with the current year rather than the row's and
   * cannot be filtered on (mcp-server/src/reports/catalog.ts, FROM_DATE).
   */
  'attendance-analytics': { academicYear: true, asOf: false, dateWindow: true },
  /** Reads students, fees, staff, admissions AND attendance -- all four filters. */
  'principal-snapshot': { academicYear: true, asOf: true, dateWindow: true },
  /**
   * No filters at all -- corrected 2026-08-26 once the real schema showed why:
   * `student_transport_data_set` has no trustworthy date column (its
   * `academicyearname` carries the same stamped-current-year trap as the
   * attendance tables, and there is nothing else to filter on instead), so a
   * query here reads whatever the table holds, unfiltered by time.
   */
  'transport-analytics': { academicYear: false, asOf: false, dateWindow: false },
  /**
   * As-of date plus a date WINDOW, not an academic year -- corrected
   * 2026-08-26 for the same reason as Attendance: `book_issue_data_set`'s
   * `academicyearname` is stamped with the current year regardless of
   * `issuedate` (confirmed on 2023/2024 rows all reading `2026-27`), so
   * `issues_by_month` filters on `issuedate` directly via the same
   * `from_date`/`to_date` window Attendance already binds.
   */
  'library-textbooks': { academicYear: false, asOf: true, dateWindow: true },
};

/**
 * The academic year, as the two dates it spans.
 *
 * April to March, which is the Indian school year and is what this ERP writes:
 * every row of `student_attendance_data_set` carries `academicyearfromdate`
 * 01-04-YYYY and `academicyeartodate` 31-03-YYYY+1. It is derived here rather
 * than read from the data because the caller needs the window BEFORE the query
 * that would tell it — and because a report whose window depends on the rows it
 * returns cannot report an empty period at all.
 *
 * If a school is ever onboarded on a different year boundary this is the one
 * place that is wrong, and it is wrong loudly: the window appears as two filter
 * pills on the logic panel, so the dates a number was computed over are on the
 * screen beside the number (Invariant 6).
 */
function academicYearWindow(year: string): { from: string; to: string } {
  const start = Number(year.slice(0, 4));
  if (!Number.isInteger(start)) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'That academic year could not be read as a date range.',
      diagnostics: { academic_year: year },
    });
  }
  return { from: `${String(start)}-04-01`, to: `${String(start + 1)}-03-31` };
}

/**
 * Turn (report id, year, as-of date) into the `run_predefined` params AND the
 * Logic-panel filter chips — the same two things `buildDashboard` always
 * derived inline. Exported so services/custom-reports.ts can build the
 * identical params for a CLONE of a predefined report (ADR-018): a clone's
 * filter values are edited through this exact vocabulary, never a free-form
 * one, so "customize" never means "invent a filter the base report never
 * declared."
 */
export function resolveReportParams(
  reportId: DashboardId,
  args: { academicYear: string; asOfDate: string },
): { params: Record<string, string>; filterChips: { label: string; value: string }[] } {
  const filters = REPORT_FILTERS[reportId];
  const params: Record<string, string> = {};
  if (filters.academicYear) params['academic_year'] = args.academicYear;
  if (filters.asOf) params['as_of_date'] = args.asOfDate;
  const window = filters.dateWindow ? academicYearWindow(args.academicYear) : null;
  if (window !== null) {
    params['from_date'] = window.from;
    params['to_date'] = window.to;
  }

  const filterChips = [
    ...(filters.academicYear ? [{ label: 'Academic year', value: args.academicYear }] : []),
    ...(filters.asOf ? [{ label: 'As of', value: args.asOfDate }] : []),
    ...(window === null
      ? []
      : [
          { label: 'From', value: window.from },
          { label: 'To', value: window.to },
        ]),
  ];

  return { params, filterChips };
}

/**
 * Per-widget clone (docs/06 §3, "clone & customize" scoped to one chart
 * rather than a whole dashboard) — which named `run_predefined` query key
 * feeds a given widget id. Keyed by report id so a widget clone is a table
 * lookup, not a new branch, the same reasoning `REPORT_FILTERS` already
 * follows. Populated for Fee Collection first (the reference
 * implementation); the remaining dashboards extend this table as they get
 * the same treatment (docs/11 tracks the rollout).
 *
 * A widget id absent from its report's map cannot be cloned on its own —
 * `services/custom-reports.ts` refuses the request rather than guessing.
 */
export const WIDGET_QUERY_KEYS: Partial<Record<DashboardId, Readonly<Record<string, string>>>> = {
  'fee-collection': {
    'line-month': 'by_month',
    'bar-class': 'by_class',
    'donut-mode': 'by_mode',
    'table-component': 'by_component',
  },
};

/**
 * The ONE query behind each dashboard's lead chart — what Home's preview cards
 * actually need.
 *
 * -- Why this table exists ----------------------------------------------------
 * Home previewed nine dashboards by building each one in full and then keeping
 * its first chart: 45 queries issued to draw 9 widgets, with 36 results parsed,
 * merged, masked and thrown away. Against the real extract that measured 6.7 s
 * for one school, and the cost was not evenly spread — a 0-row transport query
 * took 6.2 s of it, purely queued behind fee scans in a school's three-connection
 * pool (ADR-013). Fetching only the lead query removes the queue with the work.
 *
 * -- Why a table and not "the first widget" -----------------------------------
 * The old code picked the lead widget by INSPECTING the built spec. That cannot
 * work once the fetch is narrowed, because you must know which query to ask for
 * before you have anything to inspect. So the choice is declared, and declared
 * here beside `WIDGET_QUERY_KEYS` rather than in services/home.ts: which result
 * set feeds which widget is a fact about the REPORT, and this module already
 * owns that mapping. Home decides to show a preview; it does not decide what a
 * dashboard's headline chart is.
 *
 * Each entry names the query feeding the first `bar`/`line`/`donut` its builder
 * pushes, which is the same widget the previous inspect-the-spec code selected —
 * the selection is unchanged, only the moment it is made. `enrollment-overview`
 * is `by_class` (bar-class), `fee-collection` `by_month` (line-month), and so
 * on. A dashboard whose lead query returns no rows previews as blocked with its
 * reason, which is the state it was already in when the whole report was empty.
 *
 * [MANDATORY] every key here must name a real query in the report's catalog
 * entry (mcp-server/src/reports/catalog.ts) — test/home-previews.test.ts asserts
 * the table is total over DASHBOARD_IDS, and the MCP server refuses an unknown
 * key outright rather than silently running the whole report.
 */
export const DASHBOARD_LEAD_QUERY: Record<DashboardId, string> = {
  'enrollment-overview': 'by_class',
  'fee-collection': 'by_month',
  'fee-defaulters': 'aging',
  'staff-overview': 'by_department',
  'admissions-funnel': 'funnel',
  'attendance-analytics': 'by_month',
  'principal-snapshot': 'by_class',
  'transport-analytics': 'by_pickup_route',
  'library-textbooks': 'issues_by_month',
};

/**
 * The ONE query behind each dashboard's DRILL-ENTRY chart — the school-level
 * bar that the Dashboard grid draws and that a reader clicks to descend.
 *
 * -- Why this is not `DASHBOARD_LEAD_QUERY` ----------------------------------
 * The two answer different questions and, for three of the four, name different
 * statements. A dashboard's LEAD chart is whatever its own page opens with —
 * Fee Collection leads with receipts by month, a line. Its DRILL-ENTRY chart is
 * level 1 of the curated path (`DRILL_PATHS`): one bar per school, the thing a
 * click descends from. The Dashboard grid wants the second, because a card
 * showing a chart that cannot be drilled is a card that lies about what happens
 * when you click it.
 *
 * Only the mapping differs. Both tables name a query the report already vets,
 * both are fetched through the same `run_predefined` with one `query_keys`
 * entry, and neither is a second serving path.
 *
 * -- Why level 1 costs no query of its own ------------------------------------
 * Every entry here names a statement the DASHBOARD ALREADY RUNS for something
 * else, re-grouped per school rather than summed across schools
 * (`Merged.sumPerSchool`). Fee Collection's school bars come from the same
 * `by_component` rows its fee-head table reads; Fee Defaulters' from the
 * `totals` rows behind its KPI tiles. So the grid costs exactly one scan per
 * card, the same as the lead-chart previews it replaces — and it is the SAME
 * scan the full report pays for, which is what ADR-020 means by a drill being a
 * re-grouping rather than a new query.
 *
 * [MANDATORY] partial by design, and that is the invariant to keep: an entry
 * here exists if and only if the report has a `DRILL_PATHS` entry, because a
 * drill-entry query with no path to descend is a chart that renders clickable
 * and refuses the click. test/home-previews.test.ts asserts the two tables
 * agree in both directions.
 */
export const DASHBOARD_DRILL_QUERY: Partial<Record<DashboardId, string>> = {
  'enrollment-overview': 'by_class',
  'fee-collection': 'by_component',
  'fee-defaulters': 'totals',
  'attendance-analytics': 'summary',
  'staff-overview': 'by_department',
  'transport-analytics': 'by_pickup_route',
};

/**
 * Which of a report's widgets accept a `bucket` override, and which values —
 * a widget's own SQL declares its bucket variants (mcp-server/src/reports/
 * catalog.ts); this table only says which widgets HAVE one, for the clone
 * form to offer. `'month'` is always the default and is never listed as an
 * override choice — cloning without picking a bucket reproduces the
 * original grouping.
 */
export const WIDGET_BUCKET_OPTIONS: Partial<Record<DashboardId, Readonly<Record<string, readonly string[]>>>> = {
  'fee-collection': {
    'line-month': ['week', 'month', 'quarter', 'year'],
  },
};

/**
 * The Dimension Hierarchy Catalog ADR-020 requires — the ONLY drill paths that
 * exist.
 *
 * -- Why a table and not a per-report branch ---------------------------------
 * ADR-020 rejects free-form drill on any column ("nonsense paths, PII leaks,
 * unbounded queries"). That is only enforceable if there is one place that
 * enumerates what may be drilled into: the route validates a click against this
 * table, so a request naming a dimension no level declares is refused rather
 * than turned into a GROUP BY. A click can pick a level; it cannot invent one.
 *
 * -- What a level is ----------------------------------------------------------
 * `dim` is the dimension a click at the PREVIOUS level pushed to get here, and
 * the value it pushed is bound as a parameter (`param`) or narrows the school
 * set (`kind: 'scope'`) — never concatenated. `query` names one of the report's
 * own pre-vetted statements; level 1 has none because it re-groups a result set
 * the base dashboard already fetched.
 *
 * Three levels maximum, by ADR-020 and by `drillContextSchema.max(3)`. Levels
 * 2-3 are optional in the ADR (a 2-level drill is valid); this path uses all
 * three.
 */
export interface DrillLevel {
  /** The dimension a click at this level pushes onto the stack. Absent at the leaf. */
  readonly drill_dim?: string;
  /** Field in the level's rows carrying the value to push, when it is not the axis label. */
  readonly drill_value_field?: string;
  /** Which `run_predefined` query feeds this level. Absent at level 1 (see above). */
  readonly query?: string;
  /** The x-axis field of the level's chart. */
  readonly x: string;
  /** How the value pushed to REACH this level is applied. */
  readonly narrow?:
    | { readonly kind: 'scope' }
    | {
        readonly kind: 'param';
        readonly param: string;
        /**
         * Matches the `ReportParam` type the catalog declares, so a click's
         * value is refused at the MCP boundary if it arrives as the wrong kind
         * — a quarter is a number, a class name is a string, and neither is
         * coerced into the other on the way down.
         */
        readonly type: 'number' | 'string';
      };
  /** Title for the chart at this level, `{context}` replaced by the breadcrumb. */
  readonly title: string;
  /** For the Logic panel's group-by line at this level. */
  readonly group_by: string;
  /**
   * A caveat that is true at THIS level and not at the others, shown beside the
   * chart rather than in the report's notes.
   *
   * It exists because of one specific, measured hazard: a defaulter count is a
   * count of PEOPLE, and a student overdue in two quarters is one defaulter at
   * school level but a bar in both quarters. At sacskb the four quarter bars
   * total 15,367 against a school figure of 5,155 — a reader who adds them up is
   * not slightly off, they are out by a factor of three. A note in the report's
   * notes list, below the fold and shared by every level, is not where that
   * belongs; it belongs against the bars that would mislead.
   */
  readonly note?: string;
  /**
   * Categories at this level that EXIST but cannot carry a value yet, and how
   * to say so.
   *
   * Fee Defaulters' quarters are the case this was built for. Q3 and Q4 of the
   * current year hold real demand, but on 29 August nothing in them is late,
   * because their due dates have not arrived. A chart that simply omitted them
   * left a reader unable to tell "no defaulters" from "not due yet" from "does
   * not exist" — and at Meera Bagh the honest answer involved nearly 24,000
   * outstanding rows, so the ambiguity ran in the reassuring direction.
   *
   * `field` names a bookkeeping column the level's SQL returns alongside its
   * measures — zero when the category is not yet measurable. It is used to
   * build the note and is then DROPPED, never drawn: it is not a measure and a
   * reader has no use for a count of ledger rows.
   *
   * `note` is a template. `{categories}` becomes the labels of the categories
   * concerned and `{as_of}` the date they were measured against, so the
   * sentence names the quarters rather than gesturing at them.
   */
  readonly pending?: {
    readonly field: string;
    readonly note: string;
    /**
     * Used instead of `note` when EVERY category is pending, because listing
     * them all is not a sentence — "Nothing in NURSERY, K.G., I, II, III …
     * was due" says less than "nothing in this quarter was due", at four times
     * the length. Absent means `note` is used regardless.
     */
    readonly note_all?: string;
  };
}

export interface DrillPath {
  /** The widget a click starts from. Only this widget of the report drills. */
  readonly widget_id: string;
  /**
   * The measures drawn at every level, in legend order.
   *
   * One or more. Several become a grouped bar with a legend (Fee Collection's
   * payable/collected/pending); ONE stays a plain single-series bar, keeping
   * the gradient and tallest-bar highlight that only make sense when a chart is
   * comparing within itself (Fee Defaulters' headcount). Named `measures` and
   * not `series` because `bar.series` in the spec means specifically the
   * grouped case and requires at least two — the emitter below sets it only
   * when there really are.
   */
  readonly measures: readonly { readonly field: string; readonly label: string }[];
  readonly levels: readonly [DrillLevel, ...DrillLevel[]];
}

/**
 * Fees: school → quarter → class, which is docs/06 §4.4's curated fee path
 * expressed against the demand ledger (the doc writes it month→class→fee_type;
 * the demand ledger buckets by the period money was owed FOR, and a school
 * reads that in quarters — the same shape, one bucket coarser).
 *
 * Level 1 costs no query at all: `by_component` is already on the page, and
 * grouping those rows by school rather than summing them across schools answers
 * "which school is behind?" for free. That matters here more than it would
 * elsewhere — the fee tables carry no usable index, so each avoided scan is
 * seconds (apps/mcp-server/src/reports/catalog.ts).
 */
export const DRILL_PATHS: Partial<Record<DashboardId, DrillPath>> = {
  'fee-collection': {
    widget_id: 'bar-school',
    measures: [
      { field: 'payable', label: 'Fee payable' },
      { field: 'collected', label: 'Fee collected' },
      { field: 'pending', label: 'Fee pending' },
    ],
    levels: [
      {
        x: 'school_name',
        drill_dim: 'school',
        /**
         * The axis reads a school's NAME and the click pushes its id. Binding
         * the visible label would make the drill depend on names being unique
         * and never edited in the ERP — neither of which the registry promises.
         */
        drill_value_field: 'school_id',
        title: 'Demand, collection and pending by school',
        group_by: 'school',
      },
      {
        x: 'quarter',
        drill_dim: 'quarter',
        drill_value_field: 'seq',
        query: 'demand_by_quarter',
        /**
         * A school is not a filter value: narrowing to one is a SCOPE
         * narrowing, so it goes through the same intersect-with-the-token check
         * every other request makes (ADR-007 layer 1, then again at the MCP
         * layer). The school id never reaches the SQL.
         */
        narrow: { kind: 'scope' },
        title: 'Demand, collection and pending by quarter · {context}',
        group_by: 'academic quarter',
      },
      {
        x: 'classname',
        query: 'demand_by_class',
        narrow: { kind: 'param', param: 'drill_quarter', type: 'number' },
        title: 'Demand, collection and pending by class · {context}',
        group_by: 'class',
        /** The leaf: no `drill_dim`, so the chart at this level is not clickable. */
      },
    ],
  },
  /**
   * Defaulters: school → quarter → class, the same three levels as fees, on a
   * single measure — how many students carry overdue fees.
   *
   * -- The one thing this path must not let a reader believe -----------------
   * A defaulter is a PERSON, and the levels therefore relate to each other
   * differently in each direction:
   *
   *   classes within a quarter  → SUM to the quarter. A student sits in one
   *                               class, so the parts are disjoint.
   *   quarters within a school  → DO NOT sum to the school. A student overdue
   *                               on a Q1 instalment and a Q3 instalment is one
   *                               defaulter and two bars.
   *
   * That second one is not a rounding difference. Measured 2026-08-29 on the
   * real extract: sacskb has 5,155 distinct defaulters and quarter bars of
   * 1,056 / 4,551 / 4,870 / 4,890 — a sum of 15,367, three times the truth.
   * Counting each student once (say, in their earliest overdue quarter) would
   * make the bars add up and would answer a question nobody asked: "how many
   * students were overdue in Q3" is the number a bursar chasing Q3 needs. So
   * the honest count stays and the level carries its own warning, shown against
   * the bars rather than in a notes list under the page.
   */
  'fee-defaulters': {
    widget_id: 'bar-school-defaulters',
    /**
     * One measure, so this renders as a plain single-series bar rather than a
     * group — the spec's `bar.series` is for two or more, and one bar per
     * school is exactly what was asked for.
     */
    measures: [{ field: 'defaulters', label: 'Students with overdue fees' }],
    levels: [
      {
        x: 'school_name',
        drill_dim: 'school',
        drill_value_field: 'school_id',
        title: 'Students with overdue fees by school',
        group_by: 'school',
      },
      {
        x: 'quarter',
        drill_dim: 'quarter',
        drill_value_field: 'seq',
        query: 'defaulters_by_quarter',
        narrow: { kind: 'scope' },
        title: 'Students with overdue fees by quarter · {context}',
        group_by: 'academic quarter',
        note: 'A student overdue in more than one quarter is counted in each, so these bars deliberately add up to more than the school’s own total.',
        /**
         * A quarter whose dues have not fallen due yet draws a zero bar and is
         * named here, rather than being dropped from the chart. The zero is
         * honest — nobody is late — and the note is what stops it being read as
         * "nobody owes anything".
         */
        pending: {
          field: 'due_rows',
          note: 'Nothing in {categories} was due on {as_of}, so those quarters show no defaulters yet — not that their fees are paid.',
        },
      },
      {
        x: 'classname',
        query: 'defaulters_by_class',
        narrow: { kind: 'param', param: 'drill_quarter', type: 'number' },
        title: 'Students with overdue fees by class · {context}',
        group_by: 'class',
        /** These DO sum to the quarter above: a student sits in one class. */
        note: 'A student sits in one class, so these bars add up to the quarter’s own total.',
        /**
         * Reachable now that a not-yet-due quarter has a bar to click. Without
         * this the click lands on an axis of zeroes with nothing to explain it.
         */
        pending: {
          field: 'due_rows',
          note: 'Nothing in {categories} had fallen due on {as_of}.',
          note_all:
            'No fees in this quarter had fallen due on {as_of}, so no class shows a defaulter yet — not that their fees are paid.',
        },
      },
    ],
  },
  /**
   * Enrollment: school → class → section — docs/06 §4.3's third curated path,
   * and the cheapest of the three to add.
   *
   * Levels 1 and 2 introduce no SQL whatever. Level 1 keeps `by_class` per
   * school rather than summing it across schools; level 2 IS `by_class`, the
   * statement the dashboard's own bar chart already runs. Only the leaf needed
   * writing, because narrowing to one class has to happen in the database.
   *
   * -- These bars add up, at every level, and that is worth stating -----------
   * Fee Defaulters had to warn that its quarter bars overlap, because a student
   * can be overdue in two quarters at once. Nothing of the kind applies here: a
   * student is on one school's roll, in one class, in one section, so every
   * level partitions the one above it exactly. No `note` and no `pending`
   * marker — the absence is the point, not an oversight.
   */
  'enrollment-overview': {
    widget_id: 'bar-school-roll',
    measures: [{ field: 'students', label: 'Students on roll' }],
    levels: [
      {
        x: 'school_name',
        drill_dim: 'school',
        drill_value_field: 'school_id',
        title: 'Students on roll by school',
        group_by: 'school',
      },
      {
        x: 'classname',
        drill_dim: 'class',
        /** The class name IS the bound value, so no separate value field. */
        query: 'by_class',
        narrow: { kind: 'scope' },
        title: 'Students on roll by class · {context}',
        group_by: 'class',
      },
      {
        x: 'sectionname',
        query: 'by_section_for_class',
        narrow: { kind: 'param', param: 'drill_class', type: 'string' },
        title: 'Students on roll by section · {context}',
        group_by: 'section',
      },
    ],
  },

  /**
   * Attendance: school → quarter → class — docs/06 §4.3's second curated path.
   *
   * -- Why the middle level is a quarter and no longer a month ----------------
   * It was `month` until 2026-08-31. Fees and Defaulters both descend school →
   * quarter → class, and a third path whose middle level was a month made that
   * level mean something different on one card out of four: a reader comparing
   * "Q2 fees" against "July attendance" is comparing two windows without having
   * been told they differ. The quarter here is the same Apr–Mar boundary the
   * fee ledger uses — one `academicQuarter` helper in the catalog produces
   * both — so the two cannot drift into disagreeing about when the year starts.
   *
   * The monthly view is not lost: the dashboard's own `by_month` line chart
   * still draws the trend on the report page, which is where month-level detail
   * was actually read. A DRILL is for descending a hierarchy, and quarter is the
   * level the rest of the platform descends through.
   *
   * -- Counts, not the rate ---------------------------------------------------
   * Two measures, present and absent student-days, rather than the attendance
   * percentage the dashboard's tiles lead with. A rate is a quotient and
   * quotients do not survive `sumBy`: adding two schools' rates, or two months',
   * yields a number belonging to neither, and this module's own header warns
   * that summation "would NOT be honest for averages or percentages". Counts add
   * correctly at every level and the ratio is legible in the two bars anyway.
   *
   * -- What these bars are a share OF -----------------------------------------
   * MARKED student-days, not working days: nothing in the extract says which
   * days a school was open (no calendar, no holiday table, no timetable), so a
   * day nobody marked is absent from the chart rather than counted as an
   * absence. That flatters a school with poor marking discipline, which is why
   * the dashboard leads with a marking-coverage tile — the drill inherits the
   * same caveat and says so at the month level, where a thin month is easiest to
   * mistake for a good one.
   */
  'attendance-analytics': {
    widget_id: 'bar-school-attendance',
    measures: [
      { field: 'present_days', label: 'Present student-days' },
      { field: 'absent_days', label: 'Absent student-days' },
    ],
    levels: [
      {
        x: 'school_name',
        drill_dim: 'school',
        drill_value_field: 'school_id',
        title: 'Present and absent student-days by school',
        group_by: 'school',
      },
      {
        x: 'quarter',
        drill_dim: 'quarter',
        /**
         * The axis reads "Q2" and the click binds 2. Same split as the fee
         * paths: binding the visible label would make the drill depend on a
         * display string, and `drill_quarter` is typed `number` precisely so a
         * string is refused at the MCP boundary rather than coerced.
         */
        drill_value_field: 'seq',
        query: 'by_quarter',
        narrow: { kind: 'scope' },
        title: 'Present and absent student-days by quarter · {context}',
        group_by: 'academic quarter',
        note: 'These are MARKED student-days. A day nobody marked is missing from the bars rather than counted as an absence, so a thin quarter may mean poor marking rather than good attendance.',
      },
      {
        x: 'classname',
        query: 'by_class_for_quarter',
        narrow: { kind: 'param', param: 'drill_quarter', type: 'number' },
        title: 'Present and absent student-days by class · {context}',
        group_by: 'class',
      },
    ],
  },

  /**
   * Staff: school → department → designation.
   *
   * -- No quarter here, and that is the data talking -------------------------
   * Headcount is a point-in-time question — who is on the payroll on this date —
   * not a per-period one. `employees_data_set` has no academic year and no term
   * (the report's own header says why it declares no year filter), so a quarter
   * level would have nothing to compute from and would mean "staff who existed
   * during Q2", which nobody asked. Department → designation is the hierarchy
   * the columns actually describe: TEACHING contains PRT, TGT and PGT.
   *
   * The path stops at designation because nothing below it exists short of
   * naming individuals — a different report with a different PII posture, not a
   * fourth level ADR-020 would allow anyway.
   *
   * These bars add up at every level: a member of staff sits in one department
   * and holds one designation, so each level partitions the one above it. No
   * `note`, and the absence is deliberate rather than an oversight — contrast
   * Fee Defaulters, whose quarters overlap and say so.
   */
  'staff-overview': {
    widget_id: 'bar-school-staff',
    measures: [{ field: 'staff', label: 'Staff on roll' }],
    levels: [
      {
        x: 'school_name',
        drill_dim: 'school',
        drill_value_field: 'school_id',
        title: 'Staff on roll by school',
        group_by: 'school',
      },
      {
        x: 'departmentname',
        drill_dim: 'department',
        /** The department name IS the bound value, so no separate value field. */
        query: 'by_department',
        narrow: { kind: 'scope' },
        title: 'Staff on roll by department · {context}',
        group_by: 'department',
      },
      {
        x: 'designationname',
        query: 'by_designation_for_department',
        narrow: { kind: 'param', param: 'drill_department', type: 'string' },
        title: 'Staff on roll by designation · {context}',
        group_by: 'designation',
      },
    ],
  },

  /**
   * Transport: school → pickup route → class.
   *
   * -- No quarter here either -------------------------------------------------
   * Ridership is a standing arrangement rather than a per-period one:
   * `student_transport_data_set` records which route a student is ON and
   * carries no date column at all, so there is nothing to bucket a quarter
   * from. Route is what the report is about, and class beneath it is the
   * question a transport manager actually asks — which years fill this bus.
   *
   * -- The schema under this is UNVERIFIED, and the drill inherits that -------
   * This dashboard went `available` on an unverified schema
   * (mcp-server/src/schema/erp-v1.ts): the table's existence was known, its
   * columns were not. The report says so on its own face, and a drill built on
   * the same columns is exactly as provisional as the chart it descends from —
   * which is the honest position, not a reason to withhold the path. If a
   * column turns out to be named differently the level fails loudly at the
   * guard rather than drawing something plausible.
   *
   * A student rides one route and sits in one class, so these bars add up at
   * every level.
   */
  'transport-analytics': {
    widget_id: 'bar-school-transport',
    measures: [{ field: 'students', label: 'Riders' }],
    levels: [
      {
        x: 'school_name',
        drill_dim: 'school',
        drill_value_field: 'school_id',
        title: 'Riders by school',
        group_by: 'school',
      },
      {
        x: 'pickuproutename',
        drill_dim: 'route',
        query: 'by_pickup_route',
        narrow: { kind: 'scope' },
        title: 'Riders by pickup route · {context}',
        group_by: 'pickup route',
      },
      {
        x: 'classname',
        query: 'by_class_for_route',
        narrow: { kind: 'param', param: 'drill_route', type: 'string' },
        title: 'Riders by class · {context}',
        group_by: 'class',
        /**
         * The classes are ordered by SIZE, not by class ordinal. This table
         * carries no `classseq` and a drill level fetches one statement, so the
         * ordinal the dashboard borrows from `students_data_set` is not in
         * hand — and ordering class labels as text puts X before IX, which is
         * worse than admitting the axis is ranked by ridership.
         */
        note: 'Classes are ordered by number of riders, not by class ordinal — this table carries no class ordering of its own.',
      },
    ],
  },
};

export function drillPathFor(reportId: DashboardId): DrillPath | undefined {
  return DRILL_PATHS[reportId];
}

/** Everything a builder is allowed to know about the request it is answering. */
export interface BuildContext {
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
  /**
   * Run only these of the report's named queries, instead of all of them.
   *
   * The same `query_keys` mechanism the per-widget clone already uses
   * (services/custom-reports.ts, docs/06 §3), reached here so Home's preview
   * cards can ask for the ONE query behind the chart they draw rather than the
   * whole dashboard's. It is still not SQL from a caller: a key names one of
   * the report's own pre-vetted statements and the MCP server refuses anything
   * else (mcp-server/src/tools/run-predefined.ts).
   *
   * Every builder guards each widget with `if (rows.length > 0)`, so a partial
   * fetch produces exactly the widgets whose queries ran — no builder needs to
   * know it was asked for less.
   */
  queryKeys?: readonly string[];
}): Promise<DashboardResult> {
  const scope = await schoolNames(args.schoolIds);
  if (scope.length === 0) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'None of the selected schools are available for analytics right now.',
      correlationId: args.correlationId,
    });
  }

  const { params, filterChips } = resolveReportParams(args.reportId, {
    academicYear: args.academicYear,
    asOfDate: args.asOfDate,
  });

  /**
   * Tier ① (docs/09 §4). The key carries the school set, the bound filters AND
   * the session's permission class — [MANDATORY] docs/08 §5, because masking is
   * role-dependent and a key without it would serve a Principal's unmasked
   * defaulter list to an accountant.
   *
   * A partial fetch gets its OWN key. That is not tidiness: a preview holding
   * one widget must never be served to the full dashboard page, which would
   * silently render a report with most of its panels missing — the
   * success-shaped failure §10 names. Listing the keys sorted keeps the same
   * request on the same entry regardless of the order they were named in, and
   * a full fetch keeps the bare `report:<id>` kind it has always had, so no
   * existing entry is orphaned by this change.
   */
  const queryKeys = args.queryKeys;
  const key = cacheKey({
    kind:
      queryKeys === undefined
        ? `report:${args.reportId}`
        : `report:${args.reportId}:q=${[...queryKeys].sort().join('+')}`,
    schoolIds: args.schoolIds,
    permissionClass: args.session.permission_class,
    filters: params,
  });

  const hit = await cacheGet<DashboardResult>(key);
  if (hit !== null) {
    /**
     * A stale entry is served NOW and rebuilt behind the response
     * (cache/result-cache.ts). The rebuild is this same function with the same
     * arguments — so it runs on this session's scope and permission class, and
     * can only ever rewrite the key this reader was already entitled to read.
     * `queryKeys` is threaded through it too, or the refresh would write a full
     * dashboard into a preview's key.
     */
    if (hit.stale) {
      refreshInBackground(key, async () =>
        buildDashboard({ ...args, correlationId: `${args.correlationId}:refresh` }),
      );
    }
    /**
     * The spec says where the answer came from, and on a hit that is the cache
     * — ADR-028's three tiers are only honest if the label changes with them.
     * `as_of` is deliberately NOT refreshed: the data really is from the moment
     * of the underlying read, and docs/03 assumption 2 accepts replica lag only
     * on condition that it is labelled.
     */
    return {
      ...hit.value,
      spec: { ...hit.value.spec, meta: { ...hit.value.spec.meta, served_from: 'cache' } },
    };
  }

  const result = await withMcp(args.session, args.correlationId, args.schoolIds, async (mcp) =>
    mcp.call<PredefinedResult>('run_predefined', {
      report_id: args.reportId,
      school_ids: [...args.schoolIds],
      params,
      ...(queryKeys === undefined ? {} : { query_keys: [...queryKeys] }),
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
      filters: filterChips,
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

export interface DashboardBuild {
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
 *
 * Exported for services/custom-reports.ts: a cloned predefined report replays
 * the SAME builder against a `run_predefined` result built from the clone's
 * own stored params (ADR-018) — the presentation logic that turns rows into
 * widgets is a property of the REPORT, not of who asked for it or which filter
 * values they chose, so a clone must not re-derive it.
 */
export const BUILDERS: Record<DashboardId, (merged: Merged, ctx: BuildContext) => DashboardBuild> = {
  'enrollment-overview': buildEnrollment,
  'fee-collection': buildFeeCollection,
  'fee-defaulters': buildFeeDefaulters,
  'staff-overview': buildStaffOverview,
  'admissions-funnel': buildAdmissionsFunnel,
  'attendance-analytics': buildAttendance,
  'principal-snapshot': buildPrincipalSnapshot,
  'transport-analytics': buildTransportAnalytics,
  'library-textbooks': buildLibraryTextbooks,
};

function buildEnrollment(merged: Merged, { year, scope }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];
  /** Non-null by construction; test/drill.test.ts asserts the table is honest. */
  const path = DRILL_PATHS['enrollment-overview'] as DrillPath;

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

  /**
   * Drill level 1 (ADR-020, `DRILL_PATHS`) — one bar per school, drilling to
   * class and then section. Built from the `by_class` rows the chart below
   * already reads, kept per school instead of summed across them, so the entry
   * point to the whole path costs no query of its own.
   */
  const perSchool = merged.sumPerSchool('by_class', ['students']);
  if (perSchool.length > 0) {
    const schoolName = new Map(scope.map((entry) => [entry.school_id, entry.school_name]));
    widgets.push({
      id: path.widget_id,
      type: 'bar',
      title: path.levels[0].title,
      x: 'school_name',
      y: 'students',
      data: perSchool.map((entry) => ({
        school_id: entry.school_id,
        school_name: schoolName.get(entry.school_id) ?? entry.school_id,
        students: entry.totals['students'] ?? 0,
      })),
      drillable: true,
      drill_dim: 'school',
      drill_value_field: 'school_id',
      drill_context: [],
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

function buildFeeCollection(merged: Merged, { year, scope }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];
  /**
   * Non-null by construction: the entry exists in `DRILL_PATHS` above and
   * test/drill-path.test.ts asserts that every path names a widget its builder
   * actually pushes. Read from the table rather than repeated here so the
   * chart's titles, series labels and drill dimensions have ONE definition --
   * the level the route serves after a click and the level rendered before it
   * must not be able to disagree about what the chart is.
   */
  const path = DRILL_PATHS['fee-collection'] as DrillPath;

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

  /**
   * Drill level 1 (ADR-020, `DRILL_PATHS`) — demand, collection and pending
   * side by side, one group of bars per school.
   *
   * Built from the SAME `by_component` rows the KPI tiles above are summed
   * from, grouped by school instead of across schools, so it costs no extra
   * query on a table where one scan is seconds. The three measures are the
   * demand ledger's own columns and tie exactly: pending is what the ledger
   * carries as `balance_amount`, not payable minus collected computed here,
   * because a school that has over-received against a head would otherwise show
   * a negative bar that the ledger itself does not report.
   *
   * Drillable even with ONE school in scope. A single group of three bars is a
   * legitimate reading of a single-school report — and it is the entry point to
   * the quarter and class levels, which every school wants regardless of how
   * many schools the reader can see.
   */
  const perSchool = merged.sumPerSchool('by_component', ['payable', 'paid', 'balance']);
  if (perSchool.length > 0) {
    const named = new Map(scope.map((s) => [s.school_id, s.school_name]));
    widgets.push({
      id: path.widget_id,
      type: 'bar',
      title: path.levels[0].title,
      x: 'school_name',
      y: 'payable',
      series: [...path.measures],
      data: perSchool.map((entry) => ({
        school_id: entry.school_id,
        /** Falls back to the id: an unnamed bar is still a bar someone can act on. */
        school_name: named.get(entry.school_id) ?? entry.school_id,
        payable: entry.totals['payable'] ?? 0,
        collected: entry.totals['paid'] ?? 0,
        pending: entry.totals['balance'] ?? 0,
      })),
      drillable: true,
      drill_dim: 'school',
      drill_value_field: 'school_id',
      drill_context: [],
    });
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
    groupBy: ['school', 'month', 'class', 'payment mode', 'fee head'],
    /**
     * Stated because the two figures will not tie exactly, and a reader who
     * spots that without being told will reasonably distrust both. Demand and
     * receipts are different ledgers: a receipt can be recorded against a
     * different period from the demand it settles.
     */
    notes: [
      'The KPI tiles and the payable/collected/pending chart come from the fee demand ledger (what was owed and settled). The month, class and payment-mode charts come from the receipt ledger (what was banked, and when). The two will not tie exactly.',
      'Fee pending is the demand ledger’s own outstanding balance, not payable minus collected — the two differ wherever a head has been over-received.',
      'Quarters are ACADEMIC quarters measured from the period a fee was demanded for: Q1 is April–June, Q4 is January–March. Demand with no period recorded is left out of the quarter view, so the four quarters can add up to less than the school total — no such rows exist in any school today.',
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
  /** Non-null by construction; test/drill.test.ts asserts the table is honest. */
  const path = DRILL_PATHS['fee-defaulters'] as DrillPath;

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

  /**
   * Drill level 1 (ADR-020, `DRILL_PATHS`) — one bar per school, how many
   * students carry overdue fees.
   *
   * Built from the SAME `totals` rows the KPI tiles read, kept per school
   * instead of summed across them, so it costs no extra query — the same trick
   * Fee Collection's level 1 uses, and it matters more here: `totals` is the one
   * scan on this dashboard that buys a number no arithmetic on the other result
   * sets could produce (see the catalog's note on why it exists at all).
   *
   * Per-school is the only grouping where a distinct headcount can be summed
   * across at all, and even then only because a student belongs to exactly one
   * school. `sumPerSchool` adds within a school and never between them, which
   * for a one-row-per-school result set is a no-op — that is the point. Summing
   * these bars is still wrong at every level below this one; the quarter level
   * says so against its own chart.
   */
  const perSchool = merged.sumPerSchool('totals', ['defaulters']);
  if (perSchool.length > 0) {
    const schoolName = new Map(scope.map((s) => [s.school_id, s.school_name]));
    widgets.push({
      id: path.widget_id,
      type: 'bar',
      title: path.levels[0].title,
      x: 'school_name',
      y: 'defaulters',
      /**
       * No `series`: one measure is a plain bar, not a group of one. The spec
       * requires at least two entries precisely so a single-series chart cannot
       * grow a legend restating its own title.
       */
      data: perSchool.map((entry) => ({
        school_id: entry.school_id,
        school_name: schoolName.get(entry.school_id) ?? entry.school_id,
        defaulters: entry.totals['defaulters'] ?? 0,
      })),
      drillable: true,
      drill_dim: 'school',
      drill_value_field: 'school_id',
      drill_context: [],
    });
  }

  if (overdueBands.length > 0) {
    widgets.push({
      id: 'bar-aging',
      type: 'bar',
      title: 'Overdue by age of the debt',
      x: 'bucket',
      y: 'outstanding',
      /**
       * Amber, because docs/10 §1's token table assigns it to "warnings, fees
       * outstanding" and that is precisely what these bars are. Not a contrast
       * trick: `kpi-balance` above already states the same fact in the same
       * colour, and this chart had no way to. It also separates the two bar
       * panels on this page, which is a welcome side effect rather than the
       * reason.
       *
       * Set here and not in the SPA because the PDF renders the same spec
       * (ADR-021) — a colour looked up client-side would print differently
       * from the screen it was approved on.
       */
      tone: 'warning',
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
    groupBy: ['school', 'aging band', 'class', 'fee head', 'student'],
    notes: [
      `A student is counted as a defaulter when a fee period ended on or before ${asOf} and a balance remains. Dues not yet due are shown as their own band and are excluded from every "overdue" figure.`,
      /**
       * The limit of the as-of date, said plainly. Someone will backdate this
       * report expecting June's position, and the demand ledger cannot give it
       * to them — better to say so than to let a plausible number be misread.
       */
      'The fee ledger holds current balances, so the as-of date decides what counts as overdue and how deep the band is. It does not rebuild the ledger as it stood on that date: a payment made last week is already reflected here.',
      'Student names and enrolment numbers are masked for sessions without student-data permission; the amounts are not.',
      /**
       * The counting rule, stated once for the whole report. The quarter level
       * repeats it against its own bars (`DRILL_PATHS`), because that is the
       * only chart where adding the bars up is a tempting mistake — but a
       * reader who never drills should still know that these are people.
       */
      'Defaulter counts are counts of students, not of dues. A student who owes across several fee heads or several periods is one defaulter, which is why the aging bands and the quarter breakdown add up to more than the total.',
      'Quarters are ACADEMIC quarters, measured from the period a fee was demanded for, so Q2 means the same thing here as it does on Fee Collection: Q1 is April–June, Q4 is January–March.',
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
function buildStaffOverview(merged: Merged, { asOf, scope }: BuildContext): DashboardBuild {
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

  /**
   * Drill level 1 (ADR-020, `DRILL_PATHS`) — one bar per school, drilling to
   * department and then designation. Built from the `by_department` rows the
   * chart below already reads, kept per school instead of summed across them,
   * so the entry point to the whole path costs no query of its own.
   */
  const perSchool = merged.sumPerSchool('by_department', ['staff']);
  if (perSchool.length > 0) {
    const path = DRILL_PATHS['staff-overview'] as DrillPath;
    const schoolName = new Map(scope.map((entry) => [entry.school_id, entry.school_name]));
    widgets.push({
      id: path.widget_id,
      type: 'bar',
      title: path.levels[0].title,
      x: 'school_name',
      y: 'staff',
      data: perSchool.map((entry) => ({
        school_id: entry.school_id,
        /** Falls back to the id: an unnamed bar is still a bar someone can act on. */
        school_name: schoolName.get(entry.school_id) ?? entry.school_id,
        staff: entry.totals['staff'] ?? 0,
      })),
      drillable: true,
      drill_dim: 'school',
      drill_value_field: 'school_id',
      drill_context: [],
    });
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

/**
 * Attendance Analytics -- docs/06 section 2, built 2026-08-21 when the table
 * arrived (docs/11 section 1 had deferred it for want of data).
 *
 * -- The two numbers, and why both are on the page ---------------------------
 * The RATE is present student-days over MARKED student-days, because nothing in
 * the ERP extract says which days were working days -- no calendar, no holiday
 * table, no timetable (mcp-server/src/reports/catalog.ts states the same). That
 * denominator has a known bias: a day nobody marked is not counted at all
 * rather than counted as absent, which flatters a school with poor marking
 * discipline exactly when its rate should be doubted.
 *
 * So COVERAGE sits beside it -- marked student-days over days-marked x students
 * on roll -- and it is the tile that says how much the rate is worth. At 100%
 * coverage the rate is the school's attendance; at 15% it is the attendance of
 * whoever happened to be marked. Publishing the rate alone would be a
 * success-shaped failure (CODING_GUIDELINES section 10): a plausible percentage
 * with no way to see what it was computed from.
 *
 * -- Percentages are never averaged across schools ---------------------------
 * Every rate here divides a SUMMED numerator by a SUMMED denominator, never the
 * mean of per-school rates -- the rule this module's header states, and the one
 * a Director combining a 200-student school with a 4,000-student one would
 * otherwise see broken.
 */
function buildAttendance(merged: Merged, { year, scope }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];
  /** Non-null by construction; test/drill.test.ts asserts the table is honest. */
  const path = DRILL_PATHS['attendance-analytics'] as DrillPath;

  const summary = merged.sumAll('summary', [
    'marked_days',
    'working_days',
    'students_marked',
    'expected_days',
    'present_days',
    'absent_days',
    'leave_days',
    'other_days',
  ]);
  const byMonth = merged.sumBy('by_month', 'month', ['marked_days', 'present_days'], 'seq');
  const byClass = merged.sumBy('by_class', 'classname', [
    'marked_days',
    'present_days',
    'students_marked',
  ]);
  const byStatus = merged.sumBy('by_status', 'statusname', ['days']);
  const low = merged.concatRows('low_attendance');

  const markedDays = num(summary?.['marked_days']);

  /**
   * Drill level 1 (ADR-020, `DRILL_PATHS`) — present against absent
   * student-days, one pair of bars per school, drilling to month and then
   * class. Built from the `summary` rows the tiles already read.
   *
   * Counts and not the rate: a rate is a quotient and quotients do not survive
   * a merge (this module's header, and the level's own note). A school with no
   * marked days at all is absent from the chart rather than sitting at 0% --
   * which is the honest answer for the St Marks schools, none of which have any
   * attendance data (docs/11).
   */
  const perSchool = merged.sumPerSchool('summary', ['present_days', 'absent_days']);
  const attended = perSchool.filter(
    (entry) => (entry.totals['present_days'] ?? 0) + (entry.totals['absent_days'] ?? 0) > 0,
  );
  if (attended.length > 0) {
    const schoolName = new Map(scope.map((entry) => [entry.school_id, entry.school_name]));
    widgets.push({
      id: path.widget_id,
      type: 'bar',
      title: path.levels[0].title,
      x: 'school_name',
      y: 'present_days',
      series: [...path.measures],
      data: attended.map((entry) => ({
        school_id: entry.school_id,
        school_name: schoolName.get(entry.school_id) ?? entry.school_id,
        present_days: entry.totals['present_days'] ?? 0,
        absent_days: entry.totals['absent_days'] ?? 0,
      })),
      drillable: true,
      drill_dim: 'school',
      drill_value_field: 'school_id',
      drill_context: [],
    });
  }

  /**
   * Order comes from `class_order`, and it is a MIN across schools rather than a
   * sum -- `sumBy` would add two schools' ordinals for the same class and put
   * Class 1 after Class 12. Classes the enrolment table does not rank sort last
   * rather than first, so an unranked label cannot masquerade as Nursery.
   */
  const classSeq = new Map<string, number>();
  for (const { row } of merged.concatRows('class_order')) {
    const name = label(row['classname']);
    const seq = num(row['seq']);
    const seen = classSeq.get(name);
    if (seen === undefined || seq < seen) classSeq.set(name, seq);
  }
  const orderedClasses = [...byClass].sort(
    (a, b) =>
      (classSeq.get(label(a['classname'])) ?? Number.MAX_SAFE_INTEGER) -
      (classSeq.get(label(b['classname'])) ?? Number.MAX_SAFE_INTEGER),
  );

  /**
   * The tiles exist only if the query behind them ANSWERED.
   *
   * `summary` is a single COUNT with no GROUP BY, so a school where nobody has
   * marked the register still returns a row — one that says zero. A school whose
   * query FAILED returns nothing. Reading both as "zero days marked" would put
   * an outage on the screen wearing the words for an empty register, which is
   * the opposite of what the empty-register note below is for. When nothing
   * answered, no widget is emitted and buildDashboard says so loudly rather than
   * rendering a page of em dashes.
   */
  if (summary !== null) {
    /**
     * The rate tile. `--` and not `0%` when nothing was marked, and the
     * distinction is the whole point: 0% attendance is a claim that every child
     * was absent, which is a different and much more alarming thing than nobody
     * having taken the register. Same reasoning as services/home.ts's blocked
     * metrics.
     */
    widgets.push({
      id: 'kpi-attendance-rate',
      type: 'kpi',
      label: 'Attendance rate',
      value: markedDays > 0 ? percent(num(summary['present_days']) / markedDays) : '—',
      tone: attendanceTone(markedDays > 0 ? num(summary['present_days']) / markedDays : null),
    });

    widgets.push({
      id: 'kpi-days-marked',
      type: 'kpi',
      label: 'Days marked',
      value: count(num(summary['working_days'])),
      tone: 'neutral',
    });

    const expected = num(summary['expected_days']);
    widgets.push({
      id: 'kpi-coverage',
      type: 'kpi',
      label: 'Marking coverage',
      value: expected > 0 ? percent(markedDays / expected) : '—',
      /**
       * Warning below 90%: not a threshold anyone approved, and it is not
       * treated as one -- it colours a tile, it does not hide or restate a
       * number. It is here because a coverage figure a reader scrolls past is
       * the same as no coverage figure at all.
       */
      tone: expected > 0 && markedDays / expected < 0.9 ? 'warning' : 'neutral',
    });

    /**
     * Zero here means zero children below 75% ONLY if the list was read. If that
     * query is the one that failed, an em dash — the count is unknown, and
     * "0 students below 75%" is the single most reassuring wrong answer this
     * dashboard could give.
     */
    const lowRead = merged.succeeded('low_attendance');
    widgets.push({
      id: 'kpi-below-75',
      type: 'kpi',
      label: 'Students below 75%',
      value: lowRead && markedDays > 0 ? count(low.length) : '—',
      tone: low.length > 0 ? 'warning' : 'neutral',
    });
  }

  if (byMonth.length > 0) {
    widgets.push({
      id: 'line-month',
      type: 'line',
      title: 'Attendance rate by month',
      x: 'month',
      y: 'attendance_pct',
      data: byMonth.map((r) => ({
        month: monthLabel(label(r['month'])),
        attendance_pct: rate(num(r['present_days']), num(r['marked_days'])),
      })),
    });
  }

  if (orderedClasses.length > 0) {
    widgets.push({
      id: 'bar-class',
      type: 'bar',
      title: 'Attendance rate by class',
      x: 'classname',
      y: 'attendance_pct',
      data: orderedClasses.map((r) => ({
        classname: label(r['classname']),
        attendance_pct: rate(num(r['present_days']), num(r['marked_days'])),
      })),
    });
  }

  if (byStatus.length > 0) {
    /**
     * The unbucketed truth, beside the rates that bucket it.
     *
     * Present / Absent / Leave / Suspend are what this extract happens to hold;
     * no canonical status list was supplied, so the tiles above treat anything
     * else as neither present nor absent. This donut is how a reader checks that
     * -- the same reason the Admissions funnel publishes the ERP's own
     * `candidate_statusid` counts beside its inferred stages.
     */
    widgets.push({
      id: 'donut-status',
      type: 'donut',
      title: 'What was recorded',
      label_field: 'statusname',
      value_field: 'days',
      data: byStatus.map((r) => ({ statusname: label(r['statusname']), days: num(r['days']) })),
    });
  }

  if (low.length > 0) {
    const masked = merged.maskedColumns('low_attendance');
    const multi = new Set(low.map((r) => r.school_id)).size > 1;
    widgets.push({
      id: 'table-low-attendance',
      type: 'table',
      title: 'Students below 75% of their own marked days',
      columns: [
        ...(multi ? [{ field: 'school_id', label: 'School' }] : []),
        { field: 'studentname', label: 'Student', masked: masked.has('studentname') },
        { field: 'enrollmentno', label: 'Enrolment no', masked: masked.has('enrollmentno') },
        { field: 'classname', label: 'Class' },
        { field: 'sectionname', label: 'Section' },
        /**
         * `marked_days` is a column and not a footnote. A student at 0% of one
         * marked day and a student at 0% of ninety are the same percentage and
         * completely different situations, and the report refuses to hide the
         * difference behind a minimum-days threshold it was never given.
         */
        { field: 'marked_days', label: 'Days marked', align: 'right' },
        { field: 'present_days', label: 'Present', align: 'right' },
        { field: 'attendance_pct', label: 'Attendance %', align: 'right' },
      ],
      rows: low
        .map(({ school_id, row }) => ({
          ...(multi ? { school_id } : {}),
          studentname: label(row['studentname']),
          enrollmentno: label(row['enrollmentno']),
          classname: label(row['classname']),
          sectionname: label(row['sectionname']),
          marked_days: num(row['marked_days']),
          present_days: num(row['present_days']),
          attendance_pct: rate(num(row['present_days']), num(row['marked_days'])),
        }))
        .sort((a, b) => a.attendance_pct - b.attendance_pct),
    });
  }

  const notes = [
    'Attendance rate is present student-days divided by MARKED student-days. The ERP extract carries no school calendar, no holiday list and no timetable, so there is no way to know which days were working days — a day nobody marked is not counted here rather than counted as absent.',
    'Marking coverage is what tells you how much the rate is worth: marked student-days as a share of days-marked multiplied by students on roll. A high rate on low coverage is the attendance of whoever was marked, not of the school.',
    `Attendance is filtered by date (${academicYearWindow(year).from} to ${academicYearWindow(year).to}), not by academic year. The attendance table stamps every row with the current academic year rather than the year its own date falls in, so its year column cannot be filtered on. The academic year above is used only to count students on roll.`,
    'The same student and date can appear several times in this table, with no rule saying which row wins. One row per student per day is taken before anything is counted; otherwise a day marked six times would count six times.',
    'Present, Absent, Leave and Suspend are the statuses this dataset happens to contain. No canonical status list was supplied with it, so only "Present" counts towards the rate and anything unrecognised is shown in "What was recorded" rather than assumed to mean absent.',
    'Classes are ordered using the enrolment table, which is where the class ordinal lives; the attendance table carries none. A class the enrolment table does not rank is sorted last.',
    "Across several schools, coverage is each school's own marked days against its own roll, added together. A school where nothing at all was marked therefore contributes to neither side of it and does not pull the combined figure down — check the schools individually before reading a combined coverage number as good news.",
  ];

  if (summary !== null && markedDays === 0) {
    /**
     * Named, not blank. An empty attendance page is indistinguishable from an
     * outage, and the difference matters to whoever has to act: nothing here is
     * broken, nobody took the register.
     */
    notes.unshift(
      'No attendance has been marked for the selected schools in this period. The tiles below are empty for that reason, not because attendance was zero.',
    );
  }

  return {
    widgets,
    groupBy: ['month', 'class', 'status', 'student'],
    notes,
  };
}

/**
 * Principal's Snapshot -- the same five numbers Home's KPI strip shows
 * (services/home.ts), rebuilt as a first-class report so it carries a Logic
 * panel, a PDF and a place in My Reports. See reports/catalog.ts's
 * PRINCIPAL_SNAPSHOT header for why this is the one dashboard in this file
 * whose queries span three domains, and why that is safe.
 *
 * Every KPI here is independently optional -- unlike the single-source
 * dashboards above, a session missing one domain's permission (an accountant
 * with only `fees.read`) still gets a real page: the fee tile renders, the
 * enrolment/staff/admissions/attendance tiles are simply absent rather than
 * blocking the whole report, because each is read from ITS OWN result set
 * (docs/06 §3's "a panel that worked still renders", one level up from
 * queries to KPIs).
 */
function buildPrincipalSnapshot(merged: Merged, { year, asOf }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];

  const byClass = merged.sumBy('by_class', 'classname', ['students'], 'seq');
  const fees = merged.sumAll('fees', ['payable', 'paid', 'balance']);
  const staff = merged.sumAll('staff', ['on_roll']);
  const admissions = merged.sumAll('admissions', ['candidates', 'admissions']);
  const attendance = merged.sumAll('attendance', ['marked_days', 'present_days']);

  if (byClass.length > 0) {
    const total = byClass.reduce((sum, row) => sum + num(row['students']), 0);
    widgets.push({
      id: 'kpi-students',
      type: 'kpi',
      label: `Students on roll · ${year}`,
      value: count(total),
      tone: 'neutral',
    });
  }

  if (fees !== null) {
    const paid = num(fees['paid']);
    const balance = num(fees['balance']);
    widgets.push(
      { id: 'kpi-fees-collected', type: 'kpi', label: `Fees collected · ${year}`, value: rupees(paid), tone: 'positive' },
      {
        id: 'kpi-fees-outstanding',
        type: 'kpi',
        label: 'Fees outstanding',
        value: rupees(balance),
        tone: balance > 0 ? 'warning' : 'neutral',
      },
    );
  }

  if (staff !== null) {
    widgets.push({
      id: 'kpi-staff',
      type: 'kpi',
      label: `Staff on roll as of ${asOf}`,
      value: count(num(staff['on_roll'])),
      tone: 'neutral',
    });
  }

  if (admissions !== null) {
    const candidates = num(admissions['candidates']);
    const admitted = num(admissions['admissions']);
    widgets.push({
      id: 'kpi-admissions',
      type: 'kpi',
      label: `Admitted this year (of ${count(candidates)} candidates)`,
      value: count(admitted),
      tone: 'positive',
    });
  }

  // Same success-shaped-failure care as Attendance Analytics: a zero rate here
  // could mean "everyone absent" or "nobody marked the register", and only
  // `succeeded` tells the two apart.
  const attendanceRead = merged.succeeded('attendance');
  if (attendance !== null && attendanceRead) {
    const marked = num(attendance['marked_days']);
    widgets.push({
      id: 'kpi-attendance',
      type: 'kpi',
      label: 'Attendance rate (selected window)',
      value: marked > 0 ? percent(num(attendance['present_days']) / marked) : '—',
      tone: attendanceTone(marked > 0 ? num(attendance['present_days']) / marked : null),
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

  return {
    widgets,
    groupBy: ['class'],
    notes: [
      'This snapshot combines Enrollment, Fee Collection, Staff Overview, Admissions and Attendance into one page. Each tile is read from its own report and appears only if this session can read that domain -- open the individual dashboard for the full breakdown behind any one number.',
      'Attendance follows the same definition as Attendance Analytics: present student-days over MARKED student-days, not over the calendar. See that dashboard for marking coverage before trusting the rate alone.',
    ],
  };
}

/**
 * Transport Analytics -- corrected 2026-08-26 against schema/erp-v1.ts's
 * VERIFIED `student_transport_data_set` entry (read directly off
 * `information_schema` on the local `ai_analysis` instance, not inferred).
 * No year or date filter reaches this report at all (see
 * reports/catalog.ts's TRANSPORT_ANALYTICS header for why), so every widget
 * here reflects whatever assignment rows the table holds right now.
 *
 * `class_order` is read from students_data_set the same way
 * `buildAttendance`'s is, joined on `studentprofileid` -- the only student key
 * this table carries, and not the same column every other roster table uses.
 */
function buildTransportAnalytics(merged: Merged, { scope }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];

  const totals = merged.sumAll('totals', ['riders', 'pickup_routes', 'drop_routes']);
  const byPickupRoute = merged.sumBy('by_pickup_route', 'pickuproutename', ['students']);
  const byMode = merged.sumBy('by_mode', 'modeoftransport', ['students']);
  const byClass = merged.sumBy('by_class', 'classname', ['students']);

  const classSeq = new Map<string, number>();
  for (const { row } of merged.concatRows('class_order')) {
    const name = label(row['classname']);
    const seq = num(row['seq']);
    const seen = classSeq.get(name);
    if (seen === undefined || seq < seen) classSeq.set(name, seq);
  }
  const orderedClasses = [...byClass].sort(
    (a, b) =>
      (classSeq.get(label(a['classname'])) ?? Number.MAX_SAFE_INTEGER) -
      (classSeq.get(label(b['classname'])) ?? Number.MAX_SAFE_INTEGER),
  );

  const riders = totals !== null ? num(totals['riders']) : null;
  if (totals !== null) {
    widgets.push(
      { id: 'kpi-riders', type: 'kpi', label: 'Riders', value: count(riders ?? 0), tone: 'neutral' },
      {
        id: 'kpi-pickup-routes',
        type: 'kpi',
        label: 'Pickup routes in use',
        value: count(num(totals['pickup_routes'])),
        tone: 'neutral',
      },
      {
        id: 'kpi-drop-routes',
        type: 'kpi',
        label: 'Drop routes in use',
        value: count(num(totals['drop_routes'])),
        tone: 'neutral',
      },
    );
  }

  /**
   * Drill level 1 (ADR-020, `DRILL_PATHS`) — one bar per school, drilling to
   * route and then class. Built from the `by_pickup_route` rows the chart below
   * already reads, so the entry point costs no query of its own.
   */
  const perSchool = merged.sumPerSchool('by_pickup_route', ['students']);
  if (perSchool.length > 0) {
    const path = DRILL_PATHS['transport-analytics'] as DrillPath;
    const schoolName = new Map(scope.map((entry) => [entry.school_id, entry.school_name]));
    widgets.push({
      id: path.widget_id,
      type: 'bar',
      title: path.levels[0].title,
      x: 'school_name',
      y: 'students',
      data: perSchool.map((entry) => ({
        school_id: entry.school_id,
        school_name: schoolName.get(entry.school_id) ?? entry.school_id,
        students: entry.totals['students'] ?? 0,
      })),
      drillable: true,
      drill_dim: 'school',
      drill_value_field: 'school_id',
      drill_context: [],
    });
  }

  if (byPickupRoute.length > 0) {
    widgets.push({
      id: 'bar-route',
      type: 'bar',
      title: 'Riders by pickup route',
      x: 'pickuproutename',
      y: 'students',
      data: byPickupRoute.map((r) => ({
        pickuproutename: label(r['pickuproutename']),
        students: num(r['students']),
      })),
    });
  }

  if (orderedClasses.length > 0) {
    widgets.push({
      id: 'bar-class',
      type: 'bar',
      title: 'Riders by class',
      x: 'classname',
      y: 'students',
      data: orderedClasses.map((r) => ({ classname: label(r['classname']), students: num(r['students']) })),
    });
  }

  if (byMode.length > 0) {
    widgets.push({
      id: 'donut-mode',
      type: 'donut',
      title: 'Mode of transport',
      label_field: 'modeoftransport',
      value_field: 'students',
      data: byMode.map((r) => ({ modeoftransport: label(r['modeoftransport']), students: num(r['students']) })),
    });
  }

  const notes = [
    'This table carries no date column that can be trusted for filtering (the same stamped-current-year trap the attendance tables have), so this dashboard reflects every transport assignment on record right now rather than a single academic year.',
    'Capacity and utilisation are not shown here: no vehicle-capacity column exists in this table, only student/route/stop/mode assignments.',
  ];
  if (riders === 0) {
    // Named, not blank -- the same reasoning buildAttendance's empty-register
    // note follows: an empty page here is a fact about this school's data, not
    // a broken query.
    notes.unshift('No transport assignments are recorded for the selected schools.');
  }

  return { widgets, groupBy: ['pickup route', 'class', 'mode of transport'], notes };
}

/**
 * Library & Textbooks -- corrected 2026-08-26 against schema/erp-v1.ts's
 * VERIFIED `books_data_set` and `book_issue_data_set` entries.
 */
function buildLibraryTextbooks(merged: Merged, { asOf }: BuildContext): DashboardBuild {
  const widgets: Widget[] = [];

  const inventory = merged.sumAll('inventory', ['titles', 'total_copies', 'available_copies']);
  const overdue = merged.sumAll('overdue', ['overdue']);
  const byCategory = merged.sumBy('by_category', 'booktypename', ['total_copies', 'available_copies']);
  const byMonth = merged.sumBy('issues_by_month', 'ym', ['issues']);
  const byIssueType = merged.sumBy('by_issue_type', 'issuetype', ['issues']);
  const lowStock = merged.concatRows('low_stock');

  const titles = inventory !== null ? num(inventory['titles']) : null;
  if (inventory !== null) {
    widgets.push(
      { id: 'kpi-titles', type: 'kpi', label: 'Titles held', value: count(titles ?? 0), tone: 'neutral' },
      {
        id: 'kpi-copies',
        type: 'kpi',
        label: 'Copies held',
        value: count(num(inventory['total_copies'])),
        tone: 'neutral',
      },
      {
        id: 'kpi-available',
        type: 'kpi',
        label: 'Copies available now',
        value: count(num(inventory['available_copies'])),
        tone: 'neutral',
      },
    );
  }

  if (overdue !== null) {
    const overdueCount = num(overdue['overdue']);
    widgets.push({
      id: 'kpi-overdue',
      type: 'kpi',
      label: `Overdue as of ${asOf}`,
      value: count(overdueCount),
      tone: overdueCount > 0 ? 'warning' : 'positive',
    });
  }

  if (byMonth.length > 0) {
    widgets.push({
      id: 'line-month',
      type: 'line',
      title: 'Issues by month',
      x: 'ym',
      y: 'issues',
      data: byMonth.map((r) => ({ ym: label(r['ym']), issues: num(r['issues']) })),
    });
  }

  if (byCategory.length > 0) {
    widgets.push({
      id: 'table-category',
      type: 'table',
      // Titled by what the column is (docs/06 §3 -- a pill or a title claiming
      // more than the data supports is the thing the logic panel exists to
      // prevent). booktypename is the ERP's own free-text label, not a curated
      // subject taxonomy: 'STORY' and 'Story Books' both occur as separate
      // values in the real data, and it is reported as written.
      title: "Copies by the ERP's own book-type label",
      columns: [
        { field: 'booktypename', label: 'Book type' },
        { field: 'total_copies', label: 'Held', align: 'right' },
        { field: 'available_copies', label: 'Available', align: 'right' },
      ],
      rows: byCategory.map((r) => ({
        booktypename: label(r['booktypename']),
        total_copies: num(r['total_copies']),
        available_copies: num(r['available_copies']),
      })),
    });
  }

  if (lowStock.length > 0) {
    const multi = new Set(lowStock.map((r) => r.school_id)).size > 1;
    widgets.push({
      id: 'table-low-stock',
      type: 'table',
      title: 'Low stock (fewer than 3 copies available)',
      columns: [
        ...(multi ? [{ field: 'school_id', label: 'School' }] : []),
        { field: 'bookname', label: 'Title' },
        { field: 'booktypename', label: 'Book type' },
        { field: 'total_copies', label: 'Held', align: 'right' },
        { field: 'available_copies', label: 'Available', align: 'right' },
      ],
      rows: lowStock.map(({ school_id, row }) => ({
        ...(multi ? { school_id } : {}),
        bookname: label(row['bookname']),
        booktypename: label(row['booktypename']),
        total_copies: num(row['total_copies']),
        available_copies: num(row['available_copies']),
      })),
    });
  }

  if (byIssueType.length > 1) {
    // Only worth a widget once there is more than one type to compare -- a
    // single row would just repeat the total, the same restraint Attendance
    // takes with a would-be one-slice donut.
    widgets.push({
      id: 'donut-issue-type',
      type: 'donut',
      title: 'Issues by who they were issued to',
      label_field: 'issuetype',
      value_field: 'issues',
      data: byIssueType.map((r) => ({ issuetype: label(r['issuetype']), issues: num(r['issues']) })),
    });
  }

  const notes = [
    'Titles and copies are different numbers here: this table holds one row per PHYSICAL COPY, so a title with several copies on the shelf is several rows sharing the same name. "Available" is read from each copy\'s own status, not a stored count.',
    'This dashboard cannot be filtered by academic year: book_issue_data_set stamps every row with the CURRENT academic year regardless of when the book was actually issued (the same trap both attendance tables have), so the month chart and the overdue figure are read from the issue and due dates directly instead.',
    'Low stock means fewer than 3 copies available for a title, out of however many copies this table records -- a threshold this report chose, not one the ERP supplied.',
    'Issue records include both students and staff; the split is published above rather than assumed away.',
  ];
  if (titles === 0) {
    notes.unshift('No library data is recorded for the selected schools.');
  }

  return { widgets, groupBy: ['book type', 'month', 'issue type'], notes };
}

// -- Merging ------------------------------------------------------------------

/** Exported for services/custom-reports.ts, which merges a `run_predefined` result the same way `buildDashboard` does. */
export class Merged {
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
        const id = keys.map((k) => String(row[k] ?? '')).join(' ');
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
   * The same numeric fields summed WITHIN each school instead of across them.
   *
   * `sumBy` answers "what is the total?"; this answers "which school?", which
   * is drill level 1 (`DRILL_PATHS`). Deliberately built from a result set the
   * base dashboard already fetched rather than from a per-school query: the fee
   * tables have no usable index, so the school breakdown is free this way and a
   * scan otherwise.
   *
   * Schools that FAILED are simply absent — never a zero row. A school that
   * could not be reached and a school that collected nothing are the same
   * height on a bar chart and opposite facts (§10); the absent school is
   * already named in `schoolFailures()`, which the page renders as a notice.
   */
  sumPerSchool(key: string, sumFields: string[]): { school_id: string; totals: Record<string, number> }[] {
    const out: { school_id: string; totals: Record<string, number> }[] = [];
    for (const school of this.result.schools) {
      if (school.status !== 'ok') continue;
      let seen = false;
      const totals: Record<string, number> = {};
      for (const f of sumFields) totals[f] = 0;
      for (const query of school.queries ?? []) {
        if (query.key !== key || query.status !== 'ok') continue;
        for (const row of query.rows ?? []) {
          seen = true;
          for (const f of sumFields) totals[f] = (totals[f] ?? 0) + num(row[f]);
        }
      }
      if (seen) out.push({ school_id: school.school_id, totals });
    }
    return out;
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
   * Did the result set actually RETURN this column?
   *
   * `sumBy` initialises every requested field to 0 and adds, so a column that
   * was never selected is indistinguishable from one that summed to zero. That
   * is fine for a measure — an absent measure draws a zero bar and someone
   * notices — and not fine for a marker whose ZERO carries meaning: a level
   * whose `pending.field` was missing would quietly report every category as
   * "not due yet", which is a confident false statement rather than a blank.
   * Checked against the columns the query really answered with.
   */
  returnsColumn(key: string, column: string): boolean {
    return this.queriesFor(key).some(
      (query) => query.status === 'ok' && (query.columns ?? []).includes(column),
    );
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

  /**
   * Did this result set come back from at least one school?
   *
   * Distinct from "did it sum to something": a query that FAILED and a query
   * that returned a legitimate zero are the same number and opposite facts.
   * Callers that render a tile from an absent-or-zero value need to tell them
   * apart, because a zero standing in for a failure is precisely the
   * success-shaped failure CODING_GUIDELINES §10 names.
   */
  succeeded(key: string): boolean {
    return this.queriesFor(key).some((query) => query.status === 'ok');
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

/** A share as a display string. The caller has already decided it is knowable. */
function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * A share as a NUMBER, for a chart axis rather than a tile.
 *
 * Zero when the denominator is zero, because a chart point must be a number --
 * and that is exactly why the tiles use `percent` and print an em dash instead:
 * a bar chart cannot say "not known", so a class with nothing marked simply has
 * no row rather than a zero-height bar claiming nobody attended.
 */
function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

/** 75% is the line docs/06 §4.2 draws; the tones follow it rather than taste. */
function attendanceTone(share: number | null): 'neutral' | 'positive' | 'warning' {
  if (share === null) return 'neutral';
  if (share >= 0.9) return 'positive';
  return share < 0.75 ? 'warning' : 'neutral';
}

/** `2026-07` -> `Jul 2026`. Sorting already happened; this is for reading. */
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function monthLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match === null) return value;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return name === undefined ? value : `${name} ${String(match[1])}`;
}

function rupees(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 10_000_000) return `₹${(rounded / 10_000_000).toFixed(1)}Cr`;
  if (Math.abs(rounded) >= 100_000) return `₹${(rounded / 100_000).toFixed(1)}L`;
  return `₹${new Intl.NumberFormat('en-IN').format(rounded)}`;
}
