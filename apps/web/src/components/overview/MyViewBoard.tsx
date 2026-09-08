/**
 * My View — the board a reader builds themselves.
 *
 * View 1, View 2 and View 3 are arrangements this product chose (docs/10 §1.5).
 * This is the fourth tab, left of them, and it holds whatever the reader put on
 * it through any chart's "⋮ → Add to My View" (ChartMenu.tsx), from the
 * Dashboard, from a report, or from a module's preview card.
 *
 * -- It is references, not a snapshot ------------------------------------------
 * What is saved is which chart, never its numbers (myView.ts). This screen
 * fetches exactly like the Dashboard does — the same slot endpoints for a
 * Dashboard card, `/api/report/:id` for a report panel — under the scope and
 * academic year in force NOW. A reader who narrows their school selection sees
 * their own board narrow with it, because there is no other way for it to
 * behave: a saved figure would be a figure that outlived the scope check that
 * produced it (Invariant 2).
 *
 * -- Why a Dashboard card is redrawn by its own component ----------------------
 * See registry.tsx. The short version: half these cards are arrangements of
 * several widgets, and redrawing one of them from a single widget would put a
 * chart on the board that the reader never saved.
 *
 * -- Reports are fetched whole, once each --------------------------------------
 * A board holding four panels of Trend Analysis is ONE request, not four: the
 * report endpoint answers with the whole spec anyway, and asking for it four
 * times would be four fee-ledger scans for one screen. That is the same
 * reasoning `useOverview` applies to slots, one level up.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  ChartTypeSelect,
  WidgetSpecView,
  defaultChartTypeOf,
  type ChartType,
} from '@sap/chart-spec/react';
import {
  getCustomReport,
  getReport,
  type CustomReportResponse,
  type DashboardResponse,
} from '../../api/client';
import { reportFetchesOf, useMyView, type ChartSource, type MyViewChart } from '../../myView';
import { NO_CLONE_REASON, reportChartClone, reportChartLogic } from '../../reportChartMenu';
import { ChartMenu } from '../ChartMenu';
import { Card } from './cards';
import { overviewCardOf, type OverviewCardCtx } from './registry';

/**
 * A predefined report and one of the reader's own are two endpoints and two
 * response shapes, but the board draws them identically: both carry a spec and
 * a `logic`, which is all a panel and its menu need. The difference that DOES
 * matter is the clone base — a custom report's is the predefined report it was
 * cloned from, and an AI-saved one has none (`base_report_id: null`).
 */
type Fetched = DashboardResponse | CustomReportResponse;

type ReportState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly report: Fetched }
  | { readonly kind: 'failed'; readonly message: string };

/** The clone endpoint's base for a fetched report, or null where it has none. */
function cloneBaseOf(source: ChartSource, report: Fetched): string | null {
  if (source.kind !== 'report') return null;
  if (source.custom !== true) return source.reportId;
  return 'base_report_id' in report ? report.base_report_id : null;
}

export function MyViewBoard({
  ctx,
  schoolIds,
  academicYear,
}: {
  ctx: OverviewCardCtx;
  schoolIds: readonly string[];
  academicYear: string | null;
}): ReactElement {
  const myView = useMyView();
  const reports = useMyViewReports(myView.charts, schoolIds, academicYear);

  if (myView.charts.length === 0) {
    return (
      <div className="card myViewEmpty">
        <h2>Your view is empty</h2>
        <p>
          Every chart in this product carries a <b>⋮</b> menu — on this Dashboard, on Trend
          Analysis and Comparative Analysis, and on every report inside Module Wise Analysis.
          Open it on a chart you keep coming back to and choose <b>Add to My View</b>, and it
          lands here.
        </p>
        <p className="myViewEmptyFine">
          Only the choice is stored, in this browser. The figures are fetched fresh under the
          schools and academic year you have selected, exactly as they are everywhere else.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="myViewBar">
        <span>
          {myView.charts.length} {myView.charts.length === 1 ? 'chart' : 'charts'} on your board
        </span>
        <button
          type="button"
          className="tinybtn"
          onClick={() => {
            if (window.confirm('Remove every chart from My View?')) myView.clear();
          }}
        >
          Clear my view
        </button>
      </div>

      <div className="myViewGrid">
        {myView.charts.map((chart, index) => (
          <BoardItem
            key={chart.id}
            chart={chart}
            index={index}
            count={myView.charts.length}
            ctx={ctx}
            reports={reports}
            onMove={(by) => { myView.move(chart.id, by); }}
            onRemove={() => { myView.remove(chart.source); }}
          />
        ))}
      </div>
    </>
  );
}

function BoardItem({
  chart,
  index,
  count,
  ctx,
  reports,
  onMove,
  onRemove,
}: {
  chart: MyViewChart;
  index: number;
  count: number;
  ctx: OverviewCardCtx;
  reports: Record<string, ReportState>;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}): ReactElement {
  const def = overviewCardOf(chart);
  const span = def?.span ?? 6;

  return (
    <section className="myViewItem" style={{ gridColumn: `span ${String(span)}` }}>
      {/**
        * The reader's own controls for their own board: where a card sits, and
        * whether it stays. Deliberately OUTSIDE the card rather than a fifth
        * item inside its "⋮" menu — the menu is the same four actions on every
        * chart in the product, and "move left" is meaningless on the twenty
        * charts that are not on this board.
        */}
      <div className="myViewItemBar">
        <span className="myViewItemName">{chart.title}</span>
        <button type="button" className="myViewItemBtn" disabled={index === 0} title="Move earlier" aria-label={`Move ${chart.title} earlier`} onClick={() => { onMove(-1); }}>←</button>
        <button type="button" className="myViewItemBtn" disabled={index === count - 1} title="Move later" aria-label={`Move ${chart.title} later`} onClick={() => { onMove(1); }}>→</button>
        <button type="button" className="myViewItemBtn" title="Remove from My View" aria-label={`Remove ${chart.title} from My View`} onClick={onRemove}>✕</button>
      </div>

      {chart.source.kind === 'overview' ? (
        def === undefined ? (
          <Card title={chart.title}>
            <span className="ovMuted">
              This build no longer draws that Dashboard card, so there is nothing to show here.
              Remove it with ✕ above.
            </span>
          </Card>
        ) : (
          def.render(ctx)
        )
      ) : (
        <ReportChartCard chart={chart} state={reports[reportFetchKey(chart.source)]} />
      )}
    </section>
  );
}

/** Which fetch a report source belongs to — see `reportFetchesOf` (myView.ts). */
function reportFetchKey(source: ChartSource): string {
  if (source.kind !== 'report') return '';
  return `${source.custom === true ? 'custom' : 'predefined'}:${source.reportId}`;
}

/** One panel of a report, on the board — the same widget the report draws. */
function ReportChartCard({ chart, state }: { chart: MyViewChart; state: ReportState | undefined }): ReactElement {
  const source = chart.source;
  const widget =
    state?.kind === 'ready' && source.kind === 'report'
      ? state.report.spec.widgets.find((w) => (w as { id?: unknown }).id === source.widgetId)
      : undefined;
  const [chosen, setChosen] = useState<ChartType | null>(null);
  const type = chosen ?? defaultChartTypeOf(widget);

  if (source.kind !== 'report') return <Card title={chart.title}><span className="ovMuted">—</span></Card>;

  if (state === undefined || state.kind === 'loading') {
    return <Card title={chart.title}><div className="skeleton" /></Card>;
  }
  if (state.kind === 'failed') {
    return <Card title={chart.title}><span className="ovMuted">{state.message}</span></Card>;
  }
  if (widget === undefined) {
    /* Fail loud (§10): a panel the report no longer holds must not render as an
       empty chart, which reads as "there is no data" rather than "this moved". */
    return (
      <Card title={chart.title}>
        <span className="ovMuted">
          {state.report.spec.title} no longer has a panel called “{source.widgetId}”. Remove it
          with ✕ above.
        </span>
      </Card>
    );
  }

  const title = (widget as { title?: unknown }).title;
  const label = typeof title === 'string' ? title : chart.title;
  const base = cloneBaseOf(source, state.report);

  return (
    <Card
      title={label}
      sub={state.report.spec.title}
      tools={
        <>
          <ChartTypeSelect value={type} onChange={setChosen} />
          <ChartMenu
            title={label}
            source={source}
            widget={widget}
            chartType={type}
            clone={reportChartClone(base, source.widgetId, { reportTitle: state.report.spec.title })}
            cloneReason={NO_CLONE_REASON}
            logic={reportChartLogic(state.report, base, source.widgetId)}
          />
        </>
      }
    >
      <WidgetSpecView widget={widget} chartType={type} />
    </Card>
  );
}

/**
 * The reports the board needs, each fetched once.
 *
 * Held in a ref keyed by scope and year for the same reason `useOverview` holds
 * its slots that way: a result may never be reused for a scope or year it was
 * not fetched under, and a change of either clears everything rather than
 * leaving one panel disagreeing with the rest of the page about what it shows.
 */
function useMyViewReports(
  charts: readonly MyViewChart[],
  schoolIds: readonly string[],
  academicYear: string | null,
): Record<string, ReportState> {
  const [states, setStates] = useState<Record<string, ReportState>>({});
  const schoolsKey = schoolIds.join(',');
  const cacheKey = `${schoolsKey}|${academicYear ?? ''}`;
  const held = useRef<Record<string, ReportState>>({});
  const heldUnder = useRef(cacheKey);
  const wanted = reportFetchesOf(charts);
  const wantedKey = wanted.map((w) => w.key).join('|');
  /**
   * The effect reads the wanted list at the moment it RUNS, through a ref, and
   * depends only on the joined key. A new array with the same members must not
   * refetch every report — the same rule `useOverview` follows for its slots.
   */
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;

  useEffect(() => {
    if (heldUnder.current !== cacheKey) {
      held.current = {};
      heldUnder.current = cacheKey;
    }
    if (academicYear === null || schoolIds.length === 0) {
      setStates({});
      return undefined;
    }

    const fetches = wantedRef.current;
    const known: Record<string, ReportState> = {};
    for (const fetch of fetches) {
      const have = held.current[fetch.key];
      if (have !== undefined) known[fetch.key] = have;
    }
    setStates(known);

    let cancelled = false;
    const fetchedUnder = cacheKey;
    for (const fetch of fetches) {
      if (known[fetch.key] !== undefined) continue;
      const request = fetch.custom
        ? getCustomReport(fetch.reportId, schoolIds)
        : getReport(fetch.reportId, schoolIds, academicYear);
      request
        .then((report: Fetched) => {
          const state: ReportState = { kind: 'ready', report };
          if (heldUnder.current === fetchedUnder) held.current[fetch.key] = state;
          if (!cancelled) setStates((current) => ({ ...current, [fetch.key]: state }));
        })
        .catch((err: unknown) => {
          /* Not held: the next visit should retry rather than redraw the error. */
          if (!cancelled) {
            setStates((current) => ({
              ...current,
              [fetch.key]: { kind: 'failed', message: err instanceof Error ? err.message : 'This report could not be loaded.' },
            }));
          }
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, cacheKey, academicYear]);

  return states;
}
