/**
 * The drill-down EDITOR contract (docs/06 §3's visual editor, §4.1's definition
 * model, §4.3's "clones may change or disable the path").
 *
 * What is worth testing here, and why:
 *
 *   1. The editor is offered exactly the choices the server will accept. The
 *      dimensions come from the curated catalog and are never a choice at all
 *      (ADR-020); the chart options per level are computed once and used both
 *      to render the select and to check a save, so a level can never be shown
 *      an option that the next save refuses.
 *   2. A level that DRILLS stays clickable. Only cartesian charts carry a
 *      category click (react/widgets.tsx), so a donut may only ever land on a
 *      leaf — and only on a path with one measure, where the slices really are
 *      parts of one whole. Getting this wrong produces a chart that looks
 *      drillable and does nothing, the success-shaped failure §10 names.
 *   3. A stored choice the catalog can no longer honour degrades to the
 *      catalog's own chart rather than being echoed back. Paths change under
 *      saved reports; a report saved with a donut leaf must keep opening.
 *   4. Turning drill OFF actually removes the affordance, and the swap between
 *      chart types carries the drill fields — `drillable` without `drill_dim`
 *      is an unrenderable widget, so half a swap is a broken report.
 *
 * Pure: no MCP, no registry, no database. Everything here is the catalog plus
 * one already-built widget.
 */

import './env-defaults.js';
import { describe, expect, it } from 'vitest';
import { PlatformError } from '@sap/shared';
import type { BarWidget, Widget } from '@sap/chart-spec';
import { applyLevelChart, describeDrillPath, drillMeasureCount } from '../src/services/drill.js';

const CORRELATION = 'test-correlation';

/** A level as `buildDrill` emits one: a bar, single measure, still drillable. */
function levelWidget(overrides: Partial<BarWidget> = {}): BarWidget {
  return {
    id: 'bar-school',
    type: 'bar',
    title: 'Fee collected by school',
    x: 'school_name',
    y: 'collected',
    data: [
      { school_name: 'St Marks', school_id: 's1', collected: 120 },
      { school_name: 'Meera Bagh', school_id: 's2', collected: 90 },
    ],
    drillable: true,
    drill_dim: 'school',
    drill_value_field: 'school_id',
    drill_context: [],
    ...overrides,
  } as BarWidget;
}

describe('the editor is shown the curated path, and only the choices it may make', () => {
  it('describes every level of a real path, in order, with its group-by', () => {
    const view = describeDrillPath({ reportId: 'fee-collection', enabled: true });

    expect(view.available).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view.widget_id).toBe('bar-school');
    expect(view.levels.map((l) => l.n)).toEqual([1, 2, 3]);
    /* The dimension is the catalog's own `group_by` — the editor renders it, it
       never composes one (ADR-015 applied to a control). */
    expect(view.levels.every((l) => l.dim.length > 0)).toBe(true);
  });

  it('names the dimensions a level inherits, so a click reads as a narrowing', () => {
    const view = describeDrillPath({ reportId: 'fee-collection', enabled: true });

    expect(view.levels[0]?.inherit).toEqual([]);
    /* Level 3 arrives having bound whatever levels 1 and 2 pushed. */
    expect(view.levels[2]?.inherit.length).toBe(2);
    expect(view.levels[2]?.inherit).toEqual([
      view.levels[0]?.drills_on,
      view.levels[1]?.drills_on,
    ]);
  });

  it('marks the leaf as the one level that does not drill', () => {
    const view = describeDrillPath({ reportId: 'fee-collection', enabled: true });

    expect(view.levels[0]?.drills_on).not.toBeNull();
    expect(view.levels[1]?.drills_on).not.toBeNull();
    expect(view.levels[2]?.drills_on).toBeNull();
  });

  it('offers a level that drills only the charts a click still works on', () => {
    const view = describeDrillPath({ reportId: 'fee-collection', enabled: true });

    for (const level of view.levels.filter((l) => l.drills_on !== null)) {
      expect(level.chart_options).toEqual(['bar', 'line']);
      expect(level.chart_options).not.toContain('donut');
    }
  });

  it('offers a donut on a single-measure leaf, and never on a multi-measure one', () => {
    /* Fee Collection draws demand, collection and pending together: three
       totals that are not parts of one whole, so a pie of them would be a lie
       about what its slices add up to. */
    expect(drillMeasureCount('fee-collection')).toBeGreaterThan(1);
    const grouped = describeDrillPath({ reportId: 'fee-collection', enabled: true });
    expect(grouped.levels.at(-1)?.chart_options).not.toContain('donut');

    /* Trend Analysis draws one measure, so its leaf really does decompose. */
    expect(drillMeasureCount('trend-analysis')).toBe(1);
    const single = describeDrillPath({ reportId: 'trend-analysis', enabled: true });
    expect(single.levels.at(-1)?.drills_on).toBeNull();
    expect(single.levels.at(-1)?.chart_options).toContain('donut');
  });

  it('defaults every level to the bar the server actually emits', () => {
    const view = describeDrillPath({ reportId: 'fee-collection', enabled: true });
    expect(view.levels.map((l) => l.chart)).toEqual(['bar', 'bar', 'bar']);
  });

  it('reports a source with no curated path as unavailable, not as absent', () => {
    /* A report whose base has no path still gets a described block, so the
       editor can say WHY drill-down is off rather than silently dropping the
       control and leaving a reader to conclude the feature is broken. */
    const view = describeDrillPath({ reportId: 'library-textbooks', enabled: true });

    expect(view.available).toBe(false);
    expect(view.enabled).toBe(false);
    expect(view.levels).toEqual([]);
  });

  it('gives a widget-scoped clone a path only if it kept the widget that drills', () => {
    const kept = describeDrillPath({
      reportId: 'fee-collection',
      widgetScope: 'bar-school',
      enabled: true,
    });
    expect(kept.available).toBe(true);

    const other = describeDrillPath({
      reportId: 'fee-collection',
      widgetScope: 'donut-mode',
      enabled: true,
    });
    expect(other.available).toBe(false);
    expect(other.enabled).toBe(false);
  });

  it('honours a clone that switched its path off', () => {
    const view = describeDrillPath({ reportId: 'fee-collection', enabled: false });

    expect(view.available).toBe(true);
    expect(view.enabled).toBe(false);
    /* The levels are still described: the editor has to draw the path it is
       offering to switch back ON. */
    expect(view.levels).toHaveLength(3);
  });
});

describe('a stored chart choice is honoured, or dropped — never echoed back unusable', () => {
  it('applies a level chart the level can be drawn as', () => {
    const view = describeDrillPath({
      reportId: 'fee-collection',
      enabled: true,
      charts: { '2': 'line' },
    });

    expect(view.levels[1]?.chart).toBe('line');
    /* Untouched levels keep following the catalog rather than a stored copy. */
    expect(view.levels[0]?.chart).toBe('bar');
    expect(view.levels[2]?.chart).toBe('bar');
  });

  it('drops a donut stored against a level that drills', () => {
    const view = describeDrillPath({
      reportId: 'fee-collection',
      enabled: true,
      charts: { '1': 'donut' },
    });

    expect(view.levels[0]?.chart).toBe('bar');
  });

  it('drops a donut whose path has since grown a second measure', () => {
    /* Fee Collection's leaf carries three measures today. A report saved when
       a path had one must open on a bar, not fail. */
    const view = describeDrillPath({
      reportId: 'fee-collection',
      enabled: true,
      charts: { '3': 'donut' },
    });

    expect(view.levels[2]?.chart).toBe('bar');
    expect(view.levels[2]?.chart_options).not.toContain('donut');
  });
});

describe('drawing a produced level as something other than a bar', () => {
  it('carries the drill fields across a bar to line swap', () => {
    const swapped = applyLevelChart({
      widget: levelWidget(),
      chart: 'line',
      measures: 1,
      correlationId: CORRELATION,
    });

    expect(swapped.type).toBe('line');
    /* `drillable` without `drill_dim` is an invalid widget — half a swap would
       turn a chart-type choice into an unrenderable report. */
    expect(swapped).toMatchObject({
      drillable: true,
      drill_dim: 'school',
      drill_value_field: 'school_id',
    });
    expect((swapped as { data: unknown[] }).data).toHaveLength(2);
  });

  it('turns a single-measure leaf into a donut over the same rows', () => {
    const leaf = levelWidget({ drillable: false });
    delete (leaf as Partial<BarWidget>).drill_dim;
    delete (leaf as Partial<BarWidget>).drill_value_field;

    const swapped = applyLevelChart({
      widget: leaf,
      chart: 'donut',
      measures: 1,
      correlationId: CORRELATION,
    });

    expect(swapped).toMatchObject({
      type: 'donut',
      label_field: 'school_name',
      value_field: 'collected',
    });
  });

  it('refuses to draw a level that still drills as a donut', () => {
    /* A pie carries no category axis to click, so this would render a chart
       that says it drills and cannot. Unchanged is the honest answer. */
    const widget = levelWidget();
    const result = applyLevelChart({
      widget,
      chart: 'donut',
      measures: 1,
      correlationId: CORRELATION,
    });

    expect(result).toBe(widget);
  });

  it('refuses to draw a multi-measure level as a donut', () => {
    const leaf = levelWidget({ drillable: false });
    const result = applyLevelChart({
      widget: leaf,
      chart: 'donut',
      measures: 3,
      correlationId: CORRELATION,
    });

    expect(result).toBe(leaf);
  });

  it('leaves a level alone when no chart was chosen, or when it is already that chart', () => {
    const widget = levelWidget();
    expect(applyLevelChart({ widget, chart: undefined, measures: 1, correlationId: CORRELATION })).toBe(widget);
    expect(applyLevelChart({ widget, chart: 'bar', measures: 1, correlationId: CORRELATION })).toBe(widget);
  });

  it('validates what it produced rather than trusting that it built it', () => {
    /* A widget assembled from a catalog table and a result set is still an
       assembled object (§10). A bar with no y field cannot become a valid
       donut, and the failure must be a structured error, not a broken chart. */
    const broken = { ...levelWidget({ drillable: false }), y: '' } as unknown as Widget;

    expect(() =>
      applyLevelChart({ widget: broken, chart: 'donut', measures: 1, correlationId: CORRELATION }),
    ).toThrow(PlatformError);
  });
});
