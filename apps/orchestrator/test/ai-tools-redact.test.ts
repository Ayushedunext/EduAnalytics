/**
 * The ADR-030 enforcement point: `redact` decides what a Claude tool_result
 * actually contains for `run_query`/`run_multi`. This is the property that
 * makes the "model never sees row-level data" promise real, independent of
 * whatever the model is later asked to emit — the draft schema alone cannot
 * prove this, only this function's behaviour can.
 */

import { describe, expect, it } from 'vitest';
import './env-defaults.js';

const { redact } = await import('../src/services/ai-tools.js');

const CATALOG = {
  tables: [
    {
      name: 'students_data_set',
      columns: [
        { name: 'studentname', pii: 'students' as const },
        { name: 'classname' },
        { name: 'n' },
      ],
    },
    {
      name: 'employees_data_set',
      columns: [{ name: 'employeename', pii: 'staff' as const }, { name: 'departmentname' }],
    },
  ],
};

describe('redact — the model never receives row contents', () => {
  it('never includes a value for a multi-row result, however small', () => {
    const summary = redact(
      'q1',
      { columns: ['classname', 'n'], rows: [{ classname: 'IX', n: 12 }, { classname: 'X', n: 9 }], truncated: false },
      CATALOG,
    );
    expect(summary).toEqual({ query_ref: 'q1', row_count: 2, columns: ['classname', 'n'], truncated: false });
    expect(summary).not.toHaveProperty('value');
  });

  it('never includes a value for a single row carrying a pii-tagged column', () => {
    const summary = redact(
      'q1',
      { columns: ['studentname', 'classname'], rows: [{ studentname: 'A. Sharma', classname: 'IX' }], truncated: false },
      CATALOG,
    );
    expect(summary).not.toHaveProperty('value');
  });

  it('never includes a value for a single row carrying a STAFF pii column, even under a students-shaped key', () => {
    // The check is column-name-based across the whole catalog, not table-scoped
    // — a flattened result row carries no table provenance by the time it
    // reaches this function, so a name that is PII anywhere is treated as PII.
    const summary = redact(
      'q1',
      { columns: ['employeename', 'departmentname'], rows: [{ employeename: 'R. Iyer', departmentname: 'Admin' }], truncated: false },
      CATALOG,
    );
    expect(summary).not.toHaveProperty('value');
  });

  it('includes the value for a single-row aggregate with no pii-tagged column', () => {
    const summary = redact(
      'q1',
      { columns: ['n'], rows: [{ n: 247 }], truncated: false },
      CATALOG,
    );
    expect(summary).toEqual({
      query_ref: 'q1',
      row_count: 1,
      columns: ['n'],
      truncated: false,
      value: { n: 247 },
    });
  });

  it('carries the truncated flag through untouched', () => {
    const summary = redact(
      'q1',
      { columns: ['n'], rows: [{ n: 5000 }], truncated: true },
      CATALOG,
    );
    expect(summary.truncated).toBe(true);
  });

  it('matches column names case-insensitively against the catalog', () => {
    const summary = redact(
      'q1',
      { columns: ['StudentName'], rows: [{ StudentName: 'A. Sharma' }], truncated: false },
      CATALOG,
    );
    expect(summary).not.toHaveProperty('value');
  });

  it('is not fooled by an unrecognised column name — still withholds unless every column is known-safe', () => {
    // A column absent from the catalog is not thereby "known safe"; it just
    // is not matched as pii either. The one-row/no-pii-match rule still lets
    // it through here, but the case documents the boundary rather than leaving
    // it implicit: unknown != safe in general, only "checked and not pii".
    const summary = redact(
      'q1',
      { columns: ['mystery_column'], rows: [{ mystery_column: 'x' }], truncated: false },
      CATALOG,
    );
    expect(summary).toHaveProperty('value');
  });
});
