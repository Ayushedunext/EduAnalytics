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
  /**
   * Only the panels ONE query answers on its own. The KPI strip, the school
   * table and the highlights each read the demand ledger and the receipt ledger
   * together, and a per-widget clone fetches a single query — so cloning one of
   * those would produce a widget whose timing half silently came back empty.
   */
  'fee-comparative': new Set(['bar-period', 'line-recovery', 'bar-outstanding', 'bar-school']),
  /**
   * The four the receipt ledger answers alone. The year-by-year table and the
   * highlights read fees, enrollment and departures together; the enrollment and
   * staff charts each need a query this table cannot name, since it maps a
   * widget to exactly one.
   */
  'trend-analysis': new Set(['line-collection', 'line-seasonality', 'bar-mode', 'bar-school']),
};

export const WIDGET_BUCKET_OPTIONS: Partial<Record<string, Readonly<Record<string, readonly ('week' | 'month' | 'quarter' | 'year')[]>>>> = {
  'fee-collection': {
    'line-month': ['week', 'month', 'quarter', 'year'],
  },
};
