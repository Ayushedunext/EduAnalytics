/**
 * The ADR-030 enforcement point for Insights.
 *
 * `digestOf` is the entire surface the model sees when a reader asks "explain
 * this chart" — there is no tool loop on that path, so whatever this function
 * returns IS the context sent to the organisation's provider account. The
 * promise "aggregates, never rows" is made real here and nowhere else, which is
 * why it is asserted here rather than left to the prompt or the schema.
 *
 * The table cases are the ones that matter. In this catalog the per-person data
 * (defaulters, students, staff, late payers) is always a TABLE, so "a table
 * contributes shape and column aggregates and never a cell" is what keeps
 * student names out of the provider's logs.
 */

import { describe, expect, it } from 'vitest';
import './env-defaults.js';
import type { Widget } from '@sap/chart-spec';

const { digestOf } = await import('../src/services/ai-insights.js');

/** A table of exactly the kind the platform builds for defaulters. */
const DEFAULTERS: Widget = {
  id: 'table-defaulters',
  type: 'table',
  title: 'Fee defaulters',
  columns: [
    { field: 'student', label: 'Student', masked: true },
    { field: 'enrollment', label: 'Enrolment' },
    { field: 'pending', label: 'Pending' },
  ],
  rows: [
    { student: 'Abhishek Gupta', enrollment: 'EN-1001', pending: 42000 },
    { student: 'Eshanya Taneja', enrollment: 'EN-1002', pending: 18500 },
    { student: 'Swarnim Shareek', enrollment: 'EN-1003', pending: 9000 },
  ],
};

const MONTHLY: Widget = {
  id: 'line-month',
  type: 'line',
  title: 'Fee collected each month',
  x: 'month',
  y: 'received',
  x_title: 'Month',
  y_title: 'Received (₹)',
  data: [
    { month: 'Apr', received: 100 },
    { month: 'May', received: 400 },
    { month: 'Jun', received: 250 },
  ],
};

describe('digestOf — the model receives aggregates, never rows', () => {
  it('carries no cell value from a table, not even a number', () => {
    const digest = digestOf(DEFAULTERS);
    const serialised = JSON.stringify(digest);

    for (const name of ['Abhishek Gupta', 'Eshanya Taneja', 'Swarnim Shareek']) {
      expect(serialised).not.toContain(name);
    }
    for (const enrolment of ['EN-1001', 'EN-1002', 'EN-1003']) {
      expect(serialised).not.toContain(enrolment);
    }
    /**
     * The middle row's amount is the one that proves the property: a digest
     * that leaked the SERIES of values would carry it. Only the total and the
     * two extremes may leave, which is ADR-030's own sanctioned list ("count,
     * sum, min/max") — so 42,000 does appear, as this column's maximum, and it
     * appears attached to nothing. "The largest balance is ₹42,000" is a
     * statistic; it becomes a record only if a name travels with it, and no
     * name does.
     */
    expect(serialised).not.toContain('18500');
    expect(digest.table?.row_count).toBe(3);
  });

  it('carries no per-row list for a numeric column — only the three aggregates', () => {
    const digest = digestOf(DEFAULTERS);
    for (const column of digest.table?.numeric_columns ?? []) {
      expect(Object.keys(column).sort()).toEqual(['highest', 'label', 'lowest', 'total']);
    }
  });

  it('names a table’s columns and which of them are masked', () => {
    const digest = digestOf(DEFAULTERS);
    expect(digest.table?.columns).toEqual(['Student', 'Enrolment', 'Pending']);
    expect(digest.table?.masked_columns).toEqual(['Student']);
  });

  it('aggregates a numeric column and refuses a column of names', () => {
    const digest = digestOf(DEFAULTERS);
    const labels = (digest.table?.numeric_columns ?? []).map((c) => c.label);
    expect(labels).toEqual(['Pending']);
    expect(digest.table?.numeric_columns[0]).toEqual({
      label: 'Pending',
      total: 69500,
      highest: 42000,
      lowest: 9000,
    });
  });

  it('reduces a line chart to count, total and the extremes, with their labels', () => {
    const digest = digestOf(MONTHLY);
    expect(digest.series?.[0]).toEqual({
      name: 'Received (₹)',
      points: 3,
      total: 750,
      highest: { label: 'May', value: 400 },
      lowest: { label: 'Apr', value: 100 },
      first: { label: 'Apr', value: 100 },
      last: { label: 'Jun', value: 250 },
    });
    /* The axis labels travel: they are institutional dimensions, and an
       insight that could not name a month would be useless. */
    expect(digest.categories).toEqual(['Apr', 'May', 'Jun']);
    expect(digest.x_means).toBe('Month');
  });

  it('turns a donut into shares rather than values', () => {
    const digest = digestOf({
      id: 'donut-mode',
      type: 'donut',
      title: 'Payment modes',
      label_field: 'mode',
      value_field: 'amount',
      data: [
        { mode: 'Online', amount: 70 },
        { mode: 'Cash', amount: 30 },
      ],
    });
    expect(digest.slices).toEqual([
      { label: 'Online', share_pct: 70 },
      { label: 'Cash', share_pct: 30 },
    ]);
  });

  it('passes a KPI through as the pre-formatted figure the tile already prints', () => {
    const digest = digestOf({
      id: 'ring-realisation',
      type: 'kpi',
      label: 'Fee realisation',
      value: '53.0%',
      breakdown: [
        { label: 'Collected', value: '₹48.8Cr' },
        { label: 'Outstanding', value: '₹43.2Cr' },
      ],
    });
    expect(digest.figure).toEqual({
      label: 'Fee realisation',
      value: '53.0%',
      parts: [
        { label: 'Collected', value: '₹48.8Cr' },
        { label: 'Outstanding', value: '₹43.2Cr' },
      ],
    });
  });

  it('says when the base is thin, so the model cannot write over it confidently', () => {
    const thin = digestOf({ ...MONTHLY, data: [{ month: 'Apr', received: 100 }] } as Widget);
    expect(thin.caveats.join(' ')).toContain('thin base');

    const empty = digestOf({ ...MONTHLY, data: [] } as Widget);
    expect(empty.caveats.join(' ')).toContain('nothing to plot');
  });

  it('says when a table was cut off at the row cap', () => {
    const digest = digestOf({ ...DEFAULTERS, truncated: true } as Widget);
    expect(digest.table?.truncated).toBe(true);
    expect(digest.caveats.join(' ')).toContain('row cap');
  });
});
