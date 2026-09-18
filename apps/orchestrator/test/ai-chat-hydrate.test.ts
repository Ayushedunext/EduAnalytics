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

const { hydrate, hydrateWidget, tryHydrate, checkSeedReuse, buildSystemPrompt } = await import('../src/services/ai-chat.js');

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

  it('carries series and stacked through onto a hydrated grouped bar — the draft schema addition that lets Ask AI answer "as a bar chart" for a billed-vs-collected comparison', () => {
    const cache = new Map([
      [
        'q1',
        {
          columns: ['academic_year', 'billed', 'collected'],
          rows: [{ academic_year: '2024-25', billed: 900000, collected: 750000 }],
          truncated: false,
          sql: "SELECT academic_year, SUM(CASE WHEN metric='Billed' THEN amount END) AS billed, SUM(CASE WHEN metric='Collected' THEN amount END) AS collected FROM fee_ledger GROUP BY academic_year",
        },
      ],
    ]);
    const widget = {
      id: 'b1',
      type: 'bar' as const,
      x: 'academic_year',
      y: 'billed',
      query_ref: 'q1',
      series: [
        { field: 'billed', label: 'Billed' },
        { field: 'collected', label: 'Collected' },
      ],
      stacked: false,
    };
    const hydrated = hydrateWidget(widget, cache, 'corr-1');
    expect(hydrated).toMatchObject({
      type: 'bar',
      series: [
        { field: 'billed', label: 'Billed' },
        { field: 'collected', label: 'Collected' },
      ],
      data: [{ academic_year: '2024-25', billed: 900000, collected: 750000 }],
    });
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

  it('produces a valid grouped bar for a billed-vs-collected-style comparison, pivoted to one row per category', () => {
    const draft = {
      spec_version: 1 as const,
      title: 'Billed and collected, year by year',
      widgets: [
        {
          id: 'b1',
          type: 'bar' as const,
          x: 'academic_year',
          y: 'billed',
          query_ref: 'q1',
          series: [
            { field: 'billed', label: 'Billed' },
            { field: 'collected', label: 'Collected' },
          ],
        },
      ],
    };
    const cache = new Map([
      [
        'q1',
        {
          columns: ['academic_year', 'billed', 'collected'],
          rows: [
            { academic_year: '2024-25', billed: 900000, collected: 750000 },
            { academic_year: '2025-26', billed: 950000, collected: 800000 },
          ],
          truncated: false,
          sql: 'SELECT academic_year, ... GROUP BY academic_year',
        },
      ],
    ]);
    const spec = hydrate(draft, cache, SCOPE, 'corr-1');
    expect(spec.widgets[0]).toMatchObject({ type: 'bar', series: [{ field: 'billed' }, { field: 'collected' }] });
  });

  it('still rejects a grouped bar whose first series field is not y — checkWidgetInvariants applies to an AI-emitted spec exactly as it does to any other', () => {
    const draft = {
      spec_version: 1 as const,
      title: 'Billed and collected, year by year',
      widgets: [
        {
          id: 'b1',
          type: 'bar' as const,
          x: 'academic_year',
          y: 'billed',
          query_ref: 'q1',
          series: [
            { field: 'collected', label: 'Collected' },
            { field: 'billed', label: 'Billed' },
          ],
        },
      ],
    };
    const cache = new Map([
      ['q1', { columns: ['academic_year', 'billed', 'collected'], rows: [{ academic_year: '2024-25', billed: 1, collected: 2 }], truncated: false, sql: 'SELECT 1' }],
    ]);
    expect(() => hydrate(draft, cache, SCOPE, 'corr-1')).toThrow(PlatformError);
  });
});

describe('tryHydrate — the emit_report retry loop\'s non-throwing hydration', () => {
  it('returns ok:true for a valid draft, same result hydrate() would produce', () => {
    const draft = {
      spec_version: 1 as const,
      title: 'Enrollment by class',
      widgets: [{ id: 'b1', type: 'bar' as const, x: 'classname', y: 'n', query_ref: 'q1' }],
    };
    const cache = new Map([
      ['q1', { columns: ['classname', 'n'], rows: [{ classname: 'IX', n: 12 }], truncated: false, sql: 'SELECT 1' }],
    ]);
    const r = tryHydrate(draft, cache, SCOPE, 'corr-1');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false (not a throw) for a query_ref that was never run, so the caller can retry', () => {
    const draft = {
      spec_version: 1 as const,
      title: 'Tampered',
      widgets: [{ id: 'b1', type: 'bar' as const, x: 'a', y: 'b', query_ref: 'nonexistent' }],
    };
    const r = tryHydrate(draft, new Map(), SCOPE, 'corr-1');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false for a bar widget whose query result repeats a category value -- the line->bar conversion bug', () => {
    const draft = {
      spec_version: 1 as const,
      title: 'Billed and collected, year by year',
      widgets: [{ id: 'b1', type: 'bar' as const, x: 'academic_year', y: 'amount', query_ref: 'q1' }],
    };
    const cache = new Map([
      [
        'q1',
        {
          columns: ['academic_year', 'metric', 'amount'],
          rows: [
            { academic_year: '2024-25', metric: 'Billed', amount: 900000 },
            { academic_year: '2024-25', metric: 'Collected', amount: 750000 },
          ],
          truncated: false,
          sql: 'SELECT academic_year, metric, amount FROM fee_ledger',
        },
      ],
    ]);
    const r = tryHydrate(draft, cache, SCOPE, 'corr-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('checkSeedReuse — catches a refinement that rewrote the data instead of reusing it', () => {
  const SEED_CONTEXT = {
    reportName: 'Billed and collected, year by year',
    queries: [
      {
        key: 'by_year',
        sql: 'SELECT academic_year, SUM(billed) AS billed, SUM(paid) AS collected FROM fee_ledger GROUP BY academic_year ORDER BY academic_year',
      },
    ],
    widgets: [
      {
        id: 'line-1',
        type: 'line' as const,
        x: 'academic_year',
        y: 'collected',
        data: [],
        series: 'metric',
      },
    ],
  };

  it('flags a widget whose x/y match an existing chart but whose query_ref SQL is NOT one of the seeded queries', () => {
    const cache = new Map([
      ['q1', { columns: ['academic_year', 'collected'], rows: [], truncated: false, sql: 'SELECT academic_year, SUM(paid) AS collected FROM fee_ledger WHERE 1=1 GROUP BY academic_year' }],
    ]);
    const draft = {
      spec_version: 1 as const,
      title: 'Billed and collected, year by year',
      widgets: [{ id: 'b1', type: 'line' as const, x: 'academic_year', y: 'collected', query_ref: 'q1' }],
    };
    const issue = checkSeedReuse(draft, SEED_CONTEXT, cache);
    expect(issue).not.toBeNull();
    expect(issue?.message).toContain('reuse_seed_query');
  });

  it('passes when the query_ref SQL matches a seeded query verbatim (reuse_seed_query was used, or SQL is byte-identical)', () => {
    const cache = new Map([
      ['q1', { columns: ['academic_year', 'collected'], rows: [], truncated: false, sql: SEED_CONTEXT.queries[0]!.sql }],
    ]);
    const draft = {
      spec_version: 1 as const,
      title: 'Billed and collected, year by year',
      widgets: [{ id: 'b1', type: 'line' as const, x: 'academic_year', y: 'collected', query_ref: 'q1' }],
    };
    expect(checkSeedReuse(draft, SEED_CONTEXT, cache)).toBeNull();
  });

  it('does not flag a widget whose fields do not match any existing chart — a genuinely new question', () => {
    const cache = new Map([
      ['q1', { columns: ['classname', 'n'], rows: [], truncated: false, sql: 'SELECT classname, COUNT(*) AS n FROM students_data_set GROUP BY classname' }],
    ]);
    const draft = {
      spec_version: 1 as const,
      title: 'Enrollment by class',
      widgets: [{ id: 'b1', type: 'bar' as const, x: 'classname', y: 'n', query_ref: 'q1' }],
    };
    expect(checkSeedReuse(draft, SEED_CONTEXT, cache)).toBeNull();
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
    // "Show me the same data as a bar chart" must not silently become a
    // DIFFERENT query with different numbers — the model is told to call
    // reuse_seed_query (which re-runs the seeded SQL unchanged, server-side)
    // for a presentation-only change, rather than retyping the SQL itself.
    expect(prompt).toContain('reuse_seed_query');
  });

  it('always requires an ORDER BY on the category axis, refining or not — categories must render in sequence, not GROUP BY order', () => {
    const fresh = buildSystemPrompt(CATALOG, SCOPE);
    expect(fresh).toContain('ORDER BY');
    expect(fresh).toContain('category axis');
  });
});
