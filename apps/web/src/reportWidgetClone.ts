/**
 * Which predefined-dashboard widgets can be cloned on their own (docs/06 §3,
 * per-widget "⧉ Clone & customize").
 *
 * Mirrors `WIDGET_QUERY_KEYS` / `WIDGET_BUCKET_OPTIONS` in
 * apps/orchestrator/src/services/dashboards.ts — the server is the actual
 * authority (it validates every clone request against those tables again),
 * this is only which "⧉" buttons the SCREEN offers. A widget missing here
 * simply gets no clone button; it is never a security boundary, so the two
 * tables drifting apart fails safe (a button that 404s, never a clone the
 * server should have refused).
 */

export const CLONEABLE_WIDGETS: Partial<Record<string, ReadonlySet<string>>> = {
  'fee-collection': new Set(['line-month', 'bar-class', 'donut-mode', 'table-component']),
};

export const WIDGET_BUCKET_OPTIONS: Partial<Record<string, Readonly<Record<string, readonly ('week' | 'month' | 'quarter' | 'year')[]>>>> = {
  'fee-collection': {
    'line-month': ['week', 'month', 'quarter', 'year'],
  },
};
