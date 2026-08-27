/**
 * Fee-table index benchmark — the evidence behind AUDIT_REPORT C21.
 *
 * DEVELOPMENT ONLY, and read-only: SELECT and EXPLAIN, nothing else. It runs as
 * `analytics_ro` precisely because that user cannot do anything else (ADR-008),
 * so this script cannot be the thing that changes a school database.
 *
 *   npm run bench:fee-index -- before      # writes bench-fee-index.before.json
 *   npm run bench:fee-index -- after
 *
 * -- Why this file exists ------------------------------------------------------
 * `reports/catalog.ts` had carried a comment for months saying the fee tables
 * lack a usable index and that the fix belongs to whoever owns the ERP schema.
 * A comment is not a measurement, and nobody can act on "this is slow". This
 * script turns that claim into numbers a schema owner can weigh against the
 * write cost they will pay: rows examined, wall-clock, and which index (if any)
 * the optimiser actually chose.
 *
 * -- Why it rebuilds the guard's SQL rather than importing the catalog ---------
 * What reaches MySQL is NOT the text in `catalog.ts`. `sql/guard.ts` rewrites
 * every base table into a derived table carrying the scope filter:
 *
 *     FROM (SELECT * FROM fee_compile_data_set WHERE school_db = ?) AS ...
 *
 * so the tenant predicate and the year predicate arrive in DIFFERENT query
 * blocks. Whether a composite `(school_db, academicyearname)` index can serve
 * both therefore depends on the optimiser merging that derived table — if it
 * materialised it instead, the index would be half wasted and the measurement
 * would be a lie. Benchmarking the catalog text would quietly skip the one
 * thing most likely to go wrong, so the shapes below are written out as the
 * guard emits them. `EXPLAIN`'s `select_type` is the tell: `SIMPLE` means
 * merged, `DERIVED` means we have a problem.
 *
 * The SQL is duplicated from the catalog rather than imported for the same
 * reason: importing would give us the pre-guard text, which is not what runs.
 * If a catalog query changes materially, change it here too — a benchmark that
 * silently measures last month's query is worse than no benchmark.
 */

import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// The repo-root .env, named explicitly — see the note in src/config.ts.
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const LABEL = process.argv[2] ?? 'baseline';

/**
 * The largest school in the `ai_analysis` extract, on purpose. A benchmark run
 * against the smallest tenant would understate the scan and overstate the fix.
 */
const TENANT = 'stmarksmb';
const YEAR = '2025-26';
const AS_OF = '2026-08-27';
const RUNS = 5;

/** The guard's rewrite (sql/guard.ts `wrapBaseTable`). */
const scoped = (table: string): string =>
  `(SELECT * FROM ${table} WHERE school_db = :sap_tenant_key) AS ${table}`;

/**
 * `:name` → `?`, building the positional array in occurrence order. The catalog
 * binds by NAME and several statements repeat `:as_of_date`; expanding here
 * keeps the benchmarked text identical to the real one rather than quietly
 * rewriting the query to use each parameter once.
 */
function bind(sql: string, values: Record<string, string>): { text: string; params: string[] } {
  const params: string[] = [];
  const text = sql.replace(/:([a-z_]+)/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`unbound :${name}`);
    params.push(value);
    return '?';
  });
  return { text, params };
}

const VALUES: Record<string, string> = {
  sap_tenant_key: TENANT,
  academic_year: YEAR,
  as_of_date: AS_OF,
};

interface Benchmarked {
  readonly id: string;
  /** The base table whose access path we care about, when a plan has several rows. */
  readonly table: string;
  readonly sql: string;
}

const QUERIES: readonly Benchmarked[] = [
  {
    id: 'collection.by_month',
    table: 'fee_collection_data_set',
    sql: `SELECT fee_month, MIN(MONTH(feedate)) AS mo, ROUND(SUM(paidamount)) AS collected
          FROM ${scoped('fee_collection_data_set')} WHERE academicyearname = :academic_year
          GROUP BY fee_month ORDER BY mo`,
  },
  {
    id: 'collection.by_class',
    table: 'fee_collection_data_set',
    sql: `SELECT classname, MIN(classseq) AS seq, ROUND(SUM(paidamount)) AS collected
          FROM ${scoped('fee_collection_data_set')} WHERE academicyearname = :academic_year
          GROUP BY classname ORDER BY seq`,
  },
  {
    id: 'collection.by_mode',
    table: 'fee_collection_data_set',
    sql: `SELECT paymenttype, ROUND(SUM(paidamount)) AS collected
          FROM ${scoped('fee_collection_data_set')} WHERE academicyearname = :academic_year
          GROUP BY paymenttype ORDER BY collected DESC`,
  },
  {
    id: 'collection.by_component',
    table: 'fee_compile_data_set',
    sql: `SELECT componentname, ROUND(SUM(total_payable_amount)) AS payable,
                 ROUND(SUM(paid_amount)) AS paid, ROUND(SUM(balance_amount)) AS balance
          FROM ${scoped('fee_compile_data_set')} WHERE academicyearname = :academic_year
          GROUP BY componentname ORDER BY payable DESC`,
  },
  {
    id: 'defaulters.totals',
    table: 'fee_compile_data_set',
    sql: `SELECT COUNT(DISTINCT enrollmentno) AS defaulters, ROUND(SUM(balance_amount)) AS overdue
          FROM ${scoped('fee_compile_data_set')}
          WHERE academicyearname = :academic_year AND balance_amount > 0
            AND periodtodate < :as_of_date`,
  },
  {
    id: 'defaulters.aging',
    table: 'fee_compile_data_set',
    sql: `SELECT CASE
            WHEN periodtodate IS NULL THEN 'No due date recorded'
            WHEN periodtodate >= :as_of_date THEN 'Not yet due'
            WHEN DATEDIFF(:as_of_date, periodtodate) <= 30 THEN '1-30 days'
            WHEN DATEDIFF(:as_of_date, periodtodate) <= 60 THEN '31-60 days'
            WHEN DATEDIFF(:as_of_date, periodtodate) <= 90 THEN '61-90 days'
            ELSE '90+ days' END AS bucket,
          CASE
            WHEN periodtodate IS NULL THEN 0
            WHEN periodtodate >= :as_of_date THEN 1
            WHEN DATEDIFF(:as_of_date, periodtodate) <= 30 THEN 2
            WHEN DATEDIFF(:as_of_date, periodtodate) <= 60 THEN 3
            WHEN DATEDIFF(:as_of_date, periodtodate) <= 90 THEN 4
            ELSE 5 END AS seq,
          COUNT(DISTINCT enrollmentno) AS students, ROUND(SUM(balance_amount)) AS outstanding
          FROM ${scoped('fee_compile_data_set')}
          WHERE academicyearname = :academic_year AND balance_amount > 0
          GROUP BY bucket, seq ORDER BY seq`,
  },
  {
    id: 'defaulters.by_class',
    table: 'fee_compile_data_set',
    sql: `SELECT classname, MIN(classseq) AS seq, COUNT(DISTINCT enrollmentno) AS students,
                 ROUND(SUM(balance_amount)) AS outstanding
          FROM ${scoped('fee_compile_data_set')}
          WHERE academicyearname = :academic_year AND balance_amount > 0
            AND periodtodate < :as_of_date
          GROUP BY classname ORDER BY seq`,
  },
  {
    id: 'defaulters.by_component',
    table: 'fee_compile_data_set',
    sql: `SELECT componentname, COUNT(DISTINCT enrollmentno) AS students,
                 ROUND(SUM(balance_amount)) AS outstanding
          FROM ${scoped('fee_compile_data_set')}
          WHERE academicyearname = :academic_year AND balance_amount > 0
            AND periodtodate < :as_of_date
          GROUP BY componentname ORDER BY outstanding DESC`,
  },
  {
    id: 'defaulters.top_defaulters',
    table: 'fee_compile_data_set',
    sql: `SELECT enrollmentno, studentname, classname, sectionname,
                 MIN(classseq) AS seq, ROUND(SUM(balance_amount)) AS outstanding,
                 MAX(DATEDIFF(:as_of_date, periodtodate)) AS days_overdue
          FROM ${scoped('fee_compile_data_set')}
          WHERE academicyearname = :academic_year AND balance_amount > 0
            AND periodtodate < :as_of_date
          GROUP BY enrollmentno, studentname, classname, sectionname
          ORDER BY outstanding DESC LIMIT 50`,
  },
  {
    id: 'snapshot.fees',
    table: 'fee_compile_data_set',
    sql: `SELECT ROUND(SUM(total_payable_amount)) AS payable, ROUND(SUM(paid_amount)) AS paid,
                 ROUND(SUM(balance_amount)) AS balance
          FROM ${scoped('fee_compile_data_set')} WHERE academicyearname = :academic_year`,
  },

  /**
   * `get_dimensions` filters on the scope column ALONE — no year. These two are
   * the reason the index must lead with `school_db`: an index ordered
   * `(academicyearname, school_db)` would serve every query above and leave
   * these on a full scan, because a composite index is only usable from its
   * leftmost column inward.
   */
  {
    id: 'dimensions.feecategory',
    table: 'fee_compile_data_set',
    sql: `SELECT DISTINCT feecategory FROM ${scoped('fee_compile_data_set')} ORDER BY feecategory`,
  },
  {
    id: 'dimensions.componentname',
    table: 'fee_compile_data_set',
    sql: `SELECT DISTINCT componentname FROM ${scoped('fee_compile_data_set')} ORDER BY componentname`,
  },
];

interface PlanRow {
  readonly table: string | null;
  readonly select_type: string | null;
  readonly type: string | null;
  readonly key: string | null;
  readonly rows: number | null;
  readonly filtered: number | null;
  readonly Extra: string | null;
}

/**
 * The read-only school-data user, and only ever that one. Named here rather
 * than accepted from argv so this script cannot be pointed at a credential that
 * could write — the SELECT-only grant is what makes running it against a real
 * replica a safe thing to do (ADR-008).
 */
const user = process.env['SCHOOL_DB_USER'];
const password = process.env['SCHOOL_DB_PASSWORD'];
if (user === undefined || user === '' || password === undefined) {
  console.error('SCHOOL_DB_USER / SCHOOL_DB_PASSWORD are not set. Copy .env.example to .env.');
  process.exit(1);
}

const conn = await mysql.createConnection({
  host: process.env['PLATFORM_DB_HOST'] ?? '127.0.0.1',
  port: Number(process.env['PLATFORM_DB_PORT'] ?? 3306),
  user,
  password,
  database: 'ai_analysis',
});

const results = [];
console.log(`query                          median   plan\n${'─'.repeat(74)}`);

for (const q of QUERIES) {
  const { text, params } = bind(q.sql, VALUES);

  const [plan] = await conn.query<never>(`EXPLAIN ${text}`, params);
  const rows = plan as unknown as PlanRow[];
  const base = rows.find((r) => r.table === q.table) ?? rows[0]!;

  /**
   * Repeated runs, and the MEDIAN rather than the mean. The first run pays for
   * whatever is not yet in the buffer pool and a single outlier would drag an
   * average somewhere no user ever experiences; the median is the run a reader
   * actually gets. `first_ms` is kept alongside so a cold/warm gap stays
   * visible rather than being averaged away.
   */
  const timings: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await conn.query(text, params);
    timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const sorted = [...timings].sort((a, b) => a - b);

  const row = {
    id: q.id,
    table: q.table,
    first_ms: Number(timings[0]!.toFixed(1)),
    median_ms: Number(sorted[Math.floor(RUNS / 2)]!.toFixed(1)),
    best_ms: Number(sorted[0]!.toFixed(1)),
    plan: {
      select_type: base.select_type,
      type: base.type,
      key: base.key,
      rows_examined: base.rows,
      extra: base.Extra,
    },
  };
  results.push(row);

  console.log(
    `${q.id.padEnd(28)} ${String(row.median_ms).padStart(8)} ms  ` +
      `type=${base.type ?? '?'} key=${base.key ?? 'NULL'} rows=${base.rows ?? '?'}`,
  );

  if (base.select_type === 'DERIVED') {
    console.log(
      `  ! ${q.id}: the guard's derived table was MATERIALISED, not merged. ` +
        `The year filter cannot reach the index in this plan.`,
    );
  }
}

await conn.end();

const total = results.reduce((sum, r) => sum + r.median_ms, 0);
console.log(`${'─'.repeat(74)}\ntotal median: ${total.toFixed(0)} ms`);

const out = fileURLToPath(new URL(`../bench-fee-index.${LABEL}.json`, import.meta.url));
writeFileSync(out, JSON.stringify({ label: LABEL, tenant: TENANT, year: YEAR, results }, null, 2));
console.log(`written: bench-fee-index.${LABEL}.json`);
