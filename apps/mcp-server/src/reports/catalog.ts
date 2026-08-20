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
  params: [ACADEMIC_YEAR],
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
  params: [ACADEMIC_YEAR],
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
  params: [ACADEMIC_YEAR, AS_OF_DATE],
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
  params: [AS_OF_DATE],
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

const REPORTS: readonly PredefinedReport[] = [
  ENROLLMENT_OVERVIEW,
  FEE_COLLECTION,
  FEE_DEFAULTERS,
  STAFF_OVERVIEW,
  ADMISSIONS_FUNNEL,
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
