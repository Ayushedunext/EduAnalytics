/**
 * The Dashboard's look: which layout is on screen, and which palette the charts
 * and chrome are painted in (docs/10 §1.5, 2026-09-04).
 *
 * Four tabs since 2026-09-08 (docs/10 §1.6): the artifact's three layouts, plus
 * My View — the reader's own board, which is a layout only in the sense that it
 * is the fourth thing this control switches between.
 *
 * -- Where the values come from ------------------------------------------------
 * Both are the reader's choice and nothing else: no server round-trip, no
 * per-tenant config, no claim about the data. They persist in `localStorage`
 * so a reader who picked View 3 in amber lands on it next launch, and
 * a storage that refuses (a private window, an embedding that blocks it) simply
 * yields the defaults — the page never depends on the value being there.
 *
 * -- What a palette IS here ------------------------------------------------------
 * Six colour slots plus a two-stop gradient (`ChartPalette`, @sap/chart-spec).
 * Each layout ships the set the reference design used; picking a swatch or a
 * free colour DERIVES a set from that one hue (`derivePalette`) so every mark on
 * the page, the nav gradient and the KPI tiles move together. The palette is
 * applied twice from one value: as CSS custom properties (`--c0`…`--c5`,
 * `--grad-a`, `--grad-b`) for the chrome, and through `ChartPaletteProvider`
 * for the SVG gradients, which need literal hex to compute their stops.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { derivePalette, type ChartPalette } from '@sap/chart-spec/react';

export type DashboardLayout = 'A' | 'B' | 'C' | 'MY';

/**
 * The bar's order, left to right. The ids are the formats as they were drawn;
 * the labels are what a reader sees. View 1 is format B — the one a reader
 * lands on at launch (DEFAULT_LAYOUT) — so the order here is B, A, C.
 *
 * `MY` leads the row, left of View 1, because it is the reader's OWN board: the
 * three views are arrangements the product chose, and this is the one they
 * chose themselves (myView.ts). It is still never the default — an empty board
 * is a bad first screen, so a reader lands on View 1 and arrives here only by
 * having put something on it, or by asking for it.
 */
export const LAYOUTS: readonly { id: DashboardLayout; label: string }[] = [
  { id: 'MY', label: 'My View' },
  { id: 'B', label: 'View 1' },
  { id: 'A', label: 'View 2' },
  { id: 'C', label: 'View 3' },
];

/** What a reader gets before they have picked anything: View 1. */
export const DEFAULT_LAYOUT: DashboardLayout = 'B';

/**
 * Each layout's own palette, as the reference designs were drawn.
 *
 * My View takes View 1's set. It has no reference design of its own — it is
 * whatever the reader put on it — and inventing a fourth palette for it would
 * mean the same chart changed colour when it was saved, which reads as a
 * different chart.
 */
export const LAYOUT_PALETTES: Record<DashboardLayout, ChartPalette> = {
  A: { colours: ['#1fa0e8', '#37c979', '#f0508a', '#f5a623', '#8e6bf0', '#12b5a5'], gradient: ['#3dbe6c', '#1e7be0'] },
  B: { colours: ['#3c7cff', '#3ee0a0', '#ff4d8d', '#ffc940', '#ff8a3d', '#7b5cff'], gradient: ['#3c7cff', '#7b5cff'] },
  C: { colours: ['#f5a623', '#1e3a8a', '#2f7de1', '#12b5a5', '#3abf5e', '#e5484d'], gradient: ['#12b5a5', '#1e7be0'] },
  MY: { colours: ['#3c7cff', '#3ee0a0', '#ff4d8d', '#ffc940', '#ff8a3d', '#7b5cff'], gradient: ['#3c7cff', '#7b5cff'] },
};

/** The seven quick picks beside the free colour input. */
export const THEME_SWATCHES: readonly string[] = [
  '#1fa0e8',
  '#ff4d8d',
  '#f5a623',
  '#7b5cff',
  '#12b5a5',
  '#3abf5e',
  '#e5484d',
];

// v2: the default moved from format A to format B, so v1's stored picks are dropped.
const STORAGE_KEY = 'sap.dashboard.theme.v2';

interface Stored {
  layout?: unknown;
  custom?: unknown;
}

function isLayout(value: unknown): value is DashboardLayout {
  return value === 'A' || value === 'B' || value === 'C' || value === 'MY';
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function readStored(): { layout: DashboardLayout; custom: string | null } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { layout: DEFAULT_LAYOUT, custom: null };
    const parsed: unknown = JSON.parse(raw);
    const stored = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Stored;
    return {
      layout: isLayout(stored.layout) ? stored.layout : DEFAULT_LAYOUT,
      custom: isHex(stored.custom) ? stored.custom : null,
    };
  } catch {
    return { layout: DEFAULT_LAYOUT, custom: null };
  }
}

function writeStored(layout: DashboardLayout, custom: string | null): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ layout, custom }));
  } catch {
    /* Storage refused: the choice lives for this session only. */
  }
}

export interface DashboardTheme {
  readonly layout: DashboardLayout;
  /** The picked colour, or `null` for the layout's own palette. */
  readonly custom: string | null;
  readonly palette: ChartPalette;
  readonly setLayout: (layout: DashboardLayout) => void;
  readonly setCustom: (hex: string | null) => void;
}

export function useDashboardTheme(): DashboardTheme {
  const [state, setState] = useState(readStored);

  const palette = useMemo(
    () => (state.custom !== null ? derivePalette(state.custom) : LAYOUT_PALETTES[state.layout]),
    [state.custom, state.layout],
  );

  /**
   * The chrome reads the palette as custom properties on the root, so a
   * stylesheet rule can say `var(--c0)` without knowing how the page arrived at
   * it. Set on `documentElement` rather than on the shell so a floating menu
   * portaled elsewhere would still resolve them.
   */
  useEffect(() => {
    const root = document.documentElement.style;
    palette.colours.forEach((colour, index) => { root.setProperty(`--c${String(index)}`, colour); });
    root.setProperty('--grad-a', palette.gradient[0]);
    root.setProperty('--grad-b', palette.gradient[1]);
  }, [palette]);

  useEffect(() => {
    writeStored(state.layout, state.custom);
  }, [state.layout, state.custom]);

  const setLayout = useCallback((layout: DashboardLayout) => {
    setState((current) => ({ ...current, layout }));
  }, []);
  const setCustom = useCallback((hex: string | null) => {
    setState((current) => ({ ...current, custom: hex !== null && isHex(hex) ? hex.toLowerCase() : null }));
  }, []);

  return { layout: state.layout, custom: state.custom, palette, setLayout, setCustom };
}
