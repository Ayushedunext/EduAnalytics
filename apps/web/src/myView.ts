/**
 * "My View" — the charts a reader has picked out of the product and kept.
 *
 * -- What is stored, and what is not -------------------------------------------
 * A REFERENCE to a chart, never the chart: which Dashboard slot or which report
 * it came from, which widget id inside it, and the title to label it with while
 * it loads. Nothing here holds a figure, a row or a SQL statement, so a saved
 * view can never show a number the server did not send this session — My View
 * re-fetches exactly like every other screen, under the scope and year in force
 * NOW (Invariant 2: scope is law, and a cached figure from another scope would
 * be a way around it).
 *
 * -- Why localStorage ---------------------------------------------------------
 * The same reasoning as the layout and theme choice (theme/dashboardTheme.ts):
 * it is the reader's arrangement of screens they already have permission for,
 * not data and not configuration. There is no endpoint for it, and inventing a
 * per-user server table for a list of widget ids would put a write on the
 * request path of a product whose whole point is that it never writes
 * (Invariant 3). A storage that refuses simply yields an empty view.
 *
 * -- Why a module store rather than a hook's own state ------------------------
 * Two surfaces read it at once — the board itself and every kebab menu on every
 * other screen, which shows "Add" or "Remove" depending on what is in here. A
 * per-component `useState` would let a card on the Dashboard say "Add" for a
 * chart the board is already drawing. One store, `useSyncExternalStore`, and
 * they cannot disagree.
 */

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Where a chart comes from — the only two places this product draws one.
 *
 * `overview` is a card of the Dashboard, fetched from `/api/home/overview/:slot`
 * (services/overview.ts). `report` is one panel of a predefined dashboard or a
 * custom report, fetched from `/api/report/:id`.
 *
 * `reportId` on an overview source is the report that card OPENS, where it has
 * one. It is what makes Clone offerable on a Dashboard card: the clone endpoint
 * takes a report id, and a slot is not one.
 */
export type ChartSource =
  | { readonly kind: 'overview'; readonly slot: string; readonly widgetId: string; readonly reportId?: string }
  /**
   * `custom` marks one of the reader's OWN reports (My Reports), which is
   * fetched from `/api/reports/:id` rather than `/api/report/:id` and takes no
   * academic year. Carried on the reference because the board has to know
   * which endpoint to ask before it has anything back to inspect.
   */
  | { readonly kind: 'report'; readonly reportId: string; readonly widgetId: string; readonly custom?: boolean };

export interface MyViewChart {
  /** Stable identity, derived from the source — see `chartKey`. */
  readonly id: string;
  /** The label to show while the chart is still loading, and in the menu. */
  readonly title: string;
  readonly source: ChartSource;
  /** When it was added, so the board can keep the reader's own order. */
  readonly addedAt: string;
}

/**
 * One chart's identity across sessions.
 *
 * Deliberately NOT including the title: renaming a chart server-side must not
 * silently duplicate it in someone's view, and two cards drawing the same
 * widget of the same slot ARE the same chart.
 */
export function chartKey(source: ChartSource): string {
  return source.kind === 'overview'
    ? `overview:${source.slot}:${source.widgetId}`
    : `report:${source.custom === true ? 'custom:' : ''}${source.reportId}:${source.widgetId}`;
}

const STORAGE_KEY = 'sap.dashboard.myview.v1';

let charts: readonly MyViewChart[] = readStored();
const listeners = new Set<() => void>();

function isSource(value: unknown): value is ChartSource {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['widgetId'] !== 'string') return false;
  if (v['kind'] === 'overview') return typeof v['slot'] === 'string';
  if (v['kind'] === 'report') {
    return typeof v['reportId'] === 'string' && (v['custom'] === undefined || typeof v['custom'] === 'boolean');
  }
  return false;
}

function readStored(): readonly MyViewChart[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    /**
     * Every entry is re-validated, not trusted. `localStorage` is the one input
     * to this app a user can edit by hand, and a half-shaped entry would reach
     * the board as a fetch for a slot that does not exist. An unreadable entry
     * is dropped rather than repaired: there is nothing here worth guessing at.
     */
    const out: MyViewChart[] = [];
    for (const entry of parsed as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (!isSource(e['source'])) continue;
      out.push({
        id: chartKey(e['source']),
        title: typeof e['title'] === 'string' ? e['title'] : 'Chart',
        source: e['source'],
        addedAt: typeof e['addedAt'] === 'string' ? e['addedAt'] : new Date().toISOString(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function commit(next: readonly MyViewChart[]): void {
  charts = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Storage refused: the view lives for this session only. */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface MyView {
  readonly charts: readonly MyViewChart[];
  readonly has: (source: ChartSource) => boolean;
  readonly add: (chart: { title: string; source: ChartSource }) => void;
  readonly remove: (source: ChartSource) => void;
  /** Move a chart one place earlier or later, so the board is the reader's order. */
  readonly move: (id: string, by: -1 | 1) => void;
  readonly clear: () => void;
}

export function useMyView(): MyView {
  const current = useSyncExternalStore(subscribe, () => charts, () => charts);

  const has = useCallback((source: ChartSource) => charts.some((c) => c.id === chartKey(source)), []);

  const add = useCallback((chart: { title: string; source: ChartSource }) => {
    const id = chartKey(chart.source);
    /* Adding twice is a no-op, not a duplicate: the menu says "Remove" once it
       is in, so a second add only ever comes from two tabs racing. */
    if (charts.some((c) => c.id === id)) return;
    commit([...charts, { id, title: chart.title, source: chart.source, addedAt: new Date().toISOString() }]);
  }, []);

  const remove = useCallback((source: ChartSource) => {
    const id = chartKey(source);
    commit(charts.filter((c) => c.id !== id));
  }, []);

  const move = useCallback((id: string, by: -1 | 1) => {
    const from = charts.findIndex((c) => c.id === id);
    if (from < 0) return;
    const to = from + by;
    if (to < 0 || to >= charts.length) return;
    const next = [...charts];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    commit(next);
  }, []);

  const clear = useCallback(() => { commit([]); }, []);

  return { charts: current, has, add, remove, move, clear };
}

/** The Dashboard slots a saved view needs fetched, each one once. */
export function overviewSlotsOf(saved: readonly MyViewChart[]): string[] {
  return [...new Set(saved.flatMap((c) => (c.source.kind === 'overview' ? [c.source.slot] : [])))];
}

/**
 * The reports a saved view needs fetched, each one once — a predefined and a
 * custom report of the same id being two different fetches, hence the key.
 */
export function reportFetchesOf(
  saved: readonly MyViewChart[],
): { key: string; reportId: string; custom: boolean }[] {
  const out = new Map<string, { key: string; reportId: string; custom: boolean }>();
  for (const chart of saved) {
    if (chart.source.kind !== 'report') continue;
    const custom = chart.source.custom === true;
    const key = `${custom ? 'custom' : 'predefined'}:${chart.source.reportId}`;
    if (!out.has(key)) out.set(key, { key, reportId: chart.source.reportId, custom });
  }
  return [...out.values()];
}
