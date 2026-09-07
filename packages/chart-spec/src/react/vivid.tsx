/**
 * The "vivid" presentation of a data-bound widget — the dashboard look adopted
 * on 2026-09-04 from the signed-off "AI Dashboard" artifact (docs/10 §1.5).
 *
 * -- What this file is, and is not --------------------------------------------
 * It is a second way of DRAWING the same chart-spec widgets, not a second chart
 * layer and not a change to the contract. Every function here takes a validated
 * `BarWidget`, `LineWidget` or `DonutWidget` exactly as `widgets.tsx` does, reads
 * the same rows through the same fields, and never carries anything the spec
 * does not (ADR-015). Two things are new and both are presentation:
 *
 *   1. A PALETTE the page provides (`ChartPaletteProvider`). Six colour slots
 *      plus a two-stop gradient, chosen by the reader from a theme swatch or
 *      derived from a colour they picked. Absent, `widgets.tsx` draws exactly
 *      as it did — which is what the PDF surface still gets (print.tsx mounts
 *      no provider), so an export stays a photograph of the audited palette.
 *
 *   2. A CHART TYPE the reader may switch per card (`ChartType`): bar, horizontal
 *      bar, line, area, donut, pie, polar area ("spiral") and radar. The widget's
 *      numbers are untouched; the reader is choosing a projection of them. A
 *      line of twelve months drawn as a donut shows each month's share of the
 *      year — the same figures, differently arranged — and the choice lives in
 *      component state, never in the spec, so a saved report or a PDF cannot
 *      inherit one reader's view.
 *
 * -- One model, eight forms -----------------------------------------------------
 * `modelOf` reduces any of the three widgets to `{labels, series[]}`, which is
 * the only shape a chart type needs. That is what makes the type switch general
 * rather than a special case per widget: a grouped bar becomes several lines, a
 * donut becomes per-category bars, a multi-series anything becomes one slice per
 * series (summed) when a round form is asked for.
 *
 * -- Drill (ADR-020) ------------------------------------------------------------
 * A click still reports the CATEGORY INDEX and the caller turns it into a
 * `{dim, value}` pair from the widget's own row (`drillTargetAt` in
 * widgets.tsx). It is offered only where the categories ARE the widget's rows
 * (`rowsAreCategories`); the summed per-series forms have no row to bind and
 * render inert rather than guessing.
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { createContext, useContext, useId } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Label,
  Line,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
} from 'recharts';
import { CHART_MOTION_MS, useChartMotion } from './ChartMotion.js';
import type { BarWidget, DonutWidget, LineWidget, Tone } from '../spec.js';

// -- Palette ---------------------------------------------------------------------

/**
 * Six colour slots and the nav gradient, as the artifact defines them. Slot 0
 * is the lead, 1 reads as "good", 2 as "bad", 3 as "warning", 4 and 5 are
 * identity only — the same roles docs/10 §1's audited palette assigns, so a
 * widget's `tone` still lands on a colour that means what the tone means.
 */
export interface ChartPalette {
  readonly colours: readonly string[];
  readonly gradient: readonly [string, string];
}

const PaletteContext = createContext<ChartPalette | null>(null);

/** Turns the vivid presentation on for everything inside it. */
export function ChartPaletteProvider({
  palette,
  children,
}: {
  readonly palette: ChartPalette;
  readonly children: ReactNode;
}): ReactElement {
  return <PaletteContext.Provider value={palette}>{children}</PaletteContext.Provider>;
}

/** The page's palette, or `null` where none was provided (the PDF surface). */
export function useChartPalette(): ChartPalette | null {
  return useContext(PaletteContext);
}

export function paletteColour(palette: ChartPalette, slot: number): string {
  const n = palette.colours.length;
  if (n === 0) return '#1fa0e8';
  return palette.colours[((slot % n) + n) % n] ?? '#1fa0e8';
}

/**
 * Series index → palette slot. The audited series order is demand, collected,
 * pending, defaulters (widgets.tsx `SERIES`); the artifact's slots put amber at
 * 3 and pink at 2, so the third series takes slot 3 and the fourth slot 2 —
 * pending stays amber and defaulters stay pink whatever theme is picked.
 */
const SERIES_SLOTS: readonly number[] = [0, 1, 3, 2, 4, 5];

export function seriesSlot(index: number): number {
  return SERIES_SLOTS[index % SERIES_SLOTS.length] ?? index % 6;
}

/** A tone's slot, where the tone claims a meaning; `null` for neutral. */
export function toneSlot(tone: Tone | undefined): number | null {
  switch (tone) {
    case 'positive':
      return 1;
    case 'negative':
      return 2;
    case 'warning':
      return 3;
    default:
      return null;
  }
}

// -- Chart types -------------------------------------------------------------------

export const CHART_TYPES = [
  ['bar', 'Bar'],
  ['hbar', 'Horizontal bar'],
  ['line', 'Line'],
  ['area', 'Area'],
  ['donut', 'Donut'],
  ['pie', 'Pie'],
  ['polar', 'Spiral'],
  ['radar', 'Radar'],
] as const;

export type ChartType = (typeof CHART_TYPES)[number][0];

export function isChartType(value: unknown): value is ChartType {
  return CHART_TYPES.some(([id]) => id === value);
}

/**
 * The per-card type menu. Plain `<select>` so it is keyboard- and
 * screen-reader-complete without this file re-implementing either; the skin
 * CSS (`.ctype`) draws it as the small chip the artifact uses.
 */
export function ChartTypeSelect({
  value,
  onChange,
  className,
  options,
}: {
  readonly value: ChartType;
  readonly onChange: (type: ChartType) => void;
  readonly className?: string | undefined;
  /**
   * The forms this chart can honestly take. A two-value gauge has no radar or
   * polar reading — two axes make a line, two wedges a half-moon — so a caller
   * lists the forms that fit its data and the menu offers only those.
   */
  readonly options?: readonly ChartType[] | undefined;
}): ReactElement {
  const shown = options === undefined ? CHART_TYPES : CHART_TYPES.filter(([id]) => options.includes(id));
  return (
    <select
      className={className ?? 'ctype'}
      aria-label="Chart type"
      value={value}
      onClick={(event) => { event.stopPropagation(); }}
      onChange={(event) => {
        const next = event.target.value;
        if (isChartType(next)) onChange(next);
      }}
    >
      {shown.map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  );
}

// -- Colour arithmetic -------------------------------------------------------------

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return [31, 160, 232];
  let h = m[1] as string;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${String(r)},${String(g)},${String(b)},${String(alpha)})`;
}

function rgbHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h =
      max === r
        ? (g - b) / d + (g < b ? 6 : 0)
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

export function hslHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Lightness moved up by `amount` (0–1), hue and saturation held. */
export function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexRgb(hex);
  const [h, s, l] = rgbHsl(r, g, b);
  return hslHex(h, s, Math.min(0.96, l + amount));
}

/** Lightness moved down by `amount` (0–1), hue and saturation held. */
export function darken(hex: string, amount: number): string {
  const [r, g, b] = hexRgb(hex);
  const [h, s, l] = rgbHsl(r, g, b);
  return hslHex(h, s, Math.max(0.08, l - amount));
}

/**
 * A vibrant six-colour palette from one picked colour — the artifact's
 * `derive()`, verbatim in intent: the pick is slot 0, and the rest are spread
 * around the wheel at 40°, 160°, 205°, 280° and 320° so no two neighbours in a
 * chart collide. Saturation is floored and lightness clamped so a dark or pale
 * pick still yields marks that read on a white card.
 */
export function derivePalette(hex: string): ChartPalette {
  const [r, g, b] = hexRgb(hex);
  const [h, s0, l0] = rgbHsl(r, g, b);
  const s = Math.max(s0, 0.68);
  const l = Math.min(Math.max(l0, 0.46), 0.6);
  const colours = [0, 40, 160, 205, 280, 320].map((d, i) =>
    hslHex(h + d, i === 0 ? s : Math.min(1, s + 0.05), i === 1 ? Math.min(0.62, l + 0.04) : l),
  );
  return {
    colours,
    gradient: [hslHex(h + 30, s, l), hslHex(h - 25, s, Math.max(0.36, l - 0.1))],
  };
}

// -- Chrome shared by every form --------------------------------------------------

const INK_2 = '#5b6b7c';
const INK_3 = '#98a5b3';
const CARD = '#ffffff';
const compactNum = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const fullNum = new Intl.NumberFormat('en-IN');

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The artifact's dark tooltip, drawn inline so it reads the same on every page
 * without a stylesheet having to be present. Pointer-driven, so the PDF never
 * renders it.
 */
interface TipEntry {
  readonly name?: string | number;
  readonly value?: number | string;
  readonly color?: string;
  readonly dataKey?: string | number;
  readonly payload?: { readonly fill?: string; readonly __c?: string };
}

/**
 * Translucent, not solid (product owner's review, 2026-09-04): the card used
 * to be an opaque block that hid the very marks a reader was pointing at. At
 * half ink with a light blur the figure stays legible and the chart shows
 * through; the padding is tight so a sparkline is not covered by its own key.
 */
const TIP_STYLE: CSSProperties = {
  background: 'rgba(30, 42, 56, 0.5)',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
  color: '#fff',
  borderRadius: 8,
  padding: '6px 9px',
  fontSize: 11.5,
  lineHeight: 1.3,
  maxWidth: 220,
  boxShadow: '0 6px 16px -6px rgba(0,0,0,.3)',
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none',
};

function VividTooltip({
  active,
  label,
  payload,
  xTitle,
}: {
  readonly active?: boolean;
  readonly label?: string | number;
  readonly payload?: readonly TipEntry[];
  /**
   * What the hovered category IS ("Week starting"). A sparkline has no visible
   * axis, so without this the heading is a bare "6 Apr" and the reader has to
   * infer what a point on the line stands for.
   */
  readonly xTitle?: string | undefined;
}): ReactElement | null {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  const heading = label ?? payload[0]?.name;
  /**
   * An area is drawn as a fill AND a stroke on the same key (two Recharts
   * items), so the payload can name one measure twice. One row per key.
   */
  const seen = new Set<string>();
  const rows = payload.filter((entry) => {
    const key = String(entry.dataKey ?? entry.name ?? '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div style={TIP_STYLE}>
      {xTitle !== undefined && (
        <div style={{ opacity: 0.7, fontSize: 10, letterSpacing: 0.2 }}>{xTitle}</div>
      )}
      {heading !== undefined && <div style={{ fontWeight: 600, marginBottom: 4 }}>{String(heading)}</div>}
      {rows.map((entry, index) => (
        <div key={`${String(entry.dataKey ?? entry.name ?? '')}-${String(index)}`} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: entry.payload?.__c ?? entry.color ?? entry.payload?.fill ?? '#fff',
              display: 'inline-block',
            }}
          />
          {entry.name !== undefined && String(entry.name) !== String(heading) && (
            <span style={{ opacity: 0.8 }}>{String(entry.name)}</span>
          )}
          <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{fullNum.format(Number(entry.value))}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * An axis title, drawn by Recharts inside the axis band.
 *
 * `null` when the spec left the title out, so the axis keeps exactly the height
 * it had before this existed and no chart moves for a title it does not have.
 */
function axisTitle(text: string | undefined, side: 'bottom' | 'left'): ReactElement | null {
  if (text === undefined) return null;
  return (
    <Label
      value={text}
      position={side === 'bottom' ? 'insideBottom' : 'insideLeft'}
      offset={side === 'bottom' ? -2 : 0}
      {...(side === 'left' ? { angle: -90 as const } : {})}
      style={{ fill: INK_3, fontSize: 10, fontWeight: 600, textAnchor: 'middle' }}
    />
  );
}

/**
 * A sparkline's axes, written out rather than drawn: the measure above the
 * line, and under it the first category, what the categories ARE, and the last.
 * Three short strings do the work ticks would at a height where ticks do not
 * fit (the Dashboard's activity minis are 82px tall).
 */
function SparkAxes({
  model,
  children,
}: {
  readonly model: ChartModel;
  readonly children: ReactNode;
}): ReactElement {
  const first = model.labels[0];
  const last = model.labels[model.labels.length - 1];
  const foot = model.xTitle !== undefined || (first !== undefined && last !== undefined && first !== last);
  return (
    <div className="vividSpark">
      {model.yTitle !== undefined && <div className="vividSparkY">{model.yTitle}</div>}
      {children}
      {foot && (
        <div className="vividSparkX">
          <span>{first ?? ''}</span>
          {model.xTitle !== undefined && <b>{model.xTitle}</b>}
          <span>{first === last ? '' : last ?? ''}</span>
        </div>
      )}
    </div>
  );
}

/** A plain HTML key: one dot per series, in the series' own colour. */
function SeriesLegend({ entries }: { readonly entries: readonly { name: string; colour: string }[] }): ReactElement {
  return (
    <ul className="vividLegend">
      {entries.map((entry) => (
        <li key={entry.name}>
          <i style={{ background: `linear-gradient(135deg, ${lighten(entry.colour, 0.18)}, ${entry.colour})` }} />
          {entry.name}
        </li>
      ))}
    </ul>
  );
}

// -- The model ------------------------------------------------------------------

interface ModelSeries {
  readonly name: string;
  readonly values: readonly (number | null)[];
  readonly slot: number;
}

export interface ChartModel {
  readonly labels: readonly string[];
  readonly series: readonly ModelSeries[];
  /** What the category axis is, in the reader's words (`x_title`); absent means unlabelled. */
  readonly xTitle?: string | undefined;
  /** What the value axis measures, units included (`y_title`). */
  readonly yTitle?: string | undefined;
  /** Colour slot per category — used by the forms that colour BY CATEGORY. */
  readonly categorySlots: readonly number[];
  /** Whether even a cartesian form colours per category (a donut's data drawn as bars). */
  readonly categoryColoured: boolean;
  /** Whether category `i` is `widget.data[i]`, so a click can drill (ADR-020). */
  readonly rowsAreCategories: boolean;
  readonly stacked: boolean;
}

/**
 * Long rows pivoted to one row per category with a key per series — the same
 * pivot `widgets.tsx` performs for a multi-series line, kept here so this file
 * has no import from it. Category and series order are first-appearance: the
 * emitter ordered the periods and re-sorting them as text would misplace Q10.
 */
function pivot(
  rows: readonly Record<string, unknown>[],
  x: string,
  y: string,
  seriesField: string,
): { labels: string[]; names: string[]; values: Map<string, (number | null)[]> } {
  const labels: string[] = [];
  const names: string[] = [];
  for (const row of rows) {
    const label = String(row[x] ?? '');
    const name = String(row[seriesField] ?? '');
    if (!labels.includes(label)) labels.push(label);
    if (name !== '' && !names.includes(name)) names.push(name);
  }
  const values = new Map<string, (number | null)[]>(names.map((n) => [n, labels.map(() => null)]));
  for (const row of rows) {
    const name = String(row[seriesField] ?? '');
    const at = labels.indexOf(String(row[x] ?? ''));
    const bucket = values.get(name);
    if (bucket !== undefined && at >= 0) bucket[at] = num(row[y]);
  }
  return { labels, names, values };
}

export function modelOf(widget: BarWidget | LineWidget | DonutWidget, baseSlot: number): ChartModel {
  if (widget.type === 'donut') {
    return {
      labels: widget.data.map((row) => String(row[widget.label_field] ?? '')),
      series: [
        {
          name: widget.title ?? widget.value_field,
          values: widget.data.map((row) => num(row[widget.value_field])),
          slot: baseSlot,
        },
      ],
      categorySlots: widget.data.map((_row, index) => index % 6),
      categoryColoured: true,
      rowsAreCategories: true,
      stacked: false,
    };
  }
  const titles = { xTitle: widget.x_title, yTitle: widget.y_title };
  if (widget.type === 'line' && widget.series !== undefined) {
    const p = pivot(widget.data, widget.x, widget.y, widget.series);
    if (p.names.length > 0) {
      return {
        ...titles,
        labels: p.labels,
        series: p.names.map((name, index) => ({
          name,
          values: p.values.get(name) ?? [],
          slot: seriesSlot(index),
        })),
        categorySlots: p.labels.map((_label, index) => index % 6),
        categoryColoured: false,
        rowsAreCategories: false,
        stacked: false,
      };
    }
  }
  const labels = widget.data.map((row) => String(row[widget.x] ?? ''));
  const grouped = widget.type === 'bar' && widget.series !== undefined ? widget.series : null;
  const series: ModelSeries[] =
    grouped !== null
      ? grouped.map((entry, index) => ({
          name: entry.label,
          values: widget.data.map((row) => num(row[entry.field])),
          slot: seriesSlot(index),
        }))
      : [
          {
            name: widget.title ?? widget.y,
            values: widget.data.map((row) => num(row[widget.y])),
            slot: baseSlot,
          },
        ];
  return {
    ...titles,
    labels,
    series,
    categorySlots: labels.map((_label, index) => index % 6),
    categoryColoured: false,
    rowsAreCategories: true,
    stacked: widget.type === 'bar' && widget.stacked === true,
  };
}

/** Several series folded to one value each — what a round form draws. */
function collapsed(model: ChartModel): ChartModel {
  if (model.series.length <= 1) return model;
  /* No axes on a round form, so `xTitle`/`yTitle` are deliberately dropped. */
  return {
    labels: model.series.map((s) => s.name),
    series: [
      {
        name: 'Total',
        values: model.series.map((s) => s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)),
        slot: 0,
      },
    ],
    categorySlots: model.series.map((s) => s.slot),
    categoryColoured: true,
    rowsAreCategories: false,
    stacked: false,
  };
}

/**
 * The form a widget opens in before the reader touches the menu — the shape
 * `widgets.tsx` would have chosen: bars run horizontal once the labels are long
 * (its `categoryAxis` rule), a trend is an area, a composition is a donut.
 */
export function defaultChartType(widget: BarWidget | LineWidget | DonutWidget): ChartType {
  if (widget.type === 'donut') return 'donut';
  if (widget.type === 'line') return 'area';
  let longest = 0;
  for (const row of widget.data) longest = Math.max(longest, String(row[widget.x] ?? '').length);
  return longest > 8 || (longest > 5 && widget.data.length > 14) ? 'hbar' : 'bar';
}

// -- Glossy marks ----------------------------------------------------------------

/**
 * The artifact's bar: a rounded rect washed light-to-base down its length, a
 * glass highlight across it, and a soft shadow under the group. Recharts hands
 * the shape its own rectangle; everything drawn here is inside it.
 */
function glossyBar(
  gid: string,
  seriesIndex: number,
  colourAt: (index: number) => string,
  horizontal: boolean,
): (props: BarShapeProps) => ReactNode {
  return function GlossyBar(props: BarShapeProps): ReactNode {
    const { x, y, width, height, index } = props;
    if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    if (width <= 0 || height <= 0) return null;
    const colour = colourAt(index);
    const top = lighten(colour, 0.18);
    const id = `${gid}-b${String(seriesIndex)}-${String(index)}`;
    const rx = Math.min(6, width / 2, height / 2);
    return (
      <g>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2={horizontal ? '1' : '0'} y2={horizontal ? '0' : '1'}>
            <stop offset="0%" stopColor={horizontal ? colour : top} />
            <stop offset="100%" stopColor={horizontal ? top : colour} />
          </linearGradient>
          {horizontal ? (
            <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fff" stopOpacity={0.45} />
              <stop offset="55%" stopColor="#fff" stopOpacity={0} />
            </linearGradient>
          ) : (
            <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#fff" stopOpacity={0.42} />
              <stop offset="50%" stopColor="#fff" stopOpacity={0.05} />
              <stop offset="100%" stopColor="#000" stopOpacity={0.08} />
            </linearGradient>
          )}
        </defs>
        <rect x={x} y={y} width={width} height={height} rx={rx} fill={`url(#${id})`} />
        <rect x={x} y={y} width={width} height={height} rx={rx} fill={`url(#${id}s)`} />
      </g>
    );
  };
}

function Glow({ id, colour, blur, dy, opacity }: { id: string; colour: string; blur: number; dy: number; opacity: number }): ReactElement {
  return (
    <filter id={id} x="-25%" y="-25%" width="150%" height="160%">
      <feDropShadow dx="0" dy={dy} stdDeviation={blur} floodColor={colour} floodOpacity={opacity} />
    </filter>
  );
}

// -- The chart ----------------------------------------------------------------------

export interface VividChartProps {
  readonly model: ChartModel;
  readonly type: ChartType;
  readonly palette: ChartPalette;
  /** Card-sized (the Dashboard grid) rather than a full report panel. */
  readonly compact?: boolean | undefined;
  /**
   * A sparkline: the artifact's small trend under a figure. No axes, no grid,
   * no dots, a short height — the shape is the whole statement, and the figure
   * beside it carries the number. Only the cartesian forms honour it.
   */
  readonly spark?: boolean | undefined;
  /** Fill the card: the cartesian forms take the height their container gives them. */
  readonly fill?: boolean | undefined;
  /**
   * A fixed height in pixels, for a caller drawing into a small box — a gauge,
   * the rings card. Every form scales into it: a round form shrinks its
   * radius, and below 140px the legend, centre readout and radar labels are
   * dropped because they have nowhere to go.
   */
  readonly height?: number | undefined;
  /** A reader clicked category `index`, on a form whose categories are rows. */
  readonly onCategoryClick?: ((index: number) => void) | undefined;
}

export function VividChart({ model, type, palette, compact, spark, fill, height: fixedHeight, onCategoryClick }: VividChartProps): ReactElement {
  const gid = `vv-${useId().replace(/:/g, '')}`;
  const animate = useChartMotion();
  const anim = { isAnimationActive: animate, animationDuration: CHART_MOTION_MS, animationEasing: 'ease-out' as const };
  const colour = (slot: number): string => paletteColour(palette, slot);

  if (model.labels.length === 0) {
    return (
      <div className="specEmpty">
        <span className="icon" aria-hidden="true">▤</span>
        <span className="msg">No records available.</span>
      </div>
    );
  }

  const clickable = onCategoryClick !== undefined && model.rowsAreCategories;

  if (type === 'donut' || type === 'pie' || type === 'polar') {
    const single = collapsed(model);
    const values = single.series[0]?.values ?? [];
    const canClick = onCategoryClick !== undefined && single.rowsAreCategories;
    const total = values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    const colours = single.labels.map((_label, i) => colour(single.categorySlots[i] ?? i));
    const legend = (
      <ul className="specDonutLegend">
        {single.labels.map((label, i) => {
          const value = values[i] ?? null;
          const share = value !== null && total > 0 ? value / total : null;
          return (
            <li key={`${label}-${String(i)}`}>
              <span className="dot" style={{ background: `linear-gradient(135deg, ${lighten(colours[i] ?? '#999', 0.16)}, ${colours[i] ?? '#999'})` }} />
              <span className="name">{label}</span>
              {share !== null && <span className="share">{Math.round(share * 100)}%</span>}
            </li>
          );
        })}
      </ul>
    );

    const roundHeight = fixedHeight ?? (compact === true ? 210 : 220);
    /** Under 160px there is no room for a key or a centre readout. */
    const tiny = roundHeight < 160;

    if (type === 'polar') {
      return (
        <>
          <PolarArea
            labels={single.labels}
            values={values}
            colours={colours}
            height={roundHeight}
            onClick={canClick ? onCategoryClick : undefined}
          />
          {!tiny && legend}
        </>
      );
    }

    const outer = Math.min(92, Math.floor(roundHeight / 2) - 4);
    const inner = type === 'donut' ? Math.round(outer * 0.63) : 0;
    const data = single.labels.map((label, i) => ({ name: label, value: values[i] ?? 0, __c: colours[i] }));
    return (
      <>
        <div className="specDonutWrap" style={{ filter: 'drop-shadow(0 5px 7px rgba(0,0,0,.14))' }}>
          <ResponsiveContainer width="100%" height={roundHeight}>
            <PieChart>
              <defs>
                {colours.map((c, i) => (
                  <radialGradient key={`${gid}-r${String(i)}`} id={`${gid}-r${String(i)}`} gradientUnits="userSpaceOnUse" cx="50%" cy="50%" r={outer}>
                    <stop offset={`${String(Math.round((inner / outer) * 100))}%`} stopColor={darken(c, 0.06)} />
                    <stop offset="45%" stopColor={c} />
                    <stop offset="80%" stopColor={lighten(c, 0.14)} />
                    <stop offset="100%" stopColor={lighten(c, 0.04)} />
                  </radialGradient>
                ))}
              </defs>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius={inner}
                outerRadius={outer}
                stroke={CARD}
                strokeWidth={3}
                {...(canClick
                  ? {
                      style: { cursor: 'pointer' },
                      onClick: (_item: unknown, index: number): void => { onCategoryClick(index); },
                    }
                  : {})}
                {...anim}
              >
                {data.map((entry, i) => (
                  <Cell key={`${entry.name}-${String(i)}`} fill={`url(#${gid}-r${String(i)})`} />
                ))}
              </Pie>
              <Tooltip content={<VividTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          {type === 'donut' && !tiny && (
            <div className={compact === true ? 'specDonutCenter specDonutCenter--compact' : 'specDonutCenter'}>
              <span className="value">{compactNum.format(total)}</span>
              <span className="label">TOTAL</span>
            </div>
          )}
        </div>
        {!tiny && legend}
      </>
    );
  }

  if (type === 'radar') {
    const radarHeight = fixedHeight ?? (compact === true ? 230 : 260);
    const tinyRadar = radarHeight < 160;
    const data = model.labels.map((label, i) => {
      const row: Record<string, string | number | null> = { __x: label };
      model.series.forEach((s, j) => { row[`s${String(j)}`] = s.values[i] ?? null; });
      return row;
    });
    return (
      <>
        {model.series.length > 1 && !tinyRadar && (
          <SeriesLegend entries={model.series.map((s) => ({ name: s.name, colour: colour(s.slot) }))} />
        )}
        <ResponsiveContainer width="100%" height={radarHeight}>
          <RadarChart data={data} outerRadius={tinyRadar ? '80%' : '72%'}>
            <defs>
              {model.series.map((s, j) => (
                <Glow key={`${gid}-rg${String(j)}`} id={`${gid}-rg${String(j)}`} colour={colour(s.slot)} blur={4} dy={3} opacity={0.3} />
              ))}
            </defs>
            <PolarGrid stroke={rgba(INK_3, 0.28)} />
            <PolarAngleAxis dataKey="__x" tick={tinyRadar ? false : { fill: INK_2, fontSize: 10 }} />
            {model.series.map((s, j) => (
              <Radar
                key={s.name}
                name={s.name}
                dataKey={`s${String(j)}`}
                stroke={colour(s.slot)}
                strokeWidth={2}
                fill={colour(s.slot)}
                fillOpacity={0.25}
                dot={{ r: 3, fill: CARD, stroke: colour(s.slot), strokeWidth: 1.6 }}
                filter={`url(#${gid}-rg${String(j)})`}
                {...anim}
              />
            ))}
            <Tooltip content={<VividTooltip />} />
          </RadarChart>
        </ResponsiveContainer>
      </>
    );
  }

  // -- cartesian: bar, hbar, line, area -----------------------------------------
  const horizontal = type === 'hbar';
  const lines = type === 'line' || type === 'area';
  const data = model.labels.map((label, i) => {
    const row: Record<string, string | number | null> = { __x: label };
    model.series.forEach((s, j) => { row[`s${String(j)}`] = s.values[i] ?? null; });
    return row;
  });
  const longest = model.labels.reduce((most, label) => Math.max(most, label.length), 0);
  const count = model.labels.length;
  const perCategory = model.categoryColoured && model.series.length === 1;
  const colourOf = (j: number, i: number): string =>
    perCategory ? colour(model.categorySlots[i] ?? i) : colour(model.series[j]?.slot ?? 0);

  const height: number | `${number}%` = fill === true
    ? '100%'
    : fixedHeight !== undefined
    ? fixedHeight
    : spark === true
    ? 64
    : horizontal
    ? clamp(40 + count * (model.series.length > 1 && !model.stacked ? 14 * model.series.length + 10 : 26), compact === true ? 170 : 190, compact === true ? 330 : 520)
    : compact === true
      ? 230
      : 270;
  const labelWidth = horizontal ? clamp(longest * 6.6 + 14, 72, 150) : 0;
  const tilt = !horizontal && longest > 6;
  /* The band an axis title needs under the ticks; nothing when there is no title. */
  const xTitleRoom = model.xTitle === undefined ? 0 : 15;

  const chartProps = clickable
    ? {
        onClick: (state: { activeTooltipIndex?: number | string | null | undefined }): void => {
          const at = typeof state.activeTooltipIndex === 'string' ? Number(state.activeTooltipIndex) : state.activeTooltipIndex;
          if (at !== null && at !== undefined && Number.isInteger(at) && at >= 0 && at < count) onCategoryClick(at);
        },
        style: { cursor: 'pointer' } as CSSProperties,
      }
    : {};

  /**
   * A sparkline hides its axes, so its titles are written around the plot
   * (`SparkAxes`); every other form draws them on the axes themselves.
   */
  const frame = (chart: ReactElement): ReactElement =>
    spark === true && (model.xTitle !== undefined || model.yTitle !== undefined)
      ? <SparkAxes model={model}>{chart}</SparkAxes>
      : chart;

  return (
    <>
      {model.series.length > 1 && (
        <SeriesLegend entries={model.series.map((s) => ({ name: s.name, colour: colour(s.slot) }))} />
      )}
      {frame(
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart
          data={data}
          layout={horizontal ? 'vertical' : 'horizontal'}
          margin={spark === true ? { top: 4, right: 4, bottom: 2, left: 4 } : { top: 8, right: 10, bottom: 2, left: 0 }}
          barGap={3}
          barCategoryGap={horizontal ? '28%' : '32%'}
          {...chartProps}
        >
          <defs>
            <Glow id={`${gid}-glow`} colour="#000" blur={5} dy={4} opacity={0.14} />
            {model.series.map((s, j) => (
              <Glow key={`${gid}-lg${String(j)}`} id={`${gid}-lg${String(j)}`} colour={colour(s.slot)} blur={6} dy={8} opacity={0.35} />
            ))}
            {model.series.map((s, j) => (
              <linearGradient key={`${gid}-a${String(j)}`} id={`${gid}-a${String(j)}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colour(s.slot)} stopOpacity={0.5} />
                <stop offset="100%" stopColor={colour(s.slot)} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          {spark !== true && (
            <CartesianGrid stroke={rgba(INK_3, 0.22)} strokeDasharray="3 3" vertical={horizontal} horizontal={!horizontal} />
          )}
          {spark === true ? (
            horizontal ? (
              <>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="__x" hide />
              </>
            ) : (
              <>
                <XAxis dataKey="__x" hide />
                <YAxis hide />
              </>
            )
          ) : horizontal ? (
            <>
              <XAxis type="number" tick={{ fill: INK_2, fontSize: 10 }} tickFormatter={(v: number) => compactNum.format(v)} axisLine={false} tickLine={false} height={26 + (model.yTitle === undefined ? 0 : 14)}>
                {axisTitle(model.yTitle, 'bottom')}
              </XAxis>
              <YAxis
                type="category"
                dataKey="__x"
                width={labelWidth + (model.xTitle === undefined ? 0 : 14)}
                interval={0}
                tick={<CategoryTick maxChars={Math.floor((labelWidth - 14) / 6.6)} />}
                axisLine={false}
                tickLine={false}
              >
                {axisTitle(model.xTitle, 'left')}
              </YAxis>
            </>
          ) : (
            <>
              <XAxis
                dataKey="__x"
                tick={{ fill: INK_2, fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={8}
                {...(tilt
                  ? { angle: -35, textAnchor: 'end' as const, height: clamp(longest * 4.8 + 26, 40, 76) + xTitleRoom, tickMargin: 6 }
                  : { height: 30 + xTitleRoom, tickMargin: 8 })}
              >
                {axisTitle(model.xTitle, 'bottom')}
              </XAxis>
              <YAxis tick={{ fill: INK_2, fontSize: 10 }} tickFormatter={(v: number) => compactNum.format(v)} axisLine={false} tickLine={false} width={46 + (model.yTitle === undefined ? 0 : 14)}>
                {axisTitle(model.yTitle, 'left')}
              </YAxis>
            </>
          )}
          <Tooltip
            content={<VividTooltip xTitle={model.xTitle} />}
            cursor={lines ? { stroke: INK_3, strokeWidth: 1, strokeDasharray: '3 3' } : { fill: 'rgba(30,42,56,0.05)' }}
          />
          {lines
            ? model.series.flatMap((s, j) => {
                const c = colour(s.slot);
                const key = `s${String(j)}`;
                const parts: ReactElement[] = [];
                if (type === 'area') {
                  parts.push(<Area key={`${key}-a`} type="monotone" dataKey={key} name={s.name} stroke="none" fill={`url(#${gid}-a${String(j)})`} legendType="none" tooltipType="none" connectNulls={false} {...anim} />);
                }
                parts.push(
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={s.name}
                    stroke={c}
                    strokeWidth={spark === true ? 2 : compact === true ? 2.2 : 2.5}
                    strokeLinecap="round"
                    filter={`url(#${gid}-lg${String(j)})`}
                    dot={spark === true ? false : { r: 3.5, fill: CARD, stroke: c, strokeWidth: 2 }}
                    activeDot={{ r: 5, fill: c, stroke: CARD, strokeWidth: 2 }}
                    connectNulls={false}
                    {...anim}
                  />,
                );
                return parts;
              })
            : model.series.map((s, j) => (
                <Bar
                  key={`s${String(j)}`}
                  dataKey={`s${String(j)}`}
                  name={s.name}
                  maxBarSize={spark === true ? 8 : horizontal ? 14 : 22}
                  shape={glossyBar(gid, j, (i) => colourOf(j, i), horizontal)}
                  filter={`url(#${gid}-glow)`}
                  {...(model.stacked ? { stackId: 'a' } : {})}
                  animationBegin={j * 90}
                  {...anim}
                >
                  {perCategory &&
                    model.labels.map((label, i) => <Cell key={`${label}-${String(i)}`} fill={colourOf(j, i)} />)}
                </Bar>
              ))}
        </ComposedChart>
      </ResponsiveContainer>,
      )}
    </>
  );
}

/** A category tick that truncates rather than wraps; the full name is on hover. */
function CategoryTick({
  x = 0,
  y = 0,
  payload,
  maxChars = 20,
}: {
  readonly x?: number;
  readonly y?: number;
  readonly payload?: { value?: unknown };
  readonly maxChars?: number;
}): ReactElement {
  const text = String(payload?.value ?? '');
  const shown = text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill={INK_2} fontSize={10}>
      <title>{text}</title>
      {shown}
    </text>
  );
}

/**
 * A polar-area chart — the artifact's "Spiral": equal angles, radius by value.
 * Hand-drawn SVG because Recharts has no per-wedge radius on a `Pie`, and
 * twelve lines of trigonometry are less to carry than a workaround.
 */
function PolarArea({
  labels,
  values,
  colours,
  height,
  onClick,
}: {
  readonly labels: readonly string[];
  readonly values: readonly (number | null)[];
  readonly colours: readonly string[];
  readonly height: number;
  readonly onClick: ((index: number) => void) | undefined;
}): ReactElement {
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const R = 100;
  const n = labels.length;
  const max = values.reduce<number>((most, v) => Math.max(most, v ?? 0), 0);
  const step = (Math.PI * 2) / n;
  const start = -Math.PI / 2;
  return (
    <div style={{ height, display: 'flex', justifyContent: 'center', filter: 'drop-shadow(0 5px 7px rgba(0,0,0,.14))' }}>
      <svg viewBox={`0 0 ${String(size)} ${String(size)}`} height={height} width="100%" role="img" aria-label="Polar area chart">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <circle key={f} cx={cx} cy={cy} r={R * f} fill="none" stroke={rgba(INK_3, 0.28)} strokeDasharray="3 3" />
        ))}
        {labels.map((label, i) => {
          const value = values[i] ?? 0;
          const r = max > 0 ? Math.max(3, (value / max) * R) : 0;
          const a0 = start + i * step;
          const a1 = a0 + step;
          const x0 = cx + r * Math.cos(a0);
          const y0 = cy + r * Math.sin(a0);
          const x1 = cx + r * Math.cos(a1);
          const y1 = cy + r * Math.sin(a1);
          const large = step > Math.PI ? 1 : 0;
          const d = n === 1
            ? `M ${String(cx)} ${String(cy - r)} A ${String(r)} ${String(r)} 0 1 1 ${String(cx - 0.01)} ${String(cy - r)} Z`
            : `M ${String(cx)} ${String(cy)} L ${String(x0)} ${String(y0)} A ${String(r)} ${String(r)} 0 ${String(large)} 1 ${String(x1)} ${String(y1)} Z`;
          return (
            <path
              key={`${label}-${String(i)}`}
              d={d}
              fill={colours[i] ?? '#999'}
              fillOpacity={0.88}
              stroke={CARD}
              strokeWidth={1.5}
              style={onClick === undefined ? undefined : { cursor: 'pointer' }}
              onClick={onClick === undefined ? undefined : () => { onClick(i); }}
            >
              <title>{`${label}: ${fullNum.format(value)}`}</title>
            </path>
          );
        })}
      </svg>
    </div>
  );
}
