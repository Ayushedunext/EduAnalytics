/**
 * The two cross-field rules grouped bars and drill-down added to the contract
 * (spec.ts, `checkWidgetInvariants`).
 *
 * They are cross-FIELD, so `.strict()` cannot state them and a type cannot
 * either — which makes them exactly the kind of rule that quietly stops being
 * true. Asserted here rather than trusted, because both failures are silent on
 * screen: a bar whose `y` is not among its drawn series renders three bars and
 * a wrong highlight, and a `drillable` widget with no dimension renders a
 * pointer cursor over a click that can never resolve.
 */

import { describe, expect, it } from 'vitest';
import { validateChartSpec, widgetSchema, type ChartSpec } from '../src/index.js';

const meta = {
  scope: [{ school_id: 'stmarksmb', school_name: 'Meera Bagh' }],
  generated_at: '2026-08-27T09:00:00.000Z',
  served_from: 'replica' as const,
};

/** The Fee Collection level-1 chart, as services/dashboards.ts builds it. */
const groupedBar = {
  id: 'bar-school',
  type: 'bar' as const,
  title: 'Demand, collection and pending by school',
  x: 'school_name',
  y: 'payable',
  series: [
    { field: 'payable', label: 'Fee payable' },
    { field: 'collected', label: 'Fee collected' },
    { field: 'pending', label: 'Fee pending' },
  ],
  data: [{ school_id: 'stmarksmb', school_name: 'Meera Bagh', payable: 100, collected: 60, pending: 40 }],
  drillable: true,
  drill_dim: 'school',
  drill_value_field: 'school_id',
  drill_context: [],
};

function specWith(widget: unknown): unknown {
  return { spec_version: 1, title: 'Fee Collection', widgets: [widget], meta } satisfies Omit<
    ChartSpec,
    'widgets'
  > & { widgets: unknown[] };
}

describe('grouped bar series', () => {
  it('accepts a three-measure grouped bar', () => {
    expect(validateChartSpec(specWith(groupedBar)).ok).toBe(true);
  });

  it('still accepts a single-series bar with no series field at all', () => {
    const { series, drillable, drill_dim, drill_value_field, drill_context, ...single } = groupedBar;
    expect(validateChartSpec(specWith(single)).ok).toBe(true);
  });

  it("rejects a series list whose first entry is not the widget's y", () => {
    const result = validateChartSpec(
      specWith({ ...groupedBar, y: 'collected' }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a one-entry series — that is a single-series bar, not a group', () => {
    expect(
      validateChartSpec(specWith({ ...groupedBar, series: [{ field: 'payable', label: 'Fee payable' }] }))
        .ok,
    ).toBe(false);
  });

  it('rejects a series colour: colour is presentation, never carried in a spec', () => {
    expect(
      validateChartSpec(
        specWith({
          ...groupedBar,
          series: [
            { field: 'payable', label: 'Fee payable', colour: '#028090' },
            { field: 'collected', label: 'Fee collected' },
          ],
        }),
      ).ok,
    ).toBe(false);
  });
});

describe('drillable widgets name their dimension (ADR-020)', () => {
  it('rejects drillable without drill_dim', () => {
    const { drill_dim, ...noDim } = groupedBar;
    expect(validateChartSpec(specWith(noDim)).ok).toBe(false);
  });

  it('rejects a drillable donut without drill_dim, not only a bar', () => {
    const donut = {
      id: 'donut-mode',
      type: 'donut',
      label_field: 'paymenttype',
      value_field: 'collected',
      data: [{ paymenttype: 'Cash', collected: 10 }],
      drillable: true,
    };
    expect(validateChartSpec(specWith(donut)).ok).toBe(false);
  });

  it('accepts an explicitly non-drillable leaf', () => {
    expect(
      validateChartSpec(
        specWith({
          id: 'bar-school',
          type: 'bar',
          x: 'classname',
          y: 'payable',
          series: groupedBar.series,
          data: [{ classname: 'IX', payable: 1, collected: 1, pending: 0 }],
          drillable: false,
          drill_context: [
            { dim: 'school', value: 'stmarksmb' },
            { dim: 'quarter', value: '2' },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it('caps the drill context at the three levels ADR-020 allows', () => {
    const four = ['a', 'b', 'c', 'd'].map((value) => ({ dim: 'class', value }));
    expect(
      widgetSchema.safeParse({ ...groupedBar, drill_context: four }).success,
    ).toBe(false);
  });
});
