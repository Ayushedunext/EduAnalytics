/**
 * Hydration (ADR-030): a model-emitted chart-spec DRAFT names `query_ref`s;
 * this is the step that attaches the real, cached rows and produces the
 * `ChartSpec` the renderer actually draws. The model's own output never
 * contains a row by construction (the draft schema is `.strict()`), so what
 * matters here is that hydration (a) uses ONLY the cached result the
 * orchestrator itself ran, never anything from the draft, and (b) fails
 * loudly rather than silently when a widget references a query that was
 * never run.
 */

import { describe, expect, it } from 'vitest';
import { PlatformError, ERROR_CODES } from '@sap/shared';
import './env-defaults.js';

const { hydrate, hydrateWidget, buildSystemPrompt } = await import('../src/services/ai-chat.js');

const SCOPE = [{ school_id: 'stmarksmb', school_name: 'St Marks MB' }];

describe('hydrateWidget', () => {
  it('passes a kpi widget through untouched — it carries its own value, no query_ref to hydrate', () => {
    const widget = { id: 'k1', type: 'kpi' as const, label: 'Total', value: '247' };
    expect(hydrateWidget(widget, new Map(), 'corr-1')).toEqual(widget);
  });

  it('attaches the cached rows to a bar widget by query_ref — never anything from the draft', () => {
    const cache = new Map([
      [
        'q1',
        {
          columns: ['classname', 'n'],
          rows: [{ classname: 'IX', n: 12 }],
          truncated: false,
          sql: 'SELECT classname, COUNT(*) AS n FROM students_data_set GROUP BY classname',
        },
      ],
    ]);
    const widget = { id: 'b1', type: 'bar' as const, x: 'classname', y: 'n', query_ref: 'q1' };
    const hydrated = hydrateWidget(widget, cache, 'corr-1');
    expect(hydrated).toMatchObject({
      id: 'b1',
      type: 'bar',
      x: 'classname',
      y: 'n',
      data: [{ classname: 'IX', n: 12 }],
    });
  });

  it('carries the truncated flag onto a hydrated table', () => {
    const cache = new Map([
      ['q1', { columns: ['n'], rows: [{ n: 1 }], truncated: true, sql: 'SELECT COUNT(*) AS n FROM students_data_set' }],
    ]);
    const widget = {
      id: 't1',
      type: 'table' as const,
      columns: [{ field: 'n', label: 'N' }],
      query_ref: 'q1',
    };
    const hydrated = hydrateWidget(widget, cache, 'corr-1') as { truncated: boolean };
    expect(hydrated.truncated).toBe(true);
  });

  it('throws INVALID_CHART_SPEC for a query_ref that was never run', () => {
    const widget = { id: 'b1', type: 'bar' as const, x: 'a', y: 'b', query_ref: 'nonexistent' };
    expect(() => hydrateWidget(widget, new Map(), 'corr-1')).toThrow(PlatformError);
    try {
      hydrateWidget(widget, new Map(), 'corr-1');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformError);
      expect((err as PlatformError).code).toBe(ERROR_CODES.INVALID_CHART_SPEC);
    }
  });
});

describe('hydrate', () => {
  it('produces a spec that validates against the real chart-spec schema', () => {
    const draft = {
      spec_version: 1 as const,
      title: 'Enrollment by class',
      widgets: [
        { id: 'b1', type: 'bar' as const, x: 'classname', y: 'n', query_ref: 'q1' },
      ],
    };
    const cache = new Map([
      [
        'q1',
        {
          columns: ['classname', 'n'],
          rows: [{ classname: 'IX', n: 12 }],
          truncated: false,
          sql: 'SELECT classname, COUNT(*) AS n FROM students_data_set GROUP BY classname',
        },
      ],
    ]);
    const spec = hydrate(draft, cache, SCOPE, 'corr-1');
    expect(spec.title).toBe('Enrollment by class');
    expect(spec.meta.scope).toEqual(SCOPE);
    expect(spec.meta.served_from).toBe('replica');
    expect(spec.widgets).toHaveLength(1);
  });

  it('never lets a widget carry a query_ref the orchestrator did not itself run', () => {
    const draft = {
      spec_version: 1 as const,
      title: 'Tampered',
      widgets: [{ id: 'b1', type: 'bar' as const, x: 'a', y: 'b', query_ref: 'q1' }],
    };
    // The cache is what the ORCHESTRATOR built while executing tool calls —
    // an empty one here stands in for "this query_ref was never actually run".
    expect(() => hydrate(draft, new Map(), SCOPE, 'corr-1')).toThrow(PlatformError);
  });
});

describe('buildSystemPrompt — ✎ Refine with AI seeding (docs/06 §1)', () => {
  const CATALOG = { tables: [] };

  it('carries no refine seeding when no report is being refined (a fresh Ask AI question)', () => {
    const prompt = buildSystemPrompt(CATALOG, SCOPE);
    expect(prompt).not.toContain('REFINING');
  });

  it('folds the report’s current SQL and widgets into the prompt when refining', () => {
    const prompt = buildSystemPrompt(CATALOG, SCOPE, {
      reportName: 'Payment modes (copy)',
      queries: [{ key: 'by_mode', sql: 'SELECT paymenttype, SUM(paidamount) AS collected FROM fee_collection_data_set GROUP BY paymenttype' }],
      widgets: [{ id: 'donut-mode', type: 'donut', label_field: 'paymenttype', value_field: 'collected', data: [] }],
    });
    expect(prompt).toContain('REFINING');
    expect(prompt).toContain('Payment modes (copy)');
    expect(prompt).toContain('paymenttype, SUM(paidamount)');
    expect(prompt).toContain('donut-mode');
    // The instruction that keeps a Q&A-only question from silently exploding
    // into a multi-chart answer — the one behavioural rule this seeding exists
    // to give the model, worth asserting on directly rather than by proxy.
    expect(prompt).toContain('SAME NUMBER of widgets');
  });
});
