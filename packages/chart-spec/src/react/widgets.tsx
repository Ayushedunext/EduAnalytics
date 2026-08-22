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
  Label,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
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
const AXIS: CSSProperties = { fontSize: 11 };
const GRID = '#e2e8f0';
const MUTED = '#64748b';
const INK = '#032e36';

const tick = { fill: MUTED, fontSize: 11 };

/** Numbers are read as quantities, so they are grouped Indian-style. */
const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en-IN');

function axisNumber(value: number): string {
  return compact.format(value);
}

/**
 * Entry animation is OFF, everywhere.
 *
 * The same renderer draws the screen and the PDF (ADR-021), and a PDF is a
 * PHOTOGRAPH: Puppeteer captured a donut mid-grow and produced a report with an
 * empty circle and a legend under it — a chart that looked like a panel with no
 * data rather than one that had not finished drawing. Waiting out an animation
 * would be a timer, and this codebase waits for facts.
 *
 * Losing it costs a flourish on first paint. Keeping it would mean the export
 * could disagree with the screen about what the data is, which is the one thing
 * the shared renderer exists to prevent.
 */
const ANIMATE = false;

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
 * capture (which never moves a mouse) never renders it — the same reasoning
 * that keeps `ANIMATE` off applies here without needing it.
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

export function KpiTile({ widget }: { widget: KpiWidget }): ReactElement {
  return (
    <div className="card kpi">
      <b style={{ color: toneColour(widget.tone) }}>{widget.value}</b>
      <span>
        {widget.label}
        {widget.delta !== undefined && <span className="pill live ml-2">{widget.delta}</span>}
      </span>
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

export function BarPanel({ widget }: { widget: BarWidget }): ReactElement {
  const axis = categoryAxis(widget.data, widget.x);
  /**
   * A depth gradient built from ONE hue at two opacities, never a second
   * colour — so it stays inside docs/10 §1's "teal-family series" rule and
   * costs nothing on the CVD audit (opacity, unlike hue, isn't a channel a
   * colour-vision deficiency affects). Solid at the value end, softer toward
   * the baseline, so the gradient points at the number that matters.
   */
  const gradId = useGradientId('bar');

  if (axis.horizontal) {
    /**
     * The panel grows with the data instead of squeezing rows to a fixed 260px:
     * 26px a row keeps a 12px bar plus air, and the 560px ceiling stops a
     * pathological category list from producing a page-long chart.
     */
    const height = clamp(44 + axis.count * 26, 180, 560);
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
      <Panel title={widget.title}>
        <ResponsiveContainer width="100%" height={height}>
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
                <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.62} />
                <stop offset="100%" stopColor={SERIES[0]} stopOpacity={1} />
              </linearGradient>
            </defs>
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
              isAnimationActive={ANIMATE}
              activeBar={{ fill: SERIES[0], fillOpacity: 1, stroke: INK, strokeWidth: 1 }}
            />
          </BarChart>
        </ResponsiveContainer>
      </Panel>
    );
  }

  return (
    <Panel title={widget.title}>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={[...widget.data]} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES[0]} stopOpacity={1} />
              <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0.62} />
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
            isAnimationActive={ANIMATE}
            activeBar={{ fill: SERIES[0], fillOpacity: 1, stroke: INK, strokeWidth: 1 }}
          />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

export function LinePanel({ widget }: { widget: LineWidget }): ReactElement {
  const gradId = useGradientId('area');
  return (
    <Panel title={widget.title}>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={[...widget.data]} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <defs>
            {/* A static fade to transparent — fixed SVG stops, not a timed
                effect, so the PDF capture (ADR-021) still matches the screen
                exactly at whatever instant Puppeteer takes the shot. */}
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.24} />
              <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          {/* A line's x is a sequence — months, terms — so it stays horizontal
              and only sizes its band to the labels it actually has. */}
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
            cursor={{ stroke: SERIES[0], strokeWidth: 1, strokeDasharray: '3 3' }}
          />
          <Area
            type="monotone"
            dataKey={widget.y}
            stroke="none"
            fill={`url(#${gradId})`}
            isAnimationActive={ANIMATE}
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey={widget.y}
            stroke={SERIES[0]}
            strokeWidth={2.25}
            dot={{ r: 3, fill: SERIES[0], strokeWidth: 0 }}
            activeDot={{ r: 5.5, fill: SERIES[0], stroke: '#fff', strokeWidth: 2 }}
            isAnimationActive={ANIMATE}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </Panel>
  );
}

export function DonutPanel({ widget }: { widget: DonutWidget }): ReactElement {
  /** Restated at the centre of the ring — see the Label content below. */
  const total = widget.data.reduce((sum, row) => {
    const value = row[widget.value_field];
    return sum + (typeof value === 'number' ? value : 0);
  }, 0);

  return (
    <Panel title={widget.title}>
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie
            data={[...widget.data]}
            dataKey={widget.value_field}
            nameKey={widget.label_field}
            innerRadius={54}
            outerRadius={88}
            paddingAngle={2}
            isAnimationActive={ANIMATE}
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
            {/* The KPI strip above already states this total; restating it
                where the eye actually lands (the hole in the ring) saves the
                reader from adding the legend up by hand. */}
            <Label
              position="center"
              content={({ viewBox }) => {
                if (viewBox === undefined || !('cx' in viewBox) || !('cy' in viewBox)) return null;
                const { cx, cy } = viewBox;
                if (cx === undefined || cy === undefined) return null;
                return (
                  <g>
                    <text x={cx} y={cy - 5} textAnchor="middle" fontSize={19} fontWeight={700} fill={INK}>
                      {compact.format(total)}
                    </text>
                    <text x={cx} y={cy + 13} textAnchor="middle" fontSize={9.5} fill={MUTED} letterSpacing={0.8}>
                      TOTAL
                    </text>
                  </g>
                );
              }}
            />
          </Pie>
          <Legend wrapperStyle={AXIS} />
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>
    </Panel>
  );
}

export function TablePanel({ widget }: { widget: TableWidget }): ReactElement {
  return (
    <Panel title={widget.title}>
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
    </Panel>
  );
}

function Panel({
  title,
  children,
}: {
  title?: string | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="card specPanel">
      {title !== undefined && <h3 className="specPanelTitle">{title}</h3>}
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

/** Dispatch on the discriminant. The union is closed, so this is exhaustive. */
export function WidgetView({ widget }: { widget: Widget }): ReactElement {
  switch (widget.type) {
    case 'kpi':
      return <KpiTile widget={widget} />;
    case 'bar':
      return <BarPanel widget={widget} />;
    case 'line':
      return <LinePanel widget={widget} />;
    case 'donut':
      return <DonutPanel widget={widget} />;
    case 'table':
      return <TablePanel widget={widget} />;
  }
}
