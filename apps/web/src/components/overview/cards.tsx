/**
 * The Dashboard's cards — the artifact's cards, one component each, drawn from
 * the widgets `/api/home/overview/:slot` returns (docs/10 §1.5).
 *
 * [MANDATORY] ADR-015: every figure on screen is read from a validated widget
 * (`widgets.ts`). What this file adds is ARRANGEMENT — rings, gauges, avatars,
 * a table with an Action button — never a number of its own. A card that has
 * not loaded is a skeleton; one the server could not build says why.
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import {
  ChartTypeSelect,
  VividChart,
  WidgetSpecView,
  defaultChartTypeOf,
  lighten,
  paletteColour,
  useChartPalette,
  type ChartModel,
  type ChartPalette,
  type ChartType,
} from '@sap/chart-spec/react';
import type { KpiWidget, TableWidget, Widget } from '@sap/chart-spec';
import type { OverviewSlot } from '../../api/client';
import { Icon } from '../Icon';
import type { SlotState } from './useOverview';
import { ChartMenu, type ChartLogic } from '../ChartMenu';
import { donutOf, initialsOf, kpiOf, lineOf, partOf, rateOf, tableOf, validWidgets } from './widgets';

/** Forms three rates can take in a 150px box; two-value gauges take fewer (see ChartTypeSelect). */
const RING_FORMS: readonly ChartType[] = ['donut', 'pie', 'bar', 'hbar', 'polar', 'radar'];
const GAUGE_FORMS: readonly ChartType[] = ['donut', 'pie', 'bar', 'hbar'];

const FALLBACK_PALETTE: ChartPalette = {
  colours: ['#1fa0e8', '#37c979', '#f0508a', '#f5a623', '#8e6bf0', '#12b5a5'],
  gradient: ['#3dbe6c', '#1e7be0'],
};

function usePalette(): ChartPalette {
  return useChartPalette() ?? FALLBACK_PALETTE;
}

/** Per-card chart type: the reader's choice for this render, or the widget's own form. */
function useChartType(widget: unknown): [ChartType, (t: ChartType) => void] {
  const [chosen, setChosen] = useState<ChartType | null>(null);
  return [chosen ?? defaultChartTypeOf(widget), setChosen];
}

// -- Shells ------------------------------------------------------------------------

export function Card({
  className,
  title,
  sub,
  tools,
  children,
  notes,
}: {
  className?: string | undefined;
  title?: ReactNode;
  sub?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
  notes?: readonly string[] | undefined;
}): ReactElement {
  return (
    <div className={`card ovCard ${className ?? ''}`}>
      {(title !== undefined || tools !== undefined) && (
        <div className="ovHead">
          <div style={{ minWidth: 0 }}>
            {title !== undefined && <h3>{title}</h3>}
            {sub !== undefined && <div className="sub">{sub}</div>}
          </div>
          {tools !== undefined && <div className="tools">{tools}</div>}
        </div>
      )}
      {children}
      {notes !== undefined && notes.map((note) => <p key={note} className="ovNote">{note}</p>)}
    </div>
  );
}

/**
 * Loading, failed, blocked or ready — decided once, here, so every card states
 * the same three non-ready conditions the same way.
 */
export function Slot({
  state,
  children,
}: {
  state: SlotState | undefined;
  children: (widgets: Widget[], slot: OverviewSlot) => ReactNode;
}): ReactElement {
  if (state === undefined || state.kind === 'loading') return <div className="skeleton" />;
  if (state.kind === 'failed') return <span className="ovMuted">{state.message}</span>;
  if (state.slot.status !== 'ok') return <span className="ovMuted">{state.slot.reason ?? 'This card could not be built.'}</span>;
  return <>{children(validWidgets(state.slot.widgets), state.slot)}</>;
}

function notesOf(state: SlotState | undefined): string[] | undefined {
  return state?.kind === 'ready' && state.slot.notes.length > 0 ? state.slot.notes : undefined;
}

/**
 * A card's own logic (Invariant 6), read straight off the slot the server
 * answered with: its notes, its as-of date, and the vetted statements it ran
 * (services/overview.ts returns them on every slot for exactly this).
 *
 * Nothing is derived. A card that has not loaded has no logic to show, and the
 * menu then offers "View logic" disabled rather than an empty panel — a panel
 * that said "Source: —" would be this screen inventing a claim about where a
 * number came from, which is the one thing Invariant 6 exists to stop.
 */
function logicOf(state: SlotState | undefined): ChartLogic | undefined {
  if (state?.kind !== 'ready') return undefined;
  return {
    source: 'Dashboard card — vetted SQL, read-only, on the read replica',
    notes: state.slot.notes,
    queries: state.slot.queries,
    asOf: state.slot.as_of,
  };
}

/**
 * The "⋮" menu for a Dashboard card (ChartMenu.tsx).
 *
 * `reportId` is the report this card OPENS, where it has one, and it is the
 * only thing that makes Clone offerable here: the clone endpoint takes a report
 * id and a Dashboard slot is not one (services/dashboards.ts). A card with no
 * report behind it still LISTS Clone, disabled, with that reason on it.
 *
 * `widget` is passed where the card draws ONE chart-spec widget, which Enlarge
 * can then redraw at full size on its own. Where the card is an arrangement the
 * platform composes — the concentric rings, a gauge, a table of people — the
 * card hands `renderLarge` its own body instead, so what enlarges is what was
 * on screen rather than a different chart of the same numbers.
 */
function CardMenu({
  state,
  slot,
  id,
  title,
  reportId,
  widget,
  chartType,
  chartSlot,
  renderLarge,
  draws,
}: {
  state: SlotState | undefined;
  slot: string;
  id: string;
  title: string;
  reportId?: string | undefined;
  widget?: unknown;
  chartType?: ChartType | undefined;
  chartSlot?: number | undefined;
  renderLarge?: (() => ReactNode) | undefined;
  /**
   * For a card whose `id` names an ARRANGEMENT rather than a widget — the
   * concentric rings, the Data Graphic's pair of gauges — the widgets it
   * actually draws, so Insights explains the card rather than failing to find
   * a widget by that name. Absent means `id` is itself the widget.
   */
  draws?: readonly { slot: string; widgetId: string }[] | undefined;
}): ReactElement {
  return (
    <ChartMenu
      title={title}
      source={{ kind: 'overview', slot, widgetId: id, ...(reportId === undefined ? {} : { reportId }) }}
      widget={widget}
      chartType={chartType}
      slot={chartSlot}
      renderLarge={renderLarge}
      insightParts={draws}
      clone={reportId === undefined ? undefined : { baseReportId: reportId }}
      cloneReason="This card is built from the Dashboard's own query rather than from a report, so there is nothing for the clone endpoint to copy."
      logic={logicOf(state)}
    />
  );
}

function ReportButton({ onClick, label = 'Report' }: { onClick: () => void; label?: string }): ReactElement {
  return (
    <button type="button" className="tinybtn" onClick={onClick}>
      <Icon name="chart" />
      {label}
    </button>
  );
}

/** A chart-spec widget drawn at card size, in the reader's chosen form. */
function Chart({
  widget,
  type,
  slot,
  spark,
  fill,
}: {
  widget: unknown;
  type: ChartType;
  slot?: number;
  spark?: boolean;
  fill?: boolean;
}): ReactElement {
  return <WidgetSpecView widget={widget} compact spark={spark} fill={fill} chartType={type} slot={slot} />;
}

// -- Rings and gauges (SVG the artifact draws with concentric doughnuts) -----------

function RingsSvg({ rings, size = 150 }: { rings: readonly { pct: number; colour: string }[]; size?: number }): ReactElement {
  const c = size / 2;
  const stroke = 11;
  return (
    <svg viewBox={`0 0 ${String(size)} ${String(size)}`} width="100%" height="100%" aria-hidden="true" style={{ filter: 'drop-shadow(0 3px 5px rgba(0,0,0,.12))' }}>
      {rings.map((ring, i) => {
        const r = c - stroke / 2 - 2 - i * (stroke + 4);
        const circ = 2 * Math.PI * r;
        return (
          <g key={i}>
            <circle cx={c} cy={c} r={r} fill="none" stroke={ring.colour} strokeOpacity={0.16} strokeWidth={stroke} />
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={ring.colour}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${String((circ * Math.max(0, Math.min(100, ring.pct))) / 100)} ${String(circ)}`}
              transform={`rotate(-90 ${String(c)} ${String(c)})`}
            />
          </g>
        );
      })}
    </svg>
  );
}

export function GaugeRing({ pct, colour, text, size }: { pct: number | null; colour: string; text: string; size: number }): ReactElement {
  const c = size / 2;
  const stroke = Math.max(6, Math.round(size * 0.12));
  const r = c - stroke / 2 - 1;
  const circ = 2 * Math.PI * r;
  return (
    <div className="gaugeBox" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${String(size)} ${String(size)}`} width={size} height={size} aria-hidden="true" style={{ filter: `drop-shadow(0 3px 5px ${lighten(colour, 0.2)}55)` }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke={colour} strokeOpacity={0.16} strokeWidth={stroke} />
        {pct !== null && (
          <circle cx={c} cy={c} r={r} fill="none" stroke={colour} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${String((circ * pct) / 100)} ${String(circ)}`} transform={`rotate(-90 ${String(c)} ${String(c)})`} />
        )}
      </svg>
      <div className="gaugeRing" style={{ fontSize: Math.round(size * 0.2) }}>{text}</div>
    </div>
  );
}

/** A model of a few named percentages or counts, for the type menu on rings and gauges. */
function pointsModel(points: readonly { name: string; value: number; slot: number }[]): ChartModel {
  return {
    labels: points.map((p) => p.name),
    series: [{ name: 'Value', values: points.map((p) => p.value), slot: points[0]?.slot ?? 0 }],
    categorySlots: points.map((p) => p.slot),
    categoryColoured: true,
    rowsAreCategories: false,
    stacked: false,
  };
}

/** `5,012` → 5012. Counts only — a rupee figure with a unit is refused. */
function countOf(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (/[₹CrL]/.test(value)) return null;
  const n = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && value.trim() !== '' ? n : null;
}

// -- Format A ----------------------------------------------------------------------

const TILE_IDS = ['tile-students', 'tile-staff', 'tile-attendance', 'tile-staff-attendance', 'tile-admissions', 'tile-defaulters'] as const;

export function TilesCard({ state, ids = TILE_IDS, className, title, notes = true }: { state: SlotState | undefined; ids?: readonly string[]; className?: string; title?: string; notes?: boolean }): ReactElement {
  const palette = usePalette();
  return (
    <Card className={className} title={title ?? 'At a glance'} notes={notes ? notesOf(state) : undefined}>
      <Slot state={state}>
        {(widgets) => (
          <div className={ids.length > 3 ? 'tiles6' : 'tiles'}>
            {ids.map((id, i) => {
              const k = kpiOf(widgets, id);
              const colour = paletteColour(palette, i);
              return (
                <div key={id} className="tile" style={{ background: `linear-gradient(180deg, ${lighten(colour, 0.08)}, ${colour})` }}>
                  <small>{k?.label ?? id}</small>
                  <b>{k?.value ?? '—'}</b>
                  {k?.breakdown !== undefined && (
                    <div className="parts">
                      {k.breakdown.map((p) => (
                        <span key={p.label}>{p.label} {p.value}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Slot>
    </Card>
  );
}

export function RingsCard({ state, year, asOf, onOpen }: { state: SlotState | undefined; year: string | null; asOf: string | null; onOpen: (id: string) => void }): ReactElement {
  const palette = usePalette();
  const [type, setType] = useState<ChartType>('donut');
  /**
   * The card's body, at either size. Written once and called twice — in the
   * card, and again inside Enlarge — because the enlarged view has to be THIS
   * card drawn bigger, not a second drawing of the same figures free to
   * disagree with it about which ring is which colour.
   */
  const body = (large: boolean): ReactNode => (
    <Slot state={state}>
      {(widgets) => <RingsBody widgets={widgets} palette={palette} type={type} large={large} />}
    </Slot>
  );
  return (
    <Card
      className="slotRings"
      title="Attendance and fee realisation"
      tools={
        <>
          <ReportButton onClick={() => { onOpen('fee-collection'); }} />
          <span className="tinybtn dark"><Icon name="calendar" />AY {year ?? '—'} · as of {asOf ?? '—'}</span>
          <ChartTypeSelect value={type} onChange={setType} options={RING_FORMS} />
          <CardMenu
            state={state}
            slot="rings"
            id="rings"
            title="Attendance and fee realisation"
            reportId="fee-collection"
            renderLarge={() => body(true)}
            draws={[
              { slot: 'rings', widgetId: 'ring-attendance' },
              { slot: 'rings', widgetId: 'ring-realisation' },
              { slot: 'rings', widgetId: 'ring-staff' },
              { slot: 'rings', widgetId: 'ring-total' },
            ]}
          />
        </>
      }
      notes={notesOf(state)}
    >
      {body(false)}
    </Card>
  );
}

/** The three rates as concentric rings (or in the chosen form), with the bars beside them. */
function RingsBody({ widgets, palette, type, large }: { widgets: Widget[]; palette: ChartPalette; type: ChartType; large: boolean }): ReactElement {
  const slots = [3, 2, 0];
  const rings = [kpiOf(widgets, 'ring-attendance'), kpiOf(widgets, 'ring-realisation'), kpiOf(widgets, 'ring-staff')];
  const total = kpiOf(widgets, 'ring-total');
  const points = rings.flatMap((k, i) => (k === undefined ? [] : [{ name: k.label, value: rateOf(k) ?? 0, slot: slots[i] ?? 0 }]));
  const size = large ? 280 : 150;
  return (
    <div className="ringrow">
      <div>
        <div className="chart" style={large ? { height: size } : undefined}>
          {type === 'donut' ? (
            <RingsSvg rings={points.map((p) => ({ pct: p.value, colour: paletteColour(palette, p.slot) }))} size={size} />
          ) : (
            <VividChart model={pointsModel(points)} type={type} palette={palette} compact spark height={size} />
          )}
        </div>
        <div className="ringval">{total?.value ?? '—'}</div>
        <div className="ovHead" style={{ justifyContent: 'center', marginBottom: 0 }}><div className="sub">{total?.label ?? ''}</div></div>
      </div>
      <div className="bars-list">
        {points.map((p) => (
          <div className="row" key={p.name}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{p.name}</span>
              <span style={{ color: 'var(--ink-3)' }}>{p.value}%</span>
            </div>
            <div className="track">
              <div className="fill" style={{ width: `${String(p.value)}%`, color: paletteColour(palette, p.slot) }} />
            </div>
          </div>
        ))}
        {total?.breakdown?.map((p) => (
          <div className="row" key={p.label} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--ink-2)' }}>
            <span>{p.label}</span>
            <b>{p.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MonthlyCard({ state, onOpen }: { state: SlotState | undefined; onOpen: (id: string) => void }): ReactElement {
  const widget = state?.kind === 'ready' ? state.slot.widgets[0] : undefined;
  const [type, setType] = useChartType(widget);
  return (
    <Card
      className="fillChart"
      title="Monthly fee receipts"
      tools={
        <>
          <button type="button" className="tinybtn dark" onClick={() => { onOpen('fee-collection'); }}><Icon name="calendar" />Monthly</button>
          <ChartTypeSelect value={type} onChange={setType} />
          <CardMenu state={state} slot="monthly" id="bar-month" title="Monthly fee receipts" reportId="fee-collection" widget={widget} chartType={type} chartSlot={0} />
        </>
      }
      notes={notesOf(state)}
    >
      <Slot state={state}>
        {(widgets) => <Chart widget={widgets.find((w) => w.id === 'bar-month')} type={type} slot={0} fill />}
      </Slot>
    </Card>
  );
}

/**
 * New admissions, one bar per school -- the entry level of the Admissions drill
 * path, on the Dashboard.
 *
 * It shares the left column with Monthly fee receipts (`.slotBars`, which is
 * now the STACK holding both rather than the receipts card itself), so the two
 * split that column's height evenly instead of the receipts chart taking all of
 * it. That was the point of adding it here: the receipts bars had two rows to
 * fill and nothing to say with the second one.
 *
 * The chart is not clickable. The Dashboard's slot API cannot drill (see
 * `buildAdmissionsBySchool`), so the descent is behind the Report button, which
 * opens Admissions Funnel where class and section are two more clicks away.
 */
export function AdmissionsCard({ state, onOpen }: { state: SlotState | undefined; onOpen: (id: string) => void }): ReactElement {
  const widget = state?.kind === 'ready' ? state.slot.widgets.find((w) => (w as { id?: unknown }).id === 'bar-school-admissions') : undefined;
  const [type, setType] = useChartType(widget);
  return (
    <Card
      className="fillChart"
      title="New admissions"
      tools={
        <>
          <ReportButton onClick={() => { onOpen('admissions-funnel'); }} />
          <ChartTypeSelect value={type} onChange={setType} />
          <CardMenu state={state} slot="admissions_by_school" id="bar-school-admissions" title="New admissions" reportId="admissions-funnel" widget={widget} chartType={type} chartSlot={2} />
        </>
      }
      notes={notesOf(state)}
    >
      <Slot state={state}>
        {(widgets) => <Chart widget={widgets.find((w) => (w as { id?: unknown }).id === 'bar-school-admissions')} type={type} slot={2} fill />}
      </Slot>
    </Card>
  );
}

/** Weekly Sales / Weekly Orders / Customer Analytics: a figure over a sparkline. */
export function SparkCard({ state, kpiId, lineId, className, slot, title, slotKey, reportId }: { state: SlotState | undefined; kpiId: string; lineId: string; className?: string; slot: number; title: string; slotKey: string; reportId?: string }): ReactElement {
  const widget = state?.kind === 'ready' ? state.slot.widgets.find((w) => (w as { id?: unknown }).id === lineId) : undefined;
  const [type, setType] = useState<ChartType>('area');
  return (
    <Card
      className={`spark sparkChart ${className ?? ''}`}
      title={title}
      tools={
        <>
          <ChartTypeSelect value={type} onChange={setType} />
          <CardMenu state={state} slot={slotKey} id={lineId} title={title} reportId={reportId} widget={widget} chartType={type} chartSlot={slot} />
        </>
      }
      notes={notesOf(state)}
    >
      <Slot state={state}>
        {(widgets) => {
          const k = kpiOf(widgets, kpiId);
          const week = partOf(k, 'Week of');
          return (
            <>
              <div className="val">
                {k?.value ?? '—'}{' '}
                {/* The week the figure is FOR, spelled out: the tile used to print the ISO ordinal ("W36"). */}
                <small style={{ fontWeight: 500, color: 'var(--ink-3)', fontSize: 10 }}>
                  {week === undefined ? '' : `week of ${week}`}
                </small>
              </div>
              <div className="chart">
                <Chart widget={widget} type={type} slot={slot} spark />
              </div>
            </>
          );
        }}
      </Slot>
    </Card>
  );
}

export function TopSchoolsCard({ state, onOpen }: { state: SlotState | undefined; onOpen: (id: string) => void }): ReactElement {
  const palette = usePalette();
  const body = (
    <Slot state={state}>
      {(widgets) => {
        const table = tableOf(widgets, 'table-schools');
        if (table === undefined || table.rows.length === 0) return <span className="ovMuted">No fee ledger for the selected schools.</span>;
        return <TopSchoolsList table={table} palette={palette} />;
      }}
    </Slot>
  );
  return (
    <Card
      className="slotUsers"
      title="Top schools"
      sub="By fee collected this year"
      tools={
        <>
          <ReportButton onClick={() => { onOpen('fee-comparative'); }} label="Compare" />
          <CardMenu state={state} slot="top_schools" id="table-schools" title="Top schools" reportId="fee-comparative" renderLarge={() => body} />
        </>
      }
      notes={notesOf(state)}
    >
      {body}
    </Card>
  );
}

function TopSchoolsList({ table, palette }: { table: TableWidget; palette: ChartPalette }): ReactElement {
  return (
    <div>
      {table.rows.map((row, i) => {
        const name = String(row['school'] ?? '');
        const colour = paletteColour(palette, [0, 2, 4, 1, 5, 3][i % 6] ?? i);
        return (
          <div className="userrow" key={String(row['school_id'] ?? i)}>
            <span className="skAvatar" style={{ background: `linear-gradient(135deg, ${lighten(colour, 0.14)}, ${colour})` }}>{initialsOf(name)}</span>
            <div style={{ minWidth: 0 }}>
              <b>{name}</b>
              <small>Realised {String(row['realisation'] ?? '—')}</small>
            </div>
            <span className="pill" style={{ background: paletteColour(palette, 1) }}>{String(row['collected'] ?? '')}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The four minis of the fee-activity grid, in palette slots. Each names itself
 * from its own `y_title` ("Received (₹)"), so nothing is written over them
 * here — a card-side label beside the spec's would be the same word twice.
 */
const ACTIVITY = [
  ['line-received', 3],
  ['line-late', 1],
  ['line-transport', 2],
  ['line-pending', 0],
] as const;

export function FeeHeadsCard({ state }: { state: SlotState | undefined }): ReactElement {
  const donut = state?.kind === 'ready' ? state.slot.widgets.find((w) => (w as { id?: unknown }).id === 'donut-heads') : undefined;
  const [type, setType] = useChartType(donut);
  return (
    <Card
      className="slotDonut"
      title="Fee position"
      sub={state?.kind === 'ready' ? billedLine(validWidgets(state.slot.widgets)) : undefined}
      tools={
        <>
          <ChartTypeSelect value={type} onChange={setType} />
          {/* The card is a donut AND four monthly sparklines; the insight covers
              all five, though Enlarge still draws the donut it is anchored on. */}
          <CardMenu
            state={state}
            slot="fee_heads"
            id="donut-heads"
            title="Fee position"
            reportId="fee-collection"
            widget={donut}
            chartType={type}
            chartSlot={1}
            draws={[
              { slot: 'fee_heads', widgetId: 'donut-heads' },
              ...ACTIVITY.map(([lineId]) => ({ slot: 'fee_heads', widgetId: lineId })),
            ]}
          />
        </>
      }
      notes={notesOf(state)}
    >
      <Slot state={state}>
        {(widgets) => (
          <div className="donutrow">
            <div>
              <Chart widget={donutOf(widgets, 'donut-heads')} type={type} slot={1} />
            </div>
            <div>
              <div className="actsTitle">Fee activity by month</div>
              <div className="acts">
                {ACTIVITY.map(([id, slot]) => (
                  <div key={id} className="sparkChart">
                    <Chart widget={lineOf(widgets, id)} type="area" slot={slot} spark />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Slot>
    </Card>
  );
}

function billedLine(widgets: readonly Widget[]): string | undefined {
  const k = kpiOf(widgets, 'kpi-billed');
  if (k === undefined) return undefined;
  const parts = (k.breakdown ?? []).map((p) => `${p.label} ${p.value}`).join(' · ');
  return `${k.label} ${k.value}${parts === '' ? '' : ` · ${parts}`}`;
}

// -- Format B ----------------------------------------------------------------------

/** A "big" chart card of the B row: title, type menu, kebab, chart. */
export function BigChartCard({ state, widgetId, title, slot, onOpen, reportId, slotKey }: { state: SlotState | undefined; widgetId: string; title: string; slot: number; onOpen: (id: string) => void; reportId: string; slotKey: string }): ReactElement {
  const widget = state?.kind === 'ready' ? state.slot.widgets.find((w) => (w as { id?: unknown }).id === widgetId) : undefined;
  const [type, setType] = useChartType(widget);
  return (
    <Card
      className="big"
      title={title}
      tools={
        <>
          {/* The kebab used to BE the way to the report; it is the standard
              per-chart menu now (ChartMenu.tsx), so the way through gets a
              control of its own — the same "Report" chip the other cards on
              this Dashboard already carry, rather than a fifth item that would
              make this one card's menu different from every other card's. */}
          <ReportButton onClick={() => { onOpen(reportId); }} />
          <ChartTypeSelect value={type} onChange={setType} />
          <CardMenu state={state} slot={slotKey} id={widgetId} title={title} reportId={reportId} widget={widget} chartType={type} chartSlot={slot} />
        </>
      }
      notes={notesOf(state)}
    >
      <Slot state={state}>{(widgets) => <Chart widget={widgets.find((w) => w.id === widgetId)} type={type} slot={slot} />}</Slot>
    </Card>
  );
}

export function TeamCards({ state }: { state: SlotState | undefined }): ReactElement {
  const palette = usePalette();
  if (state === undefined || state.kind === 'loading') {
    return <>{[0, 1, 2, 3].map((i) => <div key={i} className="card ovCard member"><div className="skeleton" style={{ minHeight: 48 }} /></div>)}</>;
  }
  if (state.kind === 'failed') return <div className="card ovCard"><span className="ovMuted">{state.message}</span></div>;
  if (state.slot.status !== 'ok') return <div className="card ovCard"><span className="ovMuted">{state.slot.reason}</span></div>;
  const table = tableOf(validWidgets(state.slot.widgets), 'table-top-attendance');
  const rows = table?.rows ?? [];
  if (rows.length === 0) {
    return <div className="card ovCard"><span className="ovMuted">Too few days have been marked this year to rank anyone yet.</span></div>;
  }
  return (
    <>
      {rows.map((row, i) => {
        const name = String(row['student'] ?? '');
        const colour = paletteColour(palette, [0, 2, 4, 1][i % 4] ?? i);
        return (
          <div className="card ovCard member" key={`${String(row['enrollment'])}-${String(i)}`}>
            <span className="skAvatar" style={{ background: `linear-gradient(135deg, ${lighten(colour, 0.14)}, ${colour})` }}>{initialsOf(name)}</span>
            <div style={{ minWidth: 0 }}>
              <b>{name}</b>
              <small>Class {String(row['class'] ?? '—')} · {String(row['marked'] ?? '—')} days marked</small>
              <em style={{ color: colour }}>{String(row['attendance'] ?? '—')} attendance</em>
            </div>
          </div>
        );
      })}
      {state.slot.notes.length > 0 && <p className="ovNote" style={{ gridColumn: '1 / -1', margin: 0 }}>{state.slot.notes.join(' ')}</p>}
    </>
  );
}

const GAUGES = [
  ['gauge-students-rate', 'gauge-students', 4],
  ['gauge-attendance-rate', 'gauge-attendance', 5],
  ['gauge-admissions-rate', 'gauge-admissions', 1],
  ['gauge-staff-rate', 'gauge-staff', 0],
] as const;

export function GaugeCards({ state }: { state: SlotState | undefined }): ReactElement {
  return (
    <>
      {GAUGES.map(([rateId, countId, slot]) => (
        <GaugeCard key={countId} state={state} rateId={rateId} countId={countId} slot={slot} />
      ))}

    </>
  );
}

export function GaugeCard({ state, rateId, countId, slot }: { state: SlotState | undefined; rateId: string; countId: string; slot: number }): ReactElement {
  const palette = usePalette();
  const [type, setType] = useState<ChartType>('donut');
  const colour = paletteColour(palette, slot);
  const label = state?.kind === 'ready' ? kpiOf(validWidgets(state.slot.widgets), countId)?.label ?? '' : '';
  return (
    <Card
      className="gaugeCard"
      title={label}
      tools={
        <>
          <ChartTypeSelect value={type} onChange={setType} options={GAUGE_FORMS} />
          {/* No report behind a gauge: it is the Dashboard's own reading of the
              roll and the register, so Clone is listed disabled with that
              reason rather than pointing at a report it did not come from. */}
          <CardMenu state={state} slot="gauges" id={countId} title={label === '' ? 'Gauge' : label} />
        </>
      }
    >
      <Slot state={state}>
        {(widgets) => {
          const rate = kpiOf(widgets, rateId);
          const total = kpiOf(widgets, countId);
          const pct = rateOf(rate);
          const parts = (total?.breakdown ?? []).map((p, i) => ({ name: p.label, value: countOf(p.value) ?? 0, slot: i === 0 ? slot : (slot + 3) % 6 }));
          return (
            <div className="body">
              {type === 'donut' ? (
                /* The unit is part of the figure. `rateOf` only ever returns a
                   value it parsed out of a string ENDING in `%` (widgets.ts), so
                   this number is a percentage by construction — and it sat in the
                   ring as a bare "89" beside a "1,697" in the same card, where
                   nothing said which of the two was a rate. The sibling gauge on
                   the Data Graphic card below already prints the sign; this is the
                   one that did not. */
                <GaugeRing pct={pct} colour={colour} text={pct === null ? '—' : `${String(Math.round(pct))}%`} size={70} />
              ) : (
                <div style={{ width: 130, height: 82, flex: 'none' }}>
                  <VividChart model={pointsModel(parts)} type={type} palette={palette} compact spark height={82} />
                </div>
              )}
              <div className="v">
                <b>{total?.value ?? '—'}</b>
                <small>{(total?.breakdown ?? []).map((p) => `${p.label} ${p.value}`).join(' · ') || rate?.label}</small>
              </div>
            </div>
          );
        }}
      </Slot>
    </Card>
  );
}

const STATUS_SLOT: Record<string, number> = { 'Late & unpaid': 2, 'Pays late': 3, Unpaid: 0 };

export function LatePayersCard({ state }: { state: SlotState | undefined }): ReactElement {
  const palette = usePalette();
  const body = (
    <Slot state={state}>
      {(widgets) => {
        const table = tableOf(widgets, 'table-late-payers');
        if (table === undefined || table.rows.length === 0) return <span className="ovMuted">No late or unpaid fees for the selected schools this year.</span>;
        return <LatePayersTable table={table} palette={palette} />;
      }}
    </Slot>
  );
  return (
    <Card
      title="Students paying late or not paying"
      tools={
        <CardMenu
          state={state}
          slot="late_payers"
          id="table-late-payers"
          title="Students paying late or not paying"
          reportId="fee-defaulters"
          renderLarge={() => body}
        />
      }
      notes={notesOf(state)}
    >
      {body}
    </Card>
  );
}

function LatePayersTable({ table, palette }: { table: TableWidget; palette: ChartPalette }): ReactElement {
  const masked = table.columns.find((c) => c.field === 'student')?.masked === true;
  return (
    <div className="tablewrap">
      <table className="ovTable">
        <thead>
          <tr>
            <th>#</th>
            <th>Student{masked ? ' (masked)' : ''}</th>
            <th>Class</th>
            <th>Late payments</th>
            <th>Pending</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => {
            const status = String(row['status'] ?? '');
            const student = String(row['student'] ?? '');
            const enrolment = String(row['enrollment'] ?? '');
            /**
             * No recipient: the extract carries no parent contact (agreed
             * 2026-09-04). The subject and body are prefilled so the office
             * can add the address from the ERP — the reminder is drafted,
             * not sent, from here.
             */
            const subject = encodeURIComponent(`Fee reminder — ${student === '[masked]' ? `enrolment ${enrolment}` : student} (${enrolment})`);
            const body = encodeURIComponent(`Dear parent,\n\nOur records show pending fees of ${String(row['pending'] ?? '')} for ${student === '[masked]' ? `enrolment ${enrolment}` : student}, class ${String(row['class'] ?? '')}. Late payments this year: ${String(row['late_payments'] ?? '')}.\n\nKindly clear the balance at the earliest.\n`);
            return (
              <tr key={`${enrolment}-${String(i)}`}>
                <td>{i + 1}</td>
                <td>{student}</td>
                <td>{String(row['class'] ?? '')}</td>
                <td className="num">{String(row['late_payments'] ?? '')}</td>
                <td className="num">{String(row['pending'] ?? '')}</td>
                <td><span className="pill" style={{ background: paletteColour(palette, STATUS_SLOT[status] ?? 0) }}>{status}</span></td>
                <td>
                  <a className="actionBtn" href={`mailto:?subject=${subject}&body=${body}`}>
                    <Icon name="mail" />Remind
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function InboxCard({ state }: { state: SlotState | undefined }): ReactElement {
  const palette = usePalette();
  const body = (
    <Slot state={state}>
      {(widgets) => {
        const table = tableOf(widgets, 'table-pending');
        if (table === undefined || table.rows.length === 0) return <span className="ovMuted">Nothing pending for the selected schools.</span>;
        return <PendingList table={table} palette={palette} />;
      }}
    </Slot>
  );
  return (
    <Card
      title="Pending fees"
      sub="Top 10 students by balance"
      tools={
        <CardMenu
          state={state}
          slot="pending_top"
          id="table-pending"
          title="Pending fees"
          reportId="fee-defaulters"
          renderLarge={() => body}
        />
      }
      notes={notesOf(state)}
    >
      {body}
    </Card>
  );
}

function PendingList({ table, palette }: { table: TableWidget; palette: ChartPalette }): ReactElement {
  return (
    <div>
      {table.rows.map((row, i) => {
        const name = String(row['student'] ?? '');
        const colour = paletteColour(palette, [0, 2, 4, 1, 5, 3][i % 6] ?? i);
        return (
          <div className="msg" key={`${String(row['enrollment'])}-${String(i)}`}>
            <span className="skAvatar" style={{ background: `linear-gradient(135deg, ${lighten(colour, 0.14)}, ${colour})` }}>{initialsOf(name)}</span>
            <div style={{ minWidth: 0 }}>
              <b>{name}</b>
              <small>Class {String(row['class'] ?? '—')} · overdue {String(row['overdue'] ?? '—')}</small>
            </div>
            <time>{String(row['pending'] ?? '')}</time>
          </div>
        );
      })}
    </div>
  );
}

// -- Format C ----------------------------------------------------------------------

const AREA_SERIES = [
  ['line-receipts', 'Fee receipts', 0],
  ['line-staff', 'Staff present days', 4],
  ['line-attendance', 'Student attendance %', 2],
] as const;

export function AreaCard({ state, series }: { state: SlotState | undefined; series?: string }): ReactElement {
  const palette = usePalette();
  /**
   * Which series the card opens on. The Dashboard opens on the first; My View
   * opens on the one that was SAVED, because the reader kept a line, not a
   * card with three lines behind it (myView.ts).
   */
  const [active, setActive] = useState(() => {
    const found = AREA_SERIES.findIndex(([id]) => id === series);
    return found < 0 ? 0 : found;
  });
  const [type, setType] = useState<ChartType>('area');
  const current = AREA_SERIES[active] ?? AREA_SERIES[0];
  return (
    <Card
      className="slotArea"
      tools={
        <>
          <ChartTypeSelect value={type} onChange={setType} />
          {/* Identified by the series ON SCREEN, not by the card: a reader who
              keeps "Student attendance %" wants that line on their board, and
              saving "the area card" would put whichever series happened to be
              selected there instead. */}
          <CardMenu state={state} slot="area" id={current[0]} title={current[1]} chartSlot={current[2]} />
        </>
      }
      title={
        <span className="legendBtns">
          {AREA_SERIES.map(([id, label, slot], i) => (
            <button key={id} type="button" className={i === active ? '' : 'dim'} onClick={() => { setActive(i); }}>
              <i style={{ background: paletteColour(palette, slot) }} />
              {label}
            </button>
          ))}
        </span>
      }
      notes={notesOf(state)}
    >
      <Slot state={state}>{(widgets) => <Chart widget={lineOf(widgets, current[0])} type={type} slot={current[2]} />}</Slot>
    </Card>
  );
}

export function ModesCard({ state, onOpen }: { state: SlotState | undefined; onOpen: (id: string) => void }): ReactElement {
  const widget = state?.kind === 'ready' ? state.slot.widgets[0] : undefined;
  const [type, setType] = useChartType(widget);
  return (
    <Card
      className="slotPcompany"
      title="Payment modes"
      tools={
        <>
          <ReportButton onClick={() => { onOpen('fee-collection'); }} />
          <ChartTypeSelect value={type} onChange={setType} />
          <CardMenu state={state} slot="modes" id="donut-mode" title="Payment modes" reportId="fee-collection" widget={widget} chartType={type} chartSlot={0} />
        </>
      }
      notes={notesOf(state)}
    >
      <Slot state={state}>{(widgets) => <Chart widget={donutOf(widgets, 'donut-mode')} type={type} slot={0} />}</Slot>
    </Card>
  );
}

/** Data Graphic: fee realisation and today's attendance as two gauges with a delta line. */
export function GaugesCCard({ rings, tiles }: { rings: SlotState | undefined; tiles: SlotState | undefined }): ReactElement {
  const palette = usePalette();
  const ready = rings?.kind === 'ready' && tiles?.kind === 'ready';
  const ringW = rings?.kind === 'ready' ? validWidgets(rings.slot.widgets) : [];
  const tileW = tiles?.kind === 'ready' ? validWidgets(tiles.slot.widgets) : [];
  const realisation = kpiOf(ringW, 'ring-realisation');
  const total = kpiOf(ringW, 'ring-total');
  const attendance = kpiOf(tileW, 'tile-attendance');
  const gauges: { kpi: KpiWidget | undefined; amt: string; delta: string; up: boolean; slot: number }[] = [
    { kpi: realisation, amt: partOf(total, 'Collected') ?? '—', delta: `Pending ${partOf(total, 'Pending') ?? '—'}`, up: false, slot: 0 },
    { kpi: attendance, amt: `${partOf(attendance, 'Present') ?? '—'} present`, delta: `Absent ${partOf(attendance, 'Absent') ?? '—'}`, up: (rateOf(attendance) ?? 0) >= 75, slot: 4 },
  ];
  return (
    <div className="card ovCard slotGauges">
      {/* This card has no head to hang the menu in — it is two gauges and
          nothing else — so the menu floats in its corner instead. Anchored on
          the RINGS slot, which is where the realisation figure comes from; the
          attendance gauge beside it reads the tiles slot, and both are listed
          in the logic panel because both are behind what is drawn. */}
      <span className="cardMenuFloat">
        {/* The one card that reads two slots: fee realisation from the rings,
            today's attendance from the tiles. Both are named, so the insight
            covers the card rather than half of it. */}
        <CardMenu
          state={rings}
          slot="rings"
          id="gauges-c"
          title="Money and presence"
          reportId="fee-collection"
          draws={[
            { slot: 'rings', widgetId: 'ring-realisation' },
            { slot: 'rings', widgetId: 'ring-total' },
            { slot: 'tiles', widgetId: 'tile-attendance' },
          ]}
        />
      </span>
      {!ready && rings?.kind !== 'failed' && tiles?.kind !== 'failed' ? <div className="skeleton" /> : null}
      {ready &&
        gauges.map((g, i) => (
          <GaugeC key={i} kpi={g.kpi} amt={g.amt} delta={g.delta} up={g.up} colour={paletteColour(palette, g.slot)} palette={palette} />
        ))}
      {(rings?.kind === 'failed' || tiles?.kind === 'failed') && <span className="ovMuted">These figures could not be loaded.</span>}
    </div>
  );
}

function GaugeC({ kpi, amt, delta, up, colour, palette }: { kpi: KpiWidget | undefined; amt: string; delta: string; up: boolean; colour: string; palette: ChartPalette }): ReactElement {
  const [type, setType] = useState<ChartType>('donut');
  const pct = rateOf(kpi);
  const parts = (kpi?.breakdown ?? []).slice(0, 2).map((p, i) => ({ name: p.label, value: countOf(p.value) ?? 0, slot: i === 0 ? 1 : 2 }));
  return (
    <div className="gauge">
      {type === 'donut' || parts.length < 2 ? (
        <GaugeRing pct={pct} colour={colour} text={pct === null ? '—' : `${String(Math.round(pct))}%`} size={82} />
      ) : (
        <div style={{ width: 130, height: 82, flex: 'none' }}>
          <VividChart model={pointsModel(parts)} type={type} palette={palette} compact spark height={82} />
        </div>
      )}
      <div>
        <b>{kpi?.label ?? '—'}</b>
        <div className="amt">{amt}</div>
        <span className="delta" style={{ color: up ? 'var(--ok)' : 'var(--bad)' }}>
          <i style={{ background: up ? 'var(--ok)' : 'var(--bad)' }}>{up ? '▲' : '▼'}</i>
          {delta}
        </span>
        <div style={{ marginTop: 6 }}>
          <ChartTypeSelect value={type} onChange={setType} options={GAUGE_FORMS} />
        </div>
      </div>
    </div>
  );
}

export function CustomerCard({ state }: { state: SlotState | undefined }): ReactElement {
  const widget = state?.kind === 'ready' ? state.slot.widgets.find((w) => (w as { id?: unknown }).id === 'line-late-week') : undefined;
  const [type, setType] = useState<ChartType>('line');
  const k = state?.kind === 'ready' ? kpiOf(validWidgets(state.slot.widgets), 'kpi-late-week') : undefined;
  return (
    <Card
      className="slotCust cust sparkChart"
      title={<span className="v">{k?.value ?? '—'}</span>}
      sub={k?.label ?? 'Students paying late'}
      tools={
        <>
          <ChartTypeSelect value={type} onChange={setType} />
          <CardMenu state={state} slot="late_weekly" id="line-late-week" title={k?.label ?? 'Students paying late'} reportId="fee-defaulters" widget={widget} chartType={type} chartSlot={2} />
        </>
      }
      notes={notesOf(state)}
    >
      <Slot state={state}>{() => <div className="chart"><Chart widget={widget} type={type} slot={2} spark /></div>}</Slot>
    </Card>
  );
}
