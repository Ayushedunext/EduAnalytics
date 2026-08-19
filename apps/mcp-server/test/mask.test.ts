/**
 * Tests for PII masking — docs/04 §3 rail 6, docs/08 §4.4/§4.5.
 *
 * The interesting property is not "names get replaced". It is that the decision
 * is made from the RESULT METADATA, so an alias cannot slip a masked column past
 * the check, and that a masked result says so — a number that quietly differs by
 * who asked is the success-shaped failure CODING_GUIDELINES §10 warns about.
 */

import { describe, expect, it } from 'vitest';
import type { FieldPacket } from 'mysql2';
import { MASKED_VALUE, maskRows } from '../src/sql/mask.js';
import { ERP_V1 } from '../src/schema/erp-v1.js';

/** Only the four properties masking reads; the rest of a FieldPacket is noise. */
function field(name: string, orgTable: string, orgName: string): FieldPacket {
  return { name, orgTable, orgName, table: orgTable } as unknown as FieldPacket;
}

const rows = [
  { studentname: 'A. Sharma', enrollmentno: '16598', balance_amount: 21950 },
  { studentname: 'B. Puri', enrollmentno: '17033', balance_amount: 1200 },
];
const fields = [
  field('studentname', 'fee_compile_data_set', 'studentname'),
  field('enrollmentno', 'fee_compile_data_set', 'enrollmentno'),
  field('balance_amount', 'fee_compile_data_set', 'balance_amount'),
];

describe('masking follows the session permissions, not the table', () => {
  it('leaves student PII alone for a session holding students.read', () => {
    const result = maskRows({ rows, fields, catalog: ERP_V1, perms: ['fees.read', 'students.read'] });
    expect(result.maskedColumns).toEqual([]);
    expect(result.rows[0]?.['studentname']).toBe('A. Sharma');
    // Nothing was masked, so the input is returned as-is rather than copied.
    expect(result.rows).toBe(rows);
  });

  it('masks student PII inside a FEE table for a fees-only session', () => {
    // The case that matters: an accountant is entitled to the fee row and not to
    // the person it names (docs/08 §4.5).
    const result = maskRows({ rows, fields, catalog: ERP_V1, perms: ['fees.read'] });
    expect([...result.maskedColumns].sort()).toEqual(['enrollmentno', 'studentname']);
    expect(result.rows[0]?.['studentname']).toBe(MASKED_VALUE);
    expect(result.rows[0]?.['enrollmentno']).toBe(MASKED_VALUE);
    expect(result.rows[0]?.['balance_amount']).toBe(21950);
  });

  it('does not mutate the caller’s rows', () => {
    const original = [{ studentname: 'A. Sharma' }];
    maskRows({
      rows: original,
      fields: [field('studentname', 'students_data_set', 'studentname')],
      catalog: ERP_V1,
      perms: [],
    });
    expect(original[0]?.['studentname']).toBe('A. Sharma');
  });
});

describe('masking traces columns by origin, not by output name', () => {
  it('masks an aliased PII column', () => {
    const result = maskRows({
      rows: [{ n: 'A. Sharma' }],
      fields: [field('n', 'students_data_set', 'studentname')],
      catalog: ERP_V1,
      perms: ['fees.read'],
    });
    expect(result.maskedColumns).toEqual(['n']);
    expect(result.rows[0]?.['n']).toBe(MASKED_VALUE);
  });

  it('does not mask a non-PII column that happens to be named like one', () => {
    // `school_name` is reference data. An output column called `studentname`
    // sourced from it is not student PII, and masking by output name would get
    // this backwards.
    const result = maskRows({
      rows: [{ studentname: 'Meera Bagh' }],
      fields: [field('studentname', 'schools_data_set', 'school_name')],
      catalog: ERP_V1,
      perms: [],
    });
    expect(result.maskedColumns).toEqual([]);
  });

  it('leaves computed columns alone — they report no origin', () => {
    const result = maskRows({
      rows: [{ total: 3 }],
      fields: [field('total', '', '')],
      catalog: ERP_V1,
      perms: [],
    });
    expect(result.maskedColumns).toEqual([]);
  });

  it('masks staff PII independently of student PII', () => {
    const staffFields = [field('employeename', 'employees_data_set', 'employeename')];
    const staffRows = [{ employeename: 'P. Nair' }];

    expect(
      maskRows({ rows: staffRows, fields: staffFields, catalog: ERP_V1, perms: ['students.read'] })
        .maskedColumns,
    ).toEqual(['employeename']);

    expect(
      maskRows({ rows: staffRows, fields: staffFields, catalog: ERP_V1, perms: ['staff.read'] })
        .maskedColumns,
    ).toEqual([]);
  });
});
