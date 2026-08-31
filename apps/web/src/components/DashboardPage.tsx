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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChartSpecView } from '@sap/chart-spec/react';
import type { DrillTarget } from '@sap/chart-spec/react';
import type { Widget } from '@sap/chart-spec';
import {
  cloneReport,
  getReport,
  reportPdfUrl,
  ApiFailure,
  type DashboardResponse,
  type DrillStep,
  type SessionResponse,
} from '../api/client';
import { DrillTrail, useDrill, widgetIdOf } from './Drill';
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
                    /**
                     * The comparison the screen is SHOWING, read off the logic
                     * panel like the as-of date beside it — a clone captures
                     * this view, and this view compares against a year the
                     * reader may have chosen.
                     */
                    ...(shownCompareYear === null ? {} : { compare_year: shownCompareYear }),
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
