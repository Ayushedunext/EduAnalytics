/**
 * The two additions Comparative Analysis made to the contract, and the rules
 * that keep them from being misused.
 *
 * Both are ADDITIVE attributes on widgets that already existed — `bar.stacked`
 * and `tableColumn.sort_field` — rather than new widget types, which is what
 * keeps them inside ADR-015's closed vocabulary. The point of testing them is
 * that both failures are SILENT on screen:
 *
 *   - a `stacked` bar with one measure draws as an ordinary bar while claiming
 *     to show a partition, and nothing about the picture says otherwise;
 *   - a `sort_field` naming a column that is not on the rows sorts everything
 *     into one arbitrary order, which looks exactly like a sorted table.
 *
 * The first is enforced by the schema and asserted here. The second cannot be
 * (the schema sees a field NAME, never the rows a renderer will read), so the
 * emitter is what guarantees it — apps/orchestrator/test/comparative.test.ts
 * asserts every sort key it names is really on the rows it sends.
 */

import { describe, expect, it } from 'vitest';
import { validateChartSpec, type ChartSpec } from '../src/index.js';

const meta = {
  scope: [{ school_id: 'stmarksmb', school_name: 'Meera Bagh' }],
  generated_at: '2026-08-31T09:00:00.000Z',
  served_from: 'replica' as const,
};

/** Comparative Analysis' recovery timeline, as services/dashboards.ts builds it. */
const stackedBar = {
  id: 'bar-timeline',
  type: 'bar' as const,
  title: "When this year's money arrived",
  x: 'school_name',
  y: 'advance',
  stacked: true,
  series: [
    { field: 'advance', label: 'Paid in advance' },
    { field: 'same_month', label: 'Paid in the due month' },
    { field: 'pending', label: 'Still pending' },
  ],
  data: [{ school_name: 'Meera Bagh', advance: 20, same_month: 60, pending: 20 }],
};

function specWith(widget: unknown): unknown {
  return { spec_version: 1, title: 'Comparative Analysis', widgets: [widget], meta } satisfies Omit<
    ChartSpec,
    'widgets'
  > & { widgets: unknown[] };
}

describe('stacked bars', () => {
  it('accepts a stack of several measures', () => {
    expect(validateChartSpec(specWith(stackedBar)).ok).toBe(true);
  });

  it('rejects a stack with nothing to stack', () => {
    /**
     * One measure has no other part to sit on, so a stacked single-series bar
     * makes a claim it cannot support — and the renderer would draw it as an
     * ordinary bar without saying so.
     */
    const { series, ...lonely } = stackedBar;
    const outcome = validateChartSpec(specWith(lonely));
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).toContain('series');
  });

  it('leaves an unstacked grouped bar exactly as it was', () => {
    const { stacked, ...grouped } = stackedBar;
    expect(validateChartSpec(specWith(grouped)).ok).toBe(true);
  });

  it('still requires the first series to be the widget’s y', () => {
    /** The grouped-bar rule did not stop applying because the bars now stack. */
    expect(validateChartSpec(specWith({ ...stackedBar, y: 'pending' })).ok).toBe(false);
  });

  it('carries no colours — the renderer assigns them from the palette', () => {
    /**
     * A spec that could pin a hex would let a saved report outlive a palette
     * audit. Asserted as a schema fact, not a convention: `.strict()` refuses
     * the field outright.
     */
    const painted = {
      ...stackedBar,
      series: stackedBar.series.map((s) => ({ ...s, colour: '#ff0000' })),
    };
    expect(validateChartSpec(specWith(painted)).ok).toBe(false);
  });
});

describe('a table column can name where its sortable value lives', () => {
  const table = {
    id: 'table-school',
    type: 'table' as const,
    columns: [
      { field: 'school_name', label: 'School' },
      { field: 'payable', label: 'Demand raised', align: 'right' as const, sort_field: 'payable_n' },
    ],
    rows: [{ school_name: 'Meera Bagh', payable: '₹2.4 Cr', payable_n: 24_000_000 }],
  };

  it('accepts a column whose display value and sort value differ', () => {
    expect(validateChartSpec(specWith(table)).ok).toBe(true);
  });

  it('accepts a column with no sort key at all — text sorts on what it shows', () => {
    const plain = { ...table, columns: [table.columns[0]] };
    expect(validateChartSpec(specWith(plain)).ok).toBe(true);
  });

  it('refuses a sort key that would pollute the prototype chain', () => {
    /**
     * The same guard every other field name in a spec gets. A hand-edited
     * custom report is allowed to alias columns (ADR-019), and `__proto__` as a
     * row key is a cross-tenant problem in a shared orchestrator rather than a
     * local one.
     */
    const poisoned = {
      ...table,
      columns: [table.columns[0], { ...table.columns[1], sort_field: '__proto__' }],
    };
    expect(validateChartSpec(specWith(poisoned)).ok).toBe(false);
  });
});
