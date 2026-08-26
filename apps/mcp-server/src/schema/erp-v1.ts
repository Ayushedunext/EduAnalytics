/**
 * Schema catalog for `schema_version = 'erp-v1'` — the first real ERP dataset.
 *
 * Contract source: docs/04 §2 (`get_schema`) · ADR-014 (one document per schema
 * version, not per school) · db/platform/seed/stmarks.sql (the tenant mapping
 * this version describes).
 *
 * The tables and columns below were read from the live `ai_analysis` extract
 * rather than transcribed from a design document, so the catalog the AI plans
 * against is the schema that actually exists. A column present here and absent
 * in the database surfaces as a query error; the reverse — a column the model is
 * never told about — is invisible and therefore the more dangerous direction,
 * which is why generation from the live schema is the rule and hand-editing is
 * limited to the annotations (domain, PII, guidance) that no database carries.
 *
 * Two ERP tables in `ai_analysis` are deliberately absent:
 *   `data_sync_log`  — the extract's own ETL bookkeeping; not school data, and
 *                      it carries no tenant discriminator, so it could not be
 *                      scoped even if it were wanted.
 *   `search_history` — the ERP's own record of user prompts and answers. It is
 *                      tenant-scoped, but it is application telemetry rather
 *                      than analytics data, and its free-text columns would put
 *                      other users' questions inside a report.
 * Absence from this catalog is not documentation — it is enforcement: the SQL
 * guard rejects any table it does not find here (schema/catalog.ts).
 *
 * ATTENDANCE, added 2026-08-21. A second extract delivered
 * `student_attendance_data_set` and `employee_attendance_data_set`, and adding
 * them was exactly what the previous note predicted: two entries here, a report
 * in reports/catalog.ts, nothing about the tool surface (docs/04 §8). Exams are
 * still absent, so AUDIT_REPORT C20 is only half answered — but the half that is
 * answered says attendance IS captured by the ERP, which makes the remaining gap
 * an extract question rather than a product-scope one.
 *
 * Read those two entries' column notes before writing SQL against them. They
 * carry three traps that are invisible from the column names: `academicyearname`
 * is stamped with the CURRENT year rather than the row's, `statusid` means
 * different things in the two tables, and neither is unique on (subject, date).
 * Three more tables arrived in the same extract — `books_data_set`,
 * `book_issue_data_set`, `student_transport_data_set` — and were deliberately
 * NOT catalogued at the time: Library and Transport are their own catalog
 * entries in docs/06 §2, and an uncatalogued table is one the guard refuses
 * rather than one the model can quietly reach.
 *
 * TRANSPORT AND LIBRARY, added 2026-08-26, corrected the same day. The first
 * cut of these three entries was written as an INFERENCE from this catalog's
 * own naming conventions, with no sample row read — the "cannot usefully be
 * stubbed" situation docs/11 §2 item 6 already describes for the per-school
 * schema at large, at the scale of two tables rather than seven. That inference
 * turned out wrong in specific, discoverable ways the moment the two dashboards
 * were run against the local `ai_analysis` MySQL instance this dev environment
 * actually has loaded (`db/platform/seed/stmarks.sql`'s `db_name`) — Transport
 * Analytics failed outright and Library & Textbooks lost three of its five
 * panels, which is what a wrong column name looks like at runtime rather than
 * in a comment. The columns below are corrected against
 * `information_schema.columns` read directly from that instance, the same
 * verification every other table in this file already had. Three things this
 * pass found, each a trap the same way the two attendance tables' were:
 *
 *   1. `student_transport_data_set` keys students by `studentprofileid`, not
 *      `studentid` — the only table in this catalog that does. It also has no
 *      `classseq` (join students_data_set on studentprofileid for the
 *      ordinal, the same technique buildAttendance already uses) and no
 *      `deactivation_date` — there is no column recording whether an
 *      assignment is still current, so a query here reports every row the
 *      table holds, not a "currently assigned" subset.
 *   2. `books_data_set` is one row per PHYSICAL COPY (`bookid` does not
 *      repeat — 1,693 rows, 1,693 distinct `bookid`, 1,460 distinct
 *      `bookname`), not one row per title with a copies-held/copies-available
 *      pair. There is no `totalcopies`, no `availablecopies`, no `isbn`, no
 *      `category` and no `title` column — "in stock" is `statusname =
 *      'Available'` on a copy's own row, counted per `bookname`.
 *      `booktypename` is the nearest thing to a category and it is exactly as
 *      messy as `stafftype` elsewhere in this file: "STORY" and "Story Books"
 *      as two different values, plus test junk ("test", "add v3"). Report it
 *      as written; do not attempt to canonicalise it.
 *   3. `book_issue_data_set` carries the SAME stamped-current-year trap as
 *      both attendance tables: every row's `academicyearname` reads the
 *      current year regardless of `issuedate`, confirmed on rows from 2023 and
 *      2024 all labelled `2026-27`. Filter on `issuedate`/`duedate` instead,
 *      never on the year column, and its `id` disambiguates re-issues the same
 *      role `id` plays on the attendance tables. It also mixes student and
 *      staff borrowers — `employeeid`/`employeename` are populated wherever
 *      `issuetype = 'Employee'`, and the sampled data is entirely that type —
 *      so a report reading only `studentid` silently reports zero for every
 *      transaction this extract actually has.
 *
 * Real data exists for exactly one org, and it is the same one Attendance
 * found it in: `books_data_set`/`book_issue_data_set` hold rows only for
 * `training_edubac` (1,693 and 185 respectively), none for the St Marks
 * schools. `student_transport_data_set` holds zero rows anywhere, for any
 * school — not an extract gap discovered here, a genuinely empty table. Both
 * dashboards say all of this on screen, not only here
 * (services/dashboards.ts).
 */

import type { SchemaCatalog } from './catalog.js';

export const ERP_V1: SchemaCatalog = {
  schema_version: 'erp-v1',
  description:
    'EduNext ERP analytics extract. One consolidated database per org; rows are ' +
    'separated by the school_db column. Covers enrolment, admissions, fee demand ' +
    'and collection, concessions, waivers, staff, and day-level attendance for ' +
    'students and staff. No exam data.',

  /**
   * Option (a), confirmed 2026-08-19 (db/platform/seed/stmarks.sql).
   *
   * All schools of the org share one database and are separated by a column.
   * That means the DATABASE provides no tenant isolation for this version and
   * the MCP server must provide it — which it does by rewriting every table
   * reference in a statement into a filtered derived table with the school
   * bound as a parameter (sql/guard.ts). The weaker isolation model is stated
   * here as data so that the day production moves to one database per school,
   * this becomes `{ mode: 'database_per_school' }` and the rewrite stops
   * happening. Nothing above the MCP layer knows the difference either way.
   */
  tenant_isolation: { mode: 'shared_database', column: 'school_db' },

  tables: [
  {
    name: 'students_data_set',
    domain: 'students',
    description:
      'One row per student per academic year: enrolment, class/section, demographics, joining and deactivation.',
    columns: [
      { name: 'studentid', type: 'bigint' },
      { name: 'studentprofileid', type: 'bigint' },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      { name: 'studentname', type: 'varchar', pii: 'students' },
      { name: 'enrollmentno', type: 'varchar', pii: 'students' },
      {
        name: 'academicyearname',
        type: 'varchar',
        description: "Academic year label, e.g. '2025-2026'. Always filter on it: the tables hold every year since 2020.",
      },
      {
        name: 'classname',
        type: 'varchar',
        description: 'Class label, e.g. XII. Use get_dimensions for the valid values of a school.',
      },
      { name: 'sectionname', type: 'varchar', description: 'Section label within a class.' },
      { name: 'studenttype', type: 'varchar' },
      { name: 'gender', type: 'varchar' },
      { name: 'feecategory', type: 'varchar' },
      { name: 'category', type: 'varchar' },
      { name: 'housename', type: 'varchar' },
      { name: 'religionname', type: 'varchar' },
      { name: 'joining_date', type: 'date' },
      { name: 'joining_month', type: 'varchar' },
      { name: 'joining_year', type: 'varchar' },
      {
        name: 'deactivation_date',
        type: 'date',
        description: 'NULL while the record is active. A student or employee is current when this is NULL.',
      },
      { name: 'deactivation_month', type: 'varchar' },
      { name: 'deactivation_year', type: 'varchar' },
      { name: 'reason_for_leaving', type: 'varchar' },
      {
        name: 'classseq',
        type: 'bigint',
        description: 'Sortable class ordinal. ORDER BY this, not by classname, which sorts as text.',
      },
      { name: 'isOldStudent', type: 'varchar' },
      { name: 'acfromdate', type: 'date' },
      { name: 'actodate', type: 'date' },
      { name: 'classid', type: 'bigint' },
      { name: 'academicyearid', type: 'bigint' },
    ],
  },
  {
    name: 'students_admission_data_set',
    domain: 'students',
    description:
      'Admission funnel: enquiries, registrations and applications with their candidate status.',
    columns: [
      { name: 'candidateid', type: 'bigint' },
      { name: 'registrationno', type: 'varchar', pii: 'students' },
      { name: 'applicationno', type: 'varchar', pii: 'students' },
      { name: 'enquiryno', type: 'varchar', pii: 'students' },
      { name: 'admissionno', type: 'varchar', pii: 'students' },
      { name: 'candidate_statusid', type: 'bigint' },
      { name: 'gender', type: 'varchar' },
      { name: 'studenttype', type: 'varchar' },
      { name: 'category', type: 'varchar' },
      { name: 'religionname', type: 'varchar' },
      { name: 'studentname', type: 'varchar', pii: 'students' },
      {
        name: 'classname',
        type: 'varchar',
        description: 'Class label, e.g. XII. Use get_dimensions for the valid values of a school.',
      },
      { name: 'sectionname', type: 'varchar', description: 'Section label within a class.' },
      {
        name: 'academicyearname',
        type: 'varchar',
        description: "Academic year label, e.g. '2025-2026'. Always filter on it: the tables hold every year since 2020.",
      },
      { name: 'academicyearid', type: 'bigint' },
      { name: 'classid', type: 'bigint' },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      {
        name: 'deactivation_date',
        type: 'date',
        description: 'NULL while the record is active. A student or employee is current when this is NULL.',
      },
    ],
  },
  {
    name: 'student_attendance_data_set',
    domain: 'students',
    description:
      'Day-level student attendance: one row per marking of a student on a date. Not unique on (student, date) -- the same student-day can carry several rows.',
    columns: [
      {
        name: 'id',
        type: 'bigint',
        description:
          "The extract's own row key. Unique, unlike attendanceid, so it is what a de-duplicating subquery should pick a student-day by.",
      },
      { name: 'attendanceid', type: 'bigint', description: "The ERP's own attendance record id." },
      { name: 'studentid', type: 'bigint' },
      { name: 'studentprofileid', type: 'bigint' },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      { name: 'studentname', type: 'varchar', pii: 'students' },
      { name: 'enrollmentno', type: 'varchar', pii: 'students' },
      { name: 'academicyearid', type: 'bigint' },
      {
        name: 'academicyearname',
        type: 'varchar',
        description:
          "DO NOT FILTER ON THIS COLUMN. In the delivered extract every row carries the CURRENT academic year regardless of its own attendancedate -- rows dated August 2024 are labelled '2026-27'. Filter attendance by attendancedate instead.",
      },
      {
        name: 'academicyearfromdate',
        type: 'varchar',
        description: "Start of the academic year named above, written DD-MM-YYYY -- a different format from attendancedate.",
      },
      { name: 'academicyeartodate', type: 'varchar', description: 'End of that academic year, DD-MM-YYYY.' },
      {
        name: 'classname',
        type: 'varchar',
        description:
          'Class label as it stood when the row was written. Carries no classseq -- join students_data_set if the classes need ordering.',
      },
      { name: 'sectionname', type: 'varchar', description: 'Section label within a class.' },
      {
        name: 'attendancedate',
        type: 'varchar',
        description:
          "The date attendance was marked for, written YYYY-MM-DD as text rather than as a DATE. It compares and sorts correctly as text, so BETWEEN and LEFT(attendancedate, 7) work; wrapping it in STR_TO_DATE inside a WHERE clause only defeats the index.",
      },
      {
        name: 'statusid',
        type: 'bigint',
        description:
          'DO NOT BRANCH ON THIS. The codes are not stable and they do not agree with employee_attendance_data_set: 5 means Suspend here and Absent there, and both 1 and 6 mean Present. Read statusname.',
      },
      {
        name: 'statusname',
        type: 'varchar',
        description:
          "How the marking is named by the ERP. Observed in this extract: Present, Absent, Leave, Suspend. No canonical list has been supplied, so treat any other value as unknown rather than assuming it means absent.",
      },
      { name: 'createdon', type: 'datetime', description: 'When the extract wrote the row.' },
    ],
  },
  {
    name: 'fee_collection_data_set',
    domain: 'fees',
    description:
      'One row per fee receipt line: what was actually paid, when, by which student, against which component.',
    columns: [
      { name: 'id', type: 'bigint' },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      { name: 'studentname', type: 'varchar', pii: 'students' },
      { name: 'enrollmentno', type: 'varchar', pii: 'students' },
      {
        name: 'academicyearname',
        type: 'varchar',
        description: "Academic year label, e.g. '2025-2026'. Always filter on it: the tables hold every year since 2020.",
      },
      {
        name: 'classname',
        type: 'varchar',
        description: 'Class label, e.g. XII. Use get_dimensions for the valid values of a school.',
      },
      { name: 'sectionname', type: 'varchar', description: 'Section label within a class.' },
      { name: 'studenttype', type: 'varchar' },
      { name: 'gender', type: 'varchar' },
      { name: 'feecategory', type: 'varchar' },
      { name: 'feedate', type: 'date' },
      { name: 'fee_month', type: 'varchar' },
      { name: 'fee_year', type: 'varchar' },
      { name: 'receiptno', type: 'varchar' },
      { name: 'componentname', type: 'varchar', description: 'Fee head, e.g. Tuition Fee.' },
      { name: 'periodname', type: 'varchar' },
      { name: 'installmentname', type: 'varchar' },
      {
        name: 'paidamount',
        type: 'double',
        description: 'Amount actually received on this receipt line.',
      },
      { name: 'paymenttype', type: 'varchar' },
      { name: 'paymentypes', type: 'varchar' },
      { name: 'createdon', type: 'datetime' },
      { name: 'feedepositid', type: 'bigint' },
      {
        name: 'classseq',
        type: 'bigint',
        description: 'Sortable class ordinal. ORDER BY this, not by classname, which sorts as text.',
      },
      { name: 'installment_startdate', type: 'date' },
      { name: 'installment_enddate', type: 'date' },
    ],
  },
  {
    name: 'fee_compile_data_set',
    domain: 'fees',
    description:
      'Fee demand vs realisation per student per component: total payable, paid and balance. The source for defaulter analysis.',
    columns: [
      { name: 'id', type: 'bigint' },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      { name: 'studentname', type: 'varchar', pii: 'students' },
      { name: 'enrollmentno', type: 'varchar', pii: 'students' },
      {
        name: 'academicyearname',
        type: 'varchar',
        description: "Academic year label, e.g. '2025-2026'. Always filter on it: the tables hold every year since 2020.",
      },
      {
        name: 'classname',
        type: 'varchar',
        description: 'Class label, e.g. XII. Use get_dimensions for the valid values of a school.',
      },
      { name: 'sectionname', type: 'varchar', description: 'Section label within a class.' },
      { name: 'studenttype', type: 'varchar' },
      { name: 'gender', type: 'varchar' },
      { name: 'feecategory', type: 'varchar' },
      { name: 'componentname', type: 'text', description: 'Fee head, e.g. Tuition Fee.' },
      { name: 'periodname', type: 'varchar' },
      { name: 'periodfromdate', type: 'date' },
      { name: 'periodtodate', type: 'date' },
      { name: 'installmentname', type: 'varchar' },
      { name: 'totalamount', type: 'double' },
      { name: 'concession_amount', type: 'double' },
      { name: 'waiver_amount', type: 'double' },
      {
        name: 'total_payable_amount',
        type: 'double',
        description: 'Demand after concession and waiver.',
      },
      { name: 'paid_amount', type: 'double' },
      {
        name: 'balance_amount',
        type: 'double',
        description: 'total_payable_amount - paid_amount. Positive means outstanding.',
      },
      { name: 'createdon', type: 'datetime' },
      { name: 'academicyearid', type: 'bigint' },
      {
        name: 'classseq',
        type: 'bigint',
        description: 'Sortable class ordinal. ORDER BY this, not by classname, which sorts as text.',
      },
      { name: 'acfromdate', type: 'date' },
      { name: 'actodate', type: 'date' },
      { name: 'studentstatusid', type: 'bigint' },
    ],
  },
  {
    name: 'fee_concession_dataset',
    domain: 'fees',
    description:
      'Concessions granted per student per fee component.',
    columns: [
      { name: 'id', type: 'bigint' },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      { name: 'studentname', type: 'varchar', pii: 'students' },
      { name: 'enrollmentno', type: 'varchar', pii: 'students' },
      {
        name: 'academicyearname',
        type: 'varchar',
        description: "Academic year label, e.g. '2025-2026'. Always filter on it: the tables hold every year since 2020.",
      },
      {
        name: 'classname',
        type: 'varchar',
        description: 'Class label, e.g. XII. Use get_dimensions for the valid values of a school.',
      },
      { name: 'sectionname', type: 'varchar', description: 'Section label within a class.' },
      { name: 'studenttype', type: 'varchar' },
      { name: 'gender', type: 'varchar' },
      { name: 'feecategory', type: 'varchar' },
      { name: 'componentname', type: 'text', description: 'Fee head, e.g. Tuition Fee.' },
      { name: 'periodname', type: 'varchar' },
      { name: 'installmentname', type: 'varchar' },
      { name: 'concession_head_name', type: 'varchar' },
      { name: 'concession_amount', type: 'double' },
      { name: 'concession_date', type: 'date' },
      { name: 'periodfromdate', type: 'date' },
      { name: 'periodtodate', type: 'date' },
      { name: 'createdon', type: 'datetime' },
      { name: 'academicyearid', type: 'bigint' },
      {
        name: 'classseq',
        type: 'bigint',
        description: 'Sortable class ordinal. ORDER BY this, not by classname, which sorts as text.',
      },
      { name: 'acfromdate', type: 'date' },
      { name: 'actodate', type: 'date' },
    ],
  },
  {
    name: 'fee_waiver_dataset',
    domain: 'fees',
    description:
      'Waivers granted per student per fee component.',
    columns: [
      { name: 'id', type: 'bigint' },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      { name: 'studentname', type: 'varchar', pii: 'students' },
      { name: 'enrollmentno', type: 'varchar', pii: 'students' },
      {
        name: 'academicyearname',
        type: 'varchar',
        description: "Academic year label, e.g. '2025-2026'. Always filter on it: the tables hold every year since 2020.",
      },
      {
        name: 'classname',
        type: 'varchar',
        description: 'Class label, e.g. XII. Use get_dimensions for the valid values of a school.',
      },
      { name: 'sectionname', type: 'varchar', description: 'Section label within a class.' },
      { name: 'studenttype', type: 'varchar' },
      { name: 'gender', type: 'varchar' },
      { name: 'feecategory', type: 'varchar' },
      { name: 'componentname', type: 'text', description: 'Fee head, e.g. Tuition Fee.' },
      { name: 'periodname', type: 'varchar' },
      { name: 'installmentname', type: 'varchar' },
      { name: 'waiver_amount', type: 'double' },
      { name: 'waiverdate', type: 'date' },
      { name: 'periodfromdate', type: 'date' },
      { name: 'periodtodate', type: 'date' },
      { name: 'createdon', type: 'datetime' },
      { name: 'academicyearid', type: 'bigint' },
      {
        name: 'classseq',
        type: 'bigint',
        description: 'Sortable class ordinal. ORDER BY this, not by classname, which sorts as text.',
      },
      { name: 'acfromdate', type: 'date' },
      { name: 'actodate', type: 'date' },
    ],
  },
  {
    name: 'employees_data_set',
    domain: 'staff',
    description:
      'One row per employee: department, designation, staff type, joining and separation.',
    columns: [
      { name: 'employeeid', type: 'bigint' },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      { name: 'employeename', type: 'varchar', pii: 'staff' },
      { name: 'employeecode', type: 'varchar', pii: 'staff' },
      { name: 'departmentname', type: 'varchar' },
      { name: 'designationname', type: 'varchar' },
      { name: 'stafftype', type: 'varchar' },
      { name: 'gender', type: 'varchar' },
      { name: 'wingname', type: 'varchar' },
      { name: 'religionname', type: 'varchar' },
      { name: 'joining_date', type: 'date' },
      { name: 'joining_month', type: 'varchar' },
      { name: 'joining_year', type: 'varchar' },
      {
        name: 'deactivation_date',
        type: 'date',
        description: 'NULL while the record is active. A student or employee is current when this is NULL.',
      },
      { name: 'deactivation_month', type: 'varchar' },
      { name: 'deactivation_year', type: 'varchar' },
      { name: 'reason_for_leaving', type: 'varchar' },
    ],
  },
  {
    name: 'employee_attendance_data_set',
    domain: 'staff',
    description:
      'Day-level staff attendance: one row per marking of an employee on a date. Carries no academic year -- staff are not enrolled in one.',
    columns: [
      {
        name: 'id',
        type: 'bigint',
        description:
          "The extract's own row key. Unique, unlike attendanceid, so it is what a de-duplicating subquery should pick an employee-day by.",
      },
      { name: 'attendanceid', type: 'bigint', description: "The ERP's own attendance record id." },
      { name: 'employeeid', type: 'bigint' },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      { name: 'employeename', type: 'varchar', pii: 'staff' },
      { name: 'departmentname', type: 'varchar' },
      {
        name: 'attendancedate',
        type: 'varchar',
        description:
          'The date attendance was marked for, written YYYY-MM-DD as text rather than as a DATE. Compares and sorts correctly as text.',
      },
      {
        name: 'statusid',
        type: 'bigint',
        description:
          'DO NOT BRANCH ON THIS. The codes differ from student_attendance_data_set: 5 means Absent here and Suspend there. Read statusname.',
      },
      {
        name: 'statusname',
        type: 'varchar',
        description:
          "How the marking is named by the ERP. Observed in this extract: Present, Absent, First Half Leave, Second Half Leave. The half-day statuses are why a staff attendance rate is not a plain present/total count.",
      },
      { name: 'createdon', type: 'datetime', description: 'When the extract wrote the row.' },
    ],
  },
  {
    /**
     * Verified 2026-08-26 against `information_schema.columns` on the local
     * `ai_analysis` instance (see the file header note above). No rows exist
     * for this table anywhere in the extract -- every query against it is
     * correct SQL over zero data, not a stub.
     */
    name: 'student_transport_data_set',
    domain: 'students',
    description:
      "One row per student's transport assignment. No academic-year date column and no `deactivation_date`, so a query here sees every assignment row the table holds, not a filtered current subset.",
    columns: [
      { name: 'id', type: 'bigint' },
      { name: 'routeassignmentid', type: 'bigint', description: "The ERP's own assignment record id." },
      {
        name: 'studentprofileid',
        type: 'bigint',
        description: 'The join key to students_data_set for this table -- NOT studentid, which this table does not carry at all.',
      },
      { name: 'academicyearid', type: 'bigint' },
      {
        name: 'academicyearname',
        type: 'varchar',
        description: 'DO NOT FILTER ON THIS COLUMN. Carries the same stamped-current-year trap confirmed on both attendance tables and book_issue_data_set; this table has no per-row date to filter on instead, so a query here is simply unfiltered by time.',
      },
      { name: 'academicyearfromdate', type: 'varchar' },
      { name: 'academicyeartodate', type: 'varchar' },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      { name: 'studentname', type: 'varchar', pii: 'students' },
      { name: 'enrollmentno', type: 'varchar', pii: 'students' },
      { name: 'classname', type: 'varchar' },
      {
        name: 'sectionname',
        type: 'varchar',
        description: 'Carries no classseq -- join students_data_set on studentprofileid if the classes need ordering, the same technique student_attendance_data_set already requires.',
      },
      { name: 'pickuproutename', type: 'varchar' },
      { name: 'droproutename', type: 'varchar', description: 'Can differ from pickuproutename -- a student is not guaranteed the same route both ways.' },
      { name: 'pickupstopname', type: 'varchar' },
      { name: 'dropstopname', type: 'varchar' },
      { name: 'modeoftransport', type: 'varchar' },
      { name: 'createdon', type: 'datetime' },
    ],
  },
  {
    /**
     * Verified 2026-08-26 against `information_schema.columns` on the local
     * `ai_analysis` instance (see the file header note above). Real data
     * exists only for `training_edubac` (1,693 rows), none for the St Marks
     * schools.
     */
    name: 'books_data_set',
    domain: 'students',
    description:
      'One row per PHYSICAL COPY, not per title -- `bookid` never repeats. A title with several copies is several rows sharing a `bookname`. "In stock" is `statusname` on the copy\'s own row, not a stored count.',
    columns: [
      { name: 'id', type: 'bigint' },
      { name: 'bookid', type: 'bigint', description: 'Unique per COPY (confirmed: as many distinct bookid as rows), not per title.' },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      { name: 'bookname', type: 'varchar', description: 'The title. Group by this, not bookid, to count copies of the same book.' },
      { name: 'accessionno', type: 'varchar', description: "The library's own per-copy accession number." },
      { name: 'authorname', type: 'varchar' },
      { name: 'publishername', type: 'varchar' },
      {
        name: 'booktypename',
        type: 'varchar',
        description: "Free text, and messy: 'STORY' and 'Story Books' both occur as separate values, alongside test junk ('test', 'add v3'). Report it as written -- do not canonicalise casing or merge values, the same rule stafftype (employees_data_set) already carries.",
      },
      {
        name: 'statusname',
        type: 'varchar',
        description: "Observed values: 'Available', 'Issued'. No canonical list was supplied, so an unrecognised value should be shown as recorded rather than assumed to mean either.",
      },
      { name: 'yearofpublication', type: 'varchar' },
      { name: 'createdon', type: 'datetime' },
    ],
  },
  {
    /**
     * Verified 2026-08-26 against `information_schema.columns` on the local
     * `ai_analysis` instance (see the file header note above). Real data
     * exists only for `training_edubac` (185 rows), none for the St Marks
     * schools.
     */
    name: 'book_issue_data_set',
    domain: 'students',
    description:
      'One row per issue transaction, to a student OR a member of staff. `issuetype` names which; the sampled data is entirely staff transactions, so a report reading only the student columns would silently show zero activity.',
    columns: [
      { name: 'id', type: 'bigint', description: 'Unique per transaction row.' },
      { name: 'issueid', type: 'bigint', description: "The ERP's own issue record id." },
      { name: 'bookid', type: 'bigint' },
      { name: 'academicyearid', type: 'bigint' },
      {
        name: 'academicyearname',
        type: 'varchar',
        description: 'DO NOT FILTER ON THIS COLUMN. Confirmed stamped with the CURRENT academic year on every row regardless of issuedate -- rows from 2023 and 2024 both read 2026-27. Filter on issuedate/duedate instead, the same trap and the same fix as both attendance tables.',
      },
      { name: 'academicyearfromdate', type: 'varchar' },
      { name: 'academicyeartodate', type: 'varchar' },
      {
        name: 'issuetype',
        type: 'varchar',
        description: "Who the copy was issued to. Observed value in this extract: 'Employee' -- read this column rather than assuming studentid is populated.",
      },
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
      { name: 'bookname', type: 'varchar' },
      { name: 'accessionno', type: 'varchar' },
      { name: 'studentid', type: 'bigint', description: "0 (not NULL) on a staff issue -- test for issuetype, not for a non-zero id, to tell a student transaction from a staff one." },
      { name: 'studentname', type: 'varchar', pii: 'students' },
      { name: 'employeeid', type: 'bigint' },
      { name: 'employeename', type: 'varchar', pii: 'staff' },
      { name: 'classname', type: 'varchar' },
      { name: 'sectionname', type: 'varchar' },
      {
        name: 'issuedate',
        type: 'varchar',
        description: 'YYYY-MM-DD as text, like attendancedate -- compares and sorts correctly as text.',
      },
      { name: 'duedate', type: 'varchar', description: 'YYYY-MM-DD as text.' },
      { name: 'returndate', type: 'varchar', description: 'YYYY-MM-DD as text. NULL while the copy is still out.' },
      { name: 'createdon', type: 'datetime' },
    ],
  },
  {
    name: 'schools_data_set',
    domain: 'reference',
    description:
      'The schools of this org and their identifiers. Reference data, governed by scope alone.',
    columns: [
      {
        name: 'school_db',
        type: 'varchar',
        description: 'Tenant discriminator for this schema version. Injected by the MCP server as a bound parameter -- never write it into a query yourself.',
      },
      { name: 'school_name', type: 'varchar' },
      { name: 'school_code', type: 'varchar' },
      { name: 'society_url', type: 'varchar' },
      { name: 'school_url', type: 'varchar' },
      {
        name: 'society_db',
        type: 'varchar',
        description: "The org (the ERP's 'society') this row belongs to.",
      },
    ],
  },
  ],

  joins: [
    {
      from: 'students_data_set',
      to: 'fee_compile_data_set',
      on: ['enrollmentno', 'academicyearname'],
      note: 'Fee tables already carry class, section and student name, so a join is only needed for demographics the fee tables lack (house, category, religion, joining date).',
    },
    {
      from: 'students_data_set',
      to: 'fee_collection_data_set',
      on: ['enrollmentno', 'academicyearname'],
    },
    {
      from: 'fee_compile_data_set',
      to: 'fee_collection_data_set',
      on: ['enrollmentno', 'academicyearname', 'componentname'],
      note: 'Demand vs receipts for the same fee head.',
    },
    {
      from: 'student_attendance_data_set',
      to: 'students_data_set',
      on: ['studentid'],
      note: "Join on studentid ALONE and add the year to the students_data_set side, because the attendance row's own academicyearname cannot be trusted. Needed for anything the attendance table lacks -- classseq for ordering classes, gender, category.",
    },
    {
      from: 'employee_attendance_data_set',
      to: 'employees_data_set',
      on: ['employeeid'],
      note: 'Needed for designation, staff type and joining/leaving dates; the attendance table carries only the department name.',
    },
    {
      from: 'book_issue_data_set',
      to: 'books_data_set',
      on: ['bookid'],
      note: 'Both are inferred, unverified tables (see file header). Needed only if a query wants a book column the issue table does not already denormalise, such as author or category.',
    },
  ],

  /**
   * Stated to the model so it plans queries the guard will accept. Every rule
   * here is enforced independently in sql/guard.ts — this list is guidance, and
   * guidance is never the enforcement (docs/04 §3: the rails are always on).
   */
  rules: [
    'SELECT only. One statement. No INSERT/UPDATE/DELETE/DDL, no multi-statement payloads, no stored procedures.',
    'Do not write a school_db, society_db or database-name filter. The server injects the tenant filter as a bound parameter around every table you name; writing your own would be ignored at best and wrong at worst.',
    'Do not qualify tables with a database name. Say students_data_set, never ai_analysis.students_data_set.',
    'Do not use placeholders (?). Statements carry their own literal values.',
    'Common table expressions (WITH ...) are not supported yet. Use subqueries.',
    'Results are capped at 5,000 rows and 10 seconds. Aggregate in SQL rather than returning detail rows for the client to summarise.',
    'Always filter on academicyearname unless the question is explicitly historical: these tables hold every year since 2020-04.',
    'The two attendance tables are the exception to the rule above: their academicyearname is stamped with the current year rather than the year the row belongs to, so filter them on attendancedate BETWEEN two dates instead.',
    'Never branch on statusid. It is not consistent between the two attendance tables. Read statusname, and treat a value you were not told about as unknown rather than as absent.',
    'Neither attendance table is unique on (student, date) or (employee, date). De-duplicate first -- GROUP BY the subject and the date taking MAX(id), then join back on id -- or a count of days will be inflated.',
    'Order classes by classseq, never by classname, which sorts as text (X before IX).',
    'A student or employee is current when deactivation_date IS NULL.',
    'student_transport_data_set, books_data_set and book_issue_data_set are UNVERIFIED: their columns are inferred from this catalog\'s conventions, not read from a sample of the real table. Treat results from them as provisional and say so when asked about transport or library data.',
  ],
};
