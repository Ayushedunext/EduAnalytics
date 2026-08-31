/**
 * Drill latency benchmark — the evidence behind AUDIT_REPORT A7 and question 22.
 *
 * DEVELOPMENT ONLY, and read-only: SELECT only, run as `analytics_ro` precisely
 * because that user cannot do anything else (ADR-008). The sibling of
 * `bench-fee-index.ts`, and for the same reason: A7 has sat open since Rev 2 on
 * an ESTIMATE — "the fallback is 2–5× outside the budget it invokes" — and an
 * estimate is not something a product owner can weigh. This turns it into
 * numbers, per school size, for the statements that actually ship.
 *
 *   npm run bench:drill-latency -w @sap/mcp-server
 *
 * -- What it measures, and what it deliberately does not ----------------------
 * The DATABASE time for each drill level's statement, prepared through the real
 * guard so the tenant filter and the row cap are present exactly as they are in
 * production. It does not measure the orchestrator, the MCP hop or HTTP — those
 * added ~130 ms end-to-end when this was checked against the running stack, and
 * they do not vary with school size, which is the variable under study here.
 *
 * It also does not measure a cache hit. Tier ① answers a repeat drill in ~5 ms
 * (measured through the API), so every number below is the COLD case: the first
 * reader of a slice, which is the only one whose latency is in question.
 *
 * -- Why the median of five, after a discarded warm-up ------------------------
 * The first execution against a table this session pays for a cold InnoDB
 * buffer pool and reads several times slower — 2,267 ms against 491 ms for the
 * same statement, on the first attempt at writing this. Reporting that number
 * would have overstated the problem by 4.6× and sent someone to fix the wrong
 * thing. The warm-up is discarded and the median of five reported, with the
 * spread, so a reader can see the run-to-run noise rather than trust one draw.
 */

import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

// The repo-root .env, named explicitly -- the workspace script runs with this
// package as cwd, so `dotenv/config` would look in the wrong directory and fail
// with an access-denied that says nothing about the real cause.
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

import { prepareSelect } from '../src/sql/guard.js';
import { predefinedReports } from '../src/reports/catalog.js';
import { ERP_V1 } from '../src/schema/erp-v1.js';

/** The two shipped drill paths, level 2 and level 3 (services/dashboards.ts). */
const LEVELS = [
  { report: 'fee-collection', key: 'demand_by_quarter', label: 'collection L2 (by quarter)', drill: null },
  { report: 'fee-collection', key: 'demand_by_class', label: 'collection L3 (by class)', drill: 2 },
  { report: 'fee-defaulters', key: 'defaulters_by_quarter', label: 'defaulters L2 (by quarter)', drill: null },
  { report: 'fee-defaulters', key: 'defaulters_by_class', label: 'defaulters L3 (by class)', drill: 1 },
] as const;

/** docs/09 §3, via ADR-020: the budget these numbers are judged against. */
const BUDGET = { l2: 400, l3: 1500 };

const YEAR = process.env['BENCH_YEAR'] ?? '2026-27';
const AS_OF = process.env['BENCH_AS_OF'] ?? '2026-08-29';

async function main(): Promise<void> {
  const user = process.env['SCHOOL_DB_USER'];
  const password = process.env['SCHOOL_DB_PASSWORD'];
  if (user === undefined || password === undefined) {
    console.error('SCHOOL_DB_USER / SCHOOL_DB_PASSWORD are not set. Copy .env.example to .env.');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env['PLATFORM_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['PLATFORM_DB_PORT'] ?? 3306),
    user,
    password,
    database: process.env['BENCH_SCHOOL_DB'] ?? 'ai_analysis',
  });

  /**
   * Whichever tenants the loaded extract actually holds, largest first, rather
   * than a hardcoded list — the point of the exercise is how the numbers move
   * with table size, so the sample has to come from the data.
   */
  const [tenants] = await conn.query<mysql.RowDataPacket[]>(
    'SELECT school_db, COUNT(*) AS rows_total FROM fee_compile_data_set ' +
      'WHERE academicyearname = ? GROUP BY school_db HAVING rows_total > 1000 ' +
      'ORDER BY rows_total DESC LIMIT 5',
    [YEAR],
  );

  /**
   * The same typings-gap cast `db/execute.ts` carries: mysql2 accepts an object
   * of values when `namedPlaceholders` is set, but its `execute` overloads only
   * model the positional array form. Bound once here so the timing loop below
   * measures the driver call and nothing else.
   */
  const executeNamed = conn.execute.bind(conn) as unknown as (
    options: { sql: string; namedPlaceholders: true },
    values: Record<string, unknown>,
  ) => Promise<unknown>;

  const reports = predefinedReports();
  console.log(`Drill latency · AY ${YEAR} · as of ${AS_OF} · median of 5, warm-up discarded`);
  console.log(`Budget (docs/09 §3): L2 ${String(BUDGET.l2)} ms · L3 ${String(BUDGET.l3)} ms\n`);

  for (const tenant of tenants) {
    const key = String(tenant['school_db']);
    const rows = Number(tenant['rows_total']);
    console.log(`${key} — ${rows.toLocaleString('en-IN')} demand rows`);

    for (const level of LEVELS) {
      const report = reports.find((r) => r.id === level.report);
      const query = report?.queries.find((q) => q.key === level.key);
      if (report === undefined || query === undefined) {
        console.log(`  ${level.label.padEnd(28)} MISSING from the catalog`);
        continue;
      }

      const prepared = prepareSelect({
        sql: query.sql,
        catalog: ERP_V1,
        tenantKey: key,
        perms: ['fees.read'],
        rowCap: 5000,
        declaredParams: {
          academic_year: YEAR,
          as_of_date: AS_OF,
          bucket: null,
          drill_quarter: level.drill,
        },
      });

      const run = async (): Promise<number> => {
        const started = process.hrtime.bigint();
        await executeNamed({ sql: prepared.sql, namedPlaceholders: true }, { ...prepared.params });
        return Number(process.hrtime.bigint() - started) / 1e6;
      };

      await run(); // discarded: cold buffer pool, see the header note
      const runs: number[] = [];
      for (let i = 0; i < 5; i += 1) runs.push(await run());
      runs.sort((a, b) => a - b);

      const median = Math.round(runs[2] ?? 0);
      const budget = level.label.includes('L2') ? BUDGET.l2 : BUDGET.l3;
      const verdict =
        median <= budget ? 'within' : `${(median / budget).toFixed(1)}x over`;
      console.log(
        `  ${level.label.padEnd(28)} ${String(median).padStart(5)} ms  ` +
          `(${String(Math.round(runs[0] ?? 0))}-${String(Math.round(runs[4] ?? 0))})  ${verdict}`,
      );
    }
    console.log('');
  }

  await conn.end();
}

await main();
