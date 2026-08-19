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
 * NOTE for whoever adds attendance and exams (AUDIT_REPORT C20): neither exists
 * in this extract. When they arrive they are new entries here plus new dimension
 * queries — not a tool-shape change (docs/04 §8).
 */

import type { SchemaCatalog } from './catalog.js';

export const ERP_V1: SchemaCatalog = {
  schema_version: 'erp-v1',
  description:
    'EduNext ERP analytics extract. One consolidated database per org; rows are ' +
    'separated by the school_db column. Covers enrolment, admissions, fee demand ' +
    'and collection, concessions, waivers and staff. No attendance or exam data.',

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
    'Order classes by classseq, never by classname, which sorts as text (X before IX).',
    'A student or employee is current when deactivation_date IS NULL.',
  ],
};
