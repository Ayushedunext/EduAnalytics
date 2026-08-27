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
import { useId } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
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
  BarWidget,
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
/** The fold-in colour for any category past the fixed palette (dataviz non-negotiable: never a generated hue). */
const SERIES_OTHER = '#64748b';

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

export function KpiTile({ widget, hero }: { widget: KpiWidget; hero?: boolean | undefined }): ReactElement {
  const tone = widget.tone ?? 'neutral';
  const direction = widget.delta !== undefined ? deltaDirection(widget.delta) : null;
  return (
    <div className={`card kpi kpi--${tone}${hero === true ? ' kpi--hero' : ''}`}>
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
 * The same budget now also sizes Home's compact preview cards (3-up,
 * tokens.css `.pgallery`, ~600px+ each) — wider than a full dashboard panel,
 * never narrower, so nothing here needed a compact-specific number.
 */
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
      <div className="specChartFill" style={{ minHeight: naturalHeight }}>
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

export function BarPanel({
  widget,
  compact,
  accent,
  actions,
}: {
  widget: BarWidget;
  /** Card-sized: shorter than the full dashboard panel, real axes (Home preview cards). */
  compact?: boolean | undefined;
  /** Single-series colour, Home preview cards only -- see `ChartAccent`. */
  accent?: ChartAccent | undefined;
  actions?: ReactNode | undefined;
}): ReactElement {
  if (widget.data.length === 0) {
    return (
      <Panel title={widget.title} variant="medium" compact={compact} actions={actions}>
        <div className="specEmpty">
          <span className="icon" aria-hidden="true">▤</span>
          <span className="msg">No records available.</span>
        </div>
      </Panel>
    );
  }

  const axis = categoryAxis(widget.data, widget.x);
  const highlightIndex = maxValueIndex(widget.data, widget.y);
  const seriesColor = ACCENT_COLOUR[accent ?? 'primary'];
  /**
   * A depth gradient built from ONE hue at two opacities, never a second
   * colour — so it stays inside docs/10 §1's "teal-family series" rule and
   * costs nothing on the CVD audit (opacity, unlike hue, isn't a channel a
   * colour-vision deficiency affects). Solid at the value end, softer toward
   * the baseline, so the gradient points at the number that matters.
   */
  const gradId = useGradientId('bar');
  // Placed beside the existing hook so hook ORDER is unchanged from before.
  const animation = useAnimation();

  if (axis.horizontal) {
    /**
     * The panel grows with the data instead of squeezing rows to a fixed 260px:
     * 26px a row keeps a 12px bar plus air, and the 560px ceiling stops a
     * pathological category list from producing a page-long chart. Compact
     * uses the same idea at a tighter budget (22px/row, 220-340px) -- Home's
     * preview cards are wide (3-up, tokens.css `.pgallery`) but still a
     * preview, not a full report.
     */
    const height =
      compact === true
        ? clamp(64 + axis.count * 22, 220, 340)
        : clamp(44 + axis.count * 26, 180, 560);
    /**
     * The axis takes the width its labels need, up to a ceiling that leaves the
     * bars the larger half of the panel. `- 14` is the tick line and its gap.
     *
     * Both numbers come from the same budget on purpose: Recharts WRAPS a
     * category tick that does not fit its band, and a wrapped label collides
     * with the rows either side of it — worse than the ellipsis it was avoiding.
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
          >
            {/* Grid lines run along the value axis only — the category axis has
                no scale to read against. */}
            <CartesianGrid stroke={GRID} horizontal={false} />
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={seriesColor} stopOpacity={0.62} />
                <stop offset="100%" stopColor={seriesColor} stopOpacity={1} />
              </linearGradient>
            </defs>
            {/* Both axes render at every size now — Home's preview cards are wide
                enough (3-up, tokens.css `.pgallery`) for the same truncate-with-
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
            <Bar
              dataKey={widget.y}
              fill={`url(#${gradId})`}
              radius={[0, 3, 3, 0]}
              maxBarSize={14}
              {...animation}
              activeBar={{ fill: seriesColor, fillOpacity: 1, stroke: INK, strokeWidth: 1 }}
            >
              {/* The tallest bar reads as solid against the others' gradient —
                  same hue, no fifth colour, just more of it. */}
              {highlightIndex !== null &&
                widget.data.map((_, index) => (
                  <Cell key={index} fill={index === highlightIndex ? seriesColor : `url(#${gradId})`} />
                ))}
            </Bar>
          </BarChart>
        </ChartFrame>
      </Panel>
    );
  }

  return (
    <Panel title={widget.title} variant="medium" compact={compact} actions={actions}>
      <ChartFrame compact={compact} naturalHeight={compact === true ? 240 : 260}>
        <BarChart data={[...widget.data]} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesColor} stopOpacity={1} />
              <stop offset="100%" stopColor={seriesColor} stopOpacity={0.62} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey={widget.x}
            tick={tick}
            interval={0}
            angle={-35}
            textAnchor="end"
            tickMargin={4}
            height={clamp(axis.longest * 4.8 + 26, 40, 76)}
          />
          <YAxis tick={tick} tickFormatter={axisNumber} width={54} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(3,46,54,0.05)' }} />
          <Bar
            dataKey={widget.y}
            fill={`url(#${gradId})`}
            radius={[3, 3, 0, 0]}
            maxBarSize={38}
            {...animation}
            activeBar={{ fill: seriesColor, fillOpacity: 1, stroke: INK, strokeWidth: 1 }}
          >
            {highlightIndex !== null &&
              widget.data.map((_, index) => (
                <Cell key={index} fill={index === highlightIndex ? seriesColor : `url(#${gradId})`} />
              ))}
          </Bar>
        </BarChart>
      </ChartFrame>
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
  const seriesColor = ACCENT_COLOUR[accent ?? 'primary'];

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
            interval={0}
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

export function TablePanel({
  widget,
  actions,
}: {
  widget: TableWidget;
  actions?: ReactNode | undefined;
}): ReactElement {
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
                  {widget.columns.map((column) => (
                    <th key={column.field} style={{ textAlign: column.align ?? 'left' }}>
                      {column.label}
                      {/* docs/04 rail 6: a masked column says so. Hiding it would be
                          a silently different table for a different reader. */}
                      {column.masked === true && <span className="pill nodata ml-2">masked</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {widget.rows.map((row, index) => (
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
 * `hero` only ever reaches the `kpi` branch — it names the headline metric in
 * a KPI row (§22), which is meaningless for a chart or table widget. `compact`
 * only ever reaches a chart branch (bar/line/donut) — it means "card-sized,
 * chrome dropped" (Home preview cards), which a KPI tile or a table does not
 * have a smaller form of.
 */
export function WidgetView({
  widget,
  hero,
  compact,
  accent,
  actions,
}: {
  widget: Widget;
  hero?: boolean | undefined;
  compact?: boolean | undefined;
  /** Single-series colour for a bar/line widget — see `ChartAccent`. Ignored by kpi/donut/table: a donut is already multi-colour by category, and tone-colouring a KPI already goes through its own `tone` field. */
  accent?: ChartAccent | undefined;
  /** Platform chrome beside the panel title — see `Panel`'s doc comment. Never offered to a KPI tile, which has no panel head to hold it. */
  actions?: ReactNode | undefined;
}): ReactElement {
  switch (widget.type) {
    case 'kpi':
      return <KpiTile widget={widget} hero={hero} />;
    case 'bar':
      return <BarPanel widget={widget} compact={compact} accent={accent} actions={actions} />;
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
  hero,
  compact,
  accent,
}: {
  widget: unknown;
  hero?: boolean | undefined;
  compact?: boolean | undefined;
  accent?: ChartAccent | undefined;
}): ReactElement {
  const parsed = widgetSchema.safeParse(widget);
  if (!parsed.success) {
    return <div className="notice">This could not be displayed because its definition is not valid.</div>;
  }
  return <WidgetView widget={parsed.data} hero={hero} compact={compact} accent={accent} />;
}
