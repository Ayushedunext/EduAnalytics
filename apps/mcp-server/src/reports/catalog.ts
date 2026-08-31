/**
 * The predefined report catalog — the SQL behind `run_predefined`.
 *
 * Contract source: docs/04 §2 (`run_predefined(report_id, school_ids[],
 * params)`) · docs/06 §2 (the predefined catalog; "vetted parameterized SQL …
 * filters are bound parameters. Zero AI tokens") · ADR-016 (predefined and AI
 * are separate serving paths) · ADR-006.
 *
 * -- Why the SQL lives HERE and not in the orchestrator ----------------------
 * ADR-006 puts every statement that touches a school database behind this
 * server. A caller names a report and supplies FILTER VALUES; it cannot supply
 * SQL. That is the security property the tool exists for: `run_query` accepts a
 * statement and is therefore only as safe as the guard, while `run_predefined`
 * accepts no statement at all, so a compromised orchestrator or a confused model
 * can pick a report and a year and nothing else.
 *
 * The orchestrator still owns PRESENTATION — which widget, what title, which
 * chips appear in the logic panel (docs/06 §3). The split is: this file decides
 * what may be asked of the database, the orchestrator decides how the answer
 * looks. `sql_text` is returned to the caller precisely so the logic panel can
 * show it, because Invariant 6 requires every report to expose its SQL.
 *
 * -- Parameters are bound BY NAME --------------------------------------------
 * `:academic_year`, never a literal spliced into the string
 * (CODING_GUIDELINES §9 [MANDATORY]). Named rather than positional because the
 * guard injects the tenant filter into the same statement and positional order
 * would then depend on clause rendering — see TENANT_PARAM in sql/guard.ts.
 *
 * -- A note on cost -----------------------------------------------------------
 * In the first real dataset `fee_compile_data_set` carries no index but its
 * primary key, and `fee_collection_data_set`'s only secondary index starts with
 * `society_db`, so neither the tenant filter nor the year filter can use one and
 * every fee query is a full scan of ~1.8M rows. The queries below are written to
 * minimise the number of those scans — one per distinct grouping, none
 * duplicated — but the real fix is a `(school_db, academicyearname)` index on
 * both tables. That is a change to a SCHOOL database, which this platform may
 * never make (ADR-008/023: reports write nothing to school databases), so it is
 * a request to whoever owns those schemas, recorded here where the cost is felt.
 *
 * That request is now measured rather than asserted (AUDIT_REPORT C21). Building
 * the index on a local copy of the extract took the twelve statements below from
 * 15.6 s to 2.4 s in total — `type=ALL key=NULL` to `type=ref key=idx_school_year`
 * on every one — with `EXPLAIN ANALYZE` confirming 1,454,684 rows examined
 * falling to 70,233 actual. `scripts/bench-fee-index.ts` reproduces it, and the
 * two ALTERs ran `ALGORITHM=INPLACE, LOCK=NONE` in 13 s and 15 s, so the ask on
 * the schema owner needs no downtime window. The paragraph above still describes
 * PRODUCTION: nothing has changed in any school database, and until that request
 * is accepted these queries are still scanning.
 *
 * -- When report_definitions lands --------------------------------------------
 * docs/06 §1 puts report definitions in a platform table. This module is that
 * table's stand-in: same shape, same `sql_text`, resolved from code until the
 * table exists. The resolver is one function, so the swap is local — what must
 * NOT change is that the SQL is resolved server-side from an id, never accepted
 * from a caller.
 */

import type { DataDomain } from '../schema/catalog.js';

export interface ReportParam {
  readonly name: string;
  /** Validated at the boundary before binding (CODING_GUIDELINES §3/§10). */
  readonly type: 'string' | 'number';
  readonly required: boolean;
  readonly description: string;
}

export interface ReportQuery {
  /** Names the result set. The orchestrator binds widgets to these keys. */
  readonly key: string;
  readonly description: string;
  readonly sql: string;
  /**
   * Pre-vetted alternate statements for the SAME widget, keyed by a small
   * enum (e.g. time-bucket unit) — never a caller-composed statement.
   * `run_predefined` selects among these by validated key; it still never
   * accepts SQL text from a caller (see run-predefined.ts's `bucket`
   * handling). Column shape must match `sql` exactly, since the orchestrator
   * builder that reads the result does not know which variant ran.
   */
  readonly variants?: Readonly<Record<string, string>>;
  /**
   * A level of a drill path (ADR-020), not a panel of the base dashboard.
   *
   * `run_predefined` SKIPS these unless the caller names them in `query_keys`.
   * Without that, opening Fee Collection would run its by-quarter and by-class
   * drill statements — two more full scans of `fee_compile_data_set` — to build
   * widgets nobody has asked for yet, on a table whose scans are measured in
   * seconds (see the cost note at the top of this file). A drill level is
   * fetched when it is clicked and not before.
   *
   * It is NOT an access control: a drill query is as vetted as any other and
   * the same guard, scope and caps apply. It only says who pays for it.
   */
  readonly drill_only?: boolean;
}

export interface PredefinedReport {
  readonly id: string;
  readonly title: string;
  /** Which schema version's catalog this SQL is written against (ADR-014). */
  readonly schema_version: string;
  /** For the logic panel's "Source" chip (docs/06 §3). */
  readonly source: string;
  readonly domain: DataDomain;
  readonly params: readonly ReportParam[];
  readonly queries: readonly ReportQuery[];
}

const ACADEMIC_YEAR: ReportParam = {
  name: 'academic_year',
  type: 'string',
  required: true,
  description: "Academic year label as the ERP writes it, e.g. '2026-27'.",
};

/**
 * The date every "is this overdue?" and "was this person here?" question is
 * asked *as of*.
 *
 * A parameter rather than `CURDATE()`, and that is a report-semantics decision,
 * not a style one. Aging bands and headcounts computed from the server clock
 * change silently every night: the same saved report, the same PDF filename and
 * the same title produce different numbers next month, and nothing on the page
 * says why. docs/06 §5 prints an as-of line on every export precisely so a
 * printed number stays checkable, which only works if the date it was computed
 * against is an input someone chose and can choose again.
 *
 * It also makes the reports reproducible for support ("run 30 June and tell me
 * what you see") and, when `report_definitions` lands (docs/06 §1), it is
 * already a stored filter value rather than an implicit dependency on when the
 * report happened to run.
 */
const AS_OF_DATE: ReportParam = {
  name: 'as_of_date',
  type: 'string',
  required: true,
  description:
    "The date the report is computed as of, YYYY-MM-DD. Aging bands and headcounts are measured against this date, not against today.",
};

/**
 * Time-bucket selector for a single time-series widget's clone (docs/06 §3,
 * per-widget customization). Optional and report-wide in `params` shape, but
 * only meaningful to whichever query declares `variants` for it — a query
 * with no `variants` simply ignores it. This is a SELECTOR among a small,
 * catalog-authored set of statements, never a value spliced into SQL: the
 * guard (sql/guard.ts) never sees this name at all, because the orchestrator
 * picks the whole statement before anything reaches `prepareSelect`
 * (run-predefined.ts).
 */
const BUCKET: ReportParam = {
  name: 'bucket',
  type: 'string',
  required: false,
  description: 'Time grouping for a time-series widget: week | month | quarter | year.',
};

/**
 * The academic quarter a demand row belongs to, as a SQL expression.
 *
 * Not `QUARTER(periodfromdate)`. MySQL's QUARTER is a CALENDAR quarter starting
 * in January, and an Indian school year starts in April: a report that labelled
 * April-June "Q2" would disagree with every fee circular the school has sent.
 * `academicYearWindow` in the orchestrator already fixes the year at 1 April to
 * 31 March (services/dashboards.ts) and this is the same boundary expressed for
 * the demand ledger, so the two cannot drift.
 *
 * The arithmetic: shift the month so April lands on 0 (`+ 8`, mod 12), take its
 * quarter (`/ 3`, floored), number it from 1. April→Q1, July→Q2, October→Q3,
 * January→Q4. Written with FLOOR/MOD rather than the `DIV`/`MOD` operators
 * because the guard's parser must read every shipped statement (test:
 * reports-catalog.test.ts) and function calls parse where those operators do
 * not reliably.
 *
 * `periodfromdate` and not `periodtodate`: a quarter here means "the period the
 * money was demanded FOR", which is where a bursar looks for an instalment. The
 * defaulter report asks the other question — how late is it — and uses
 * `periodtodate` for exactly that reason.
 */
function academicQuarter(column: string): string {
  return `FLOOR(MOD(MONTH(${column}) + 8, 12) / 3) + 1`;
}

/** The demand ledger's quarter — the original, and still the common case. */
const ACADEMIC_QUARTER = academicQuarter('periodfromdate');

/**
 * The same boundary against the attendance register's own date column.
 *
 * Derived from `academicQuarter` rather than written out again, which is the
 * whole reason that function exists. Two hand-written copies of "shift April to
 * 0, divide by 3" would be two places for the school year to start in January,
 * and a fees quarter disagreeing with an attendance quarter is the kind of drift
 * nobody notices until a principal compares two screens.
 */
const ATTENDANCE_QUARTER = academicQuarter('a.attendancedate');

/**
 * The quarter a drill click narrowed to (ADR-020: clicked values enter as BOUND
 * parameters, never concatenated — a click can only narrow).
 *
 * Optional, and null when absent, so the one query that reads it degrades to
 * "every quarter" rather than to `= NULL`, which matches nothing. That is safe
 * here and would not be for `academic_year`: an unnarrowed quarter is a
 * legitimate view of the same report, whereas an unfiltered year silently sums
 * a decade (see ENROLLMENT_OVERVIEW).
 *
 * Typed `number`, so `run_predefined` refuses a string before it reaches the
 * guard — the drill value arrives from a click in a browser, which is to say
 * from outside.
 */
const DRILL_QUARTER: ReportParam = {
  name: 'drill_quarter',
  type: 'number',
  required: false,
  description:
    'Drill context: restrict to one academic quarter, 1 (Apr-Jun) to 4 (Jan-Mar). Omitted means all quarters.',
};

/**
 * The class a drill click narrowed to (ADR-020), as a bound value.
 *
 * A string, and that is the first drill dimension that is one. It reaches MySQL
 * as a parameter like every other filter (CODING_GUIDELINES §9 [MANDATORY]), so
 * a class named `'; DROP` is a class that matches no rows rather than a
 * statement — the guard never sees the value at all, only the placeholder.
 *
 * Optional for the same reason `drill_quarter` is: the base dashboard runs the
 * same report with no drill context every time someone opens it, and a required
 * drill filter would refuse that request outright.
 */
const DRILL_CLASS: ReportParam = {
  name: 'drill_class',
  type: 'string',
  required: false,
  description:
    'Drill context: restrict to one class, as `classname` records it. Omitted means every class.',
};

/**
 * The department a drill click narrowed to (ADR-020), as a bound value.
 *
 * A string, like `drill_class`, and for the same reason: `departmentname` is
 * free text in `employees_data_set` and there is no id to bind instead. It
 * reaches MySQL as a parameter, so a department named `'; DROP` is a department
 * matching no rows rather than a statement — the guard never sees the value,
 * only the placeholder.
 */
const DRILL_DEPARTMENT: ReportParam = {
  name: 'drill_department',
  type: 'string',
  required: false,
  description:
    'Drill context: restrict to one department, as `departmentname` records it. Omitted means every department.',
};

/**
 * The pickup route a drill click narrowed to (ADR-020), as a bound value.
 *
 * A string for the same reason again — `pickuproutename` is the only identifier
 * this table carries for a route.
 */
const DRILL_ROUTE: ReportParam = {
  name: 'drill_route',
  type: 'string',
  required: false,
  description:
    'Drill context: restrict to one pickup route, as `pickuproutename` records it. Omitted means every route.',
};

/**
 * Enrollment Overview — docs/06 §2, Phase 1.
 *
 * Every query filters on the academic year. That is not cosmetic: these tables
 * hold every year since 2015, so an unfiltered "strength by class" would sum a
 * decade of students into one bar and look entirely plausible doing it.
 */
const ENROLLMENT_OVERVIEW: PredefinedReport = {
  id: 'enrollment-overview',
  title: 'Enrollment Overview',
  schema_version: 'erp-v1',
  source: 'students_data_set',
  domain: 'students',
  params: [ACADEMIC_YEAR, DRILL_CLASS],
  queries: [
    {
      key: 'by_class',
      description: 'Students on roll by class',
      sql:
        'SELECT classname, MIN(classseq) AS seq, COUNT(*) AS students ' +
        'FROM students_data_set ' +
        'WHERE academicyearname = :academic_year AND deactivation_date IS NULL ' +
        'GROUP BY classname ORDER BY seq',
    },
    {
      key: 'by_gender',
      description: 'Gender mix',
      sql:
        'SELECT gender, COUNT(*) AS students FROM students_data_set ' +
        'WHERE academicyearname = :academic_year AND deactivation_date IS NULL ' +
        'GROUP BY gender ORDER BY students DESC',
    },
    {
      key: 'by_category',
      description: 'Students by category',
      sql:
        'SELECT category, COUNT(*) AS students FROM students_data_set ' +
        'WHERE academicyearname = :academic_year AND deactivation_date IS NULL ' +
        'GROUP BY category ORDER BY students DESC',
    },
    {
      key: 'by_section',
      description: 'Class and section breakdown',
      sql:
        'SELECT classname, sectionname, COUNT(*) AS students, MIN(classseq) AS seq ' +
        'FROM students_data_set ' +
        'WHERE academicyearname = :academic_year AND deactivation_date IS NULL ' +
        'GROUP BY classname, sectionname ORDER BY seq, sectionname',
    },
    /**
     * Drill level 3 — sections within the clicked class.
     *
     * Levels 1 and 2 add no SQL at all: level 1 keeps `by_class` per school
     * instead of summing it, and level 2 IS `by_class`, unchanged. Only the
     * leaf needs a statement, because narrowing to one class has to happen in
     * the database — filtering `by_section`'s full result in the orchestrator
     * would read every section of every class to draw one class's, and ADR-020
     * is explicit that a click narrows the QUERY.
     *
     * Not `drill_only`: `by_section` already feeds a table on the dashboard, so
     * the base report reads sections anyway. This is the same question asked of
     * one class, and it is cheap on `students_data_set` — unlike the fee
     * tables, this one is small and the year filter is selective.
     */
    {
      key: 'by_section_for_class',
      description: 'Students on roll by section, within one class',
      drill_only: true,
      sql:
        'SELECT sectionname, COUNT(*) AS students ' +
        'FROM students_data_set ' +
        'WHERE academicyearname = :academic_year AND deactivation_date IS NULL ' +
        'AND (:drill_class IS NULL OR classname = :drill_class) ' +
        'GROUP BY sectionname ORDER BY sectionname',
    },
  ],
};

/**
 * Fee Collection — docs/06 §2, Phase 1.
 *
 * Two sources on purpose: `fee_collection_data_set` is receipts (what came in,
 * and when), `fee_compile_data_set` is demand versus realisation (what was owed
 * and what is outstanding). "Collected" and "collectable" are different
 * questions and answering both from one table would silently answer neither.
 */
const FEE_COLLECTION: PredefinedReport = {
  id: 'fee-collection',
  title: 'Fee Collection',
  schema_version: 'erp-v1',
  source: 'fee_collection_data_set · fee_compile_data_set',
  domain: 'fees',
  params: [ACADEMIC_YEAR, BUCKET, DRILL_QUARTER],
  queries: [
    /**
     * There is deliberately no separate `totals` query. It would be a second
     * full scan of `fee_compile_data_set` for numbers that are the column sums
     * of `by_component` — the orchestrator adds them up instead. On a table with
     * no usable index (see the note below) one avoided scan is seconds.
     */
    {
      key: 'by_month',
      description: 'Receipts by month, from the collection ledger',
      sql:
        'SELECT fee_month, MIN(MONTH(feedate)) AS mo, ROUND(SUM(paidamount)) AS collected ' +
        'FROM fee_collection_data_set WHERE academicyearname = :academic_year ' +
        'GROUP BY fee_month ORDER BY mo',
      /**
       * Per-widget clone (docs/06 §3): "Receipts by month" cloned on its own
       * may re-group by week/quarter/year instead. `fee_month` has no raw
       * week/quarter/year counterpart on the table, so these read `feedate`
       * (a real per-row date, unlike the stamped-current-year columns
       * elsewhere in this catalog) directly. Column names match the default
       * exactly (`fee_month` as the label, `mo` as the sort key) so the
       * orchestrator's widget builder needs no bucket-specific branch.
       */
      variants: {
        week:
          "SELECT DATE_FORMAT(feedate, '%x-W%v') AS fee_month, MIN(YEARWEEK(feedate, 3)) AS mo, ROUND(SUM(paidamount)) AS collected " +
          'FROM fee_collection_data_set WHERE academicyearname = :academic_year ' +
          "GROUP BY DATE_FORMAT(feedate, '%x-W%v') ORDER BY mo",
        quarter:
          "SELECT CONCAT('Q', QUARTER(feedate)) AS fee_month, MIN(QUARTER(feedate)) AS mo, ROUND(SUM(paidamount)) AS collected " +
          'FROM fee_collection_data_set WHERE academicyearname = :academic_year ' +
          'GROUP BY QUARTER(feedate) ORDER BY mo',
        year:
          'SELECT YEAR(feedate) AS fee_month, MIN(YEAR(feedate)) AS mo, ROUND(SUM(paidamount)) AS collected ' +
          'FROM fee_collection_data_set WHERE academicyearname = :academic_year ' +
          'GROUP BY YEAR(feedate) ORDER BY mo',
      },
    },
    {
      key: 'by_class',
      description: 'Receipts by class, from the collection ledger',
      sql:
        'SELECT classname, MIN(classseq) AS seq, ROUND(SUM(paidamount)) AS collected ' +
        'FROM fee_collection_data_set WHERE academicyearname = :academic_year ' +
        'GROUP BY classname ORDER BY seq',
    },
    {
      key: 'by_mode',
      description: 'Receipts by payment mode, from the collection ledger',
      sql:
        'SELECT paymenttype, ROUND(SUM(paidamount)) AS collected ' +
        'FROM fee_collection_data_set WHERE academicyearname = :academic_year ' +
        'GROUP BY paymenttype ORDER BY collected DESC',
    },
    {
      key: 'by_component',
      description: 'Demand versus realisation by fee head, from the demand ledger',
      sql:
        'SELECT componentname, ROUND(SUM(total_payable_amount)) AS payable, ' +
        'ROUND(SUM(paid_amount)) AS paid, ROUND(SUM(balance_amount)) AS balance ' +
        'FROM fee_compile_data_set WHERE academicyearname = :academic_year ' +
        'GROUP BY componentname ORDER BY payable DESC',
    },
    /**
     * Drill level 2 — demand, collection and pending by academic quarter, for
     * whichever school the reader clicked at level 1.
     *
     * There is no level-1 query. Level 1 groups the SAME `by_component` rows by
     * school instead of summing them across schools, which the orchestrator
     * already has in hand from the base dashboard (services/dashboards.ts) —
     * so opening the report and drilling into the school breakdown costs one
     * scan between them, not two.
     *
     * The school itself never appears in this SQL. Narrowing to one school is a
     * SCOPE narrowing, handled where every other scope decision is (the launch
     * token, checked at the orchestrator and again at `requireInScope`), so a
     * drill click cannot reach a school the session was not already entitled
     * to — and the model, or a browser, never supplies a tenant identifier.
     *
     * `periodfromdate IS NOT NULL` keeps the axis to exactly Q1..Q4. A row with
     * no demand period has no quarter, and letting it through would draw a
     * fifth, unlabelled bar whose click binds a quarter that matches nothing —
     * a drill target that leads to an empty chart. The cost is that the four
     * quarters can sum to less than the school total, which is stated on screen
     * (services/dashboards.ts notes) rather than left for a reader to notice.
     * Measured 2026-08-27 across the real extract: zero such rows in any of the
     * eight schools, so this is defence, not a live discrepancy.
     */
    {
      key: 'demand_by_quarter',
      description: 'Demand, collection and pending by academic quarter, from the demand ledger',
      drill_only: true,
      sql:
        `SELECT CONCAT('Q', ${ACADEMIC_QUARTER}) AS quarter, ${ACADEMIC_QUARTER} AS seq, ` +
        'ROUND(SUM(total_payable_amount)) AS payable, ROUND(SUM(paid_amount)) AS collected, ' +
        'ROUND(SUM(balance_amount)) AS pending ' +
        'FROM fee_compile_data_set WHERE academicyearname = :academic_year ' +
        'AND periodfromdate IS NOT NULL ' +
        'GROUP BY quarter, seq ORDER BY seq',
    },
    /**
     * Drill level 3 — the same three measures by class, within the clicked
     * school and quarter.
     *
     * `:drill_quarter IS NULL OR …` rather than two statements: the alternative
     * is a `variants` pair that differ only in a WHERE clause, and the day one
     * of them gained a measure the other would quietly answer a different
     * question under the same heading. Level 3 always arrives WITH a quarter
     * (its drill context is [school, quarter] by construction — see DRILL_PATHS
     * in services/dashboards.ts); the null branch is what keeps the statement
     * honest if it is ever run on its own.
     *
     * Ordered by `classseq`, never by `classname`: class labels sort as text,
     * which puts X before IX.
     */
    {
      key: 'demand_by_class',
      description: 'Demand, collection and pending by class, from the demand ledger',
      drill_only: true,
      sql:
        'SELECT classname, MIN(classseq) AS seq, ' +
        'ROUND(SUM(total_payable_amount)) AS payable, ROUND(SUM(paid_amount)) AS collected, ' +
        'ROUND(SUM(balance_amount)) AS pending ' +
        'FROM fee_compile_data_set WHERE academicyearname = :academic_year ' +
        `AND (:drill_quarter IS NULL OR ${ACADEMIC_QUARTER} = :drill_quarter) ` +
        'GROUP BY classname ORDER BY seq',
    },
  ],
};

/**
 * The year the current one is measured AGAINST (the "Compare with" filter).
 *
 * A second academic year rather than a boolean "compare to last year", because
 * the year before is not always the year a reader wants: a school that changed
 * its fee structure in 2024-25 compares this year with 2023-24 to see the
 * structure's effect, and a trust that absorbed schools mid-year compares with
 * the last year its school set was stable. The orchestrator DERIVES the
 * preceding year when the caller names none (services/dashboards.ts), so the
 * common case still costs the reader nothing.
 *
 * Required here, unlike the drill parameters below, for the same reason
 * `academic_year` is: every statement in this report is about two years, and a
 * NULL would silently drop the comparison half of every chart — leaving a
 * "comparative analysis" that compares nothing while looking complete.
 */
const COMPARE_YEAR: ReportParam = {
  name: 'compare_year',
  type: 'string',
  required: true,
  description:
    "The academic year to compare against, as the ERP writes it, e.g. '2025-26'. Usually the preceding year.",
};

/**
 * The instalment a drill click narrowed to (ADR-020), as a bound value.
 *
 * A string, like `drill_class`: `installmentname` is free text on the demand
 * ledger ("Installment-1", "Term I") and carries no id to bind instead. It
 * reaches MySQL as a parameter, so an instalment named `'; DROP` matches no
 * rows rather than becoming a statement.
 */
const DRILL_INSTALLMENT: ReportParam = {
  name: 'drill_installment',
  type: 'string',
  required: false,
  description:
    'Drill context: restrict to one instalment, as `installmentname` records it. Omitted means every instalment.',
};

/**
 * The sortable ordinal of an instalment, as a SQL expression.
 *
 * `installmentname` is free text and sorts as text, which puts "Installment-10"
 * before "Installment-2" — the trap `classseq` exists to avoid for classes. The
 * demand ledger has no `installmentseq`, but it does carry the period the
 * instalment was demanded FOR, and instalments are demanded in calendar order by
 * construction, so the first day of that period IS the ordinal.
 *
 * `DATE_FORMAT(..., '%Y%m%d')` rather than the raw date because the value
 * travels through a JSON result set, where a `MIN(date)` arrives as a
 * driver-specific date object; a zero-padded YYYYMMDD reads as a number
 * everywhere. Rows with no period sort to 0, i.e. first — visible rather than
 * dropped.
 *
 * Used only WITHIN one school and one year (the drill levels below), where the
 * instalment names are internally consistent. Across years or across schools
 * they are not — see `PERIOD_MONTH`.
 */
const INSTALLMENT_SEQ = "MIN(DATE_FORMAT(periodfromdate, '%Y%m%d'))";

/**
 * The calendar month a fee was demanded FOR — the axis a year-on-year
 * comparison is drawn against.
 *
 * NOT `installmentname`, and this is the single most important line in the
 * report. That column is free text a school types, and the delivered extract
 * shows what that means in practice (read 2026-08-31 across eight live schools):
 * one school writes "APR 2025-26" one year and "April 2026-27" the next, another
 * writes "Apr", a third "APL (2025-26)", a fourth mixes "Apr-2026" with
 * "April-June 2026" and "1st Installment" in the same year. Grouping a
 * comparison on that string puts the two years in DISJOINT categories: every bar
 * would carry one year and a gap where the other should be, and the chart would
 * look like a school that raised no fees last year rather than like a bug.
 *
 * `MONTH(periodfromdate)` is the one dimension that means the same thing in
 * every school and every year. It is also the only one that survives the
 * ERP's date staleness: one school's `periodfromdate` still carries 2023 in
 * both years' rows, and the MONTH is right there even though the year is not.
 *
 * The academic ordering (April first, March last) is applied by the
 * orchestrator rather than here — it is a presentation fact, the report already
 * returns the month number, and the same reordering is needed for the label.
 *
 * A row with no period recorded returns NULL and is drawn as its own named
 * category. It carries real money; dropping it would quietly shrink the demand
 * total below the KPI tile that sums the same rows.
 */
const PERIOD_MONTH = 'MONTH(periodfromdate)';

/**
 * How late a receipt was, in whole months, relative to the instalment it settled.
 *
 * Negative → paid before the due month opened (advance). 0 → paid within the due
 * month. 1 → the month after. >1 → later still. NULL on either side → the row
 * cannot be classified at all, which is counted separately rather than folded
 * into a bucket it did not earn.
 *
 * MONTHS, not days, and that is the definition the whole timeline is built on. A
 * school's fee calendar is monthly: a circular says "October instalment", a
 * parent pays "in October", and a bursar asks who paid in the month and who paid
 * the month after. Measuring in days from `installment_enddate` would file a
 * payment made on the 31st as on-time and one made on 1 November as four weeks
 * late, when both are "the month it was due" and "the month after".
 *
 * `installment_enddate` and not `installment_startdate`: the end of the
 * collection window is the date money is expected BY, which is what "on time"
 * means to whoever sent the circular.
 */
const PAYMENT_LATENESS =
  "PERIOD_DIFF(DATE_FORMAT(feedate, '%Y%m'), DATE_FORMAT(installment_enddate, '%Y%m'))";

/**
 * Comparative Analysis — year-on-year fee recovery, school by school.
 *
 * -- What this report is FOR, and how it differs from Fee Collection ----------
 * Fee Collection answers "where did this year's money come from?" — by month, by
 * class, by payment mode, for the schools in view summed together. Comparative
 * Analysis answers the two questions a trust's management asks instead: is
 * recovery better or worse than LAST year, and which school is dragging the
 * number down. So every measure here arrives twice, this year and the comparison
 * year, and nothing is summed across schools without also being available per
 * school.
 *
 * -- Two statements, and why that is the whole report -------------------------
 * The demand ledger is scanned ONCE for both years: the year joins the GROUP BY
 * rather than becoming a second statement, so a comparison costs one pass over
 * `fee_compile_data_set` where two year-filtered statements would cost two — and
 * on a table with no usable index for these predicates (see the cost note at the
 * top of this file) a pass is measured in seconds, not milliseconds. Splitting
 * the rows by year afterwards is free.
 *
 * The per-SCHOOL split costs nothing either. `run_predefined` already answers per
 * school (one connection per tenant, ADR-013), so the orchestrator has each
 * school's rows in hand and re-groups them (`Merged.concatRows`) rather than
 * issuing a query per school. A trust of twenty schools is twenty scans because
 * it is twenty databases, not because this report asks twenty questions.
 *
 * -- Why payment timing reads the RECEIPT ledger ------------------------------
 * "Paid in advance" and "paid the month after" are facts about WHEN money
 * arrived, and only `fee_collection_data_set` carries a payment date. The demand
 * ledger is a current snapshot: it knows what is still owed, never when the
 * settled part was settled. So the timeline's paid states come from receipts
 * while its "still pending" state comes from demand — which is exactly why the
 * orchestrator states on screen that the two ledgers do not tie to the rupee.
 */
const FEE_COMPARATIVE: PredefinedReport = {
  id: 'fee-comparative',
  title: 'Comparative Analysis',
  schema_version: 'erp-v1',
  source: 'fee_compile_data_set · fee_collection_data_set',
  domain: 'fees',
  params: [ACADEMIC_YEAR, COMPARE_YEAR, DRILL_INSTALLMENT],
  queries: [
    /**
     * Both years, both broken down by instalment, in one pass.
     *
     * There is deliberately no `totals` query and no per-school query: every KPI
     * on the page is a column sum of these rows, and the school breakdown is
     * these same rows grouped by the school that returned them. One scan of the
     * demand ledger answers the entire left-hand side of the report.
     *
     * `outstanding` is the ledger's own `balance_amount` rather than payable
     * minus collected. A fee head that has been over-received would otherwise
     * show as negative outstanding — a number the ledger never reports, and one
     * that would quietly reduce a school's arrears on screen.
     *
     * Two `=` predicates rather than `IN (...)`: both bind by name and mean the
     * same thing to MySQL, and the guard's parameter walk has one shape of node
     * to recognise instead of two.
     */
    {
      key: 'demand_by_period',
      description: 'Demand, collection and outstanding by fee period, for both years',
      sql:
        `SELECT academicyearname AS ay, ${PERIOD_MONTH} AS period_month, ` +
        'ROUND(SUM(total_payable_amount)) AS payable, ' +
        'ROUND(SUM(paid_amount)) AS collected, ' +
        'ROUND(SUM(balance_amount)) AS outstanding ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year OR academicyearname = :compare_year ' +
        `GROUP BY academicyearname, ${PERIOD_MONTH} ORDER BY ay, period_month`,
    },
    /**
     * When the money actually arrived, against when it was due — the receipt
     * ledger's half of the recovery timeline.
     *
     * Five sums over one scan rather than five statements: the CASE arms are
     * mutually exclusive by construction (a lateness is one of <0, 0, 1, >1, or
     * unknown), so each row is read once and lands in exactly one bucket. That
     * exclusivity is the property the whole timeline depends on, and expressing
     * it as arms of one expression is what makes it checkable by reading.
     *
     * `undated` is not a rounding bucket to be hidden. A receipt whose instalment
     * carries no end date, or which carries no payment date, cannot be called
     * early or late by anyone: counting it as on-time would flatter the school
     * and counting it as late would libel it. It is returned so the orchestrator
     * can draw it as its own segment when it is non-zero, and say nothing when it
     * is not.
     */
    {
      key: 'timing',
      description: 'Receipts by how they fell relative to the instalment due month',
      sql:
        'SELECT ' +
        `ROUND(SUM(CASE WHEN ${PAYMENT_LATENESS} < 0 THEN paidamount ELSE 0 END)) AS advance, ` +
        `ROUND(SUM(CASE WHEN ${PAYMENT_LATENESS} = 0 THEN paidamount ELSE 0 END)) AS same_month, ` +
        `ROUND(SUM(CASE WHEN ${PAYMENT_LATENESS} = 1 THEN paidamount ELSE 0 END)) AS next_month, ` +
        `ROUND(SUM(CASE WHEN ${PAYMENT_LATENESS} > 1 THEN paidamount ELSE 0 END)) AS later, ` +
        'ROUND(SUM(CASE WHEN installment_enddate IS NULL OR feedate IS NULL ' +
        'THEN paidamount ELSE 0 END)) AS undated, ' +
        'ROUND(SUM(paidamount)) AS receipts ' +
        'FROM fee_collection_data_set WHERE academicyearname = :academic_year',
    },
    /**
     * Drill level 2 — the clicked school's own instalments, current year only.
     *
     * `demand_by_period` above cannot serve this level, for two reasons. It
     * returns BOTH years, and the drill renderer sums a level's rows by its axis
     * field, which would add last year's period to this year's under one bar;
     * and it groups by month rather than by the school's own instalment names,
     * which is right for comparing years and wrong for a bursar looking at one
     * school's own book. Inside a single school and a single year those names
     * ARE consistent, so this level uses them.
     *
     * The school never appears in this SQL. Narrowing to one school is a SCOPE
     * narrowing, handled where every other scope decision is (the launch token,
     * checked at the orchestrator and again at `requireInScope`), so a drill
     * click cannot reach a school the session was not already entitled to.
     */
    {
      key: 'installments_current',
      description: 'Demand, collection and outstanding by instalment, current year',
      drill_only: true,
      sql:
        'SELECT installmentname, ' +
        `${INSTALLMENT_SEQ} AS seq, ` +
        'ROUND(SUM(total_payable_amount)) AS payable, ' +
        'ROUND(SUM(paid_amount)) AS collected, ' +
        'ROUND(SUM(balance_amount)) AS outstanding ' +
        'FROM fee_compile_data_set WHERE academicyearname = :academic_year ' +
        'GROUP BY installmentname ORDER BY seq',
    },
    /**
     * Drill level 3 — the same three measures by class, within the clicked school
     * and instalment.
     *
     * `:drill_installment IS NULL OR …` rather than two statements, for the
     * reason Fee Collection's level 3 gives: a `variants` pair differing only in
     * a WHERE clause would, the day one of them gained a measure, answer a
     * different question under the same heading. Level 3 always arrives WITH an
     * instalment by construction; the null branch keeps the statement honest if
     * it is ever run alone.
     *
     * Ordered by `classseq`, never `classname`: class labels sort as text, which
     * puts X before IX.
     */
    {
      key: 'classes_current',
      description: 'Demand, collection and outstanding by class, current year',
      drill_only: true,
      sql:
        'SELECT classname, MIN(classseq) AS seq, ' +
        'ROUND(SUM(total_payable_amount)) AS payable, ' +
        'ROUND(SUM(paid_amount)) AS collected, ' +
        'ROUND(SUM(balance_amount)) AS outstanding ' +
        'FROM fee_compile_data_set WHERE academicyearname = :academic_year ' +
        'AND (:drill_installment IS NULL OR installmentname = :drill_installment) ' +
        'GROUP BY classname ORDER BY seq',
    },
  ],
};

/**
 * Fee Defaulters (aging 30/60/90) — docs/06 §2, Phase 1 (docs/11 §1).
 *
 * -- What "defaulter" means here, exactly ------------------------------------
 * A row of `fee_compile_data_set` with `balance_amount > 0` whose collection
 * period has ENDED on or before the as-of date. Both halves matter: an unpaid
 * instalment that is not yet due is not a default, and a school that dunned on
 * `balance_amount > 0` alone would chase parents for money the calendar has not
 * asked for yet. The `aging` query keeps a "Not yet due" band anyway, so the
 * number excluded from the defaulter total is visible rather than invisible.
 *
 * -- What the as-of date does, and what it does NOT --------------------------
 * `fee_compile_data_set` is a CURRENT snapshot: `balance_amount` is what is
 * outstanding now, with no history of what it was in June. So `as_of_date`
 * decides which dues count as OVERDUE and how deep the aging band is; it does
 * not reconstruct the ledger as it stood on that date. Backdating it does not
 * un-collect a payment made last week. That limitation is stated on screen too
 * (services/dashboards.ts) because a reader who assumes otherwise would read a
 * backdated report as a historical one.
 *
 * -- The student list is the one place this report names children -------------
 * `top_defaulters` selects `studentname`/`enrollmentno`, which are `pii:
 * 'students'` in the catalog: a session without `students.read` — an accountant,
 * per docs/08 §4.5 — gets the amounts with the identities masked, by rail 6,
 * without this query needing to know that. It is also `LIMIT 50`, which is
 * docs/06 §4.2's "student-level leaves are top-N capped" applied to a predefined
 * report rather than to a drill path.
 */
const FEE_DEFAULTERS: PredefinedReport = {
  id: 'fee-defaulters',
  title: 'Fee Defaulters',
  schema_version: 'erp-v1',
  source: 'fee_compile_data_set',
  domain: 'fees',
  params: [ACADEMIC_YEAR, AS_OF_DATE, DRILL_QUARTER],
  queries: [
    /**
     * Distinct students cannot be derived by adding up the other result sets —
     * one child owes across several heads and several bands — so this scan buys
     * a number no amount of arithmetic on the others could produce. Every other
     * total on the dashboard is summed from the breakdowns instead (see
     * FEE_COLLECTION on why one avoided scan matters on these tables).
     */
    {
      key: 'totals',
      description: 'Overdue total and how many distinct students carry it',
      sql:
        'SELECT COUNT(DISTINCT enrollmentno) AS defaulters, ' +
        'ROUND(SUM(balance_amount)) AS overdue ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND balance_amount > 0 ' +
        'AND periodtodate < :as_of_date',
    },
    /**
     * The band ordinal is emitted explicitly rather than derived from the
     * minimum days overdue.
     *
     * It costs a repeated CASE, and it buys the one thing presentation must be
     * able to do without pattern-matching English: tell an OVERDUE band from a
     * context band. 0 and 1 are context — nobody is chased for them — and 2..5
     * are the 30/60/90 escalation. A renderer that had to recognise the string
     * '90+ days' would break the day the wording changed.
     *
     * The NULL branch is first on purpose. A row with no period end date is
     * unbucketable, and letting it fall through to the ELSE would report it as
     * the WORST band, inflating exactly the number a school escalates on.
     */
    {
      key: 'aging',
      description: 'Outstanding by how long it has been overdue (30/60/90 bands)',
      sql:
        'SELECT CASE ' +
        "WHEN periodtodate IS NULL THEN 'No due date recorded' " +
        "WHEN periodtodate >= :as_of_date THEN 'Not yet due' " +
        "WHEN DATEDIFF(:as_of_date, periodtodate) <= 30 THEN '1-30 days' " +
        "WHEN DATEDIFF(:as_of_date, periodtodate) <= 60 THEN '31-60 days' " +
        "WHEN DATEDIFF(:as_of_date, periodtodate) <= 90 THEN '61-90 days' " +
        "ELSE '90+ days' END AS bucket, " +
        'CASE ' +
        'WHEN periodtodate IS NULL THEN 0 ' +
        'WHEN periodtodate >= :as_of_date THEN 1 ' +
        'WHEN DATEDIFF(:as_of_date, periodtodate) <= 30 THEN 2 ' +
        'WHEN DATEDIFF(:as_of_date, periodtodate) <= 60 THEN 3 ' +
        'WHEN DATEDIFF(:as_of_date, periodtodate) <= 90 THEN 4 ' +
        'ELSE 5 END AS seq, ' +
        'COUNT(DISTINCT enrollmentno) AS students, ' +
        'ROUND(SUM(balance_amount)) AS outstanding ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND balance_amount > 0 ' +
        'GROUP BY bucket, seq ORDER BY seq',
    },
    {
      key: 'by_class',
      description: 'Overdue amount and defaulter count by class',
      sql:
        'SELECT classname, MIN(classseq) AS seq, ' +
        'COUNT(DISTINCT enrollmentno) AS students, ' +
        'ROUND(SUM(balance_amount)) AS outstanding ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND balance_amount > 0 ' +
        'AND periodtodate < :as_of_date ' +
        'GROUP BY classname ORDER BY seq',
    },
    {
      key: 'by_component',
      description: 'Overdue amount by fee head',
      sql:
        'SELECT componentname, COUNT(DISTINCT enrollmentno) AS students, ' +
        'ROUND(SUM(balance_amount)) AS outstanding ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND balance_amount > 0 ' +
        'AND periodtodate < :as_of_date ' +
        'GROUP BY componentname ORDER BY outstanding DESC',
    },
    {
      key: 'top_defaulters',
      description: 'The 50 largest individual balances (identities masked without students.read)',
      sql:
        'SELECT enrollmentno, studentname, classname, sectionname, ' +
        'MIN(classseq) AS seq, ROUND(SUM(balance_amount)) AS outstanding, ' +
        'MAX(DATEDIFF(:as_of_date, periodtodate)) AS days_overdue ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND balance_amount > 0 ' +
        'AND periodtodate < :as_of_date ' +
        'GROUP BY enrollmentno, studentname, classname, sectionname ' +
        'ORDER BY outstanding DESC LIMIT 50',
    },
    /**
     * Drill level 2 — how many students carry overdue fees, by academic quarter,
     * for whichever school the reader clicked at level 1.
     *
     * There is no level-1 query: level 1 keeps the `totals` rows above per
     * school instead of summing them (services/dashboards.ts), so the school
     * breakdown costs nothing on a table where a scan is seconds.
     *
     * -- Bucketed on periodfromdate, filtered on periodtodate ------------------
     * Two different date columns doing two different jobs, deliberately. The
     * OVERDUE test is `periodtodate < :as_of_date` — the same test every other
     * query in this report uses, so a drill cannot quietly redefine what a
     * defaulter is. The BUCKET is the quarter the demand period began in, which
     * is what Fee Collection's drill also uses, so "Q2" means the same instalment
     * on both dashboards and a reader can put them side by side.
     *
     * The two disagree only for a period that starts in one academic quarter and
     * ends in the next. Measured 2026-08-29 on the real extract: 4,158 of
     * 333,598 rows at sacskb (1.2%), 25 at premium_test, and none at all in the
     * four St Marks schools.
     *
     * -- COUNT(DISTINCT), and what that means for the reader -------------------
     * A student overdue on two instalments in the same quarter is one bar-unit,
     * not two. Across quarters they are counted once in each, so these bars add
     * up to more than the school's own figure — by a factor of three at sacskb.
     * That is the honest answer to "how many students are overdue for Q3", which
     * is the number a bursar chasing Q3 needs, and the level carries a note
     * saying so against the chart (`DRILL_PATHS`).
     */
    {
      key: 'defaulters_by_quarter',
      description: 'Students with overdue fees, by academic quarter',
      drill_only: true,
      /**
       * -- Why the overdue test is in the SELECT and not the WHERE ------------
       * Put it in the WHERE and a quarter whose dues have not fallen due yet
       * returns no rows at all, so it draws no bar. On 29 August a reader saw
       * Q1 and Q2 and no explanation, and could not tell "Q3 has no
       * defaulters" from "Q3 is not due yet" from "Q3 does not exist" — three
       * different facts, one of which (nearly 24,000 outstanding rows at Meera
       * Bagh alone) is the opposite of reassuring.
       *
       * Aggregating conditionally instead keeps every quarter that has demand,
       * with a zero where nothing is late. `due_rows` is what tells the two
       * kinds of zero apart: zero due rows means the calendar has not asked
       * yet, while due rows with no defaulters means everybody paid on time —
       * good news, and it should look different from silence. The orchestrator
       * turns the first case into a note naming the quarters (`DrillLevel.
       * pending`).
       *
       * This is the same instinct as the `aging` query's "Not yet due" band a
       * few statements up: the number excluded from a defaulter total is
       * visible rather than invisible.
       *
       * It costs nothing extra. The scan is the same scan — the predicate just
       * moved from filtering rows to classifying them.
       */
      sql:
        `SELECT CONCAT('Q', ${ACADEMIC_QUARTER}) AS quarter, ${ACADEMIC_QUARTER} AS seq, ` +
        'COUNT(DISTINCT CASE WHEN balance_amount > 0 AND periodtodate < :as_of_date ' +
        'THEN enrollmentno END) AS defaulters, ' +
        'ROUND(SUM(CASE WHEN balance_amount > 0 AND periodtodate < :as_of_date ' +
        'THEN balance_amount ELSE 0 END)) AS outstanding, ' +
        'SUM(periodtodate < :as_of_date) AS due_rows ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND periodfromdate IS NOT NULL ' +
        'GROUP BY quarter, seq ORDER BY seq',
    },
    /**
     * Drill level 3 — the same headcount by class, within the clicked school and
     * quarter.
     *
     * These bars DO add up to the quarter above, and that is a fact about
     * students rather than about the SQL: a child sits in one class, so the
     * classes partition the quarter's distinct students exactly. Verified on the
     * real extract (sacskb Q1: 1,056 = 1,056 across 14 classes; Q2: 4,551 =
     * 4,551 across 15).
     *
     * Ordered by `classseq`, never by `classname`, which sorts X before IX.
     */
    {
      key: 'defaulters_by_class',
      description: 'Students with overdue fees, by class',
      drill_only: true,
      /**
       * Classified rather than filtered, for the same reason as the quarter
       * query above and one more besides. Now that a not-yet-due quarter draws
       * a bar, it can be CLICKED — and filtering here would answer that click
       * with a blank panel and no reason, which is a worse dead end than the
       * missing bar was. Keeping the classes and zeroing them lets the level
       * say what it knows.
       *
       * It also steadies the axis: the same classes appear whichever quarter is
       * open, so drilling Q1 then Q2 compares like with like instead of
       * silently dropping whichever classes happened to be clean.
       */
      sql:
        'SELECT classname, MIN(classseq) AS seq, ' +
        'COUNT(DISTINCT CASE WHEN balance_amount > 0 AND periodtodate < :as_of_date ' +
        'THEN enrollmentno END) AS defaulters, ' +
        'ROUND(SUM(CASE WHEN balance_amount > 0 AND periodtodate < :as_of_date ' +
        'THEN balance_amount ELSE 0 END)) AS outstanding, ' +
        'SUM(periodtodate < :as_of_date) AS due_rows ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year ' +
        `AND (:drill_quarter IS NULL OR ${ACADEMIC_QUARTER} = :drill_quarter) ` +
        'GROUP BY classname ORDER BY seq',
    },
  ],
};

/**
 * Staff Overview — docs/06 §2, Phase 1 (docs/11 §1).
 *
 * -- Why there is no academic-year filter ------------------------------------
 * `employees_data_set` has no `academicyearname` column. Staff are not enrolled
 * in a year; they join on a date and leave on one. Faking the filter by mapping
 * '2026-27' onto `joining_year` would answer a different question ("who joined
 * during that year") under the heading of headcount, so the report declares only
 * `as_of_date` and says so on screen. A dashboard whose filter pill does nothing
 * is worse than one that admits the filter does not apply.
 *
 * -- "On roll" is a point-in-time question -----------------------------------
 * Active as of a date = joined on or before it, and either never deactivated or
 * deactivated after it. `deactivation_date IS NULL` alone (which is what the
 * Home summary uses for a live count) would report today's roll under a
 * backdated as-of date, which is the same trap the fee report avoids.
 *
 * Joining and leaving dates may be NULL in the real extract, so every predicate
 * says what it means for NULL rather than letting three-valued logic decide.
 */
const STAFF_OVERVIEW: PredefinedReport = {
  id: 'staff-overview',
  title: 'Staff Overview',
  schema_version: 'erp-v1',
  source: 'employees_data_set',
  domain: 'staff',
  params: [AS_OF_DATE, DRILL_DEPARTMENT],
  queries: [
    /**
     * One scan, three numbers. Headcount, joiners and leavers have different
     * predicates but the same source, and conditional sums answer all three
     * without reading the table three times.
     */
    {
      key: 'movement',
      description: 'Headcount as of the date, plus joiners and leavers in the 12 months before it',
      sql:
        'SELECT SUM(CASE WHEN (deactivation_date IS NULL OR deactivation_date > :as_of_date) ' +
        'AND (joining_date IS NULL OR joining_date <= :as_of_date) THEN 1 ELSE 0 END) AS on_roll, ' +
        'SUM(CASE WHEN DATEDIFF(:as_of_date, joining_date) BETWEEN 0 AND 365 THEN 1 ELSE 0 END) AS joined_12m, ' +
        'SUM(CASE WHEN DATEDIFF(:as_of_date, deactivation_date) BETWEEN 0 AND 365 THEN 1 ELSE 0 END) AS left_12m ' +
        'FROM employees_data_set',
    },
    {
      key: 'by_department',
      description: 'Headcount by department',
      sql:
        'SELECT departmentname, COUNT(*) AS staff FROM employees_data_set ' +
        'WHERE (deactivation_date IS NULL OR deactivation_date > :as_of_date) ' +
        'AND (joining_date IS NULL OR joining_date <= :as_of_date) ' +
        'GROUP BY departmentname ORDER BY staff DESC',
    },
    {
      key: 'by_designation',
      description: 'The 15 largest designations by headcount',
      sql:
        'SELECT designationname, COUNT(*) AS staff FROM employees_data_set ' +
        'WHERE (deactivation_date IS NULL OR deactivation_date > :as_of_date) ' +
        'AND (joining_date IS NULL OR joining_date <= :as_of_date) ' +
        'GROUP BY designationname ORDER BY staff DESC LIMIT 15',
    },
    {
      key: 'by_stafftype',
      /**
       * Employment type, NOT teaching versus non-teaching. In the real extract
       * `stafftype` holds CONFIRMATION / CONTRACTUAL / PROBATION alongside
       * opaque codes (S0011, S004AD) — 19 distinct values across three schools.
       * Teaching staff cannot be separated from the rest without a mapping
       * nobody has confirmed (the same finding already recorded in the Home
       * summary, services/home.ts), so this reports what the column is.
       */
      description: "Headcount by employment type (the ERP's stafftype)",
      sql:
        'SELECT stafftype, COUNT(*) AS staff FROM employees_data_set ' +
        'WHERE (deactivation_date IS NULL OR deactivation_date > :as_of_date) ' +
        'AND (joining_date IS NULL OR joining_date <= :as_of_date) ' +
        'GROUP BY stafftype ORDER BY staff DESC',
    },
    {
      key: 'by_gender',
      description: 'Gender mix of staff on roll',
      sql:
        'SELECT gender, COUNT(*) AS staff FROM employees_data_set ' +
        'WHERE (deactivation_date IS NULL OR deactivation_date > :as_of_date) ' +
        'AND (joining_date IS NULL OR joining_date <= :as_of_date) ' +
        'GROUP BY gender ORDER BY staff DESC',
    },
    {
      key: 'leavers_by_reason',
      description: 'Why staff left, over the 12 months before the date',
      sql:
        'SELECT reason_for_leaving, COUNT(*) AS leavers FROM employees_data_set ' +
        'WHERE DATEDIFF(:as_of_date, deactivation_date) BETWEEN 0 AND 365 ' +
        'GROUP BY reason_for_leaving ORDER BY leavers DESC',
    },
    /**
     * Drill level 3 — designations within the clicked department.
     *
     * Levels 1 and 2 introduce no SQL: level 1 keeps `by_department` per school
     * rather than summing it across schools, and level 2 IS `by_department`.
     * Only the leaf has to narrow, and narrowing has to happen in the database.
     *
     * -- Why this path has no quarter, and stops at designation ----------------
     * Headcount is a point-in-time question ("who is on the payroll on this
     * date"), not a per-period one, so there is no honest quarter level to
     * offer: staff are not enrolled in a term. Department → designation is the
     * hierarchy the columns actually describe — TEACHING contains PRT, TGT and
     * PGT — and the path stops there because nothing below designation exists
     * short of naming individuals, which is a different report with a different
     * PII posture.
     *
     * Deliberately NOT `LIMIT 15` as `by_designation` has. That cap makes sense
     * for a whole school's designation chart, where the tail is noise; inside
     * ONE department the tail is the small teams, and dropping them would make
     * the bars fail to account for the department total directly above them.
     */
    {
      key: 'by_designation_for_department',
      description: 'Headcount by designation, within one department',
      drill_only: true,
      sql:
        'SELECT designationname, COUNT(*) AS staff FROM employees_data_set ' +
        'WHERE (deactivation_date IS NULL OR deactivation_date > :as_of_date) ' +
        'AND (joining_date IS NULL OR joining_date <= :as_of_date) ' +
        'AND (:drill_department IS NULL OR departmentname = :drill_department) ' +
        'GROUP BY designationname ORDER BY staff DESC',
    },
  ],
};

/**
 * Admissions Funnel — docs/06 §2; taken into Phase 1 as the fifth dashboard
 * (docs/11 §1 names it "a viable fifth if Phase 1 has room").
 *
 * -- The stages are INFERRED, and that has to be said ------------------------
 * `students_admission_data_set` carries an enquiry number, a registration
 * number, an application number and an admission number per candidate, and a
 * `candidate_statusid`. There is no stage column and no stage-transition dates,
 * so "reached registration" is read as "has a registration number". That is a
 * reasonable reading of the ERP's own numbering and it is still a reading: the
 * dashboard states it, and `by_status` publishes the ERP's own status counts
 * beside it so the two can be compared rather than conflated.
 *
 * `candidate_statusid` has no lookup table in this extract, so the ids are shown
 * as ids. Inventing labels for them would be the analytics layer asserting
 * meaning the ERP never gave it; the status lookup is an owed input (docs/11 §2
 * item 6) and this is where its absence is felt.
 *
 * -- Counting, not identifying -----------------------------------------------
 * The identifier columns are `pii: 'students'`, but they appear here only inside
 * `SUM(CASE WHEN ... IS NOT NULL ...)`, which yields a count and never a name.
 * Rail 6 masks a column by its ORIGIN, so an aggregate is not masked — correct
 * here, and worth knowing before someone adds a raw identifier column to this
 * report and assumes masking will cover it.
 */
const ADMISSIONS_FUNNEL: PredefinedReport = {
  id: 'admissions-funnel',
  title: 'Admissions Funnel',
  schema_version: 'erp-v1',
  source: 'students_admission_data_set',
  domain: 'students',
  params: [ACADEMIC_YEAR],
  queries: [
    {
      key: 'funnel',
      description: 'Candidates reaching each stage, inferred from the numbers the ERP issued',
      sql:
        'SELECT COUNT(*) AS candidates, ' +
        "SUM(CASE WHEN enquiryno IS NOT NULL AND enquiryno <> '' THEN 1 ELSE 0 END) AS enquiries, " +
        "SUM(CASE WHEN registrationno IS NOT NULL AND registrationno <> '' THEN 1 ELSE 0 END) AS registrations, " +
        "SUM(CASE WHEN applicationno IS NOT NULL AND applicationno <> '' THEN 1 ELSE 0 END) AS applications, " +
        "SUM(CASE WHEN admissionno IS NOT NULL AND admissionno <> '' THEN 1 ELSE 0 END) AS admissions " +
        'FROM students_admission_data_set WHERE academicyearname = :academic_year',
    },
    {
      key: 'by_class',
      description: 'Candidates and admissions by class applied for',
      sql:
        'SELECT classname, MIN(classid) AS seq, COUNT(*) AS candidates, ' +
        "SUM(CASE WHEN admissionno IS NOT NULL AND admissionno <> '' THEN 1 ELSE 0 END) AS admissions " +
        'FROM students_admission_data_set WHERE academicyearname = :academic_year ' +
        'GROUP BY classname ORDER BY seq',
    },
    {
      key: 'by_status',
      description: "The ERP's own candidate status counts (ids; no status lookup was supplied)",
      sql:
        'SELECT candidate_statusid, COUNT(*) AS candidates ' +
        'FROM students_admission_data_set WHERE academicyearname = :academic_year ' +
        'GROUP BY candidate_statusid ORDER BY candidates DESC',
    },
    {
      key: 'by_gender',
      description: 'Gender mix of candidates and of those admitted',
      sql:
        'SELECT gender, COUNT(*) AS candidates, ' +
        "SUM(CASE WHEN admissionno IS NOT NULL AND admissionno <> '' THEN 1 ELSE 0 END) AS admissions " +
        'FROM students_admission_data_set WHERE academicyearname = :academic_year ' +
        'GROUP BY gender ORDER BY candidates DESC',
    },
  ],
};

/**
 * The date window an attendance report is computed over.
 *
 * Attendance is the one domain in this catalog that CANNOT be filtered by
 * academic year, and that is a property of the delivered data rather than a
 * preference. In `student_attendance_data_set` every row carries the CURRENT
 * academic year rather than the year its own `attendancedate` falls in -- rows
 * dated August 2024 arrive labelled `2026-27`, contradicted by the row's own
 * `academicyearfromdate` of 01-04-2026. Either the extract stamps the label at
 * export time or the sample is wrong; both readings break the same filter.
 *
 * So the year selector on screen is resolved to a date window by the caller and
 * bound here, and `attendancedate` -- which is trustworthy, and is the column the
 * number actually means -- carries the filter. Adding `academicyearname` beside
 * it would not be belt and braces: under the "stamped at export" reading it
 * would silently drop every row of any year but the current one.
 */
const FROM_DATE: ReportParam = {
  name: 'from_date',
  type: 'string',
  required: true,
  description: 'First date of the attendance window, YYYY-MM-DD, inclusive.',
};

const TO_DATE: ReportParam = {
  name: 'to_date',
  type: 'string',
  required: true,
  description: 'Last date of the attendance window, YYYY-MM-DD, inclusive.',
};

/**
 * One row per student per day -- which the table does not give us.
 *
 * `student_attendance_data_set` is not unique on (studentid, attendancedate):
 * in the delivered extract one student carries six rows for 2024-10-15, each
 * with its own `attendanceid`. Whether the ERP keeps re-markings as history or
 * the extract flattened period-wise rows and lost the period is an open question
 * for the ERP team; either way a report that counts rows counts that day six
 * times, and every rate below it is wrong by an amount nobody can see.
 *
 * So every attendance query starts from this: group the window down to one row
 * per student-day taking the largest `id`, then join back for the columns. `id`
 * rather than `attendanceid` because `id` is the extract's own AUTO_INCREMENT
 * primary key and is therefore guaranteed unique and non-null, which is exactly
 * what a tie-break needs to be. Which of six rows wins is arbitrary; that it is
 * ONE row is not.
 *
 * The window predicate is repeated inside the subquery deliberately. It has to
 * be: without it the GROUP BY spans the whole table and the join then discards
 * most of what it built.
 */
const STUDENT_DAYS =
  '(SELECT MAX(id) AS id FROM student_attendance_data_set ' +
  'WHERE attendancedate BETWEEN :from_date AND :to_date ' +
  'GROUP BY studentid, attendancedate) k ' +
  'JOIN student_attendance_data_set a ON a.id = k.id';

/**
 * The status buckets.
 *
 * Keyed on `statusname`, never on `statusid`, because the ids are not stable
 * across tables -- 5 is Suspend for a student and Absent for an employee, and 1
 * and 6 both mean Present. No canonical status list was supplied with the
 * extract (it joins the owed inputs in docs/11 section 2 item 6), so anything
 * outside the four observed values falls into `other_days` rather than being
 * assumed to mean absent. The dashboard publishes the raw `by_status` counts
 * beside every rate for the same reason the Admissions funnel publishes
 * `candidate_statusid`: a reader can then check the bucketing instead of
 * trusting it.
 */
const STATUS_SUMS =
  "SUM(CASE WHEN a.statusname = 'Present' THEN 1 ELSE 0 END) AS present_days, " +
  "SUM(CASE WHEN a.statusname = 'Absent' THEN 1 ELSE 0 END) AS absent_days, " +
  "SUM(CASE WHEN a.statusname = 'Leave' THEN 1 ELSE 0 END) AS leave_days, " +
  "SUM(CASE WHEN a.statusname IS NULL OR a.statusname NOT IN ('Present', 'Absent', 'Leave') " +
  'THEN 1 ELSE 0 END) AS other_days';

/** `2026-07` from `2026-07-21`, and `202607` to sort it by. */
const MONTH_SEQ = 'MIN(LEFT(a.attendancedate, 4) * 100 + SUBSTRING(a.attendancedate, 6, 2)) AS seq';

/**
 * Attendance Analytics -- docs/06 section 2, deferred to Phase 3 by docs/11
 * section 1 for want of data and taken up on 2026-08-21 when a second extract
 * delivered the table.
 *
 * -- What "attendance rate" means here ----------------------------------------
 * present student-days / MARKED student-days. Not present over working days,
 * because nothing in the extract says which days were working days: there is no
 * school calendar, no holiday table and no timetable. Any denominator built from
 * the calendar would be this platform inventing a school's year, and it would be
 * wrong first for exactly the schools that need the number most.
 *
 * The cost of the honest denominator is that a day a teacher never marked simply
 * is not counted, rather than counting as absent -- which flatters a school with
 * poor marking discipline. That is why `expected_days` is computed beside it and
 * the dashboard leads with a marking-coverage tile: the weakness is put on the
 * screen rather than left in this comment. Coverage is a real metric in its own
 * right, and for most principals a more actionable one than the rate.
 *
 * -- Why the academic year is still a parameter -------------------------------
 * Not for the attendance table, which cannot be trusted to carry it (see
 * FROM_DATE). It is bound only against `students_data_set`, whose year column is
 * reliable, to count how many students were on roll -- the denominator of
 * coverage. Two filters against two tables, each on the column that table can
 * actually support.
 */
const ATTENDANCE_ANALYTICS: PredefinedReport = {
  id: 'attendance-analytics',
  title: 'Attendance Analytics',
  schema_version: 'erp-v1',
  source: 'student_attendance_data_set',
  domain: 'students',
  params: [ACADEMIC_YEAR, FROM_DATE, TO_DATE, DRILL_QUARTER],
  queries: [
    {
      key: 'summary',
      description: 'Marked student-days, days marked, and how many were expected',
      sql:
        'SELECT COUNT(*) AS marked_days, ' +
        'COUNT(DISTINCT a.attendancedate) AS working_days, ' +
        'COUNT(DISTINCT a.studentid) AS students_marked, ' +
        /**
         * Expected student-days for THIS school, multiplied in SQL rather than
         * in the merge. Across several schools the honest total is
         * SUM(days_i x roll_i), and a merge that summed days and roll separately
         * before multiplying would produce a number belonging to no school.
         */
        'COUNT(DISTINCT a.attendancedate) * (SELECT COUNT(*) FROM students_data_set ' +
        'WHERE academicyearname = :academic_year AND deactivation_date IS NULL) AS expected_days, ' +
        STATUS_SUMS +
        ' FROM ' +
        STUDENT_DAYS,
    },
    {
      key: 'by_month',
      description: 'Attendance by month over the window',
      sql:
        'SELECT LEFT(a.attendancedate, 7) AS month, ' +
        MONTH_SEQ +
        ', COUNT(*) AS marked_days, COUNT(DISTINCT a.attendancedate) AS working_days, ' +
        STATUS_SUMS +
        ' FROM ' +
        STUDENT_DAYS +
        ' GROUP BY LEFT(a.attendancedate, 7) ORDER BY seq',
    },
    {
      key: 'by_class',
      description: 'Attendance by class',
      sql:
        'SELECT a.classname, COUNT(*) AS marked_days, ' +
        'COUNT(DISTINCT a.studentid) AS students_marked, ' +
        STATUS_SUMS +
        ' FROM ' +
        STUDENT_DAYS +
        ' GROUP BY a.classname ORDER BY marked_days DESC',
    },
    {
      /**
       * The attendance table has no `classseq`, so the ordinal is fetched from
       * the table that owns it and applied during the merge. A join would have
       * been the obvious alternative and is the wrong one here: a student with
       * more than one enrolment row for the year would fan the attendance rows
       * out and inflate every count in `by_class` -- a wrong number rather than
       * a wrongly ordered axis.
       */
      key: 'class_order',
      description: 'Class ordinals, read from enrolment because attendance has none',
      sql:
        'SELECT classname, MIN(classseq) AS seq FROM students_data_set ' +
        'WHERE academicyearname = :academic_year GROUP BY classname ORDER BY seq',
    },
    {
      key: 'by_status',
      description: 'What the ERP actually recorded, unbucketed',
      sql:
        'SELECT a.statusname, COUNT(*) AS days FROM ' +
        STUDENT_DAYS +
        ' GROUP BY a.statusname ORDER BY days DESC',
    },
    {
      /**
       * The 75% line comes from docs/06 section 4.2, which puts `student(<75%)`
       * at the bottom of the attendance drill path, and from PROJECT_CONTEXT
       * section 1's flagship Ask-AI question. No minimum number of marked days
       * is imposed: a student marked once and absent once really is at 0%, and
       * hiding them behind a threshold would be this layer deciding which
       * children count. `marked_days` is therefore a column on the table, so a
       * one-day 0% is visibly a one-day 0%.
       */
      key: 'low_attendance',
      description: 'Students below 75% of their own marked days',
      sql:
        'SELECT a.studentname, a.enrollmentno, a.classname, a.sectionname, ' +
        'COUNT(*) AS marked_days, ' +
        "SUM(CASE WHEN a.statusname = 'Present' THEN 1 ELSE 0 END) AS present_days" +
        ' FROM ' +
        STUDENT_DAYS +
        ' GROUP BY a.studentid, a.studentname, a.enrollmentno, a.classname, a.sectionname ' +
        "HAVING SUM(CASE WHEN a.statusname = 'Present' THEN 1 ELSE 0 END) < 0.75 * COUNT(*) " +
        "ORDER BY SUM(CASE WHEN a.statusname = 'Present' THEN 1 ELSE 0 END) / COUNT(*) ASC, " +
        'marked_days DESC LIMIT 200',
    },
    /**
     * Drill level 2 — the same status counts by academic quarter.
     *
     * -- Why quarter and not month ----------------------------------------------
     * This level WAS `by_month`, and the swap is deliberate rather than a
     * preference. Fees and Defaulters both descend school → quarter → class, and
     * an attendance drill that descended school → month → class made the middle
     * level mean something different on one card out of four — a reader
     * comparing "Q2 fees" with "July attendance" is comparing two windows
     * without being told. The quarter is the same Apr–Mar boundary the fee
     * ledger uses (`academicQuarter`), so the two now line up by construction.
     *
     * Nothing is lost from the product: the dashboard's own `by_month` line
     * chart still draws the monthly trend on the report page, which is where
     * month-level detail was actually being read. The DRILL is about descending
     * a hierarchy, and quarter is the level the rest of the platform descends
     * through.
     *
     * `seq` is the quarter NUMBER, which is what a click binds (`drill_quarter`
     * is typed `number`), while `quarter` is the "Q2" a reader sees. Same
     * split as `demand_by_quarter`, for the same reason: the axis label and the
     * bound value are different things and conflating them makes the drill
     * depend on a display string.
     */
    {
      key: 'by_quarter',
      description: 'Present and absent student-days by academic quarter',
      drill_only: true,
      sql:
        `SELECT CONCAT('Q', ${ATTENDANCE_QUARTER}) AS quarter, ${ATTENDANCE_QUARTER} AS seq, ` +
        'COUNT(*) AS marked_days, COUNT(DISTINCT a.attendancedate) AS working_days, ' +
        STATUS_SUMS +
        ' FROM ' +
        STUDENT_DAYS +
        ' GROUP BY quarter, seq ORDER BY seq',
    },
    /**
     * Drill level 3 — the same status counts by class, within the clicked
     * quarter.
     *
     * Level 1 adds no SQL (it keeps `summary` per school); levels 2 and 3 are
     * the two statements above and below this comment.
     *
     * `:drill_quarter IS NULL OR …` rather than two statements, exactly as
     * `demand_by_class` does it: a `variants` pair differing only in a WHERE
     * clause would, the day one of them gained a measure, quietly answer a
     * different question under the same heading. Level 3 always arrives WITH a
     * quarter by construction (its context is [school, quarter] — see
     * DRILL_PATHS); the null branch keeps the statement honest if it is ever run
     * on its own.
     *
     * The drill measures are COUNTS (present and absent student-days), never
     * the rate the dashboard's own tiles show. A rate is a quotient, and
     * quotients do not survive the merge `sumBy` performs: adding two schools'
     * rates, or two quarters', produces a number belonging to neither. Counts
     * add correctly at every level, and the ratio a reader wants is legible in
     * the two bars standing side by side.
     */
    {
      key: 'by_class_for_quarter',
      description: 'Present and absent student-days by class, within one academic quarter',
      drill_only: true,
      sql:
        'SELECT a.classname, COUNT(*) AS marked_days, ' +
        STATUS_SUMS +
        ' FROM ' +
        STUDENT_DAYS +
        ` WHERE (:drill_quarter IS NULL OR ${ATTENDANCE_QUARTER} = :drill_quarter) ` +
        'GROUP BY a.classname ORDER BY marked_days DESC',
    },
  ],
};


/**
 * One row per employee-day, de-duplicated before anything counts it.
 *
 * `employee_attendance_data_set` is not unique on (employee, date) any more than
 * the student table is, and `id` is the column the schema names as the unique
 * one — so MAX(id) picks exactly one marking per employee-day. Which of several
 * rows wins is arbitrary; that it is ONE row is not.
 *
 * The window predicate is repeated inside the subquery deliberately, for the
 * same reason it is on the student side: without it the GROUP BY spans the whole
 * table and the join then discards most of what it built.
 */
const STAFF_DAYS =
  '(SELECT MAX(id) AS id FROM employee_attendance_data_set ' +
  'WHERE attendancedate BETWEEN :from_date AND :to_date ' +
  'GROUP BY employeeid, attendancedate) k ' +
  'JOIN employee_attendance_data_set e ON e.id = k.id';

/**
 * The staff status buckets, and the half-day is the point of them.
 *
 * Keyed on `statusname`, never `statusid` — the ids disagree ACROSS the two
 * attendance tables (5 is Absent here, Suspend on the student side), so
 * branching on the id would be right on one table and quietly wrong on the
 * other.
 *
 * `half_days` is its own bucket rather than being added to either neighbour.
 * Folding a half-day into present says half a day of work counted as a whole
 * one; folding it into absent says it counted as none. The ERP made neither
 * claim, a payroll clerk would dispute them in opposite directions, and the
 * schema note already warns that this is exactly why a staff rate "is not a
 * plain present/total count".
 *
 * `other_days` catches anything outside the four observed statuses instead of
 * assuming it means absent — the same defence the student table's sums apply,
 * and for the same reason: no canonical status list came with the extract.
 */
const STAFF_STATUS_SUMS =
  "SUM(CASE WHEN e.statusname = 'Present' THEN 1 ELSE 0 END) AS present_days, " +
  "SUM(CASE WHEN e.statusname = 'Absent' THEN 1 ELSE 0 END) AS absent_days, " +
  "SUM(CASE WHEN e.statusname IN ('First Half Leave', 'Second Half Leave') " +
  'THEN 1 ELSE 0 END) AS half_days, ' +
  "SUM(CASE WHEN e.statusname IS NULL OR e.statusname NOT IN " +
  "('Present', 'Absent', 'First Half Leave', 'Second Half Leave') " +
  'THEN 1 ELSE 0 END) AS other_days';

/** The academic quarter against the staff register's own date column. */
const STAFF_QUARTER = academicQuarter('e.attendancedate');



/**
 * Fee by Student — what each individual child owes, from the demand ledger.
 *
 * -- How this differs from Fee Defaulters, which it would otherwise duplicate --
 * Fee Defaulters answers "who is LATE": every one of its statements filters
 * `periodtodate < :as_of_date`, so an instalment not yet due is invisible there
 * by design. This report answers "what does each student OWE", over the whole
 * year's book, due or not. The same child appears in both with different
 * numbers, and that is correct rather than a discrepancy — a family owing
 * ₹80,000 for the year of which ₹20,000 has fallen due is a ₹20,000 defaulter
 * and an ₹80,000 payer. Both reports say on screen which question they answer,
 * because a bursar comparing the two totals must not read the gap as an error.
 *
 * There is deliberately no `as_of_date` here for that reason: nothing in this
 * report depends on what has fallen due, so a filter that appeared to move the
 * numbers and did not would be worse than no filter at all.
 *
 * -- This report NAMES children, and what protects them ----------------------
 * `students` selects `studentname` and `enrollmentno`, both `pii: 'students'`
 * in the schema catalog. A session without `students.read` — an accountant, per
 * docs/08 §4.5 — receives the amounts with the identities replaced by
 * `[masked]`, applied at the MCP layer by rail 6 from MySQL's own column
 * origins, without this statement needing to know it. `fees.read` alone is
 * therefore NOT enough to see a child's name here, which is the platform's
 * existing policy and not a rule this report invents.
 *
 * `LIMIT 200` is docs/06 §4.2's "student-level leaves are top-N capped".
 * Larger than Fee Defaulters' 50 because this is the report's PRINCIPAL
 * content rather than a supporting panel, and small enough that it stays a
 * ranked list a person reads rather than an export of the school roll.
 *
 * -- Two scans, and why they are not one -------------------------------------
 * `totals` reads the whole book; `dues` reads only rows carrying a balance.
 * They could be folded into one statement with conditional aggregates, and the
 * folded version needs `COUNT(DISTINCT CASE WHEN … END)` to count students with
 * dues — an expression the SQL guard has no reason to have seen before. Two
 * plain statements over an unindexed table cost more than one clever one; being
 * certain what each returns is worth that on a report that names children.
 */
const FEE_BY_STUDENT: PredefinedReport = {
  id: 'fee-by-student',
  title: 'Fee by Student',
  schema_version: 'erp-v1',
  source: 'fee_compile_data_set',
  domain: 'fees',
  params: [ACADEMIC_YEAR, DRILL_QUARTER],
  queries: [
    {
      key: 'totals',
      description: "The year's whole demand, and how many students it was raised against",
      sql:
        'SELECT COUNT(DISTINCT enrollmentno) AS students_billed, ' +
        'ROUND(SUM(total_payable_amount)) AS payable, ' +
        'ROUND(SUM(paid_amount)) AS paid ' +
        'FROM fee_compile_data_set WHERE academicyearname = :academic_year',
    },
    {
      /**
       * Students carrying a balance, and what they carry between them. Rows with
       * a credit balance are excluded rather than netted off: a student who has
       * overpaid does not reduce what another family owes, and arrears are the
       * number someone acts on. Same rule as the Dashboard's fee tile.
       */
      key: 'dues',
      description: 'Students carrying a balance, and the total outstanding',
      sql:
        'SELECT COUNT(DISTINCT enrollmentno) AS students, ' +
        'ROUND(SUM(balance_amount)) AS outstanding ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND balance_amount > 0',
    },
    {
      key: 'by_class',
      description: 'Outstanding and students carrying it, by class',
      sql:
        'SELECT classname, MIN(classseq) AS seq, ' +
        'COUNT(DISTINCT enrollmentno) AS students, ' +
        'ROUND(SUM(balance_amount)) AS outstanding ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND balance_amount > 0 ' +
        'GROUP BY classname ORDER BY seq',
    },
    {
      /**
       * The report's principal content: one row per student, largest balance
       * first. Grouped by `enrollmentno` as well as name because two children
       * can share a name and must not be merged into one row — the enrolment
       * number is the identifier, the name is how a person recognises it.
       */
      key: 'students',
      description: 'What each student owes, largest balance first (top 200)',
      sql:
        'SELECT studentname, enrollmentno, classname, sectionname, ' +
        'ROUND(SUM(total_payable_amount)) AS payable, ' +
        'ROUND(SUM(paid_amount)) AS paid, ' +
        'ROUND(SUM(balance_amount)) AS balance ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND balance_amount > 0 ' +
        'GROUP BY enrollmentno, studentname, classname, sectionname ' +
        'ORDER BY balance DESC LIMIT 200',
    },
    /**
     * Drill level 2 — outstanding by the quarter the money was demanded FOR.
     *
     * `periodfromdate` and not `periodtodate`, the same choice Fee Collection's
     * quarter level makes: a quarter here means the period the fee was raised
     * for, which is where a bursar looks for an instalment. `IS NOT NULL` keeps
     * the axis to exactly Q1..Q4 — a row with no demand period has no quarter,
     * and letting it through would draw a fifth unlabelled bar whose click binds
     * a quarter matching nothing.
     */
    {
      key: 'by_quarter',
      description: 'Outstanding by academic quarter, from the demand ledger',
      drill_only: true,
      sql:
        `SELECT CONCAT('Q', ${ACADEMIC_QUARTER}) AS quarter, ${ACADEMIC_QUARTER} AS seq, ` +
        'COUNT(DISTINCT enrollmentno) AS students, ' +
        'ROUND(SUM(balance_amount)) AS outstanding ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND balance_amount > 0 ' +
        'AND periodfromdate IS NOT NULL ' +
        'GROUP BY quarter, seq ORDER BY seq',
    },
    {
      key: 'by_class_for_quarter',
      description: 'Outstanding by class, within one academic quarter',
      drill_only: true,
      sql:
        'SELECT classname, MIN(classseq) AS seq, ' +
        'COUNT(DISTINCT enrollmentno) AS students, ' +
        'ROUND(SUM(balance_amount)) AS outstanding ' +
        'FROM fee_compile_data_set ' +
        'WHERE academicyearname = :academic_year AND balance_amount > 0 ' +
        `AND (:drill_quarter IS NULL OR ${ACADEMIC_QUARTER} = :drill_quarter) ` +
        'GROUP BY classname ORDER BY seq',
    },
  ],
};

/**
 * Staff Attendance — `employee_attendance_data_set`.
 *
 * -- Why this exists now, when docs/11 said it should not ---------------------
 * docs/11 §2 recorded staff attendance as "deliberately not a dashboard": the
 * table was catalogued so Ask AI could reach it, but the only staff-attendance
 * entry in docs/06 §2's catalog was the Director's Cross-School Attendance,
 * which is Phase 2 and needs the rollup store. Adding a school-level dashboard
 * was therefore a NEW catalog entry rather than an implementation of an
 * existing one — which is a decision, not an oversight, and it has now been
 * taken. docs/11 records the amendment.
 *
 * -- Three traps, all of them the same shape as the student table ------------
 * This is `student_attendance_data_set`'s sibling and it carries the same
 * hazards, which is why the statements below look like Attendance Analytics'
 * and not like something new:
 *
 *   1. De-duplicate to one row per employee-day FIRST. `attendanceid` is not
 *      unique; `id` is (schema/erp-v1.ts says so in as many words), so the
 *      subquery picks MAX(id) per (employeeid, attendancedate). Counting rows
 *      instead would count a day as many times as it was written.
 *   2. Read `statusname`, never `statusid`. The codes disagree ACROSS the two
 *      attendance tables — 5 is Absent here and Suspend there — so a query that
 *      branched on the id would be right on one table and silently wrong on the
 *      other.
 *   3. There is no academic year, and none is faked. Staff are not enrolled in
 *      one. The window is `from_date`/`to_date`, exactly as the student report
 *      does it for the same reason.
 *
 * -- The half-days are the one thing that is NOT like the student table ------
 * The observed statuses are Present, Absent, First Half Leave and Second Half
 * Leave, and the schema note is explicit that "the half-day statuses are why a
 * staff attendance rate is not a plain present/total count".
 *
 * So a half-day is NOT folded into present, and NOT folded into absent. It gets
 * its own bucket, is drawn as its own bar, and is named on screen. Either
 * folding would be this layer deciding that half a day of work counts as a
 * whole one or as none — a judgement the ERP did not make and that a payroll
 * clerk would dispute in opposite directions. `other_days` catches anything
 * outside the four observed values rather than assuming it means absent, the
 * same defence `STATUS_SUMS` applies on the student side.
 */
const STAFF_ATTENDANCE: PredefinedReport = {
  id: 'staff-attendance',
  title: 'Staff Attendance',
  schema_version: 'erp-v1',
  source: 'employee_attendance_data_set',
  domain: 'staff',
  params: [FROM_DATE, TO_DATE, DRILL_QUARTER],
  queries: [
    {
      key: 'summary',
      description: 'Marked staff-days over the window, by what was recorded',
      sql:
        'SELECT COUNT(*) AS marked_days, ' +
        'COUNT(DISTINCT e.attendancedate) AS days_marked, ' +
        'COUNT(DISTINCT e.employeeid) AS staff_marked, ' +
        STAFF_STATUS_SUMS +
        ' FROM ' +
        STAFF_DAYS,
    },
    {
      key: 'by_month',
      description: 'Staff attendance by month over the window',
      sql:
        'SELECT LEFT(e.attendancedate, 7) AS month, ' +
        'MIN(LEFT(e.attendancedate, 4) * 100 + SUBSTRING(e.attendancedate, 6, 2)) AS seq, ' +
        'COUNT(*) AS marked_days, ' +
        STAFF_STATUS_SUMS +
        ' FROM ' +
        STAFF_DAYS +
        ' GROUP BY LEFT(e.attendancedate, 7) ORDER BY seq',
    },
    {
      key: 'by_department',
      description: 'Staff attendance by department',
      sql:
        'SELECT e.departmentname, COUNT(*) AS marked_days, ' +
        'COUNT(DISTINCT e.employeeid) AS staff_marked, ' +
        STAFF_STATUS_SUMS +
        ' FROM ' +
        STAFF_DAYS +
        ' GROUP BY e.departmentname ORDER BY marked_days DESC',
    },
    {
      key: 'by_status',
      description: 'What the ERP actually recorded, unbucketed',
      sql:
        'SELECT e.statusname, COUNT(*) AS days FROM ' +
        STAFF_DAYS +
        ' GROUP BY e.statusname ORDER BY days DESC',
    },
    /**
     * Drill level 2 — the same status counts by academic quarter.
     *
     * A quarter is available here in a way it is not for Staff Overview: this
     * table has a real per-row date, so bucketing is arithmetic rather than
     * invention. Same Apr–Mar boundary as every other quarter in the platform
     * (`academicQuarter`), so a reader comparing staff attendance against fees
     * or student attendance is comparing the same window.
     */
    {
      key: 'by_quarter',
      description: 'Staff attendance by academic quarter',
      drill_only: true,
      sql:
        `SELECT CONCAT('Q', ${STAFF_QUARTER}) AS quarter, ${STAFF_QUARTER} AS seq, ` +
        'COUNT(*) AS marked_days, ' +
        STAFF_STATUS_SUMS +
        ' FROM ' +
        STAFF_DAYS +
        ' GROUP BY quarter, seq ORDER BY seq',
    },
    /**
     * Drill level 3 — the same counts by department, within the clicked
     * quarter. Department is the leaf because the only level below it is
     * naming individuals, which is a different report with a different PII
     * posture — the same boundary Staff Overview's path stops at.
     */
    {
      key: 'by_department_for_quarter',
      description: 'Staff attendance by department, within one academic quarter',
      drill_only: true,
      sql:
        'SELECT e.departmentname, COUNT(*) AS marked_days, ' +
        STAFF_STATUS_SUMS +
        ' FROM ' +
        STAFF_DAYS +
        ` WHERE (:drill_quarter IS NULL OR ${STAFF_QUARTER} = :drill_quarter) ` +
        'GROUP BY e.departmentname ORDER BY marked_days DESC',
    },
  ],
};

/**
 * Principal's Snapshot -- docs/06 §2 ("default single-school landing"), taken
 * up 2026-08-26 as one of the remaining predefined dashboards.
 *
 * -- Why this is genuinely cross-domain, and what that costs -----------------
 * Every other report in this file reads one domain's tables. This one reads
 * three -- students_data_set (students), fee_compile_data_set (fees) and
 * employees_data_set (staff) -- because a principal's one-page snapshot is
 * exactly the report a single-domain catalog cannot produce. The SQL guard
 * already enforces access per TABLE, not per report (sql/guard.ts reads
 * `table.domain`, never a report-level field), so a session with only
 * `fees.read` is refused the staff and enrolment queries here and served the
 * fee one -- correct without this file doing anything extra. `domain:
 * 'students'` below is informational only (it feeds the "Source" chip's
 * grouping and nothing else -- confirmed by grep before this was written), and
 * reports-catalog.test.ts's permission-gating test was generalised alongside
 * this report to check each query against the domains its OWN tables need
 * rather than assume one domain speaks for the whole report.
 *
 * -- What it is, and what it deliberately is not -----------------------------
 * The same five numbers Home's KPI strip already shows (services/home.ts),
 * rebuilt as a first-class `report_definitions` entry: one with a Logic panel,
 * a PDF, a place in My Reports and clone-to-edit -- everything Home's ad hoc
 * `run_multi` metrics do not get. It is not a replacement for Home, and it is
 * not a re-derivation of any other dashboard's full breakdown -- follow the
 * "Clone & customize" or "Ask AI about this data" link on this dashboard, or
 * open Enrollment/Fee Collection/Staff Overview/Admissions/Attendance
 * directly, for the detail underneath any one of these five numbers.
 */
const PRINCIPAL_SNAPSHOT: PredefinedReport = {
  id: 'principal-snapshot',
  title: "Principal's Snapshot",
  schema_version: 'erp-v1',
  source:
    'students_data_set · fee_compile_data_set · employees_data_set · students_admission_data_set · student_attendance_data_set',
  domain: 'students',
  params: [ACADEMIC_YEAR, AS_OF_DATE, FROM_DATE, TO_DATE],
  queries: [
    {
      key: 'by_class',
      description: 'Students on roll by class (also gives the roll total)',
      sql:
        'SELECT classname, MIN(classseq) AS seq, COUNT(*) AS students ' +
        'FROM students_data_set ' +
        'WHERE academicyearname = :academic_year AND deactivation_date IS NULL ' +
        'GROUP BY classname ORDER BY seq',
    },
    {
      key: 'fees',
      description: 'Fee demand, realisation and balance for the year',
      sql:
        'SELECT ROUND(SUM(total_payable_amount)) AS payable, ' +
        'ROUND(SUM(paid_amount)) AS paid, ROUND(SUM(balance_amount)) AS balance ' +
        'FROM fee_compile_data_set WHERE academicyearname = :academic_year',
    },
    {
      key: 'staff',
      description: 'Staff on roll as of the date',
      sql:
        'SELECT SUM(CASE WHEN (deactivation_date IS NULL OR deactivation_date > :as_of_date) ' +
        'AND (joining_date IS NULL OR joining_date <= :as_of_date) THEN 1 ELSE 0 END) AS on_roll ' +
        'FROM employees_data_set',
    },
    {
      key: 'admissions',
      description: 'Candidates and admissions so far this year',
      sql:
        'SELECT COUNT(*) AS candidates, ' +
        "SUM(CASE WHEN admissionno IS NOT NULL AND admissionno <> '' THEN 1 ELSE 0 END) AS admissions " +
        'FROM students_admission_data_set WHERE academicyearname = :academic_year',
    },
    {
      /**
       * The same de-duplication Attendance Analytics uses (STUDENT_DAYS below),
       * inlined rather than shared across two reports of different shape -- see
       * that constant's own comment for why one row per student-day must be
       * taken before anything is counted.
       */
      key: 'attendance',
      description: 'Attendance rate over the window',
      sql:
        "SELECT COUNT(*) AS marked_days, SUM(CASE WHEN a.statusname = 'Present' THEN 1 ELSE 0 END) AS present_days " +
        'FROM (SELECT MAX(id) AS id FROM student_attendance_data_set ' +
        'WHERE attendancedate BETWEEN :from_date AND :to_date ' +
        'GROUP BY studentid, attendancedate) k ' +
        'JOIN student_attendance_data_set a ON a.id = k.id',
    },
  ],
};

/**
 * Transport Analytics -- docs/06 §2, taken up 2026-08-26, corrected the same
 * day against schema/erp-v1.ts's verified `student_transport_data_set` entry.
 *
 * No parameters, and that is a property of the table rather than an
 * oversight: it carries no trustworthy date (its `academicyearname` carries
 * the same stamped-current-year trap the attendance tables and
 * book_issue_data_set do, and there is no other date column), so a query here
 * reads whatever rows the table holds, unfiltered by time. Class ordering
 * needs its own query (`class_order`) rather than a `classseq` column,
 * because this table has none -- the same technique
 * ATTENDANCE_ANALYTICS.class_order already uses, joined on `studentprofileid`
 * rather than `studentid` since that is the only key this table carries.
 * "Capacity utilisation" from the catalog blurb is still not attempted: no
 * seating-capacity column exists, verified or otherwise.
 */
const TRANSPORT_ANALYTICS: PredefinedReport = {
  id: 'transport-analytics',
  title: 'Transport Analytics',
  schema_version: 'erp-v1',
  source: 'student_transport_data_set',
  domain: 'students',
  params: [DRILL_ROUTE],
  queries: [
    {
      key: 'totals',
      description: 'Riders, and distinct pickup/drop routes in use',
      sql:
        'SELECT COUNT(*) AS riders, COUNT(DISTINCT pickuproutename) AS pickup_routes, ' +
        'COUNT(DISTINCT droproutename) AS drop_routes FROM student_transport_data_set',
    },
    {
      key: 'by_pickup_route',
      description: 'Riders by pickup route',
      sql:
        'SELECT pickuproutename, COUNT(*) AS students FROM student_transport_data_set ' +
        'GROUP BY pickuproutename ORDER BY students DESC',
    },
    {
      key: 'by_mode',
      description: 'Riders by mode of transport',
      sql:
        'SELECT modeoftransport, COUNT(*) AS students FROM student_transport_data_set ' +
        'GROUP BY modeoftransport ORDER BY students DESC',
    },
    {
      key: 'by_class',
      description: 'Riders by class',
      sql:
        'SELECT classname, COUNT(*) AS students FROM student_transport_data_set ' +
        'GROUP BY classname ORDER BY students DESC',
    },
    {
      key: 'class_order',
      description: 'Class ordinals, read from enrolment because this table has none',
      sql: 'SELECT classname, MIN(classseq) AS seq FROM students_data_set GROUP BY classname ORDER BY seq',
    },
    /**
     * Drill level 3 — riders by class, within the clicked pickup route.
     *
     * Levels 1 and 2 introduce no SQL: level 1 keeps `by_pickup_route` per
     * school, level 2 IS `by_pickup_route`. Only the leaf narrows.
     *
     * -- Why route and not quarter --------------------------------------------
     * Ridership is a standing arrangement, not a per-period one: this table
     * records which route a student is ON, with no date column to bucket by, so
     * a quarter level would have nothing to compute from. Route is the
     * dimension the report is actually about ("Route ridership by route, stop
     * and class"), and class beneath it is the question a transport manager
     * asks — which years fill this bus.
     *
     * -- Ordered by size, not by class ordinal --------------------------------
     * `student_transport_data_set` carries no `classseq`; the dashboard borrows
     * one from `students_data_set` via `class_order` and applies it in the
     * merge. A drill level fetches ONE statement, so that ordinal is not
     * available here, and ordering by `classname` as TEXT would be worse than
     * useless — it puts X before IX. Largest first is honest about what it is
     * sorting by. Same reasoning as `by_class_for_quarter` on Attendance.
     */
    {
      key: 'by_class_for_route',
      description: 'Riders by class, within one pickup route',
      drill_only: true,
      sql:
        'SELECT classname, COUNT(*) AS students FROM student_transport_data_set ' +
        'WHERE (:drill_route IS NULL OR pickuproutename = :drill_route) ' +
        'GROUP BY classname ORDER BY students DESC',
    },
  ],
};

/**
 * Library & Textbooks -- docs/06 §2, taken up 2026-08-26, corrected the same
 * day against schema/erp-v1.ts's verified `books_data_set` and
 * `book_issue_data_set` entries.
 *
 * No academic year here either: `books_data_set` has no year concept at all
 * (it is a copy's current status, not a per-year record), and
 * `book_issue_data_set`'s `academicyearname` carries the same
 * stamped-current-year trap as both attendance tables (confirmed: rows from
 * 2023 and 2024 all read `2026-27`) -- so `issues_by_month` filters on
 * `issuedate` directly, the same fix Attendance Analytics already applies.
 * `AS_OF_DATE` still gates "overdue", which is a real date comparison and
 * unaffected by either trap.
 *
 * "Titles" and "copies" are two different numbers because the table is one
 * row per COPY (`books_data_set`'s own header note): `bookname` is the title,
 * `bookid` the copy, and "in stock" reads `statusname = 'Available'` on that
 * copy's row rather than a stored count. "Low-stock alerts" from the catalog
 * blurb is read as fewer than 3 copies available of a title with at least
 * one copy on record -- a threshold this report chooses, not one the ERP
 * supplied, stated on screen for the same reason the Fee Defaulters aging
 * bands are (services/dashboards.ts). `by_issue_type` publishes the raw
 * student-vs-staff split the same way Attendance publishes its raw
 * `by_status` and Admissions its raw `candidate_statusid` -- so a reader can
 * check "is this mostly staff activity?" rather than have it assumed away.
 */
const LIBRARY_TEXTBOOKS: PredefinedReport = {
  id: 'library-textbooks',
  title: 'Library & Textbooks',
  schema_version: 'erp-v1',
  source: 'books_data_set · book_issue_data_set',
  domain: 'students',
  params: [AS_OF_DATE, FROM_DATE, TO_DATE],
  queries: [
    {
      key: 'inventory',
      description: 'Titles held, copies held and copies currently available',
      sql:
        'SELECT COUNT(DISTINCT bookname) AS titles, COUNT(*) AS total_copies, ' +
        "SUM(CASE WHEN statusname = 'Available' THEN 1 ELSE 0 END) AS available_copies " +
        'FROM books_data_set',
    },
    {
      key: 'by_category',
      description: 'Copies held and available by the ERP\'s own book-type label',
      sql:
        'SELECT booktypename, COUNT(*) AS total_copies, ' +
        "SUM(CASE WHEN statusname = 'Available' THEN 1 ELSE 0 END) AS available_copies " +
        'FROM books_data_set GROUP BY booktypename ORDER BY total_copies DESC',
    },
    {
      key: 'low_stock',
      description: 'Titles with fewer than 3 copies available',
      sql:
        'SELECT bookname, booktypename, COUNT(*) AS total_copies, ' +
        "SUM(CASE WHEN statusname = 'Available' THEN 1 ELSE 0 END) AS available_copies " +
        'FROM books_data_set GROUP BY bookname, booktypename ' +
        "HAVING SUM(CASE WHEN statusname = 'Available' THEN 1 ELSE 0 END) < 3 " +
        'ORDER BY available_copies ASC, total_copies DESC LIMIT 50',
    },
    {
      key: 'issues_by_month',
      description: 'Issues by month, over the selected window',
      sql:
        'SELECT LEFT(issuedate, 7) AS ym, COUNT(*) AS issues FROM book_issue_data_set ' +
        'WHERE issuedate BETWEEN :from_date AND :to_date ' +
        'GROUP BY LEFT(issuedate, 7) ORDER BY ym',
    },
    {
      key: 'overdue',
      description: 'Copies not yet returned past their due date',
      sql:
        'SELECT COUNT(*) AS overdue FROM book_issue_data_set ' +
        'WHERE returndate IS NULL AND duedate < :as_of_date',
    },
    {
      key: 'by_issue_type',
      description: 'Issues by who they were issued to (student vs. staff)',
      sql: 'SELECT issuetype, COUNT(*) AS issues FROM book_issue_data_set GROUP BY issuetype ORDER BY issues DESC',
    },
  ],
};


/**
 * The academic year a DATE falls in, as the calendar year that year STARTED.
 *
 * The same 1 April boundary `academicQuarter` above draws, expressed as a year
 * rather than a quarter and derived from the same rule so the two cannot drift.
 * An Indian school year runs April to March, so a receipt dated 12 February 2026
 * belongs to 2025-26, and grouping it under 2026 would move a third of every
 * year's money into the next one.
 *
 * Returns a NUMBER (the starting year, 2025) and not a label ('2025-26'), for
 * the reason `PERIOD_MONTH` returns a month number: the label is a presentation
 * fact, the orchestrator already has to build one for the axis, and a number is
 * the only shape that sorts correctly and binds as a drill parameter without
 * either side agreeing on a string format the ERP writes three different ways
 * ('2025-26', '2025-2026', 'APR 2025-26').
 *
 * Written with CASE rather than the boolean arithmetic `YEAR(d) - (MONTH(d) < 4)`
 * that would also work: the guard's parser must read every shipped statement
 * (test: reports-catalog.test.ts), and a comparison used as an integer is the
 * kind of MySQL-ism that parses in the server and not necessarily in the parser.
 */
function academicYearStart(column: string): string {
  return `CASE WHEN MONTH(${column}) < 4 THEN YEAR(${column}) - 1 ELSE YEAR(${column}) END`;
}

/** The receipt ledger's academic year — the only date column this report trends on. */
const RECEIPT_AY_START = academicYearStart('feedate');

/**
 * That same academic year as the label a school writes it with — '2025-26'.
 *
 * Built in SQL, which is the exception to the rule the paragraph above states,
 * and the exception is narrow: it is used ONLY by the drilled levels. A drill
 * level's axis text is whatever its `x` column contains (services/drill.ts
 * stringifies it), because the drill renderer is generic across every report and
 * has nowhere to put a per-report labelling rule. The base dashboard's charts
 * still label years in the orchestrator, where the same shift orders the
 * seasonality axis — so the label exists twice, in the one place each mechanism
 * can reach, rather than in neither.
 *
 * `LPAD(MOD(start + 1, 100), 2, '0')` and not a bare `start + 1`: the second
 * half is a two-digit suffix, so 2025-26 rather than 2025-2026, and a year
 * ending in a single digit ('2009-10' from 2009) needs the pad or it reads
 * '2009-1'. The century rollover is handled by the MOD rather than assumed away.
 */
const RECEIPT_AY_LABEL =
  `CONCAT(${RECEIPT_AY_START}, '-', LPAD(MOD(${RECEIPT_AY_START} + 1, 100), 2, '0'))`;

/**
 * The earliest date this report will treat as real.
 *
 * Not a business rule — a data-quality floor, and it is here rather than in the
 * orchestrator because the row it excludes should never travel. The delivered
 * extract carries sentinel dates where a date was never entered: `employees_data_set`
 * holds a `joining_date` of `0002-11-30` and `students_data_set` a `1900-01-19`
 * (read 2026-08-31 across the three St Marks schools). One such row puts a
 * category on a year axis eighteen centuries wide, which does not distort the
 * trend so much as erase it — every real year collapses into a single pixel at
 * the right-hand edge.
 *
 * 1950, and the number was MEASURED rather than picked. The floor should exclude
 * only what is impossible, not what is merely old, and reading every pre-1950
 * date in the three St Marks schools on 2026-08-31 shows exactly two distinct
 * values in the whole extract: `0002-11-30` (4 staff rows) and `1900-01-19` (1
 * student row). Everything else runs continuously from 1976 — real teachers with
 * thirty-year careers, who belong on the chart. An earlier draft of this constant
 * said 1990, which excluded fifteen of them while claiming to exclude only the
 * impossible; nobody can join a school before 1950 and still appear in a current
 * staff table, and nobody in this data did.
 *
 * This floor removes what is IMPOSSIBLE. What is merely stranded — a genuine
 * 1976 joiner followed by a six-year gap — is dropped further downstream by
 * `contiguousRun` (services/dashboards.ts), because a line drawn across a gap is
 * not a trend. Two different problems, two different mechanisms, and both say on
 * screen how much they removed rather than dropping it silently (§10: a row
 * removed without a word is a row a reader believes was never there).
 */
const DATE_FLOOR = "'1950-01-01'";

/**
 * Why a student left, collapsed from free text into categories that survive
 * being counted.
 *
 * -- The problem this exists to solve ----------------------------------------
 * `reason_for_leaving` is free text a clerk types, and the delivered extract
 * shows what that means: 118 distinct values in one school alone, in which
 * "CLASS XII PASS OUT" (3,032), "CLASS XII PASSOUT" (2,620), "CLASS-XII PASS
 * OUT" (49) and "CLASS XII-PASS OUT" (40) are one reason written four ways, and
 * "ON PARENT'S REQUEST" (2,175), "ON PARENTS REQUEST" (963), "ON PARENT REQUEST"
 * (45) and "ON PARENT''S REQUEST" (19) are another. Trending the raw column
 * draws one real cause as four separate declining lines, none of which is the
 * truth and all of which look like findings.
 *
 * -- The decision that matters more than the spelling ------------------------
 * GRADUATION IS NOT ATTRITION, and in this data it is the majority of it.
 * Measured 2026-08-31 across the three St Marks schools: 5,744 of 9,879
 * departures — 58% — are Class XII completing. A "students leaving" trend that
 * folds them in reports every school as losing a sixth of its roll every March,
 * which is the school working exactly as intended. So completion is its own
 * category, named for what it is, and the orchestrator's attrition figures
 * exclude it explicitly rather than by hoping a reader notices the legend.
 *
 * -- The arms are ORDERED, and the order is a judgement ----------------------
 * A CASE stops at its first match, and these reasons genuinely overlap: "NAME
 * STRUCK OFF DUE TO LONG ABSENCE AND NON PAYMENT OF FEE" is two causes in one
 * string. Fees are tested before absence, and withdrawal before the family's
 * request, because in each pair the earlier is the cause a school can ACT on —
 * a bursar reads "fees unpaid" as a collections problem and "prolonged absence"
 * as a welfare one, and filing a row that says both under the actionable half is
 * the more useful of two defensible answers. Stated here because it is a choice,
 * not an arithmetic fact, and a school that wants the other reading changes this
 * order rather than hunting through a builder.
 *
 * -- What the residue is ------------------------------------------------------
 * "Not recorded" is tested FIRST and matches empty strings and the dash-only
 * placeholders this extract is full of ('--', and one row of forty-one hyphens).
 * "Other reason" is the honest remainder: 77 of 9,879 rows, 0.8%. Both are drawn
 * rather than hidden — a category that exists and is not on the chart is a bar
 * that silently does not add up, and these arms are mutually exclusive by
 * construction so the eight categories together ARE the departures.
 */
const LEAVING_REASON =
  'CASE ' +
  "WHEN reason_for_leaving IS NULL OR TRIM(REPLACE(REPLACE(reason_for_leaving, '-', ''), '.', '')) = '' " +
  "THEN 'Not recorded' " +
  "WHEN UPPER(reason_for_leaving) LIKE '%XII%' AND UPPER(reason_for_leaving) LIKE '%PASS%' " +
  "THEN 'Completed Class XII' " +
  "WHEN UPPER(reason_for_leaving) LIKE '%NON PAYMENT%' " +
  "OR UPPER(reason_for_leaving) LIKE '%NONPAYMENT%' " +
  "OR UPPER(reason_for_leaving) LIKE '%DEFAULTER%' THEN 'Fees unpaid' " +
  "WHEN UPPER(reason_for_leaving) LIKE '%ABSEN%' OR UPPER(reason_for_leaving) LIKE '%ABSAN%' " +
  "THEN 'Prolonged absence' " +
  "WHEN UPPER(reason_for_leaving) LIKE '%WITHDRAW%' " +
  "OR UPPER(reason_for_leaving) LIKE '%WITHDRWAL%' " +
  "OR UPPER(reason_for_leaving) LIKE '%CANCEL%' THEN 'Admission withdrawn' " +
  "WHEN UPPER(reason_for_leaving) LIKE '%PARENT%' OR UPPER(reason_for_leaving) LIKE '%PERSONAL%' " +
  "THEN 'At the family request' " +
  "WHEN UPPER(reason_for_leaving) LIKE '%T.C%' OR UPPER(TRIM(reason_for_leaving)) = 'TC' " +
  "THEN 'Transfer certificate' " +
  "ELSE 'Other reason' END";

/**
 * The academic year a drill click narrowed to, as the calendar year it STARTED
 * (ADR-020: clicked values enter as bound parameters, never concatenated).
 *
 * Typed `number`, so `run_predefined` refuses a string before it reaches the
 * guard — the value arrives from a click in a browser, which is to say from
 * outside — and so the comparison against `academicYearStart` is integer against
 * integer rather than a string match against a label the ERP writes three ways.
 *
 * Optional, like every other drill parameter: the base dashboard runs this same
 * report with no drill context every time someone opens it, and a required drill
 * filter would refuse that request outright.
 */
const DRILL_YEAR: ReportParam = {
  name: 'drill_year',
  type: 'number',
  required: false,
  description:
    'Drill context: restrict to one academic year, as the calendar year it began (2025 means 2025-26). Omitted means every year.',
};

/**
 * Trend Analysis — how the school has moved over the years the extract can see.
 *
 * -- What this report is FOR, and how it differs from Comparative Analysis ----
 * Comparative Analysis answers "is this year better than last?" — two years,
 * every measure twice, school by school. Trend Analysis answers the question
 * that needs more than two points: which way has this been going, for how long,
 * and is the current year continuing it or breaking it. So nothing here is a
 * pair; everything is a series, and the axis is time rather than school.
 *
 * -- Why it binds NO academic year -------------------------------------------
 * Every other fee report on this platform filters `academicyearname =
 * :academic_year`. This one must not, and that is the decision the whole report
 * follows from: the year is the AXIS here, and binding one would collapse every
 * series to a single point while leaving a page that still looked like a trend.
 * The only filter is the as-of date, which is where the series STOPS — the same
 * reproducibility argument `AS_OF_DATE` already makes, applied to the right-hand
 * end of a line instead of to an aging band.
 *
 * -- The depth each source actually has, which is why these five queries ------
 * Read from the delivered extract on 2026-08-31 rather than assumed, and it
 * decided the report's contents:
 *
 *   fee_collection_data_set   Apr 2020 - Aug 2026, daily, no null `feedate`
 *   students_data_set         2015-16 - 2026-27, twelve consecutive years
 *   employees_data_set        joins from 2011, exits from 2014
 *   fee_compile_data_set      three years only -- too few to draw a line
 *   attendance / transport    49 rows / 0 rows / 185 rows in one school
 *   / library
 *
 * The last two rows are why this report reads three tables and not eight. A
 * trend drawn through four points of attendance data would be a shape made of
 * noise, and on the page it would look exactly like the ones above it that are
 * real.
 *
 * -- One scan of the receipt ledger, three charts -----------------------------
 * `collection_by_month` groups by month AND payment mode in a single pass, and
 * the orchestrator re-groups those rows three ways: as a continuous monthly
 * timeline, as one line per academic year over an April-to-March axis, and as
 * the payment-mode mix per year. Three separate statements would be three full
 * scans of 1.7M unindexed rows (see the cost note at the top of this file);
 * splitting rows already in hand costs nothing. The same reasoning
 * `demand_by_period` follows in Comparative Analysis, one table over.
 *
 * -- Why COUNT(DISTINCT studentid) is correct here, and would not be in a
 *    hand-written cross-school query -----------------------------------------
 * `studentid` RESTARTS PER SCHOOL in this extract: ids 1 to 5 exist in all three
 * St Marks schools. `run_predefined` runs each statement against one school at a
 * time (ADR-013), so within a result set the id is unique and this count is
 * exact; the orchestrator then SUMS the per-school counts, which is the
 * composite (school, student) count by construction. Verified on 2026-08-31 —
 * the summed per-school figures reproduce the composite count in all twelve
 * years exactly.
 *
 * The trap is worth stating because the naive cross-school version does not
 * merely lose precision, it INVERTS the finding: `COUNT(DISTINCT studentid)`
 * over three schools returns 4,226 for 2015-16 against a true 9,560, and the
 * collision decays as the id ranges diverge — so it draws a trust doubling over
 * a decade where enrollment actually moved 9,560 to 9,838. Anyone adding a query
 * here inherits the per-school guarantee only for as long as they leave the scan
 * inside one school.
 */
const TREND_ANALYSIS: PredefinedReport = {
  id: 'trend-analysis',
  title: 'Trend Analysis',
  schema_version: 'erp-v1',
  source: 'fee_collection_data_set · students_data_set · employees_data_set',
  domain: 'fees',
  params: [AS_OF_DATE, DRILL_YEAR],
  queries: [
    /**
     * The receipt ledger by month and payment mode — one scan, three charts.
     *
     * `feedate` and nothing else, because it is the only column on this table
     * that records when money actually ARRIVED, and it is clean: 1.2M rows
     * across the three St Marks schools with not one NULL, spanning April 2020
     * to August 2026 without a gap (read 2026-08-31).
     *
     * `academicyearname` is NOT used, and deliberately. The same table writes it
     * as both '2025-26' and '2025-2026', and receipts against 2018-19 are still
     * arriving in 2025 — so grouping the timeline on it would file money under
     * the year it was OWED FOR rather than the year it was RECEIVED, which is
     * the opposite of what a collection trend means.
     *
     * `<= :as_of_date` rather than an open right-hand end. A trend must stop
     * somewhere a reader chose, or the same saved report grows a point every
     * night and the PDF printed last week stops reproducing (`AS_OF_DATE`). It
     * also fences off future-dated receipts, which a fee ledger does carry.
     *
     * ~250-320 rows per school over the whole six years, so the 5,000-row cap is
     * not close and no bucketing is needed to stay under it.
     */
    {
      key: 'collection_by_month',
      description: 'Receipts by calendar month and payment mode, over all recorded history',
      sql:
        "SELECT DATE_FORMAT(feedate, '%Y-%m') AS ym, paymenttype, " +
        'ROUND(SUM(paidamount)) AS collected, COUNT(*) AS receipts ' +
        'FROM fee_collection_data_set ' +
        `WHERE feedate IS NOT NULL AND feedate >= ${DATE_FLOOR} AND feedate <= :as_of_date ` +
        'GROUP BY ym, paymenttype ORDER BY ym',
    },
    /**
     * Students on roll per academic year, with the gender split.
     *
     * `academicyearname` here rather than a derived date, because enrollment is
     * not an event with a date — a student is on the roll OF a year, and this
     * table says which. Its grain is one row per student per year, so the count
     * equals the row count in all but the earliest years; `COUNT(DISTINCT
     * studentid)` regardless, because that grain is a property of the extract
     * rather than a promise it makes, and a duplicated row would otherwise
     * become a student.
     *
     * The label is returned RAW and filtered by the orchestrator, which is the
     * unusual half of this statement. The column is free text and the extract
     * proves it: alongside twelve well-formed years it holds '04', '05',
     * '2010-11 New', '1995-96' and 'Demo_Palak_2030-2031'. Filtering in SQL
     * would need a REGEXP the guard has no reason to permit; filtering in the
     * orchestrator keeps the rejected labels visible, so the page can say how
     * many it dropped rather than quietly drawing eleven years and calling it
     * twelve.
     *
     * No `:as_of_date`. An academic year is not a date, and there is no honest
     * way to ask this table what the roll looked like mid-year. The guard binds
     * only the parameters a statement uses, so declaring one here and not
     * applying it would be a filter that narrows nothing.
     */
    {
      key: 'enrollment_by_year',
      description: 'Students on roll by academic year, with the gender split',
      sql:
        'SELECT academicyearname AS ay, COUNT(DISTINCT studentid) AS students, ' +
        "COUNT(DISTINCT CASE WHEN gender = 'Girl' THEN studentid END) AS girls, " +
        "COUNT(DISTINCT CASE WHEN gender = 'Boy' THEN studentid END) AS boys " +
        'FROM students_data_set GROUP BY ay ORDER BY ay',
    },
    /**
     * Departures by the calendar year they happened in, and why.
     *
     * By CALENDAR year rather than academic, and this is the one place in the
     * report where that is the right choice: `deactivation_date` is a real date,
     * departures cluster in March and April around the year boundary, and an
     * academic bucket would split one exit season across two categories. The
     * enrollment series above is academic because a roll IS academic; this one
     * is an event, and events are dated.
     *
     * See `LEAVING_REASON` for why the reason is bucketed at all, and why Class
     * XII completion is a category of its own rather than part of the total.
     */
    {
      key: 'student_exits',
      description: 'Students leaving by calendar year, grouped by a normalised reason',
      sql:
        `SELECT YEAR(deactivation_date) AS y, ${LEAVING_REASON} AS reason, ` +
        'COUNT(DISTINCT studentid) AS students ' +
        'FROM students_data_set WHERE deactivation_date IS NOT NULL ' +
        `AND deactivation_date >= ${DATE_FLOOR} AND deactivation_date <= :as_of_date ` +
        'GROUP BY y, reason ORDER BY y',
    },
    /**
     * Staff joining, by the year they joined.
     *
     * Two statements rather than one for joins and exits, because they group by
     * two DIFFERENT date columns of the same row and no single GROUP BY serves
     * both. A `UNION ALL` inside a derived table would do it in one pass, and is
     * not worth it: `employees_data_set` is 6,747 rows against the receipt
     * ledger's 1.7M, so the second scan is free, while the union would put a
     * shape through the guard's tenant-injection walk that nothing else in this
     * catalog uses. Cheap and ordinary beats clever on a table this size.
     */
    {
      key: 'staff_joins',
      description: 'Staff joining by calendar year',
      sql:
        'SELECT YEAR(joining_date) AS y, COUNT(DISTINCT employeeid) AS staff ' +
        'FROM employees_data_set WHERE joining_date IS NOT NULL ' +
        `AND joining_date >= ${DATE_FLOOR} AND joining_date <= :as_of_date ` +
        'GROUP BY y ORDER BY y',
    },
    /** Staff leaving, by the year they left. The other half of `staff_joins`. */
    {
      key: 'staff_exits',
      description: 'Staff leaving by calendar year',
      sql:
        'SELECT YEAR(deactivation_date) AS y, COUNT(DISTINCT employeeid) AS staff ' +
        'FROM employees_data_set WHERE deactivation_date IS NOT NULL ' +
        `AND deactivation_date >= ${DATE_FLOOR} AND deactivation_date <= :as_of_date ` +
        'GROUP BY y ORDER BY y',
    },
    /**
     * Drill level 2 — the clicked school's own collection by academic year.
     *
     * `collection_by_month` cannot serve this level even though it holds the
     * same money. The drill renderer sums a level's rows by its axis field, and
     * those rows are keyed by calendar month across every school in scope;
     * re-grouping them into academic years is exactly what the base page does
     * for its own charts, but a drilled level must be a statement the report
     * VETS and the audit trail can name (Invariant 6), not a second re-grouping
     * the orchestrator performs off-screen.
     *
     * The school never appears in this SQL. Narrowing to one school is a SCOPE
     * narrowing, handled where every other scope decision is (the launch token,
     * checked at the orchestrator and again at `requireInScope`), so a drill
     * click cannot reach a school the session was not already entitled to.
     *
     * The starting year is returned as `seq` and NOT under a name of its own,
     * which is a constraint of the drill renderer rather than a preference. That
     * renderer merges a level's rows with `sumBy(key, level.x, measures, 'seq')`
     * (services/drill.ts), and `sumBy` carries exactly three things through the
     * merge: the axis field, the measures, and the column literally called
     * `seq`. A year returned as `ay_start` would be dropped there and reach the
     * widget as 0, so every click at this level would drill into the year zero —
     * which is the same trick Fee Collection's quarter level already relies on,
     * for the same reason.
     */
    {
      key: 'collection_by_year',
      description: 'Receipts by academic year, for one school',
      drill_only: true,
      sql:
        `SELECT ${RECEIPT_AY_LABEL} AS ay, ${RECEIPT_AY_START} AS seq, ` +
        'ROUND(SUM(paidamount)) AS collected, COUNT(*) AS receipts ' +
        'FROM fee_collection_data_set ' +
        `WHERE feedate IS NOT NULL AND feedate >= ${DATE_FLOOR} AND feedate <= :as_of_date ` +
        'GROUP BY ay, seq ORDER BY seq',
    },
    /**
     * Drill level 3 — the months of the clicked academic year, within the
     * clicked school.
     *
     * `:drill_year IS NULL OR …` rather than two statements, for the reason Fee
     * Collection's level 3 gives: a `variants` pair differing only in a WHERE
     * clause would, the day one of them gained a measure, answer a different
     * question under the same heading. Level 3 always arrives WITH a year by
     * construction; the null branch keeps the statement honest if it is ever run
     * alone.
     *
     * `seq` is `MIN(DATE_FORMAT(feedate, '%Y%m'))` and not `MONTH(feedate)`,
     * because this level spans an ACADEMIC year: sorting on the calendar month
     * would draw January, February and March first, three months that are the
     * END of the year being looked at. A zero-padded YYYYMM sorts April 2025
     * before March 2026 without the orchestrator's April shift, and it reads as
     * a number everywhere — which a `MIN(date)` travelling through a JSON result
     * set does not (the reason `INSTALLMENT_SEQ` uses the same trick).
     */
    {
      key: 'collection_months_in_year',
      description: 'Receipts by month within one academic year, for one school',
      drill_only: true,
      sql:
        "SELECT DATE_FORMAT(feedate, '%b %Y') AS month, " +
        "MIN(DATE_FORMAT(feedate, '%Y%m')) AS seq, " +
        'ROUND(SUM(paidamount)) AS collected, COUNT(*) AS receipts ' +
        'FROM fee_collection_data_set ' +
        `WHERE feedate IS NOT NULL AND feedate >= ${DATE_FLOOR} AND feedate <= :as_of_date ` +
        `AND (:drill_year IS NULL OR ${RECEIPT_AY_START} = :drill_year) ` +
        'GROUP BY month ORDER BY seq',
    },
  ],
};
const REPORTS: readonly PredefinedReport[] = [
  ENROLLMENT_OVERVIEW,
  FEE_COMPARATIVE,
  FEE_COLLECTION,
  FEE_DEFAULTERS,
  STAFF_OVERVIEW,
  STAFF_ATTENDANCE,
  FEE_BY_STUDENT,
  ADMISSIONS_FUNNEL,
  ATTENDANCE_ANALYTICS,
  PRINCIPAL_SNAPSHOT,
  TRANSPORT_ANALYTICS,
  LIBRARY_TEXTBOOKS,
  TREND_ANALYSIS,
];

const BY_ID = new Map(REPORTS.map((report) => [report.id, report]));

export function getPredefinedReport(id: string): PredefinedReport | undefined {
  return BY_ID.get(id);
}

export function predefinedReportIds(): string[] {
  return [...BY_ID.keys()];
}

/**
 * The whole catalog. Exported for the invariant tests, which assert properties
 * that must hold for EVERY report — that each statement survives the guard, and
 * that no report uses a parameter it did not declare. A test that names reports
 * one by one stops covering the fifth one the day someone adds it.
 */
export function predefinedReports(): readonly PredefinedReport[] {
  return REPORTS;
}
