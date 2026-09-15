/**
 * What reaches the paper.
 *
 * A PDF outlives the session that made it: it gets forwarded, printed, filed
 * and read months later by someone who cannot ask the screen a question. So the
 * decisions about what appears on it — which schools it claims to cover, which
 * filters were bound, whether the SQL appendix prints — are worth testing, even
 * though whether Chromium can draw a donut is not.
 *
 * No browser is launched here. `buildPrintPayload` is the seam: pure input to
 * pure output, which is exactly the part that carries the meaning.
 */

import { describe, expect, it } from 'vitest';
import './env-defaults.js';
import { PlatformError } from '@sap/shared';
import type { DashboardResult } from '../src/services/dashboards.js';

const { buildPrintPayload, escapeHtml, narrowToWidget } = await import('../src/services/pdf.js');

const DASHBOARD = {
  spec: {
    spec_version: 1,
    title: 'Fee Defaulters',
    widgets: [{ id: 'kpi', type: 'kpi', label: 'Overdue', value: '₹30.6L' }],
    meta: {
      scope: [{ school_id: 'stmarksmb', school_name: 'Meera Bagh' }],
      generated_at: '2026-08-21T04:00:00.000Z',
      served_from: 'cache',
    },
  },
  logic: {
    source: 'fee_compile_data_set',
    scope: [{ school_id: 'stmarksmb', school_name: 'Meera Bagh' }],
    filters: [
      { label: 'Academic year', value: '2026-27' },
      { label: 'As of', value: '2026-08-21' },
    ],
    group_by: ['aging band', 'class'],
    charts: ['kpi', 'bar'],
    queries: [{ key: 'totals', description: 'Overdue total', sql: 'SELECT 1' }],
    notes: ['A student is counted as a defaulter when…'],
  },
  degraded: [],
  degraded_schools: [],
} as unknown as DashboardResult;

const BASE = {
  dashboard: DASHBOARD,
  title: 'Fee Defaulters',
  orgName: 'St Marks Society',
  scopeLine: 'Meera Bagh',
  includeLogic: false,
};

describe('every export says what it is about', () => {
  const payload = buildPrintPayload(BASE, '2026-08-21T05:00:00.000Z');

  it('names the org, the report and the schools', () => {
    expect(payload.org_name).toBe('St Marks Society');
    expect(payload.title).toBe('Fee Defaulters');
    // docs/06 §5 and docs/10 §3: a printed number without a subject is not a
    // report. The scope line is not optional and has no "all schools" shorthand.
    expect(payload.scope_line).toBe('Meera Bagh');
  });

  it('carries the filters that were actually bound, not a fixed set', () => {
    expect(payload.filters).toEqual([
      { label: 'Academic year', value: '2026-27' },
      { label: 'As of', value: '2026-08-21' },
    ]);
  });

  it('stamps when it was generated', () => {
    expect(payload.generated_at).toBe('2026-08-21T05:00:00.000Z');
  });

  it('renders the same spec the screen rendered', () => {
    // ADR-021: one spec, one renderer. If the export ever transformed the spec
    // on its way to the page, the PDF could disagree with the screen.
    expect(payload.spec).toBe(DASHBOARD.spec);
  });
});

/**
 * ChartMenu's per-chart "Print" (docs/06 §5, ADR-021 extension 2026-09-15):
 * `?widget_id=` reduces the already-rebuilt spec to one widget before it
 * reaches the print route.
 */
describe('narrowToWidget — Print, one chart at a time', () => {
  const spec = {
    spec_version: 1,
    title: 'Fee Defaulters',
    narrative: 'Overdue balances rose 4% against last quarter.',
    widgets: [
      { id: 'kpi', type: 'kpi', label: 'Overdue', value: '₹30.6L' },
      { id: 'bar', type: 'bar', title: 'Overdue by age', x: 'band', y: 'amount', data: [] },
    ],
    meta: DASHBOARD.spec.meta,
  } as unknown as DashboardResult['spec'];

  it('keeps only the named widget and takes its title as the document title', () => {
    const narrowed = narrowToWidget(spec, 'bar');
    expect(narrowed.widgets).toHaveLength(1);
    expect(narrowed.widgets[0]).toEqual(spec.widgets[1]);
    expect(narrowed.title).toBe('Overdue by age');
  });

  it('falls back to the report title when the widget has none of its own', () => {
    expect(narrowToWidget(spec, 'kpi').title).toBe('Fee Defaulters');
  });

  it('drops the narrative — it is the REPORT’s summary, not this chart’s', () => {
    expect(narrowToWidget(spec, 'kpi')).not.toHaveProperty('narrative');
  });

  it('refuses a widget id this report does not have, rather than printing an empty page', () => {
    expect(() => narrowToWidget(spec, 'missing')).toThrow(PlatformError);
  });

  it('leaves buildPrintPayload drawing the whole report when no widget id is given', () => {
    const payload = buildPrintPayload({ ...BASE, dashboard: { ...DASHBOARD, spec } }, 'now');
    expect(payload.spec).toBe(spec);
    expect(payload.title).toBe(BASE.title);
  });

  it('narrows buildPrintPayload’s own spec and title when a widget id is given', () => {
    const payload = buildPrintPayload(
      { ...BASE, dashboard: { ...DASHBOARD, spec }, widgetId: 'bar' },
      'now',
    );
    expect(payload.spec.widgets).toEqual([spec.widgets[1]]);
    expect(payload.title).toBe('Overdue by age');
  });
});

describe('the SQL appendix is opt-in', () => {
  it('is absent unless asked for', () => {
    expect(buildPrintPayload(BASE, 'now')).not.toHaveProperty('logic');
  });

  it('carries source, grouping, notes and every statement when asked for', () => {
    const payload = buildPrintPayload({ ...BASE, includeLogic: true }, 'now');
    expect(payload.logic?.source).toBe('fee_compile_data_set');
    expect(payload.logic?.group_by).toEqual(['aging band', 'class']);
    expect(payload.logic?.notes).toHaveLength(1);
    /**
     * Invariant 6 on paper: "every report exposes its definition and its SQL".
     * A reader who cannot ask the screen "where did this come from?" must be
     * able to answer it from the document.
     */
    expect(payload.logic?.queries).toEqual([
      { key: 'totals', description: 'Overdue total', sql: 'SELECT 1' },
    ]);
  });
});

/**
 * The footer is an HTML template, and the org name is data. Both come from our
 * own registry today, so this is defence in depth — but the day a trust is
 * named `Smith & Sons <Charitable>` the unescaped version silently produces a
 * broken document.
 */
describe('the footer treats names as text', () => {
  it.each([
    ['&', 'Smith & Sons', 'Smith &amp; Sons'],
    ['<', 'A <b>Trust', 'A &lt;b&gt;Trust'],
    ['"', 'The "Big" School', 'The &quot;Big&quot; School'],
  ])('escapes %s', (_label, input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it('escapes the ampersand first, so an escape is not double-escaped', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
