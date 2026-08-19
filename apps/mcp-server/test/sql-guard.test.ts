/**
 * Invariant tests for the SQL guard.
 *
 * [MANDATORY] CODING_GUIDELINES §14: "non-SELECT/multi-statement SQL rejected
 * (ADR-008)". That line is the headline, but the guard carries more of the
 * safety story than it says, so the tenant-filter rewrite and the row cap are
 * tested to the same standard here — under option (a) the tenant filter is the
 * ONLY thing separating one school's rows from another's (schema/erp-v1.ts), and
 * an untested rewrite would make Invariant 2 rest on an assertion.
 *
 * These are pure: no database, no network, no configuration. The guard is a
 * function from a statement to a statement, which is exactly what makes it
 * cheap to test exhaustively and worth putting the tenancy decision inside.
 */

import { describe, expect, it } from 'vitest';
import { PlatformError } from '@sap/shared';
import { prepareSelect, TENANT_PARAM } from '../src/sql/guard.js';
import { ERP_V1 } from '../src/schema/erp-v1.js';
import type { SchemaCatalog } from '../src/schema/catalog.js';

const ALL_PERMS = ['students.read', 'fees.read', 'staff.read'];

function prepare(sql: string, options: { perms?: string[]; rowCap?: number } = {}) {
  return prepareSelect({
    sql,
    catalog: ERP_V1,
    tenantKey: 'stmarksmb',
    perms: options.perms ?? ALL_PERMS,
    rowCap: options.rowCap ?? 5000,
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof PlatformError ? err.code : 'NOT_A_PLATFORM_ERROR';
  }
  return 'NO_ERROR';
}

describe('ADR-008: the data plane is read-only', () => {
  it.each([
    ['INSERT', "INSERT INTO students_data_set (studentname) VALUES ('x')"],
    ['UPDATE', "UPDATE students_data_set SET studentname = 'x'"],
    ['DELETE', 'DELETE FROM students_data_set'],
    ['REPLACE', "REPLACE INTO students_data_set (studentname) VALUES ('x')"],
    ['DROP', 'DROP TABLE students_data_set'],
    ['TRUNCATE', 'TRUNCATE TABLE students_data_set'],
    ['CREATE', 'CREATE TABLE t (a INT)'],
    ['ALTER', 'ALTER TABLE students_data_set ADD COLUMN x INT'],
    ['GRANT', "GRANT ALL ON *.* TO 'analytics_ro'@'%'"],
    ['SET', 'SET SESSION sql_mode = 0'],
  ])('rejects %s', (_label, sql) => {
    expect(codeOf(() => prepare(sql))).toBe('SQL_REJECTED');
  });

  it.each([
    ['a stacked write', "SELECT 1 FROM students_data_set; DELETE FROM students_data_set"],
    ['a stacked read', 'SELECT 1 FROM students_data_set; SELECT 2 FROM students_data_set'],
    ['a trailing semicolon plus junk', 'SELECT 1 FROM students_data_set; --'],
  ])('rejects %s (multi-statement)', (_label, sql) => {
    expect(codeOf(() => prepare(sql))).toBe('SQL_REJECTED');
  });

  it('rejects a locking read: a replica must not take locks', () => {
    expect(codeOf(() => prepare('SELECT studentid FROM students_data_set FOR UPDATE'))).toBe(
      'SQL_REJECTED',
    );
  });

  it.each(['SLEEP(30)', 'BENCHMARK(100000, MD5(1))', "LOAD_FILE('/etc/passwd')"])(
    'rejects %s — valid SELECT syntax, not analytics',
    (expression) => {
      expect(codeOf(() => prepare(`SELECT ${expression} FROM students_data_set`))).toBe(
        'SQL_REJECTED',
      );
    },
  );
});

describe('the catalog is the allowlist', () => {
  it('rejects a table that is not in the catalog', () => {
    expect(codeOf(() => prepare('SELECT * FROM search_history'))).toBe('SQL_REJECTED');
  });

  it('rejects a database-qualified table, including the system databases', () => {
    for (const sql of [
      'SELECT * FROM mysql.user',
      'SELECT * FROM information_schema.tables',
      'SELECT * FROM ai_analysis.students_data_set',
    ]) {
      expect(codeOf(() => prepare(sql))).toBe('SQL_REJECTED');
    }
  });

  it('rejects an unknown table hidden inside a subquery', () => {
    expect(
      codeOf(() =>
        prepare(
          'SELECT classname FROM students_data_set WHERE studentid IN (SELECT id FROM data_sync_log)',
        ),
      ),
    ).toBe('SQL_REJECTED');
  });

  it('rejects a statement that reads no catalog table at all', () => {
    expect(codeOf(() => prepare('SELECT 1'))).toBe('SQL_REJECTED');
  });

  it('rejects a CTE rather than letting an unrecognised construct through', () => {
    expect(
      codeOf(() => prepare('WITH x AS (SELECT 1 AS a FROM students_data_set) SELECT a FROM x')),
    ).toBe('SQL_REJECTED');
  });
});

describe('Invariant 2: every table reference carries the tenant filter', () => {
  const scoped = /\(SELECT \* FROM `[a-z_]+` WHERE `school_db` = :sap_tenant_key\)/g;

  it.each([
    ['a plain select', 'SELECT classname FROM students_data_set', 1],
    [
      'a join',
      'SELECT s.classname FROM students_data_set s JOIN fee_compile_data_set f ON f.enrollmentno = s.enrollmentno',
      2,
    ],
    [
      'a self join — both sides, not just the first',
      'SELECT a.classname FROM students_data_set a JOIN students_data_set b ON a.classid = b.classid',
      2,
    ],
    [
      'a subquery in WHERE',
      'SELECT classname FROM students_data_set WHERE enrollmentno IN (SELECT enrollmentno FROM fee_compile_data_set WHERE balance_amount > 0)',
      2,
    ],
    [
      'a derived table',
      'SELECT t.c FROM (SELECT COUNT(*) AS c FROM employees_data_set) t',
      1,
    ],
    [
      'a union',
      'SELECT classname FROM students_data_set UNION ALL SELECT classname FROM students_admission_data_set',
      2,
    ],
    [
      'a subquery in the select list',
      'SELECT classname, (SELECT COUNT(*) FROM fee_waiver_dataset) AS w FROM students_data_set',
      2,
    ],
  ])('filters %s', (_label, sql, expected) => {
    const prepared = prepare(sql);
    // One filtered derived table per table reference...
    expect(prepared.sql.match(scoped)).toHaveLength(expected);
    // ...all binding the SAME name, so the value is supplied exactly once and
    // cannot be mis-ordered however many tables the statement touches.
    expect(prepared.params).toEqual({ [TENANT_PARAM]: 'stmarksmb' });
  });

  it('binds the school as a parameter, never as text in the statement', () => {
    expect(prepare('SELECT classname FROM students_data_set').sql).not.toContain('stmarksmb');
  });

  it('refuses caller placeholders, so every ? in the output is the server’s', () => {
    expect(codeOf(() => prepare('SELECT classname FROM students_data_set WHERE gender = ?'))).toBe(
      'SQL_REJECTED',
    );
  });

  it("ignores a caller's own school_db predicate rather than trusting it", () => {
    // The caller's WHERE survives as an ordinary predicate on the ALREADY
    // filtered derived table, so it can narrow and can never widen.
    const prepared = prepare("SELECT classname FROM students_data_set WHERE school_db = 'stmarksj'");
    expect(prepared.params).toEqual({ [TENANT_PARAM]: 'stmarksmb' });
    expect(prepared.sql).toMatch(scoped);
  });

  it('refuses to run at all when a column-isolated school has no tenant_key', () => {
    const code = codeOf(() =>
      prepareSelect({
        sql: 'SELECT classname FROM students_data_set',
        catalog: ERP_V1,
        tenantKey: null,
        perms: ALL_PERMS,
        rowCap: 5000,
      }),
    );
    expect(code).toBe('TENANT_UNAVAILABLE');
  });

  it('injects nothing when the schema version isolates tenants by database', () => {
    const perSchool: SchemaCatalog = {
      ...ERP_V1,
      tenant_isolation: { mode: 'database_per_school' },
    };
    const prepared = prepareSelect({
      sql: 'SELECT classname FROM students_data_set',
      catalog: perSchool,
      tenantKey: null,
      perms: ALL_PERMS,
      rowCap: 5000,
    });
    expect(prepared.params).toEqual({});
    expect(prepared.sql).not.toContain('school_db');
  });
});

describe('ADR-008: the row cap is in the statement, not applied afterwards', () => {
  it('adds a cap when the caller asked for none', () => {
    expect(prepare('SELECT classname FROM students_data_set').sql).toMatch(/LIMIT 5001$/);
  });

  it('clamps a cap that is too large', () => {
    expect(prepare('SELECT classname FROM students_data_set LIMIT 1000000').sql).toMatch(
      /LIMIT 5001$/,
    );
  });

  it('leaves a smaller cap alone', () => {
    expect(prepare('SELECT classname FROM students_data_set LIMIT 10').sql).toMatch(/LIMIT 10$/);
  });

  it('clamps the row count and not the offset', () => {
    expect(prepare('SELECT classname FROM students_data_set LIMIT 20, 999999').sql).toMatch(
      /LIMIT 20, 5001$/,
    );
    expect(prepare('SELECT classname FROM students_data_set LIMIT 999999 OFFSET 20').sql).toMatch(
      /LIMIT 5001 OFFSET 20/,
    );
  });

  it('caps the union as a whole, where MySQL puts the trailing LIMIT', () => {
    const prepared = prepare(
      'SELECT classname FROM students_data_set UNION ALL SELECT classname FROM students_admission_data_set',
    );
    expect(prepared.sql).toMatch(/LIMIT 5001$/);
    expect(prepared.sql.match(/LIMIT/g)).toHaveLength(1);
  });

  it('requests one row beyond the cap, so truncation is observed', () => {
    expect(prepare('SELECT classname FROM students_data_set', { rowCap: 10 }).sql).toMatch(
      /LIMIT 11$/,
    );
  });
});

describe('docs/08 §4.5: domain permissions gate whole tables', () => {
  it('refuses a students table to a session holding only fees.read', () => {
    expect(codeOf(() => prepare('SELECT studentname FROM students_data_set', { perms: ['fees.read'] })))
      .toBe('PERMISSION_DENIED');
  });

  it('allows the fee tables to that same session', () => {
    expect(() =>
      prepare('SELECT paidamount FROM fee_collection_data_set', { perms: ['fees.read'] }),
    ).not.toThrow();
  });

  it('refuses staff data to a session without staff.read', () => {
    expect(
      codeOf(() => prepare('SELECT employeename FROM employees_data_set', { perms: ['fees.read'] })),
    ).toBe('PERMISSION_DENIED');
  });

  it('refuses a forbidden table reached through a join', () => {
    expect(
      codeOf(() =>
        prepare(
          'SELECT f.paidamount FROM fee_collection_data_set f JOIN students_data_set s ON s.enrollmentno = f.enrollmentno',
          { perms: ['fees.read'] },
        ),
      ),
    ).toBe('PERMISSION_DENIED');
  });
});

describe('predefined reports bind filters by name', () => {
  function prepareWithParams(sql: string, params: Record<string, string | number | null>) {
    return prepareSelect({
      sql,
      catalog: ERP_V1,
      tenantKey: 'stmarksmb',
      perms: ALL_PERMS,
      rowCap: 5000,
      declaredParams: params,
    });
  }

  it('binds a declared parameter alongside the tenant key', () => {
    const prepared = prepareWithParams(
      'SELECT classname FROM students_data_set WHERE academicyearname = :academic_year',
      { academic_year: '2026-27' },
    );
    expect(prepared.params).toEqual({
      [TENANT_PARAM]: 'stmarksmb',
      academic_year: '2026-27',
    });
    // Bound, never spliced: the value must not appear in the statement text.
    expect(prepared.sql).not.toContain('2026-27');
    expect(prepared.sql).toContain(':academic_year');
  });

  it('rejects a parameter the report did not declare', () => {
    expect(
      codeOf(() =>
        prepareWithParams('SELECT classname FROM students_data_set WHERE gender = :gender', {
          academic_year: '2026-27',
        }),
      ),
    ).toBe('SQL_REJECTED');
  });

  it('rejects a report trying to write into the tenant slot', () => {
    // A statement that could bind the tenant parameter could choose its school.
    expect(
      codeOf(() =>
        prepareWithParams(
          `SELECT classname FROM students_data_set WHERE school_db = :${TENANT_PARAM}`,
          { [TENANT_PARAM]: 'stmarksj' },
        ),
      ),
    ).toBe('SQL_REJECTED');
  });

  it('rejects parameters entirely when none were declared', () => {
    // run_query / run_multi take no parameters (docs/04 §2), so an unbound name
    // must not survive as far as the driver.
    expect(
      codeOf(() => prepare('SELECT classname FROM students_data_set WHERE gender = :g')),
    ).toBe('SQL_REJECTED');
  });

  it('binds only the parameters the statement actually uses', () => {
    const prepared = prepareWithParams('SELECT classname FROM students_data_set', {
      academic_year: '2026-27',
    });
    expect(prepared.params).toEqual({ [TENANT_PARAM]: 'stmarksmb' });
  });

  it('keeps the tenant filter when a report also filters', () => {
    const prepared = prepareWithParams(
      'SELECT classname FROM students_data_set WHERE academicyearname = :academic_year',
      { academic_year: '2026-27' },
    );
    expect(prepared.sql).toMatch(/WHERE `school_db` = :sap_tenant_key/);
  });
});

describe('the guard refuses output it cannot account for', () => {
  it('reports the tables it read, for the audit record', () => {
    const prepared = prepare(
      'SELECT s.classname FROM students_data_set s JOIN fee_compile_data_set f ON f.enrollmentno = s.enrollmentno',
    );
    expect([...prepared.tables].sort()).toEqual(['fee_compile_data_set', 'students_data_set']);
  });

  it('normalises table casing to the catalog spelling', () => {
    expect(prepare('SELECT classname FROM STUDENTS_DATA_SET').tables).toEqual([
      'students_data_set',
    ]);
  });

  it('produces a statement that re-parses — the postcondition is real', () => {
    // A rewrite that renders unparseable SQL is the failure mode the output
    // check exists for; if this ever regresses, prepareSelect throws rather
    // than handing the driver something it would reject at execution time.
    for (const sql of [
      'SELECT classname FROM students_data_set',
      'SELECT s.classname FROM students_data_set s JOIN fee_compile_data_set f ON f.enrollmentno = s.enrollmentno',
      'SELECT t.c FROM (SELECT COUNT(*) AS c FROM employees_data_set) t',
    ]) {
      expect(() => prepare(sql)).not.toThrow();
    }
  });
});
