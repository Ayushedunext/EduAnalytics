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
import { DOMAIN_PERM } from '../src/schema/catalog.js';

const ALL_PERMS = ['students.read', 'fees.read', 'staff.read'];

/** Plausible values, in the shape `run_predefined` would bind them. */
const VALUES: Record<string, string> = {
  academic_year: '2026-27',
  as_of_date: '2026-08-19',
};

const reports = predefinedReports();

/** Every (report, query) pair, as vitest table rows. */
const everyQuery = reports.flatMap((report) =>
  report.queries.map((query) => [`${report.id} · ${query.key}`, report, query] as const),
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
       * A declared-but-unused filter is a pill on screen that narrows nothing —
       * the user believes the report is filtered and it is not. `prepareSelect`
       * binds only the parameters a statement actually uses, so an unused
       * declaration is invisible at runtime and must be caught here.
       */
      expect([...used].sort()).toEqual(report.params.map((p) => p.name).sort());
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
 * nothing else. That is enforced in the guard, per table, per statement — so it
 * holds for predefined reports without the catalog doing anything, and this
 * proves it rather than assuming it.
 */
describe('domain permissions still gate a predefined report', () => {
  it.each(everyQuery)('%s is refused to a session without its domain', (_label, report, query) => {
    const required = DOMAIN_PERM[report.domain];
    if (required === null) return; // reference data is governed by scope alone
    const perms = ALL_PERMS.filter((p) => p !== required);
    let code = 'NO_ERROR';
    try {
      prepare(report, query.sql, perms);
    } catch (err) {
      code = err instanceof PlatformError ? err.code : 'NOT_A_PLATFORM_ERROR';
    }
    expect(code).toBe('PERMISSION_DENIED');
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
