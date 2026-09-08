/**
 * A predefined dashboard.
 *
 * Contract source: docs/06 §2–3 · ADR-015 (the page renders a spec, and only a
 * spec) · ADR-019 / Invariant 6 (the Logic panel is part of the report) ·
 * ADR-018 (clone-to-edit).
 *
 * [MANDATORY] CODING_GUIDELINES §17: every report surface exposes the standard
 * affordances — View logic, Clone, PDF, scope line. All four are real here, and
 * since 2026-09-08 two of them are reached PER CHART rather than per page.
 *
 * -- Why View logic and Clone left this bar (docs/10 §1.6) --------------------
 * Both were page-level: one panel of SQL for a report of eight charts, and one
 * clone of the whole thing. Every chart now carries them in its own "⋮" menu
 * (ChartMenu.tsx), which is a better answer to both questions a reader actually
 * asks — "where does THIS number come from" and "let me keep THIS chart" — and
 * keeping a second, page-wide copy of each would be two ways to the same place
 * with different scope, one of them always the vaguer.
 *
 * Nothing is lost. The menu's logic panel shows the report's whole statement
 * set with this chart's marked (Invariant 6 is unchanged: every statement is
 * still one click away from every chart), and its clone offers "this chart" or
 * "the whole report" — the second carrying today's filter values exactly as the
 * page button did, because a clone is meant to capture "this view, editable",
 * not reset to a blank form.
 *
 * Every widget is drawn by the shared renderer in `@sap/chart-spec/react` — the
 * same layer the PDF path will use (ADR-021), so screen and export cannot
 * diverge. This file draws no chart of its own.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChartSpecView } from '@sap/chart-spec/react';
import type { DrillTarget } from '@sap/chart-spec/react';
import type { Widget } from '@sap/chart-spec';
import {
  getReport,
  reportPdfUrl,
  type DashboardResponse,
  type DrillStep,
  type SessionResponse,
} from '../api/client';
import { DrillTrail, useDrill, widgetIdOf } from './Drill';
import { ChartMenu } from './ChartMenu';
import { reportChartClone, reportChartLogic } from '../reportChartMenu';

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
  /**
   * The "Compare with" year, for a report that takes one.
   *
   * `null` means "whatever the server derives", which is the preceding year —
   * so the page opens on the comparison a reader almost always wants without
   * this component having to know how academic-year labels are spelled. The
   * value only ever LEAVES this component as a query parameter; the year the
   * report was actually built against comes back on `logic.filters` and is what
   * the control displays, so the chip, the charts and the selector cannot
   * disagree.
   */
  const [compareYear, setCompareYear] = useState<string | null>(null);

  /**
   * Which reports offer the control is read off the LOADED report, never from a
   * list of report ids kept here. `logic.filters` is the server's own statement
   * of what it bound (Invariant 6), so a report that gains or loses a comparison
   * filter changes this screen without touching this file — the same rule the
   * scope line and the as-of chip already follow.
   */
  const comparesYears = report?.logic.filters.some((f) => f.label === 'Compare with') === true;
  const shownCompareYear =
    report?.logic.filters.find((f) => f.label === 'Compare with')?.value ?? null;

  /**
   * Drill navigation, shared with the Dashboard grid's cards (components/
   * Drill.tsx). This page keeps only the decision of WHERE a failure is said —
   * in its own notice, above the charts.
   */
  const { drills, busy: drillBusy, navigate: navigateDrill, clear: clearDrills } = useDrill({
    reportId,
    schoolIds,
    academicYear,
    compareYear: compareYear ?? undefined,
    onError: useCallback((message: string | null) => { setError(message); }, []),
  });

  /**
   * A new report, or a new academic year, drops the chosen comparison year.
   *
   * Not tidiness: the years on offer are derived from the CURRENT academic year,
   * so a reader who compared 2026-27 with 2023-24 and then moved to 2024-25
   * would be left comparing a year with one four years before it — and, if the
   * years happened to coincide, with itself, which the server refuses. Falling
   * back to `null` re-derives the preceding year, which is right for every
   * report and every year.
   */
  useEffect(() => {
    setCompareYear(null);
  }, [reportId, academicYear]);

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
    clearDrills();
    getReport(reportId, schoolIds, academicYear, { compareYear: compareYear ?? undefined })
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
  }, [reportId, schoolIds, academicYear, compareYear, clearDrills]);

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
              {/**
                * The one filter this screen owns.
                *
                * Scope and academic year are chosen in the Topbar, because they
                * apply to every screen; a comparison year applies to exactly the
                * report that declares one, so it sits with that report's own
                * affordances rather than in global chrome that would show a dead
                * control on ten other pages.
                *
                * The options are DERIVED from the academic year rather than
                * fetched, and that is a deliberate limit: there is no endpoint
                * that says which years a school holds fee data for, and adding
                * a query to find out would cost a scan of the fee tables on
                * every page load. A year with no demand recorded is not hidden
                * from the list — it is chosen, and the report then shows blank
                * comparison columns with the reason in its notes, which is the
                * honest answer rather than a quietly shortened list.
                */}
              {comparesYears && academicYear !== null && (
                <label className="chipbtn chipSelect">
                  <span>Compare with</span>
                  <select
                    value={compareYear ?? shownCompareYear ?? ''}
                    disabled={loading}
                    onChange={(event) => { setCompareYear(event.target.value); }}
                  >
                    {precedingYears(academicYear).map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {/* View logic and Clone & customise used to sit here. They are
                  on every chart's own "⋮" menu now — see the header. */}
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
                    : reportPdfUrl(reportId, schoolIds, academicYear, {
                        logic: true,
                        /**
                         * The export carries the comparison on screen, not the
                         * server's default — a PDF that compared against a
                         * different year from the page it was taken from is
                         * exactly the screen/export divergence ADR-021 exists to
                         * prevent.
                         */
                        compareYear: compareYear ?? undefined,
                      })
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
              /**
                * Every panel gets the same four-action menu (ChartMenu.tsx), on
                * this screen exactly as on the Dashboard and inside a module.
                * It used to be a "⧉" that appeared on the four widgets the
                * clone endpoint would take on their own and on nothing else,
                * which meant a reader learned an affordance that then vanished
                * on the next chart.
                */
              renderWidgetActions={(widget: Widget) => {
                const drilled = drills[widget.id];
                const asOfValue = report.logic.filters.find((f) => f.label === 'As of')?.value;
                const logic = reportChartLogic(shownReport ?? report, reportId, widget.id);
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
                    <ChartMenu
                      title={widget.title ?? report.spec.title}
                      source={{ kind: 'report', reportId, widgetId: widget.id }}
                      widget={widget}
                      clone={
                        academicYear === null
                          ? undefined
                          : reportChartClone(reportId, widget.id, {
                              reportTitle: report.spec.title,
                              asOf: asOfValue,
                              compareYear: shownCompareYear ?? undefined,
                            })
                      }
                      /**
                       * A drilled panel's logic is the LEVEL's statement, not
                       * the report's top one — docs/06 §4.4 puts every level's
                       * SQL in the panel with the active one marked, and the
                       * level on screen is the active one.
                       */
                      logic={
                        drilled === undefined
                          ? logic
                          : { ...logic, activeQueryKey: drilled.query.key }
                      }
                      compareYear={shownCompareYear ?? undefined}
                    />
                  </>
                );
              }}
            />

          </>
        )}
      </div>
    </main>
  );
}

/**
 * The four academic years before this one, newest first.
 *
 * Four because a fee comparison is a management question about recent
 * behaviour, and a select of fifteen years is a scroll rather than a choice.
 * Derived here in the SPELLING the current year uses — `2026-27` gives
 * `2025-26`, the longer `2026-2027` gives `2025-2026` — so the value posted back
 * matches what the ERP writes rather than a shape this component preferred.
 *
 * An unreadable label yields an empty list, and the control then renders no
 * options rather than made-up ones; the report still loads on the server's
 * derived comparison.
 */
export function precedingYears(academicYear: string, howMany = 4): string[] {
  const long = /^(\d{4})-(\d{4})$/.exec(academicYear);
  const short = /^(\d{4})-(\d{2})$/.exec(academicYear);
  const start = Number(long?.[1] ?? short?.[1]);
  if (!Number.isInteger(start)) return [];
  return Array.from({ length: howMany }, (_unused, index) => {
    const from = start - index - 1;
    return long !== null
      ? `${String(from)}-${String(from + 1)}`
      : `${String(from)}-${String((from + 1) % 100).padStart(2, '0')}`;
  });
}

function asOf(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `today, ${time}` : date.toLocaleString();
}
