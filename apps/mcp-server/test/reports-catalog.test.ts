/**
 * Invariant tests for the predefined report catalog.
 *
 * The catalog is the one place in this system where SQL is written by hand and
 * shipped. `run_predefined` cannot be handed a statement (that is the whole
 * point of it, ADR-016), so a broken statement here is not a caller's problem to
 * discover at runtime — it is a dashboard that fails for every school, every
 * time, until someone reads a log.
 *
 * So every property that must hold for EVERY report is asserted over the
 * catalog itself rather than over a list of report ids typed out here. A test
 * that names reports one by one silently stops covering the next one added.
 *
 * These are pure: no database, no MCP server, no configuration. The guard is a
 * function from a statement to a statement, which is what makes "does the
 * shipped SQL survive the guard?" answerable in a unit test rather than in
 * staging.
 */

import { describe, expect, it } from 'vitest';
import { PlatformError } from '@sap/shared';
import { predefinedReports, predefinedReportIds } from '../src/reports/catalog.js';
import { prepareSelect, TENANT_PARAM } from '../src/sql/guard.js';
import { ERP_V1 } from '../src/schema/erp-v1.js';
import { DOMAIN_PERM, type DataDomain } from '../src/schema/catalog.js';

const ALL_PERMS = ['students.read', 'fees.read', 'staff.read'];

/**
 * Plausible values, in the shape `run_predefined` would bind them.
 *
 * `drill_quarter` is deliberately absent: it is an OPTIONAL parameter, and
 * `run_predefined` binds an absent optional as null (run-predefined.ts). Every
 * statement that reads it must therefore survive the guard with the value
 * missing, which is what `bind()` below reproduces by falling through to 'x' —
 * see the null-branch test at the end of this file for the real shape.
 */
const VALUES: Record<string, string> = {
  academic_year: '2026-27',
  as_of_date: '2026-08-19',
};

const reports = predefinedReports();

/** Every (report, query) pair, as vitest table rows. */
const everyQuery = reports.flatMap((report) =>
  report.queries.map((query) => [`${report.id} · ${query.key}`, report, query] as const),
);

/**
 * Every (report, bucket variant) pair — docs/06 §3's per-widget clone. A
 * variant is hand-written SQL exactly like `query.sql` (reports/catalog.ts),
 * so it gets the same "does the shipped SQL survive the guard?" coverage;
 * `run_predefined` selects one of these to RUN, never to display alongside
 * the default, so nothing else in this file would otherwise exercise it.
 */
const everyVariant = reports.flatMap((report) =>
  report.queries.flatMap((query) =>
    Object.entries(query.variants ?? {}).map(
      ([bucket, sql]) => [`${report.id} · ${query.key} · ${bucket}`, report, sql] as const,
    ),
  ),
);

function bind(report: (typeof reports)[number]): Record<string, string> {
  return Object.fromEntries(report.params.map((p) => [p.name, VALUES[p.name] ?? 'x']));
}

function prepare(
  report: (typeof reports)[number],
  sql: string,
  perms: readonly string[] = ALL_PERMS,
) {
  return prepareSelect({
    sql,
    catalog: ERP_V1,
    tenantKey: 'stmarksmb',
    perms,
    rowCap: 5000,
    declaredParams: bind(report),
  });
}

describe('every shipped statement survives the guard', () => {
  it.each(everyQuery)('%s prepares', (_label, report, query) => {
    expect(() => prepare(report, query.sql)).not.toThrow();
  });

  it.each(everyQuery)('%s carries the tenant filter, bound', (_label, report, query) => {
    const prepared = prepare(report, query.sql);
    expect(prepared.params[TENANT_PARAM]).toBe('stmarksmb');
    expect(prepared.sql).toContain(TENANT_PARAM);
    // Rewritten, never the author's text: the wrapper is what isolates tenants.
    expect(prepared.sql).not.toBe(query.sql);
  });

  it.each(everyQuery)('%s reads only tables in the schema catalog', (_label, report, query) => {
    const prepared = prepare(report, query.sql);
    expect(prepared.tables.length).toBeGreaterThan(0);
    for (const table of prepared.tables) {
      expect(ERP_V1.tables.some((t) => t.name === table)).toBe(true);
    }
  });
});

describe('every bucket variant survives the guard, same as its default statement', () => {
  it.each(everyVariant)('%s prepares', (_label, report, sql) => {
    expect(() => prepare(report, sql)).not.toThrow();
  });

  it.each(everyVariant)('%s carries the tenant filter, bound', (_label, report, sql) => {
    const prepared = prepare(report, sql);
    expect(prepared.params[TENANT_PARAM]).toBe('stmarksmb');
  });

  it.each(everyVariant)('%s reads only tables in the schema catalog', (_label, report, sql) => {
    const prepared = prepare(report, sql);
    expect(prepared.tables.length).toBeGreaterThan(0);
    for (const table of prepared.tables) {
      expect(ERP_V1.tables.some((t) => t.name === table)).toBe(true);
    }
  });

  /**
   * The whole point of picking a variant instead of parameterising the
   * statement (reports/catalog.ts's comment on `ReportQuery.variants`) is
   * that the orchestrator's widget-building code never learns which one ran
   * — `merged.sumBy('by_month', 'fee_month', ..., 'mo')` reads the same two
   * column names regardless of bucket. A variant with a different shape
   * would silently break that reuse.
   */
  it('every bucket variant of a query returns the same column names as its default', () => {
    for (const report of reports) {
      for (const query of report.queries) {
        if (query.variants === undefined) continue;
        const defaultColumns = columnAliases(query.sql);
        for (const [bucket, sql] of Object.entries(query.variants)) {
          expect(columnAliases(sql), `${report.id} · ${query.key} · ${bucket}`).toEqual(defaultColumns);
        }
      }
    }
  });
});

/**
 * Column aliases in declaration order, e.g. 'SELECT a AS x, b AS y' -> ['x',
 * 'y']. Splits on top-level commas only (parenthesis-depth aware), since a
 * bucket variant's column list nests them — `DATE_FORMAT(feedate, '...')`
 * has a comma that is not a column separator.
 */
function columnAliases(sql: string): string[] {
  const select = sql.slice(sql.indexOf('SELECT') + 'SELECT'.length, sql.indexOf(' FROM '));
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < select.length; i += 1) {
    const ch = select[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(select.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(select.slice(start));
  return parts.map((part) => part.trim().split(/\s+AS\s+/i)[1] ?? part.trim());
}

describe('a report may only use filters it declares', () => {
  it.each(everyQuery)('%s binds no undeclared parameter', (_label, report, query) => {
    const prepared = prepare(report, query.sql);
    const declared = new Set(report.params.map((p) => p.name));
    for (const name of Object.keys(prepared.params)) {
      if (name === TENANT_PARAM) continue;
      expect(declared.has(name)).toBe(true);
    }
  });

  it('declares no filter that no query uses', () => {
    for (const report of reports) {
      const used = new Set<string>();
      for (const query of report.queries) {
        for (const name of Object.keys(prepare(report, query.sql).params)) {
          if (name !== TENANT_PARAM) used.add(name);
        }
      }
      /**
       * `bucket` (docs/06 §3 per-widget clone) is a SELECTOR among a query's
       * pre-vetted `variants` (reports/catalog.ts) — run-predefined.ts picks
       * a whole alternate statement with it and never binds it as `:bucket`,
       * so it can never appear in `prepare(...).params` even when genuinely
       * consumed. Excepted narrowly, only for a report where some query
       * actually declares `variants`: a report with none has no legitimate
       * reason to declare `bucket` either, and would still be caught below.
       */
      const hasVariants = report.queries.some((q) => q.variants !== undefined);
      const expectedNames = report.params.map((p) => p.name).filter((name) => !(name === 'bucket' && hasVariants));
      /**
       * A declared-but-unused filter is a pill on screen that narrows nothing —
       * the user believes the report is filtered and it is not. `prepareSelect`
       * binds only the parameters a statement actually uses, so an unused
       * declaration is invisible at runtime and must be caught here.
       */
      expect([...used].sort()).toEqual(expectedNames.sort());
    }
  });

  it('never declares the reserved tenant parameter', () => {
    for (const report of reports) {
      expect(report.params.some((p) => p.name === TENANT_PARAM)).toBe(false);
    }
  });
});

describe('the catalog is internally consistent', () => {
  it('has unique report ids and unique query keys within a report', () => {
    expect(new Set(predefinedReportIds()).size).toBe(reports.length);
    for (const report of reports) {
      expect(new Set(report.queries.map((q) => q.key)).size).toBe(report.queries.length);
    }
  });

  it('writes every report against a schema version the server has', () => {
    for (const report of reports) {
      expect(report.schema_version).toBe(ERP_V1.schema_version);
    }
  });

  it('gives every report a source, a domain and at least one query', () => {
    for (const report of reports) {
      expect(report.source).not.toBe('');
      expect(report.title).not.toBe('');
      expect(report.queries.length).toBeGreaterThan(0);
    }
  });
});

/**
 * docs/08 §4.5: a session holding only `fees.read` may read the fee tables and
 * nothing else. That is enforced in the guard, per TABLE, per statement
 * (sql/guard.ts reads `table.domain`, never a report-level field) — so it holds
 * for predefined reports without the catalog doing anything, and this proves
 * it rather than assuming it.
 *
 * Derived from the TABLES a query actually touches, not from `report.domain`.
 * A report's declared `domain` is one label for a whole report (used only for
 * the Source chip's grouping — confirmed by grep, nothing else reads it), and
 * every report was single-domain until Principal's Snapshot, whose queries
 * span students/fees/staff. Asserting against `report.domain` alone would have
 * only checked the FIRST domain a report happens to be filed under and missed
 * the other two entirely for a query that needs them — the gap this file
 * exists to catch.
 */
describe('domain permissions still gate a predefined report', () => {
  it.each(everyQuery)('%s is refused a session missing any domain its own tables need', (_label, report, query) => {
    const prepared = prepare(report, query.sql); // ALL_PERMS, just to discover the tables touched
    const domainsNeeded = new Set(
      prepared.tables
        .map((name) => ERP_V1.tables.find((t) => t.name === name)?.domain)
        .filter((d): d is DataDomain => d !== undefined),
    );
    for (const domain of domainsNeeded) {
      const required = DOMAIN_PERM[domain];
      if (required === null) continue; // reference data is governed by scope alone
      const perms = ALL_PERMS.filter((p) => p !== required);
      let code = 'NO_ERROR';
      try {
        prepare(report, query.sql, perms);
      } catch (err) {
        code = err instanceof PlatformError ? err.code : 'NOT_A_PLATFORM_ERROR';
      }
      expect(code).toBe('PERMISSION_DENIED');
    }
  });
});

/**
 * docs/06 §4.2: "student-level leaves are top-N capped". The defaulter list is
 * the only predefined query that returns one row per child, and the cap is part
 * of the report's definition rather than something the row cap happens to do —
 * 5,000 named children would be a very different document from the 50 the
 * dashboard promises.
 */
describe('the student-level list is capped by the report, not by the row cap', () => {
  it('limits the defaulter list to a top-N', () => {
    const report = reports.find((r) => r.id === 'fee-defaulters');
    expect(report).toBeDefined();
    const list = report?.queries.find((q) => q.key === 'top_defaulters');
    expect(list?.sql).toMatch(/LIMIT 50$/);
  });

  it('keeps that cap after the guard rewrites the statement', () => {
    const report = reports.find((r) => r.id === 'fee-defaulters');
    const list = report?.queries.find((q) => q.key === 'top_defaulters');
    if (report === undefined || list === undefined) throw new Error('report vanished');
    // Clamped down, never widened to the 5,000-row cap.
    expect(prepare(report, list.sql).sql).toMatch(/LIMIT 50/);
  });
});

/**
 * A drill level is a panel that does not exist until someone clicks it
 * (ADR-020). It ships as vetted SQL like any other query — same guard, same
 * caps — but a DEFAULT run of the report must not pay for it: on
 * `fee_compile_data_set`, which carries no usable index, two unasked-for levels
 * are two extra full scans on every dashboard open.
 */
describe('drill-only queries are opt-in, not part of a dashboard', () => {
  const drillQueries = reports.flatMap((report) =>
    report.queries
      .filter((q) => q.drill_only === true)
      .map((q) => [`${report.id} · ${q.key}`, report, q] as const),
  );

  it('there is at least one, or this file is asserting nothing', () => {
    expect(drillQueries.length).toBeGreaterThan(0);
  });

  it.each(drillQueries)('%s survives the guard with its drill filter unbound', (_label, report, q) => {
    /**
     * Bound as NULL, which is what an un-clicked drill parameter really is —
     * not the placeholder string `bind()` supplies. A statement written as
     * `:p IS NULL OR expr = :p` has to hold in both branches, and only this
     * shape exercises the one a caller can reach without clicking.
     */
    const declared = Object.fromEntries(
      report.params.map((p) => [p.name, p.name.startsWith('drill_') ? null : (VALUES[p.name] ?? 'x')]),
    );
    expect(() =>
      prepareSelect({
        sql: q.sql,
        catalog: ERP_V1,
        tenantKey: 'stmarksmb',
        perms: ALL_PERMS,
        rowCap: 5000,
        declaredParams: declared,
      }),
    ).not.toThrow();
  });

  it.each(drillQueries)('%s binds its drill filter rather than splicing it', (_label, _report, q) => {
    /**
     * The clicked value must reach the database as a parameter. A statement
     * that had interpolated it would carry a literal here, and "a click can
     * only narrow" would rest on nobody having made a mistake in this file.
     */
    if (!q.sql.includes('drill_')) return;
    expect(q.sql).toMatch(/:drill_\w+/);
  });

  it('every report declaring a drill parameter declares it optional', () => {
    for (const report of reports) {
      for (const param of report.params) {
        if (!param.name.startsWith('drill_')) continue;
        /**
         * Required would break the base dashboard: the same report is run with
         * no drill context every time someone opens it, and a required drill
         * filter would refuse that request outright.
         */
        expect(param.required, `${report.id}: ${param.name}`).toBe(false);
      }
    }
  });
});
