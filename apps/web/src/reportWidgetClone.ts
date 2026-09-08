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

/**
 * Which SQL statement feeds which panel, for the per-chart "View logic"
 * (ChartMenu.tsx) — mirroring `WIDGET_QUERY_KEYS` in
 * apps/orchestrator/src/services/dashboards.ts.
 *
 * A DISPLAY hint and nothing more: the report response already carries every
 * statement behind the page (Invariant 6, `logic.queries`), and the menu shows
 * all of them. This table only says which one to mark as "this chart", so a
 * widget missing here loses a highlight, never a statement. That is why the
 * mirror drifting apart from the server's table is harmless in a way the clone
 * table's drift also is: the failure mode is a missing emphasis, not a wrong
 * or hidden SQL.
 *
 * It is deliberately the same three reports and the same widgets as
 * `CLONEABLE_WIDGETS` above, because both answer the same question — which
 * panels ONE query answers on their own. Panels that read several result sets
 * together (the year-by-year table, the highlights, the KPI strip) have no
 * single statement to point at, and the menu lists all of them for those.
 */
export const WIDGET_QUERY_KEYS: Partial<Record<string, Readonly<Record<string, string>>>> = {
  'trend-analysis': {
    'line-collection': 'collection_by_month',
    'line-seasonality': 'collection_by_month',
    'bar-mode': 'collection_by_month',
    'bar-school': 'collection_by_month',
  },
  'fee-comparative': {
    'bar-period': 'demand_by_period',
    'line-recovery': 'demand_by_period',
    'bar-outstanding': 'demand_by_period',
    'bar-school': 'demand_by_period',
  },
  'fee-collection': {
    'line-month': 'by_month',
    'bar-class': 'by_class',
    'donut-mode': 'by_mode',
    'table-component': 'by_component',
  },
};
