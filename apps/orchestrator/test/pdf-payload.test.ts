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
import type { DashboardResult } from '../src/services/dashboards.js';

const { buildPrintPayload, escapeHtml } = await import('../src/services/pdf.js');

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
