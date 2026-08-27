/**
 * A predefined dashboard.
 *
 * Contract source: docs/06 §2–3 · ADR-015 (the page renders a spec, and only a
 * spec) · ADR-019 / Invariant 6 (the Logic panel is part of the report) ·
 * ADR-018 (clone-to-edit).
 *
 * [MANDATORY] CODING_GUIDELINES §17: "Every report surface exposes the standard
 * affordances: 🧠 View logic, ⧉ Clone, ⬇ PDF, scope line. A new report surface
 * missing them is incomplete, not minimal." All four are real here.
 *
 * ⧉ Clone posts today's filter values (the ones this screen is actually
 * showing) as the new report's starting values — cloning is meant to capture
 * "this view, editable", not reset to a blank form.
 *
 * Every widget is drawn by the shared renderer in `@sap/chart-spec/react` — the
 * same layer the PDF path will use (ADR-021), so screen and export cannot
 * diverge. This file draws no chart of its own.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChartSpecView } from '@sap/chart-spec/react';
import type { DrillTarget } from '@sap/chart-spec/react';
import type { Widget } from '@sap/chart-spec';
import {
  cloneReport,
  drillReport,
  getReport,
  reportPdfUrl,
  ApiFailure,
  type DashboardResponse,
  type DrillStep,
  type SessionResponse,
} from '../api/client';
import { LogicPanel } from './LogicPanel';
import { WidgetCloneButton } from './WidgetCloneButton';
import { CLONEABLE_WIDGETS, WIDGET_BUCKET_OPTIONS } from '../reportWidgetClone';

interface Props {
  session: SessionResponse;
  reportId: string;
  schoolIds: readonly string[];
  academicYear: string | null;
  onBack: () => void;
  onAskAI: (seedQuestion: string) => void;
  onCloned: (id: string) => void;
}

export function DashboardPage({
  session,
  reportId,
  schoolIds,
  academicYear,
  onBack,
  onAskAI,
  onCloned,
}: Props): JSX.Element {
  const [report, setReport] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLogic, setShowLogic] = useState(false);
  const [cloning, setCloning] = useState(false);

  /**
   * Drilled panels, keyed by widget id (ADR-020). Absent means level 1 — the
   * chart as the dashboard response delivered it, which is why Reset costs no
   * request: level 1 never left.
   */
  const [drills, setDrills] = useState<Record<string, DrillState>>({});
  const [drillBusy, setDrillBusy] = useState<string | null>(null);

  useEffect(() => {
    if (academicYear === null) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    /**
     * A new report, school set or year invalidates every drilled panel. Keeping
     * a class breakdown of last year's fees on screen while the heading said
     * this year would be the success-shaped failure §10 names — so the drill
     * stack is cleared with the fetch that replaces the data under it.
     */
    setDrills({});
    setDrillBusy(null);
    getReport(reportId, schoolIds, academicYear)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err: unknown) => {
        // Fail loud (§10): an empty dashboard would read as "no data".
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this report.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [reportId, schoolIds, academicYear]);

  /**
   * Fetch the level reached by `context`, or restore level 1 when it is empty.
   *
   * One function for both a click (context grows by one) and a breadcrumb jump
   * (context is truncated), because they are the same request: the level is
   * always `context.length + 1`. A separate "go back" path would be a second
   * way to compute the same number, and the first time they disagreed the
   * breadcrumb would name a slice the chart is not showing.
   */
  function navigateDrill(widgetId: string, context: readonly DrillStep[]): void {
    if (academicYear === null) return;
    if (context.length === 0) {
      setDrills((current) => {
        const next = { ...current };
        delete next[widgetId];
        return next;
      });
      return;
    }
    setDrillBusy(widgetId);
    setError(null);
    drillReport(reportId, schoolIds, academicYear, {
      widget_id: widgetId,
      level: context.length + 1,
      context,
    })
      .then((result) => {
        setDrills((current) => ({
          ...current,
          [widgetId]: {
            widget: result.widget,
            context: result.context,
            level: result.level,
            query: result.query,
          },
        }));
        if (result.degraded.length > 0 || result.degraded_schools.length > 0) {
          setError('That level could not be read for every school in the selection.');
        }
      })
      .catch((err: unknown) => {
        // The panel stays on the level it was: a failed drill must not leave
        // the chart blank under a breadcrumb claiming it drilled (§10).
        setError(err instanceof ApiFailure ? err.message : 'Could not drill into that value.');
      })
      .finally(() => {
        setDrillBusy((busy) => (busy === widgetId ? null : busy));
      });
  }

  /**
   * The spec as it should be DRAWN: every drilled widget replaced in place by
   * the level currently on screen.
   *
   * Substituted here rather than by mutating `report`, so the level-1 spec is
   * still intact for Reset, for the PDF link (which rebuilds server-side
   * anyway) and for the clone button, which is meant to capture the report —
   * not one reader's navigation through it.
   */
  const shownSpec = useMemo(() => {
    if (report === null) return null;
    if (Object.keys(drills).length === 0) return report.spec;
    return {
      ...report.spec,
      widgets: report.spec.widgets.map((widget) => {
        const id = widgetIdOf(widget);
        return id !== null && drills[id] !== undefined ? drills[id].widget : widget;
      }),
    };
  }, [report, drills]);

  /**
   * The base report's statements plus the active drill level's, so Invariant 6
   * holds at every level rather than only at the top (docs/06 §4.4).
   */
  const shownReport = useMemo(() => {
    if (report === null) return null;
    const levels = Object.values(drills);
    if (levels.length === 0) return report;
    const known = new Set(report.logic.queries.map((q) => q.key));
    const extra = levels.map((d) => d.query).filter((q) => q.sql !== '' && !known.has(q.key));
    return { ...report, logic: { ...report.logic, queries: [...report.logic.queries, ...extra] } };
  }, [report, drills]);

  const activeDrill = Object.values(drills)[0];

  return (
    <main className="flex-1 overflow-y-auto">
      {/* 1900px, not the 1180px "reading column" width other single-report
          screens use (AskAI.tsx) -- this page's body is `.specPanels`, a
          12-column bento grid of charts (Home.tsx carries the identical
          reasoning for its card grid). Capping a grid at 1180px on a wide
          monitor doesn't make it more readable, it just wastes the columns
          beside it and forces every panel into a narrower, more cramped
          share of the space that IS given to it. */}
      <div className="px-7 py-6 max-w-[1900px]">
        <button type="button" className="backLink" onClick={onBack}>
          ← Home
        </button>

        {error !== null && <div className="notice mt-4">{error}</div>}

        {report === null ? (
          <div className="mt-10 text-[13px] text-[var(--color-muted)] animate-pulse">
            {error === null ? 'Querying your schools…' : ''}
          </div>
        ) : (
          <>
            <h1 className="page-title mt-3">{report.spec.title}</h1>

            {/* docs/10 §3: scope on screen, and "as of" because docs/03
                assumption 2 only accepts replica lag if it is labelled.

                The filters are whatever the SERVER says it bound, not a fixed
                "AY …" label. Staff records carry no academic year, so a hardcoded
                year here would print a filter that report never applied. */}
            <div className="pageContext">
              <span>{report.logic.scope.map((s) => s.school_name).join(' · ')}</span>
              {report.logic.filters.map((f) => (
                <span key={f.label}>
                  <span className="dot">·</span> {f.label} {f.value}
                </span>
              ))}
              <span className="dot">·</span>
              <span>data as of {asOf(report.spec.meta.as_of ?? report.spec.meta.generated_at)}</span>
              {loading && (
                <>
                  <span className="dot">·</span>
                  <span>refreshing…</span>
                </>
              )}
            </div>

            <div className="affordances">
              <button
                type="button"
                className="chipbtn"
                onClick={() => { setShowLogic((v) => !v); }}
                aria-expanded={showLogic}
              >
                🧠 {showLogic ? 'Hide logic' : 'View logic'}
              </button>
              <button
                type="button"
                className="chipbtn"
                disabled={cloning || academicYear === null}
                title="Clone this dashboard into My Reports, editable, without changing the original"
                onClick={() => {
                  if (academicYear === null) return;
                  const name = window.prompt('Name this report', `${report?.spec.title ?? 'Report'} (copy)`);
                  if (name === null || name.trim() === '') return;
                  setCloning(true);
                  setError(null);
                  const asOfValue = report?.logic.filters.find((f) => f.label === 'As of')?.value;
                  cloneReport({
                    base_report_id: reportId,
                    name: name.trim(),
                    academic_year: academicYear,
                    ...(asOfValue === undefined ? {} : { as_of: asOfValue }),
                    school_ids: schoolIds,
                  })
                    .then((cloned) => { onCloned(cloned.id); })
                    .catch((err: unknown) => {
                      setError(err instanceof ApiFailure ? err.message : 'Could not clone this report.');
                    })
                    .finally(() => { setCloning(false); });
                }}
              >
                {cloning ? 'Cloning…' : '⧉ Clone & customise'}
              </button>
              {/**
                * A link, not a fetch. The server sets `Content-Disposition`, so
                * the browser handles the download itself -- with a real
                * progress indicator and the filename the server chose. Buffering
                * a multi-megabyte binary through JavaScript to re-offer it as a
                * blob would be more code and a worse download.
                *
                * `logic=1` prints the appendix docs/06 §5 describes: source,
                * grouping, notes and every statement behind the numbers. On a
                * document that will be forwarded and filed, "where did this come
                * from?" should be answerable from the paper (Invariant 6).
                */}
              <a
                className={`chipbtn ${academicYear === null ? 'disabled' : ''}`}
                href={
                  academicYear === null
                    ? undefined
                    : reportPdfUrl(reportId, schoolIds, academicYear, { logic: true })
                }
                title="Download this report as a branded PDF, with the SQL appendix"
              >
                ⬇ PDF
              </a>
              <span className="spacer" />
              <button
                type="button"
                className={`chipbtn chipbtn--ai ${session.ai_status === 'active' ? '' : 'disabled'}`}
                disabled={session.ai_status !== 'active'}
                title={
                  session.ai_status === 'active'
                    ? 'Ask AI about this data'
                    : 'Complete AI setup in Settings to ask about this data'
                }
                onClick={() => {
                  // docs/05 §2: "Ask AI about this data" is the deliberate
                  // bridge from the deterministic path into the AI path with
                  // context (ADR-016) -- a seed question naming the report,
                  // not a full context thread (that is later work).
                  onAskAI(`About ${report?.spec.title ?? 'this report'}: `);
                }}
              >
                ✦ Ask AI about this data
              </button>
            </div>

            {/* ADR-011 applied to panels: a chart that failed says so; the rest
                of the report still renders. */}
            {report.degraded.length > 0 && (
              <div className="notice mb-4">
                Some panels could not be produced:{' '}
                {report.degraded.map((d) => d.key).join(', ')}.
              </div>
            )}
            {report.degraded_schools.length > 0 && (
              <div className="notice mb-4">
                These schools could not be reached, so the totals are partial:{' '}
                {report.degraded_schools.map((d) => d.school_id).join(', ')}.
              </div>
            )}

            {/* The spec goes in unvalidated on purpose: the renderer validates
                it against the schema before drawing (ADR-015, §10). */}
            <ChartSpecView
              spec={shownSpec}
              /**
               * A click on a drillable chart (ADR-020). The renderer reports
               * WHICH value was clicked; deciding what to fetch is this page's
               * job, because the drill path is server-side catalog (DRILL_PATHS)
               * and the spec carries only the dimension, never a query.
               */
              onDrill={(widget: Widget, target: DrillTarget) => {
                navigateDrill(widget.id, [...(drills[widget.id]?.context ?? []), target]);
              }}
              renderWidgetActions={(widget: Widget) => {
                const drilled = drills[widget.id];
                const cloneable =
                  academicYear !== null && CLONEABLE_WIDGETS[reportId]?.has(widget.id) === true;
                if (drilled === undefined && !cloneable) return undefined;
                return (
                  <>
                    {drilled !== undefined && (
                      <DrillTrail
                        title={report.spec.title}
                        state={drilled}
                        busy={drillBusy === widget.id}
                        onJump={(depth) => {
                          navigateDrill(widget.id, drilled.context.slice(0, depth));
                        }}
                      />
                    )}
                    {cloneable && academicYear !== null && (
                      <WidgetCloneButton
                        baseReportId={reportId}
                        widgetId={widget.id}
                        widgetTitle={widget.title ?? report.spec.title}
                        academicYear={academicYear}
                        schoolIds={schoolIds}
                        bucketOptions={WIDGET_BUCKET_OPTIONS[reportId]?.[widget.id]}
                        onCloned={onCloned}
                      />
                    )}
                  </>
                );
              }}
            />

            {showLogic && shownReport !== null && (
              <LogicPanel report={shownReport} activeQueryKey={activeDrill?.query.key} />
            )}
          </>
        )}
      </div>
    </main>
  );
}

/**
 * Where a drilled panel currently is (ADR-020, docs/06 §4.4).
 *
 * Page state, not spec state. ADR-015 keeps the spec a description of WHAT to
 * draw; which level a reader has navigated to is a property of this session at
 * this moment, and putting it in the spec would mean a saved report or a PDF
 * carried someone else's navigation.
 *
 * Keyed by widget id because a report may hold more than one drillable chart
 * and each drills independently. `null` for a widget means level 1 — the chart
 * exactly as the dashboard response delivered it, which is why Reset needs no
 * request: level 1 is already in hand.
 */
interface DrillState {
  readonly widget: unknown;
  readonly context: readonly DrillStep[];
  readonly level: number;
  readonly query: { key: string; description: string; sql: string };
}

/**
 * Breadcrumb, Back and Reset for a drilled panel, rendered into the panel's
 * existing actions slot beside the Clone button.
 *
 * In the PAGE rather than in the renderer, for the same reason the Clone button
 * is: `@sap/chart-spec` draws specs and the PDF uses the identical code path
 * (ADR-021), so an interactive control living there would either print or need
 * a flag to stop it printing. The renderer's only part in this is reporting the
 * click.
 */
function DrillTrail({
  title,
  state,
  busy,
  onJump,
}: {
  title: string;
  state: DrillState;
  busy: boolean;
  /** Jump to `depth` steps of context — 0 is level 1, the un-drilled chart. */
  onJump: (depth: number) => void;
}): JSX.Element {
  /*
   * The root crumb is the REPORT's name, not the un-drilled chart's title
   * ("Demand, collection and pending by school"). docs/06 §4.3 writes the trail
   * as `Fee Collection ▸ Apr-26 ▸ Class 9`, and a root that restated the whole
   * chart title would fill the panel head while saying nothing the drilled
   * chart's own title does not already say.
   */
  return (
    <div className="drillTrail">
      <span className="drillLevel">Level {state.level} of 3</span>
      <button
        type="button"
        className="drillCrumb"
        onClick={() => { onJump(0); }}
        disabled={busy}
      >
        {title}
      </button>
      {state.context.map((step, index) => (
        <span key={`${step.dim}:${step.value}`}>
          <span className="drillCrumbSep">▸</span>{' '}
          <button
            type="button"
            className="drillCrumb"
            /* The last crumb is where the reader already is: it names the
               current view rather than offering to navigate to it. */
            disabled={busy || index === state.context.length - 1}
            onClick={() => { onJump(index + 1); }}
          >
            {step.label}
          </button>
        </span>
      ))}
      <button
        type="button"
        className="chipbtn"
        disabled={busy}
        onClick={() => { onJump(state.context.length - 1); }}
      >
        ← Back
      </button>
      <button type="button" className="chipbtn" disabled={busy} onClick={() => { onJump(0); }}>
        ⟲ Reset
      </button>
      {busy && <span className="drillBusy">loading…</span>}
    </div>
  );
}

/**
 * A widget's id, off an `unknown` from the API.
 *
 * `DashboardResponse.spec.widgets` is deliberately `unknown[]` in the client
 * (api/client.ts): the renderer validates against the schema before drawing, and
 * a narrower type here would be a second, weaker copy of that check. This page
 * needs only the id, to know which panel a drilled level replaces, so it reads
 * exactly that and nothing else.
 */
function widgetIdOf(widget: unknown): string | null {
  if (typeof widget !== 'object' || widget === null) return null;
  const id = (widget as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function asOf(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `today, ${time}` : date.toLocaleString();
}
