/**
 * The widget renderers — one implementation per chart-spec widget type.
 *
 * [MANDATORY] ADR-015 / CODING_GUIDELINES §4: this is the ONLY place a spec
 * becomes pixels. There is no second charting approach for one screen, and
 * nothing here ever renders a string as markup — every value reaches the DOM as
 * a text child, so a spec is data even when it came from a model.
 *
 * -- Why the renderer lives in the contract package --------------------------
 * CODING_GUIDELINES §18 names `/packages/chart-spec` as the seam for ALL
 * rendering, and ADR-021 requires the PDF to be produced from the same spec by
 * the same layer so screen and export cannot disagree. A renderer living in
 * `apps/web` would have to be duplicated by the PDF service, and the first
 * divergence between the two copies would be a report that prints differently
 * from how it was approved on screen.
 *
 * The package exposes it on a `./react` subpath so Node services that only need
 * the TYPES (the orchestrator builds specs; it does not draw them) never pull
 * React into their dependency graph.
 *
 * -- Chart library ------------------------------------------------------------
 * Recharts. PROJECT_CONTEXT §7 already fixes "a Recharts/Chart.js-class chart
 * layer rendering chart-spec", so having one is settled and only the vendor was
 * open; picked 2026-08-19 for declarative React components (no canvas refs or
 * imperative lifecycle to manage) and because it renders to SVG, which the
 * server-side PDF path can produce without a live canvas. A technology choice
 * inside an existing seam, not a contract change — so no ADR, recorded here.
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { useId, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_MOTION_MS, useChartMotion } from './ChartMotion.js';
import { widgetSchema } from '../spec.js';
import type {
  BarSeries,
  BarWidget,
  Tone,
  DonutWidget,
  KpiWidget,
  LineWidget,
  TableWidget,
  Widget,
} from '../spec.js';

/**
 * docs/10 §1: the platform palette, capped at four categorical steps.
 *
 * The previous seven-colour rotation failed a CVD/contrast audit: adjacent
 * slots #02c39a/#00a896 sat ΔE 7.9 apart under normal vision (floor is 15) —
 * two teal-family steps that close together are indistinguishable at
 * chart-mark size, colourblind or not. docs/10 §1.2 mandates a teal-family
 * chart language, which rules out reaching for an unrelated hue to fix the
 * spacing; the fix is fewer, further-apart steps instead. This four-colour
 * set is the largest subset of the existing brand tokens that clears the
 * CVD-separation and normal-vision-floor checks (validated 2026-08-22).
 * Categories beyond these four are never a fifth generated hue — see
 * `SERIES_OTHER` below.
 */
const SERIES: readonly [string, ...string[]] = ['#028090', '#02c39a', '#f2a93b', '#e05252'];
/**
 * The fold-in colours for categories past the fixed palette — neutrals, so a
 * fifth category reads as "the rest" rather than competing with the four that
 * carry meaning. Never a GENERATED hue (the dataviz non-negotiable): these are
 * two existing tokens, `--color-muted` and `--color-line`.
 *
 * Two of them, not one, because of stacked bars. A single fold-in colour is fine
 * when the extra categories sit apart — a fifth donut slice, a fifth bar in a
 * group — and wrong inside one stacked bar, where two adjacent segments painted
 * the same grey are one segment as far as a reader can tell. Comparative
 * Analysis' recovery timeline is exactly that case: "still pending" and "timing
 * not recorded" are its fifth and sixth states.
 *
 * They alternate rather than extend, so this is not a sixth and seventh
 * categorical step by the back door — the palette is still four steps plus a
 * neutral pair, and anything past six is deliberately repeating.
 */
const SERIES_NEUTRALS: readonly [string, string] = ['#64748b', '#cbd5e1'];
/** The single fold-in neutral, where only one is needed (donut legend, etc.). */
const SERIES_OTHER = SERIES_NEUTRALS[0];

/** The colour of the nth series: the fixed palette, then the neutrals. */
function seriesColourAt(index: number): string {
  return (
    SERIES[index] ??
    SERIES_NEUTRALS[(index - SERIES.length) % SERIES_NEUTRALS.length] ??
    SERIES_OTHER
  );
}

/**
 * A single-series bar/line's colour, for callers that want visual variety
 * across SEVERAL single-series charts shown together (Home's preview grid)
 * without inventing a hue outside the CVD-audited four above. Deliberately
 * NOT part of the chart-spec contract (spec.ts) -- it is how a caller
 * presents a widget, not a fact the widget's data carries, so a caller that
 * passes nothing (every full dashboard and the PDF path) gets exactly
 * `SERIES[0]`, pixel-identical to before this existed.
 *
 * Named `primary`/`secondary` rather than reusing `KpiWidget['tone']`
 * (`neutral`/`positive`/`warning`/`negative`) on purpose: tone claims the
 * NUMBER is good or bad news, which is true for a KPI's delta and not true
 * for, say, which teal step a headcount-by-department bar happens to be
 * drawn in. `warning`/`negative` are kept because those two really do carry
 * meaning here too (docs/10 §1 token table: amber = warnings, red =
 * defaulter counts) -- callers only reach for them when that meaning
 * actually applies.
 */
export type ChartAccent = 'primary' | 'secondary' | 'warning' | 'negative';
const ACCENT_COLOUR: Record<ChartAccent, string> = {
  primary: SERIES[0],
  secondary: SERIES[1] ?? SERIES[0],
  warning: SERIES[2] ?? SERIES[0],
  negative: SERIES[3] ?? SERIES[0],
};
const AXIS: CSSProperties = { fontSize: 11 };
const GRID = '#e2e8f0';
const MUTED = '#64748b';
const INK = '#032e36';

const tick = { fill: MUTED, fontSize: 11 };

/** Numbers are read as quantities, so they are grouped Indian-style. */
const compactNum = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en-IN');

function axisNumber(value: number): string {
  return compactNum.format(value);
}

/**
 * Entry animation is OFF unless something explicitly turns it on.
 *
 * It used to be off unconditionally (`const ANIMATE = false`), for a reason
 * that has not changed: the same renderer draws the screen and the PDF
 * (ADR-021), and a PDF is a PHOTOGRAPH. Puppeteer once captured a donut
 * mid-grow and produced a report with an empty circle and a legend under it —
 * a chart that looked like a panel with no data rather than one that had not
 * finished drawing. Waiting out an animation would be a timer, and this
 * codebase waits for facts.
 *
 * What changed is only WHERE that decision is made. `useChartMotion()` reads a
 * context that defaults to `false`, and `print.tsx` provides no value — so the
 * export still cannot animate, and cannot be made to by editing this file.
 * See ChartMotion.tsx for why the default carries the safety property.
 */
function useAnimation(): { readonly isAnimationActive: boolean; readonly animationDuration: number } {
  return { isAnimationActive: useChartMotion(), animationDuration: CHART_MOTION_MS };
}

/**
 * A stable id for an `<svg><defs>` gradient, scoped to one chart instance.
 *
 * `useId()` returns colons (":r0:"), which are legal in an SVG id but break
 * the `url(#id)` paint reference in some renderers unless the fragment is
 * quoted — stripped here so the id is plain alphanumerics and every caller
 * can reference it the same, simpler way.
 */
function useGradientId(prefix: string): string {
  return `${prefix}-${useId().replace(/:/g, '')}`;
}

interface TooltipPayloadEntry {
  readonly name?: string | number;
  readonly value?: number | string;
  readonly color?: string;
  readonly dataKey?: string | number;
  readonly payload?: { readonly fill?: string };
}

/**
 * Replaces Recharts' default tooltip box, which doesn't share the product's
 * card styling (docs/10 §1) — border, radius and shadow all drift from the
 * `.card` the panel itself sits in. Pointer-driven only, so a headless PDF
 * capture (which never moves a mouse) never renders it — it needs no equivalent
 * of `useChartMotion()`'s default-off guard, because there is no pointer on the
 * print surface to trigger it in the first place.
 */
function ChartTooltip({
  active,
  label,
  payload,
}: {
  readonly active?: boolean;
  readonly label?: string | number;
  readonly payload?: readonly TooltipPayloadEntry[];
}): ReactElement | null {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  return (
    <div className="specTooltip">
      {label !== undefined && <div className="specTooltipLabel">{String(label)}</div>}
      {payload.map((entry, index) => (
        <div className="specTooltipRow" key={String(entry.dataKey ?? entry.name ?? index)}>
          <span
            className="specTooltipDot"
            style={{ background: entry.color ?? entry.payload?.fill ?? MUTED }}
          />
          {entry.name !== undefined && <span className="specTooltipName">{entry.name}</span>}
          <span>{full.format(Number(entry.value))}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Reads the SIGN already present in a server-formatted delta string ("+12.4%",
 * "-3.1 pts") to decide the pill's colour and arrow. This is presentation of a
 * fact the server already computed, not a client-side trend calculation — a
 * widget with no `delta` renders no pill at all rather than a fabricated one
 * (§4 "do not add fake trends").
 */
function deltaDirection(delta: string): 'up' | 'down' | 'flat' {
  const trimmed = delta.trim();
  if (trimmed.startsWith('+')) return 'up';
  if (trimmed.startsWith('-') || trimmed.startsWith('−')) return 'down';
  return 'flat';
}

const DELTA_ARROW: Record<'up' | 'down' | 'flat', string> = { up: '▲', down: '▼', flat: '•' };

/**
 * One metric, one tile — the same tile everywhere, at the same size (§22).
 *
 * -- Why there is no headline tile any more (2026-09-01) ---------------------
 * The first tile in a strip used to render double-width at a 36px figure. The
 * intent was a reading order, but a strip is already read left to right, and
 * what the width actually produced was a row that looked broken: on Dashboard's
 * four cards, one 2× tile beside three 1× tiles reads as a layout accident
 * before it reads as emphasis, and the eye goes to the odd shape rather than to
 * the number in it.
 *
 * Emphasis a strip can carry without breaking its own grid: ORDER, which is
 * still the server's (`spec.widgets`, held as contract in
 * test/home-summary.test.ts), and `tone`, which colours the left edge from
 * meaning the server assigned. Both survive a tile changing size; a hard-coded
 * 2× span does not survive the strip growing by one card, which is what the old
 * "hero up to five tiles, none at six" rule was already conceding.
 */
export function KpiTile({ widget }: { widget: KpiWidget }): ReactElement {
  const tone = widget.tone ?? 'neutral';
  const direction = widget.delta !== undefined ? deltaDirection(widget.delta) : null;
  return (
    <div className={`card kpi kpi--${tone}`}>
      <span className="kpiLabel">{widget.label}</span>
      <b className="kpiValue" style={{ color: toneColour(widget.tone) }}>
        {widget.value}
      </b>
      {widget.delta !== undefined && direction !== null && (
        <span className={`kpiDelta ${direction}`}>
          <span aria-hidden="true">{DELTA_ARROW[direction]}</span>
          {widget.delta}
        </span>
      )}
      {/**
        * The parts of the figure above, on one row beneath it.
        *
        * Rendered as a definition list because that is what it is — a set of
        * label/value pairs qualifying one headline number — and a screen reader
        * then announces "Girls, 4,812" as a pair instead of reading a wall of
        * loose text. `.kpiPartValue` carries `tabular-nums` for the same reason
        * `.kpiValue` does: these sit in a row and digits that do not line up
        * read as sloppy at a glance.
        *
        * No tone is applied unless the server sent one. A breakdown is mostly
        * neutral description — "Boys" and "Girls" are not good and bad news —
        * and colouring parts by default would invent a judgement the data does
        * not carry. Fees pending is the case that DOES want it, and it says so
        * in its own spec.
        */}
      {widget.breakdown !== undefined && (
        <dl className="kpiBreakdown">
          {widget.breakdown.map((part) => (
            <div key={part.label} className="kpiPart">
              <dt className="kpiPartLabel">{part.label}</dt>
              <dd className="kpiPartValue" style={{ color: toneColour(part.tone) }}>
                {part.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Category labels decide which way the bars run.
 *
 * A panel here is ~340–450px wide (`.specPanels` is a `minmax(340px, 1fr)`
 * grid), so twenty department names — "ADHOC OFFICE STAFF(A.O.S)" is 25
 * characters — get about 20px of axis each. No rotation angle rescues that;
 * rotated long labels overlap, then get clipped by the axis band, and the chart
 * stops being readable at all.
 *
 * Turning the bars horizontal gives every label its own line at 0°, which is
 * the standard answer for categorical comparison with long or numerous names.
 * Short ordinal axes — class I…XII, months — stay vertical, because their shape
 * across the sequence is the thing being read and rotating six-character labels
 * costs nothing.
 *
 * The thresholds are about LABEL WIDTH, not category count: five bands read
 * horizontally too when one of them is "No due date recorded".
 *
 * The same budget now also sizes Home's compact preview cards (2-up,
 * tokens.css `.pgallery`, ~900px each) — wider than a full dashboard panel,
 * never narrower, so nothing here needed a compact-specific number.
 */
/**
 * How thick a bar is drawn, in pixels. A CAP, not a width: Recharts sizes a bar
 * from its category band and this only stops it growing past here, so a chart
 * with many categories still thins out on its own.
 *
 * -- Why these numbers went up (2026-09-01) ----------------------------------
 * Horizontal bars were 14px single / 11px grouped. In a Home preview card that
 * drew three schools as three hairlines with far more air than ink, and a
 * preview that does not read as a chart is a card that does not earn its click.
 * The complaint the change came from was that the bars looked flat and cheap
 * next to the prototype's; the prototype's bars are not shaded or bevelled, they
 * are simply THICK, solid and rounded at the tip, and thickness is nearly all of
 * that impression.
 *
 * 22px is the ceiling on purpose. A mark much past ~24px stops being a bar and
 * becomes a block: it fills its band, the air between categories disappears, and
 * a row of blocks reads louder than the numbers it carries. The band's leftover
 * is meant to be air — so these grew to the top of that range and stopped there,
 * and `perRow` below grew with them so the air came back rather than being eaten.
 *
 * A grouped bar is thinner than a single one because three of them share one
 * band; `barGap={2}` keeps the 2px surface gap between them, which is what makes
 * three fills read as three marks without a stroke drawn around each.
 *
 * Vertical columns were already in this range (38/26) and are unchanged — the
 * complaint was never about them, and they have a whole column's height to give
 * the mark presence that a horizontal bar has to get from thickness.
 */
const BAR_PX = {
  /** One measure, bars running horizontally. */
  single: 22,
  /** One measure per band, columns running vertically. */
  singleV: 38,
  /** One of several measures sharing a horizontal band. */
  grouped: 16,
  /** One of several measures sharing a vertical band. */
  groupedV: 26,
} as const;

function categoryAxis(rows: readonly Record<string, unknown>[], field: string) {
  let longest = 0;
  for (const row of rows) longest = Math.max(longest, String(row[field] ?? '').length);
  return { count: rows.length, longest, horizontal: longest > 8 || (longest > 5 && rows.length > 14) };
}

/**
 * Width budget per character at 11px Inter, rounded UP for capitals.
 *
 * The ERP's dimension values arrive shouting — TEACHING, ADHOC OFFICE
 * STAFF(A.O.S), CONFIRMATION — and uppercase runs ~7.2px a glyph where mixed
 * case runs ~6.2px. Budgeting at the lowercase rate is what makes a label
 * "fit" by arithmetic and wrap in the browser.
 */
const CHAR_PX = 7.4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Air between two rotated labels, on top of the room the labels themselves take.
 *
 * 8px rather than Recharts' default 5, because these axes are read at a glance
 * across a wide panel and touching labels read as one string. It is a gap, not a
 * slot: the width of the label is measured and added by Recharts (see below).
 */
const TICK_GAP_PX = 8;

/**
 * How a rotated category axis thins its labels when they will not all fit.
 *
 * -- What went wrong without this ---------------------------------------------
 * Every rotated axis here passed `interval={0}`, which is an instruction to draw
 * EVERY label whatever the width — not a default, a demand. That was invisible
 * while the longest axis on the platform was twelve classes or four quarters,
 * and became unreadable the moment Trend Analysis drew 78 months across one
 * panel: at ~16px of axis each, the dates overprint into a grey smear and a
 * reader cannot recover a single one of them. Recharts had no licence to
 * intervene; it was told to draw them all, and it did.
 *
 * -- Why the thinning is Recharts' job and not arithmetic here ----------------
 * This module does not know how wide the panel is. A grid panel is ~340-450px, a
 * `wide` line spans two thirds of the page and a `hero` the whole of it, and all
 * three are `width="100%"` inside a `ResponsiveContainer` — so any constant
 * chosen here would be right for one variant and wrong for the other two.
 * Recharts knows the width at layout time, and `preserveStartEnd` is its own API
 * for exactly this: keep the first and last, drop what will not fit between.
 *
 * -- The correction this deliberately does NOT make ---------------------------
 * An earlier attempt subtracted the label's width from `minTickGap`, on the
 * assumption that Recharts measures ticks unrotated and would therefore reserve
 * far too much room for a −35° label. It does not: `getTicks` calls
 * `getAngledTickWidth(size, unitSize, angle)` and already reserves the label's
 * true horizontal extent (recharts/lib/cartesian/getTicks.js). The subtraction
 * cancelled the thinning almost exactly — required gap fell to ~10px against
 * ~16px available, so nothing was dropped and the axis stayed a smear. The
 * geometry is already handled; what is left to say is only how much air to leave.
 *
 * Preserving the START and END is the half that matters for a time series: an
 * axis that dropped "Apr 2020" and "Aug 2026" would lose the two labels a reader
 * looks for first — where the history begins and where it stops.
 *
 * An axis whose labels already fit is untouched. Nothing is dropped when there is
 * room, so twelve classes and four quarters render exactly as they did.
 */
const rotatedTicks = {
  interval: 'preserveStartEnd',
  minTickGap: TICK_GAP_PX,
} as const;

/**
 * A category tick that cannot wrap.
 *
 * Recharts' default tick is its `<Text>` component, which WRAPS to a second
 * line when the string exceeds the axis width — and a wrapped label overlaps
 * the rows above and below it, which is worse than the ellipsis it was trying
 * to avoid. No arithmetic fixes that reliably: the wrap point depends on the
 * browser's own text metrics, so a per-character estimate is always one long
 * department name away from being wrong.
 *
 * A plain `<text>` never wraps, so truncation here is the only behaviour there
 * is. The `<title>` child gives the untruncated name on hover — the axis
 * abbreviates, the name is never lost.
 */
interface TickProps {
  readonly x?: number;
  readonly y?: number;
  readonly payload?: { value?: unknown };
  readonly maxChars?: number;
}

function CategoryTick({ x = 0, y = 0, payload, maxChars = 24 }: TickProps): ReactElement {
  const text = String(payload?.value ?? '');
  const shown = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill={MUTED} fontSize={11}>
      <title>{text}</title>
      {shown}
    </text>
  );
}

/**
 * Wraps a chart's `ResponsiveContainer` so a COMPACT card's chart can grow to
 * fill whatever height the CSS grid row stretches its card to (`.pgallery`
 * stretches every card in a row to match the tallest one, e.g. a
 * many-department bar chart) instead of sitting at a fixed pixel height with
 * dead space below it. `naturalHeight` is what the chart would be standing
 * alone — still applied as a CSS `min-height` (tokens.css `.specChartFill`),
 * so nothing changes for a card with no taller neighbour. The full dashboard
 * and the PDF (`compact` unset) are untouched: a plain `ResponsiveContainer`
 * at its original fixed height, exactly as before this existed.
 *
 * -- Why the stretch is now BOUNDED (2026-09-01) -----------------------------
 * It was unbounded, and the 2-up grid made that visible: a 3-school Enrollment
 * card sharing a row with an 8-department Staff Overview was stretched to the
 * taller card's height, so three 22px bars sat in 390px with ~110px of blank
 * band between them. That is not a chart breathing, it is a chart coming apart
 * — the bars stop reading as one series because nothing visually groups them.
 *
 * 1.3× is the ceiling: enough that a card an inch taller than its neighbour
 * still fills, which is the case this wrapper was written for, and not so much
 * that a 3-row chart can be stretched to an 8-row one's height. Past the
 * ceiling the leftover goes back to being space under the chart. Dead space at
 * the bottom of a card is a smaller problem than a chart whose own rows have
 * drifted apart, and it is the one the reader does not notice.
 */
function ChartFrame({
  compact,
  naturalHeight,
  children,
}: {
  compact: boolean | undefined;
  naturalHeight: number;
  children: ReactElement;
}): ReactElement {
  if (compact === true) {
    return (
      <div
        className="specChartFill"
        style={{ minHeight: naturalHeight, maxHeight: Math.round(naturalHeight * 1.3) }}
      >
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={naturalHeight}>
      {children}
    </ResponsiveContainer>
  );
}

/**
 * The tallest bar, so a chart with a genuine standout can say so visually
 * (§8 "highlighting of the highest category when analytically meaningful").
 * Only computed with more than one bar — a single-category chart has no
 * "highest" to point at, and pointing at it anyway would be decoration, not
 * an observation.
 */
function maxValueIndex(rows: readonly Record<string, unknown>[], field: string): number | null {
  if (rows.length < 2) return null;
  let best = -1;
  let bestValue = -Infinity;
  rows.forEach((row, index) => {
    const value = row[field];
    if (typeof value === 'number' && value > bestValue) {
      bestValue = value;
      best = index;
    }
  });
  return best >= 0 ? best : null;
}

/**
 * One drill click, as ADR-020 defines it: a `{dim, value}` pair pushed onto the
 * drill stack, plus the text the breadcrumb should show for it.
 *
 * `label` is separate from `value` because they are not always the same string
 * — a school drills on its id and reads as its name — and a breadcrumb built
 * from the id would name a slice nobody recognises. The renderer reports the
 * click; deciding what to fetch next belongs to the caller, which owns the
 * drill path (services/dashboards.ts `DRILL_PATHS`).
 */
export interface DrillTarget {
  readonly dim: string;
  readonly value: string;
  readonly label: string;
}

export type DrillHandler = (target: DrillTarget) => void;

/**
 * The Recharts click state, narrowed to the one field this file reads.
 * Recharts' own `CategoricalChartState` is not exported from its public types,
 * and the alternative — `any` on a click handler — is exactly the shape §3
 * refuses.
 */
interface ChartClickState {
  /**
   * Recharts types this as `number | TooltipIndex | undefined`, where
   * `TooltipIndex` widens to a string or null. Accepted as it really is and
   * narrowed in `drillTargetAt`, rather than declared as a number here and
   * cast — a cast would move the same uncertainty somewhere it cannot be
   * checked.
   */
  readonly activeTooltipIndex?: number | string | null | undefined;
}

/**
 * Turn a click on category N into the pair the caller pushes.
 *
 * Reads the ROW, not the label Recharts hands back: `drill_value_field` lets a
 * chart display one string and narrow on another (a school's name versus its
 * id), and a drill built from the visible label would silently depend on those
 * being the same. Returns null when the widget is not drillable, when the index
 * is out of range, or when the row has no usable value — a click that cannot be
 * turned into a bound parameter must do nothing rather than something
 * approximate.
 */
function drillTargetAt(
  widget: {
    data: readonly Record<string, unknown>[];
    x: string;
    drillable?: boolean | undefined;
    drill_dim?: string | undefined;
    drill_value_field?: string | undefined;
  },
  index: number | string | null | undefined,
): DrillTarget | null {
  if (widget.drillable !== true || widget.drill_dim === undefined) return null;
  const at = typeof index === 'string' ? Number(index) : index;
  if (at === null || at === undefined || !Number.isInteger(at)) return null;
  if (at < 0 || at >= widget.data.length) return null;
  const row = widget.data[at];
  if (row === undefined) return null;
  const label = String(row[widget.x] ?? '');
  const raw = row[widget.drill_value_field ?? widget.x];
  if (raw === null || raw === undefined) return null;
  const value = String(raw);
  if (value === '') return null;
  return { dim: widget.drill_dim, value, label: label === '' ? value : label };
}

/**
 * The measures a bar chart draws, as a list, whether or not it is grouped.
 *
 * A single-series bar is the one-element case rather than a separate concept,
 * so the axis-sizing arithmetic and the click handling below have ONE shape to
 * reason about. What stays separate is the PAINT: a lone series keeps its
 * gradient and tallest-bar highlight (devices that mean "compare within this
 * chart"), which would read as noise once three colours are already carrying
 * identity.
 */
function seriesOf(widget: BarWidget): readonly BarSeries[] {
  return widget.series ?? [{ field: widget.y, label: widget.title ?? widget.y }];
}

/**
 * The colour a data-bound chart draws in.
 *
 * `tone` wins over `accent` when both are present, and the precedence is the
 * point: `accent` is variety chosen by the page showing the chart, `tone` is
 * what the measure IS (spec.ts). A caller cycling colours across a preview grid
 * must not be able to paint overdue money in the teal it uses for headcounts —
 * meaning outranks arrangement. Neither present is the platform teal every
 * chart has always been.
 */
function measureColour(tone: Tone | undefined, accent: ChartAccent | undefined): string {
  if (tone !== undefined && tone !== 'neutral') return toneColour(tone);
  return ACCENT_COLOUR[accent ?? 'primary'];
}

export function BarPanel({
  widget,
  compact,
  accent,
  actions,
  onDrill,
}: {
  widget: BarWidget;
  /** Card-sized: shorter than the full dashboard panel, real axes (Home preview cards). */
  compact?: boolean | undefined;
  /** Single-series colour, Home preview cards only -- see `ChartAccent`. Ignored by a grouped bar, whose colours carry series identity rather than variety. */
  accent?: ChartAccent | undefined;
  actions?: ReactNode | undefined;
  /**
   * Called when a reader clicks a category, for a `drillable` widget (ADR-020).
   * Absent means the chart is inert -- which is how the PDF route renders it
   * (print.tsx passes nothing), so an export can never carry a dead affordance.
   */
  onDrill?: DrillHandler | undefined;
}): ReactElement {
  const series = seriesOf(widget);
  const grouped = widget.series !== undefined;
  /**
   * The measures are PARTS of one bar rather than bars beside each other
   * (spec.ts, `bar.stacked`). The schema already guarantees `series` is present
   * whenever this is true, so everything below can treat it as a variation of
   * the grouped case rather than a third kind of chart.
   */
  const stacked = grouped && widget.stacked === true;
  const seriesColour = measureColour(widget.tone, accent);
  /**
   * Is this panel a level of a drill path (ADR-020)? True at every level: level
   * 1 declares `drillable`, and a level reached by clicking carries the context
   * that got it there — the leaf included, which declares `drillable: false`.
   *
   * It decides the panel's FOOTPRINT, below, and nothing else.
   */
  const drillPanel =
    widget.drillable === true || (widget.drill_context ?? []).length > 0;
  /**
   * A depth gradient built from ONE hue at two opacities, never a second
   * colour -- so it stays inside docs/10 section 1's "teal-family series" rule
   * and costs nothing on the CVD audit (opacity, unlike hue, isn't a channel a
   * colour-vision deficiency affects). Solid at the value end, softer toward
   * the baseline, so the gradient points at the number that matters.
   *
   * Single-series only. With three colours already spending the reader's
   * attention on identity, a fourth signal drawn in opacity is decoration.
   */
  const gradId = useGradientId('bar');
  // Placed beside the existing hook so hook ORDER is unchanged from before.
  const animation = useAnimation();

  /**
   * Both hooks run before the empty check, unconditionally. React requires the
   * same hooks in the same order on every render, and an early `return` above
   * a `useId()` would break that the first time a widget went from having rows
   * to having none -- a filter change, or a drill into an empty slice, which is
   * exactly when this chart is most likely to be re-rendered.
   */
  if (widget.data.length === 0) {
    return (
      <Panel
        title={widget.title}
        variant={drillPanel ? 'wide' : 'medium'}
        compact={compact}
        actions={actions}
      >
        <div className="specEmpty">
          <span className="icon" aria-hidden="true">▤</span>
          <span className="msg">No records available.</span>
        </div>
      </Panel>
    );
  }

  const axis = categoryAxis(widget.data, widget.x);
  const highlightIndex = grouped ? null : maxValueIndex(widget.data, widget.y);

  /** Live only when the spec says drillable AND the caller wants the clicks. */
  const drillable =
    widget.drillable === true && widget.drill_dim !== undefined && onDrill !== undefined;
  /**
   * Cursor and click sit on the CHART, not on the panel: the title and the
   * "Clone" button beside it are not drill targets, and a pointer cursor over
   * the whole card would promise a click that does nothing there.
   */
  const chartProps = drillable
    ? {
        onClick: (state: ChartClickState): void => {
          const target = drillTargetAt(widget, state.activeTooltipIndex);
          if (target !== null) onDrill?.(target);
        },
        style: { cursor: 'pointer' } as CSSProperties,
      }
    : {};

  /**
   * The bars themselves. Grouped bars are flat fills in the fixed docs/10
   * section 1 order (`SERIES`) -- colour carries series identity, so it must
   * not also depend on which series happens to be tallest, and removing one
   * series must never repaint the survivors.
   *
   * `barGap` is the 2px surface gap that keeps adjacent fills readable as two
   * marks rather than one wide one; the category gap Recharts defaults to is
   * already wider, which is what makes the grouping legible without a box
   * around it.
   */
  const bars = grouped
    ? series.map((entry, index) => {
        /**
         * Only the segment at the VALUE end of a stack is rounded; rounding
         * every segment would draw four capsules with gaps of background
         * between them, which reads as four bars — the exact misreading
         * stacking exists to prevent. An unstacked group rounds each bar,
         * because each one really is its own mark.
         */
        const last = index === series.length - 1;
        const square: [number, number, number, number] = [0, 0, 0, 0];
        /**
         * 4px at the DATA end, square at the baseline. Both halves of that
         * matter: the rounded cap is what stops a bar reading as a bare rule,
         * and the square foot is what keeps every bar starting from one shared
         * line — a capsule rounded at both ends floats off its own axis and the
         * eye has to guess where the measurement begins.
         */
        const rounded: [number, number, number, number] = axis.horizontal
          ? [0, 4, 4, 0]
          : [4, 4, 0, 0];
        return (
          <Bar
            key={entry.field}
            dataKey={entry.field}
            name={entry.label}
            fill={seriesColourAt(index)}
            {...(stacked ? { stackId: 'a' } : {})}
            radius={stacked ? (last ? rounded : square) : rounded}
            /**
             * A stack is ONE bar per category however many measures it holds,
             * so it gets the width a single-series bar would have rather than
             * the narrow band a member of a group gets.
             */
            maxBarSize={
              stacked
                ? axis.horizontal
                  ? BAR_PX.single
                  : BAR_PX.singleV
                : axis.horizontal
                  ? BAR_PX.grouped
                  : BAR_PX.groupedV
            }
            {...animation}
            activeBar={{ stroke: INK, strokeWidth: 1 }}
          />
        );
      })
    : [
        <Bar
          key={widget.y}
          dataKey={widget.y}
          fill={`url(#${gradId})`}
          radius={axis.horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
          maxBarSize={axis.horizontal ? BAR_PX.single : BAR_PX.singleV}
          {...animation}
          activeBar={{ fill: seriesColour, fillOpacity: 1, stroke: INK, strokeWidth: 1 }}
        >
          {/* The tallest bar reads as solid against the others' gradient --
              same hue, no fifth colour, just more of it. */}
          {highlightIndex !== null &&
            widget.data.map((_, index) => (
              <Cell key={index} fill={index === highlightIndex ? seriesColour : `url(#${gradId})`} />
            ))}
        </Bar>,
      ];

  const gradientDefs = grouped ? null : (
    <defs>
      <linearGradient
        id={gradId}
        x1="0"
        y1="0"
        x2={axis.horizontal ? '1' : '0'}
        y2={axis.horizontal ? '0' : '1'}
      >
        <stop offset="0%" stopColor={seriesColour} stopOpacity={axis.horizontal ? 0.62 : 1} />
        <stop offset="100%" stopColor={seriesColour} stopOpacity={axis.horizontal ? 1 : 0.62} />
      </linearGradient>
    </defs>
  );

  /**
   * [MANDATORY for two or more series] identity is never colour alone, so a
   * grouped bar always carries a legend. A single-series bar never does: its
   * title already names the one thing it draws, and a legend box repeating it
   * would be chrome standing in for information.
   */
  /**
   * The legend's entries are passed EXPLICITLY, in the spec's series order.
   *
   * Recharts derives its own payload otherwise, and the order it derives is not
   * the order the chart draws — the Fee Collection group renders
   * payable/collected/pending and legends them "Collected, Demand raised,
   * Outstanding". On a grouped bar that is a nuisance; on a STACKED one it is a
   * defect, because the legend is the only key to which band of one bar is
   * which, and a reader matching top-to-bottom gets the wrong answer.
   */
  const legend = grouped ? (
    <Legend
      verticalAlign="top"
      align="left"
      height={26}
      iconType="circle"
      iconSize={8}
      wrapperStyle={{ fontSize: 11, color: MUTED, paddingBottom: 4 }}
      /**
       * `content` rather than `payload`: this Recharts version derives the
       * payload itself and does not accept one, so the only way to fix the
       * ORDER is to draw the row. It is six spans and a dot each — chrome, not
       * a chart — and it renders identically on paper, which a legend the PDF
       * had to re-derive would not be guaranteed to do.
       */
      content={() => (
        <ul
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 14px',
            listStyle: 'none',
            margin: 0,
            padding: 0,
            fontSize: 11,
            color: MUTED,
          }}
        >
          {series.map((entry, index) => (
            <li key={entry.field} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: seriesColourAt(index),
                  display: 'inline-block',
                }}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      )}
    />
  ) : null;

  /**
   * docs/06 section 4.4 asks for a hover hint naming what a click does. Dropped
   * at card size, where there is no room for a line of prose under the chart,
   * and absent from the PDF for free -- the export passes no `onDrill`.
   */
  const hint =
    drillable && compact !== true ? (
      <p className="specDrillHint">Click a bar to see this {widget.drill_dim} broken down.</p>
    ) : null;

  if (axis.horizontal) {
    /**
     * The panel grows with the data instead of squeezing rows to a fixed 260px:
     * 26px a row keeps a 12px bar plus air, and the ceiling stops a
     * pathological category list from producing a page-long chart. Compact
     * uses the same idea at a tighter budget -- Home's preview cards are wide
     * (2-up, tokens.css `.pgallery`) but still a preview, not a full report.
     */
    /**
     * A band's height, per category. Raised with `BAR_PX` on 2026-09-01 and for
     * the same reason: thickness alone would have made a thicker bar eat the gap
     * between categories, trading one kind of ugly for another. The rule of
     * thumb here is bar + roughly half a bar of air — 22px marks in a ~34px
     * band, 3×16px grouped marks in a ~62px band — which keeps each category
     * legible as its own row while the marks stay solid.
     *
     * A grouped band holds one bar PER SERIES, so its budget is per-bar rather
     * than per-category: three measures across nine classes is 27 bars, and a
     * band sized for one would draw them on top of each other.
     */
    const perRow = grouped && !stacked ? 19 * series.length + 12 : 34;
    const compactPerRow = grouped && !stacked ? 17 * series.length + 10 : 30;
    const height =
      compact === true
        ? clamp(64 + axis.count * compactPerRow, 230, 380)
        : clamp(44 + axis.count * perRow + (grouped ? 26 : 0), 190, 680);
    /**
     * The axis takes the width its labels need, up to a ceiling that leaves the
     * bars the larger half of the panel. `- 14` is the tick line and its gap.
     *
     * Both numbers come from the same budget on purpose: Recharts WRAPS a
     * category tick that does not fit its band, and a wrapped label collides
     * with the rows either side of it -- worse than the ellipsis it was avoiding.
     * So the ellipsis is applied at exactly the width the axis was given.
     */
    const labelWidth = clamp(axis.longest * CHAR_PX + 14, 104, 168);
    const labelChars = Math.floor((labelWidth - 14) / CHAR_PX);

    return (
      <Panel title={widget.title} variant="wide" compact={compact} actions={actions}>
        <ChartFrame compact={compact} naturalHeight={height}>
          <BarChart
            data={[...widget.data]}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
            barGap={2}
            {...chartProps}
          >
            {/* Grid lines run along the value axis only -- the category axis has
                no scale to read against. */}
            <CartesianGrid stroke={GRID} horizontal={false} />
            {gradientDefs}
            {/* Both axes render at every size now -- Home's preview cards are wide
                enough (2-up, tokens.css `.pgallery`) for the same truncate-with-
                tooltip treatment the full dashboard uses (`CategoryTick`,
                `axisNumber` below) to stay legible; a glance no longer has to
                guess what a bar's category or scale is. */}
            <XAxis type="number" tick={tick} tickFormatter={axisNumber} height={28} />
            <YAxis
              type="category"
              dataKey={widget.x}
              tick={<CategoryTick maxChars={labelChars} />}
              interval={0}
              width={labelWidth}
            />
            {/* The tooltip carries the untruncated name: the axis may abbreviate,
                the reader can still find out what a bar is. */}
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(3,46,54,0.05)' }} />
            {legend}
            {bars}
          </BarChart>
        </ChartFrame>
        {hint}
      </Panel>
    );
  }

  return (
    /**
     * A drill panel is `wide` even when its bars run vertically.
     *
     * Orientation is derived from the CATEGORY LABELS (`categoryAxis`), and a
     * drill path changes its categories at every level — so Comparative
     * Analysis' panel is horizontal at school level ("World School"), still
     * horizontal at instalment level ("April 2026-27"), and turns vertical at
     * class level, where the longest label is "NURSERY". Sized by orientation
     * alone that panel is 12 columns, then 12, then 6: it HALVES under the
     * reader on the last click, and the six columns it frees cannot be filled,
     * because every panel below it on these reports is already 12.
     *
     * Which is the wrong thing to optimise anyway. docs/06 §4.4 has a drill
     * "swap the chart in place", and a panel that resizes as you descend is not
     * in place — the page reflows under the cursor that just clicked, and
     * clicking ← Back reflows it again. A stable frame is what makes three
     * levels read as one chart being narrowed rather than three charts.
     *
     * `wide` and not `medium` for the pair of them, because level 1 is
     * horizontal on every path in the catalog (they all begin with school
     * names) and is therefore already 12. Widening the leaf costs nothing and
     * narrowing the root would cramp the chart the whole path descends from.
     */
    <Panel
      title={widget.title}
      variant={drillPanel ? 'wide' : 'medium'}
      compact={compact}
      actions={actions}
    >
      <ChartFrame
        compact={compact}
        naturalHeight={compact === true ? 240 : grouped ? 300 : 260}
      >
        <BarChart
          data={[...widget.data]}
          margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
          barGap={2}
          {...chartProps}
        >
          <CartesianGrid stroke={GRID} vertical={false} />
          {gradientDefs}
          <XAxis
            dataKey={widget.x}
            tick={tick}
            {...rotatedTicks}
            angle={-35}
            textAnchor="end"
            tickMargin={4}
            height={clamp(axis.longest * 4.8 + 26, 40, 76)}
          />
          <YAxis tick={tick} tickFormatter={axisNumber} width={54} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(3,46,54,0.05)' }} />
          {legend}
          {bars}
        </BarChart>
      </ChartFrame>
      {hint}
    </Panel>
  );
}

/** A custom dot renderer's props, per Recharts' convention (mirrors `TickProps` above). */
interface LineDotProps {
  readonly cx?: number;
  readonly cy?: number;
  readonly index?: number;
}

/**
 * The latest point drawn larger and outlined, permanently — not only on
 * hover. A trend line's most recent value is usually the one a reader came
 * to check, so it stays visually singled out (§7 "highlight the latest data
 * point"). `lastIndex` is closed over rather than read from props because
 * Recharts does not otherwise tell a dot renderer how many points there are.
 */
function makeLineDot(lastIndex: number, color: string): (props: LineDotProps) => ReactElement {
  return function LineDot({ cx = 0, cy = 0, index = -1 }: LineDotProps): ReactElement {
    const isLatest = index === lastIndex;
    return (
      <circle
        cx={cx}
        cy={cy}
        r={isLatest ? 4.5 : 3}
        fill={color}
        stroke={isLatest ? '#fff' : 'none'}
        strokeWidth={isLatest ? 2 : 0}
      />
    );
  };
}

/**
 * Long-format rows pivoted into the wide shape Recharts draws from.
 *
 * The spec's `line.series` names a FIELD whose value splits the rows into
 * several lines -- one row per (period, year) for a two-year recovery trend --
 * because that is the shape SQL returns and the shape a spec can describe
 * without inventing a column name per series. Recharts wants the opposite: one
 * row per period carrying a key per line. Pivoting here, in the renderer, keeps
 * the contract describing the DATA rather than the drawing library.
 *
 * Category order is the order the rows arrive in, never sorted: the emitter
 * ordered the periods (`seq` in the SQL) and re-sorting them as text would put
 * Q10 before Q2. Series order is first-appearance for the same reason -- the
 * emitter puts the current year first, and colour identity follows it.
 *
 * A missing (period, series) pair is left ABSENT rather than filled with zero:
 * a year with no instalment 5 has no point there, and a zero would draw a line
 * diving to the floor, which is a measurement nobody took.
 */
function pivotSeries(
  rows: readonly Record<string, unknown>[],
  x: string,
  y: string,
  seriesField: string,
): { rows: Record<string, unknown>[]; names: string[] } {
  const byCategory = new Map<string, Record<string, unknown>>();
  const names: string[] = [];
  for (const row of rows) {
    const category = String(row[x] ?? '');
    const name = String(row[seriesField] ?? '');
    if (name !== '' && !names.includes(name)) names.push(name);
    let entry = byCategory.get(category);
    if (entry === undefined) {
      entry = { [x]: category };
      byCategory.set(category, entry);
    }
    const value = row[y];
    if (name !== '' && value !== null && value !== undefined) entry[name] = value;
  }
  return { rows: [...byCategory.values()], names };
}

export function LinePanel({
  widget,
  compact,
  accent,
  actions,
}: {
  widget: LineWidget;
  /** Card-sized: shorter than the full dashboard panel, real axes (Home preview cards). */
  compact?: boolean | undefined;
  /** Single-series colour, Home preview cards only -- see `ChartAccent`. */
  accent?: ChartAccent | undefined;
  actions?: ReactNode | undefined;
}): ReactElement {
  const gradId = useGradientId('area');
  const animation = useAnimation();
  const seriesColor = measureColour(widget.tone, accent);

  // Empty and single-point series read as a broken chart if forced through
  // the same axes a real trend uses — an honest small state instead (§18/19).
  if (widget.data.length === 0) {
    return (
      <Panel title={widget.title} variant="hero" compact={compact} actions={actions}>
        <div className="specEmpty">
          <span className="icon" aria-hidden="true">📈</span>
          <span className="msg">No records available for this period.</span>
        </div>
      </Panel>
    );
  }

  /**
   * Several lines on one pair of axes (`line.series`) -- the year-on-year
   * comparison Comparative Analysis' recovery trend is. Kept as its own branch
   * rather than folded into the single-series path below because the two differ
   * in more than a loop: a gradient fill under two overlapping lines is mud, and
   * the "latest point" emphasis that makes sense for one trend would mark two
   * different points on two different lines.
   *
   * `series` has been in the contract since it was written and had no renderer
   * until now, which is why this is an implementation rather than a contract
   * change: a spec setting it drew a single line and silently lost the split.
   */
  if (widget.series !== undefined) {
    const pivoted = pivotSeries(widget.data, widget.x, widget.y, widget.series);
    if (pivoted.names.length > 0) {
      return (
        /**
         * `wide`, where a single-series line is `hero`.
         *
         * Not a preference — it is the same kind of rule as `categoryAxis`
         * deciding a bar's orientation from its label lengths: the widget's own
         * shape decides its footprint. A one-series line is a trend, and `hero`
         * (span 7) leaves exactly the 5 columns a donut's `side` fills, which is
         * the pairing Fee Collection's "Receipts by month" and "Payment modes"
         * are built on. A MULTI-series line is a comparison: it carries a legend,
         * twice the marks, and the reader is matching two shapes against each
         * other point by point, which is the one thing horizontal room actually
         * buys. It also has no donut to pair with — a report that compares two
         * years has no reason to also carry a five-slice breakdown — so at span 7
         * those 5 columns strand, and the page grows a hole no later panel can
         * fill because every remaining panel is span 12.
         *
         * Single-series lines are untouched: Fee Collection's row still pairs.
         */
        <Panel title={widget.title} variant="wide" compact={compact} actions={actions}>
          <ChartFrame compact={compact} naturalHeight={compact === true ? 240 : 320}>
            <ComposedChart data={pivoted.rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey={widget.x}
                tick={tick}
                {...rotatedTicks}
                angle={-35}
                textAnchor="end"
                tickMargin={4}
                height={clamp(categoryAxis(pivoted.rows, widget.x).longest * 4.8 + 26, 40, 76)}
              />
              <YAxis tick={tick} tickFormatter={axisNumber} width={54} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: MUTED, strokeWidth: 1, strokeDasharray: '3 3' }} />
              {/* [MANDATORY for two or more series] identity is never colour
                  alone -- the same rule the grouped bar follows. */}
              <Legend
                verticalAlign="top"
                align="left"
                height={26}
                iconType="plainline"
                iconSize={14}
                wrapperStyle={{ fontSize: 11, color: MUTED, paddingBottom: 4 }}
              />
              {pivoted.names.map((name, index) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  name={name}
                  stroke={SERIES[index] ?? SERIES_OTHER}
                  strokeWidth={2.25}
                  /**
                   * Dotted from the second line on. A comparison line is a
                   * REFERENCE, and dash pattern separates it from this year's
                   * line without a fifth hue -- and it survives a greyscale
                   * print, which colour alone does not (docs/10 §1).
                   */
                  {...(index === 0 ? {} : { strokeDasharray: '5 4' })}
                  dot={{ r: 2.5, fill: SERIES[index] ?? SERIES_OTHER, strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: SERIES[index] ?? SERIES_OTHER, stroke: '#fff', strokeWidth: 2 }}
                  connectNulls={false}
                  {...animation}
                />
              ))}
            </ComposedChart>
          </ChartFrame>
        </Panel>
      );
    }
  }

  if (widget.data.length === 1) {
    const row = widget.data[0] as Record<string, unknown>;
    const value = row[widget.y];
    const label = row[widget.x];
    return (
      <Panel title={widget.title} variant="hero" compact={compact} actions={actions}>
        <div className="specSingle">
          <span className="value">
            {typeof value === 'number' ? full.format(value) : String(value ?? '—')}
          </span>
          {label !== undefined && label !== null && <span className="label">{String(label)}</span>}
          <span className="note">Only one period is currently available.</span>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title={widget.title} variant="hero" compact={compact} actions={actions}>
      <ChartFrame compact={compact} naturalHeight={compact === true ? 240 : 260}>
        <ComposedChart data={[...widget.data]} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <defs>
            {/* A static fade to transparent — fixed SVG stops, not a timed
                effect, so the PDF capture (ADR-021) still matches the screen
                exactly at whatever instant Puppeteer takes the shot. */}
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesColor} stopOpacity={0.24} />
              <stop offset="100%" stopColor={seriesColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          {/* A line's x is a sequence — months, terms — so it stays horizontal
              and only sizes its band to the labels it actually has. Rendered
              at every size now (see BarPanel's axes above for why compact no
              longer drops them). */}
          <XAxis
            dataKey={widget.x}
            tick={tick}
            {...rotatedTicks}
            angle={-35}
            textAnchor="end"
            tickMargin={4}
            height={clamp(categoryAxis(widget.data, widget.x).longest * 4.8 + 26, 40, 76)}
          />
          <YAxis tick={tick} tickFormatter={axisNumber} width={54} />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: seriesColor, strokeWidth: 1, strokeDasharray: '3 3' }}
          />
          <Area
            type="monotone"
            dataKey={widget.y}
            stroke="none"
            fill={`url(#${gradId})`}
            {...animation}
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey={widget.y}
            stroke={seriesColor}
            strokeWidth={2.25}
            dot={makeLineDot(widget.data.length - 1, seriesColor)}
            activeDot={{ r: 5.5, fill: seriesColor, stroke: '#fff', strokeWidth: 2 }}
            {...animation}
          />
        </ComposedChart>
      </ChartFrame>
    </Panel>
  );
}

/** A centre label longer than this collides with the ring at this radius. */
function centerLabel(text: string, max = 15): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function DonutPanel({
  widget,
  compact,
  actions,
}: {
  widget: DonutWidget;
  /** Card-sized: smaller ring, no legend list (Home preview cards). */
  compact?: boolean | undefined;
  actions?: ReactNode | undefined;
}): ReactElement {
  if (widget.data.length === 0) {
    return (
      <Panel title={widget.title} variant="side" compact={compact} actions={actions}>
        <div className="specEmpty">
          <span className="icon" aria-hidden="true">◔</span>
          <span className="msg">No records available.</span>
        </div>
      </Panel>
    );
  }

  const animation = useAnimation();

  /** Restated at the centre of the ring — see `specDonutCenter` below. */
  const total = widget.data.reduce((sum, row) => {
    const value = row[widget.value_field];
    return sum + (typeof value === 'number' ? value : 0);
  }, 0);

  /**
   * When one slice genuinely dominates, naming it beats restating the total —
   * "68% Online" is the observation a reader would otherwise have to compute
   * from the legend by hand (§9). Derived purely from this widget's own data;
   * below a clear majority the total is the more honest summary.
   */
  let dominant: { label: string; value: number } | null = null;
  for (const row of widget.data) {
    const value = row[widget.value_field];
    if (typeof value === 'number' && (dominant === null || value > dominant.value)) {
      dominant = { label: String(row[widget.label_field] ?? ''), value };
    }
  }
  const dominantShare = dominant !== null && total > 0 ? dominant.value / total : 0;
  const showDominant = widget.data.length > 1 && dominant !== null && dominantShare >= 0.5;

  return (
    <Panel title={widget.title} variant="side" compact={compact} actions={actions}>
      {/**
       * The centre readout is a plain HTML overlay, not an SVG `<Label>` child
       * of `<Pie>`. Recharts 3's Pie no longer mounts a child `Label` at all
       * (confirmed against the rendered DOM — zero `<text>` nodes, silently) —
       * an internal-architecture break from the v2 pattern this used to be,
       * not a chart-spec contract change. `pointer-events: none` keeps the
       * overlay from stealing hover off the ring underneath it.
       */}
      <div className="specDonutWrap">
        <ResponsiveContainer width="100%" height={compact === true ? 210 : 220}>
          <PieChart>
            <Pie
              data={[...widget.data]}
              dataKey={widget.value_field}
              nameKey={widget.label_field}
              innerRadius={58}
              outerRadius={compact === true ? 90 : 88}
              paddingAngle={2}
              {...animation}
            >
              {widget.data.map((row, index) => {
                /* dataviz non-negotiable: a category past the validated,
                   four-step palette is never a fifth generated hue — it folds
                   into a single recessive "Other" fill instead. */
                const inPalette = index < SERIES.length;
                return (
                  <Cell
                    key={String(row[widget.label_field] ?? index)}
                    fill={inPalette ? (SERIES[index] ?? SERIES_OTHER) : SERIES_OTHER}
                    fillOpacity={inPalette ? 1 : 0.55}
                  />
                );
              })}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        {/* The KPI strip above already states the total; restating it (or,
            when one slice dominates, naming that slice) where the eye
            actually lands saves the reader from adding the legend by hand. */}
        <div className={compact === true ? 'specDonutCenter specDonutCenter--compact' : 'specDonutCenter'}>
          {showDominant && dominant !== null ? (
            <>
              <span className="value">{Math.round(dominantShare * 100)}%</span>
              {compact !== true && <span className="label">{centerLabel(dominant.label)}</span>}
            </>
          ) : (
            <>
              <span className="value">{compactNum.format(total)}</span>
              {compact !== true && <span className="label">TOTAL</span>}
            </>
          )}
        </div>
      </div>
      {/* A plain HTML legend, not Recharts' — sharing the Pie's own drawing
          area with a legend row pushed the ring's true centre away from the
          container's geometric centre, which is what the HTML overlay above
          centres against. Keeping the legend outside that area keeps both
          simple. Dropped entirely at card size: the ring's colour split is the
          glance, and the full legend is a click away on the real dashboard. */}
      {compact !== true && (
        <ul className="specDonutLegend">
          {widget.data.map((row, index) => {
            const inPalette = index < SERIES.length;
            return (
              <li key={String(row[widget.label_field] ?? index)}>
                <span
                  className="dot"
                  style={{ background: inPalette ? (SERIES[index] ?? SERIES_OTHER) : SERIES_OTHER }}
                />
                {String(row[widget.label_field] ?? '')}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Compare two cells of the same column.
 *
 * Numbers numerically, everything else as text under the reader's own locale —
 * `localeCompare` rather than `<`, so "Ácharya" files beside "Acharya" instead
 * of after "Zoya". Nulls sort last in both directions: a missing value is not
 * the smallest value, and letting it lead an ascending sort would put every
 * blank row at the top of a table someone sorted to find their worst school.
 */
function compareCells(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function TablePanel({
  widget,
  actions,
}: {
  widget: TableWidget;
  actions?: ReactNode | undefined;
}): ReactElement {
  /**
   * Which column the reader sorted by, if any. `null` means the EMITTED order,
   * which is not "unsorted": the server ranked these rows for a reason (worst
   * arrears first, largest class first), so the initial view is the report's own
   * answer and re-sorting is the reader overriding it. Reset is therefore a real
   * third state of the header, not a no-op.
   *
   * Held here rather than lifted to the page because it is a property of looking
   * at this table, not of the report — a sorted column is never persisted, never
   * cloned into a saved report, and never printed: the PDF renders the spec's own
   * order (ADR-021), which is what keeps an export matching what was approved.
   */
  const [sort, setSort] = useState<{ field: string; descending: boolean } | null>(null);

  const sorted = (() => {
    if (sort === null) return widget.rows;
    const column = widget.columns.find((entry) => entry.field === sort.field);
    if (column === undefined) return widget.rows;
    const key = column.sort_field ?? column.field;
    /**
     * A copy. `widget.rows` belongs to the spec, and sorting in place would
     * mutate the object the PDF route and the clone button read from.
     */
    return [...widget.rows].sort((a, b) => {
      const order = compareCells(a[key], b[key]);
      return sort.descending ? -order : order;
    });
  })();

  return (
    <Panel title={widget.title} variant="wide" actions={actions}>
      {widget.rows.length === 0 ? (
        <div className="specEmpty">
          <span className="icon" aria-hidden="true">▤</span>
          <span className="msg">No rows to show.</span>
        </div>
      ) : (
        <>
          <div className="specTableWrap">
            <table className="specTable">
              <thead>
                <tr>
                  {widget.columns.map((column) => {
                    const active = sort !== null && sort.field === column.field;
                    return (
                      <th
                        key={column.field}
                        style={{ textAlign: column.align ?? 'left' }}
                        aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                      >
                        {/* A real button, so the header is reachable by keyboard
                            and announced as the control it is. Three states in
                            order: ascending, descending, back to the order the
                            server sent. */}
                        <button
                          type="button"
                          className={`specSort${active ? ' active' : ''}`}
                          onClick={() => {
                            setSort((current) =>
                              current === null || current.field !== column.field
                                ? { field: column.field, descending: false }
                                : current.descending
                                  ? null
                                  : { field: column.field, descending: true },
                            );
                          }}
                        >
                          {column.label}
                          <span className="specSortMark" aria-hidden="true">
                            {active ? (sort.descending ? '▾' : '▴') : '⇅'}
                          </span>
                        </button>
                        {/* docs/04 rail 6: a masked column says so. Hiding it would be
                            a silently different table for a different reader. */}
                        {column.masked === true && <span className="pill nodata ml-2">masked</span>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, index) => (
                  <tr key={index}>
                    {widget.columns.map((column) => (
                      <td key={column.field} style={{ textAlign: column.align ?? 'left' }}>
                        {formatCell(row[column.field])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* ADR-008: truncation is never silent. */}
          {widget.truncated === true && (
            <p className="specNote">
              Showing the first rows only — this result hit the 5,000-row cap.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

/** Bento sizing (§5) — a widget kind's normal visual weight on the grid. */
type PanelVariant = 'hero' | 'side' | 'medium' | 'wide';

function Panel({
  title,
  variant,
  compact,
  actions,
  children,
}: {
  title?: string | undefined;
  variant?: PanelVariant | undefined;
  /**
   * A caller that already owns the card chrome and the title -- Home's preview
   * cards (services/home.ts `buildHomePreview`) -- gets the chart with neither
   * repeated. Never used by the dashboard screen or the PDF: both still get the
   * full `.card specPanel` exactly as before, which is what keeps ADR-021 true
   * (same renderer produces what prints).
   */
  compact?: boolean | undefined;
  /**
   * Platform chrome the caller renders beside the title — e.g. a per-chart
   * "⧉ Clone" button (docs/06 §3, per-widget customization). This is NOT
   * part of the chart-spec contract (ADR-015 still governs the widget's
   * DATA): the caller decides whether and what to render here from its own
   * page state, never from anything inside `spec`. Dropped in `compact` and
   * PDF rendering — neither owns page chrome (PDF renders no interactive
   * controls at all).
   */
  actions?: ReactNode | undefined;
  children: ReactNode;
}): ReactElement {
  if (compact === true) {
    return (
      <div className="specPanelCompact">
        {/* Axis chrome is dropped at card size (see the callers above), but the
            title is the one piece of context a shape cannot carry on its own --
            without it a preview card's chart is a squiggle or a stack of bars
            with no way to tell what it counts. The card's own header (Home's
            `pcardHead`) names the DASHBOARD; this names the specific metric the
            lead chart draws, which is not always the same string. */}
        {title !== undefined && <div className="specPanelCompactTitle">{title}</div>}
        {children}
      </div>
    );
  }
  return (
    <section className={`card specPanel${variant !== undefined ? ` specPanel--${variant}` : ''}`}>
      {(title !== undefined || actions !== undefined) && (
        <div className="specPanelHead">
          {title !== undefined && <h3 className="specPanelTitle">{title}</h3>}
          {actions !== undefined && <div className="specPanelActions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return full.format(value);
  return String(value);
}

function toneColour(tone: KpiWidget['tone']): string {
  switch (tone) {
    case 'warning':
      return '#f2a93b';
    case 'negative':
      return '#e05252';
    case 'positive':
      return '#02c39a';
    default:
      return '#028090';
  }
}

/**
 * Dispatch on the discriminant. The union is closed, so this is exhaustive.
 * `compact` only ever reaches a chart branch (bar/line/donut) — it means
 * "card-sized, chrome dropped" (Home preview cards), which a KPI tile or a
 * table does not have a smaller form of. (A `hero` flag sat beside it until
 * 2026-09-01, naming the headline tile in a KPI row; every tile is one size
 * now, so the strip needs no per-tile prop at all — see `KpiTile`.)
 */
export function WidgetView({
  widget,
  compact,
  accent,
  actions,
  onDrill,
}: {
  widget: Widget;
  compact?: boolean | undefined;
  /** Single-series colour for a bar/line widget — see `ChartAccent`. Ignored by kpi/donut/table: a donut is already multi-colour by category, and tone-colouring a KPI already goes through its own `tone` field. */
  accent?: ChartAccent | undefined;
  /** Platform chrome beside the panel title — see `Panel`'s doc comment. Never offered to a KPI tile, which has no panel head to hold it. */
  actions?: ReactNode | undefined;
  /**
   * Drill clicks (ADR-020). Only the `bar` branch takes it today, because
   * `bar-school` is the only drillable widget the catalog ships; the prop is
   * declared on the dispatcher rather than plumbed report-by-report so a
   * drillable donut is a one-line change here and nothing at the call sites.
   */
  onDrill?: DrillHandler | undefined;
}): ReactElement {
  switch (widget.type) {
    case 'kpi':
      return <KpiTile widget={widget} />;
    case 'bar':
      return (
        <BarPanel
          widget={widget}
          compact={compact}
          accent={accent}
          actions={actions}
          onDrill={onDrill}
        />
      );
    case 'line':
      return <LinePanel widget={widget} compact={compact} accent={accent} actions={actions} />;
    case 'donut':
      return <DonutPanel widget={widget} compact={compact} actions={actions} />;
    case 'table':
      return <TablePanel widget={widget} actions={actions} />;
  }
}

/**
 * Validate-then-render for exactly ONE untrusted widget, the same contract
 * `ChartSpecView` applies to a whole spec (CODING_GUIDELINES §10) — for a
 * caller that has a single widget rather than a full report, e.g. Home's
 * per-dashboard preview cards. Never skip straight to `WidgetView` with an
 * unvalidated widget; that would make this the one rendering path in the
 * product whose safety depends on the honesty of whoever built the object.
 */
export function WidgetSpecView({
  widget,
  compact,
  accent,
  onDrill,
}: {
  widget: unknown;
  compact?: boolean | undefined;
  accent?: ChartAccent | undefined;
  /**
   * Drill clicks (ADR-020), forwarded to `WidgetView` exactly as `ChartSpecView`
   * forwards them for a whole spec. Added for the Dashboard grid, whose cards
   * each hold ONE widget and are drilled in place — before this, a single-widget
   * caller could render a chart the spec marked `drillable` and then silently
   * drop every click on it, which is the affordance lying about itself.
   *
   * Still nothing prints: a drilled level is reached by clicking, and the PDF
   * path passes no handler, so the hint and the pointer cursor stay off paper
   * for free.
   */
  onDrill?: DrillHandler | undefined;
}): ReactElement {
  const parsed = widgetSchema.safeParse(widget);
  if (!parsed.success) {
    return <div className="notice">This could not be displayed because its definition is not valid.</div>;
  }
  return (
    <WidgetView
      widget={parsed.data}
      compact={compact}
      accent={accent}
      onDrill={onDrill}
    />
  );
}
