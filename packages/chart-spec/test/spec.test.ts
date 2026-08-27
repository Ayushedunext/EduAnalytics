import { describe, expect, it } from 'vitest';
import {
  validateChartSpec,
  validateChartSpecDraft,
  assertNoInlineData,
  findDuplicateWidgetIds,
  type ChartSpec,
} from '../src/index.js';

const meta = {
  scope: [{ school_id: 'stmarksmb', school_name: 'Meera Bagh' }],
  generated_at: '2026-08-19T09:00:00.000Z',
  served_from: 'replica' as const,
};

const spec: ChartSpec = {
  spec_version: 1,
  title: 'Fee Collection',
  narrative: 'Collections are tracking ahead of last year.',
  widgets: [
    { id: 'k1', type: 'kpi', label: 'Collected', value: '₹215.4 cr' },
    {
      id: 'b1',
      type: 'bar',
      x: 'fee_month',
      y: 'paid',
      data: [{ fee_month: 'Apr', paid: 1200000 }],
      drillable: true,
      drill_dim: 'month',
    },
    {
      id: 't1',
      type: 'table',
      columns: [{ field: 'classname', label: 'Class' }],
      rows: [{ classname: 'IX' }],
    },
  ],
  meta,
};

describe('chart-spec round trip (CODING §14 contract test)', () => {
  it('accepts a valid hydrated spec', () => {
    const r = validateChartSpec(spec);
    expect(r.ok).toBe(true);
  });

  it('survives JSON round-tripping -- specs are persisted and re-read (ADR-018)', () => {
    const r = validateChartSpec(JSON.parse(JSON.stringify(spec)));
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown widget type instead of skipping it', () => {
    const r = validateChartSpec({
      ...spec,
      widgets: [{ id: 'x', type: 'heatmap', data: [] }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a spec with no widgets', () => {
    expect(validateChartSpec({ ...spec, widgets: [] }).ok).toBe(false);
  });

  it('requires scope in meta -- scope is always on screen (docs/10 §3)', () => {
    const { scope: _drop, ...noScope } = meta;
    expect(validateChartSpec({ ...spec, meta: noScope }).ok).toBe(false);
  });

  it('rejects a drill context deeper than 3 levels (ADR-020 hard cap)', () => {
    const r = validateChartSpec({
      ...spec,
      widgets: [
        {
          id: 'b1',
          type: 'bar',
          x: 'a',
          y: 'b',
          data: [],
          drill_context: [
            { dim: 'month', value: 'Apr' },
            { dim: 'class', value: 'IX' },
            { dim: 'fee_type', value: 'Tuition' },
            { dim: 'student', value: 'X' },
          ],
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('never throws on hostile input -- a half-render is worse than an error', () => {
    for (const bad of [null, undefined, 42, 'nope', [], { widgets: 'no' }]) {
      expect(() => validateChartSpec(bad)).not.toThrow();
      expect(validateChartSpec(bad).ok).toBe(false);
    }
  });

  it('detects duplicate widget ids', () => {
    expect(findDuplicateWidgetIds([spec.widgets[0]!, spec.widgets[0]!])).toEqual(['k1']);
  });
});

describe('server-side hydration (AUDIT_REPORT C15)', () => {
  it('accepts a draft that references a query instead of carrying data', () => {
    const r = validateChartSpecDraft({
      spec_version: 1,
      title: 'Fee Collection',
      widgets: [{ id: 'b1', type: 'bar', x: 'fee_month', y: 'paid', query_ref: 'q1' }],
    });
    expect(r.ok).toBe(true);
  });

  it('REJECTS a model-emitted draft carrying inline data rows', () => {
    // The privacy property: student rows must never pass through the model.
    const withData = {
      spec_version: 1,
      title: 'Fee Collection',
      widgets: [
        { id: 'b1', type: 'bar', x: 'fee_month', y: 'paid', data: [{ fee_month: 'Apr' }] },
      ],
    };
    expect(validateChartSpecDraft(withData).ok).toBe(false);
    expect(assertNoInlineData(withData).ok).toBe(false);
  });

  it('assertNoInlineData passes a clean draft', () => {
    expect(
      assertNoInlineData({
        widgets: [{ id: 'b1', type: 'bar', query_ref: 'q1' }],
      }).ok,
    ).toBe(true);
  });
});
