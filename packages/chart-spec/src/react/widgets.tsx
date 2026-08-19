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
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
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
 * docs/10 §1: the platform palette. Series colours come from the design tokens,
 * never from the spec — a spec that could choose its own colours could also
 * make a school's brand unrecognisable, and ADR-015's point is that the
 * PLATFORM owns the visual language.
 */
const SERIES: readonly [string, ...string[]] = [
  '#028090',
  '#00a896',
  '#02c39a',
  '#f2a93b',
  '#e05252',
  '#046e7c',
  '#7c9aa5',
];
const AXIS: CSSProperties = { fontSize: 11 };
const GRID = '#e2e8f0';
const MUTED = '#64748b';

const tick = { fill: MUTED, fontSize: 11 };

/** Numbers are read as quantities, so they are grouped Indian-style. */
const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en-IN');

function axisNumber(value: number): string {
  return compact.format(value);
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

export function BarPanel({ widget }: { widget: BarWidget }): ReactElement {
  return (
    <Panel title={widget.title}>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={[...widget.data]} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={widget.x} tick={tick} interval={0} angle={-30} textAnchor="end" height={54} />
          <YAxis tick={tick} tickFormatter={axisNumber} width={54} />
          <Tooltip formatter={(v) => full.format(Number(v))} contentStyle={AXIS} />
          <Bar dataKey={widget.y} fill={SERIES[0]} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

export function LinePanel({ widget }: { widget: LineWidget }): ReactElement {
  return (
    <Panel title={widget.title}>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={[...widget.data]} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={widget.x} tick={tick} interval={0} angle={-30} textAnchor="end" height={54} />
          <YAxis tick={tick} tickFormatter={axisNumber} width={54} />
          <Tooltip formatter={(v) => full.format(Number(v))} contentStyle={AXIS} />
          <Line
            type="monotone"
            dataKey={widget.y}
            stroke={SERIES[0]}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </Panel>
  );
}

export function DonutPanel({ widget }: { widget: DonutWidget }): ReactElement {
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
          >
            {widget.data.map((row, index) => (
              <Cell
                key={String(row[widget.label_field] ?? index)}
                fill={SERIES[index % SERIES.length] ?? SERIES[0]}
              />
            ))}
          </Pie>
          <Legend wrapperStyle={AXIS} />
          <Tooltip formatter={(v) => full.format(Number(v))} contentStyle={AXIS} />
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
