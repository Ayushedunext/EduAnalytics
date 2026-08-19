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

const REPORTS: readonly PredefinedReport[] = [ENROLLMENT_OVERVIEW, FEE_COLLECTION];

const BY_ID = new Map(REPORTS.map((report) => [report.id, report]));

export function getPredefinedReport(id: string): PredefinedReport | undefined {
  return BY_ID.get(id);
}

export function predefinedReportIds(): string[] {
  return [...BY_ID.keys()];
}
