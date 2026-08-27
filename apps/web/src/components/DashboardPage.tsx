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

import { useEffect, useState } from 'react';
import { ChartSpecView } from '@sap/chart-spec/react';
import type { Widget } from '@sap/chart-spec';
import {
  cloneReport,
  getReport,
  reportPdfUrl,
  ApiFailure,
  type DashboardResponse,
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

  useEffect(() => {
    if (academicYear === null) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
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
              spec={report.spec}
              renderWidgetActions={(widget: Widget) =>
                academicYear === null || !CLONEABLE_WIDGETS[reportId]?.has(widget.id) ? undefined : (
                  <WidgetCloneButton
                    baseReportId={reportId}
                    widgetId={widget.id}
                    widgetTitle={widget.title ?? report.spec.title}
                    academicYear={academicYear}
                    schoolIds={schoolIds}
                    bucketOptions={WIDGET_BUCKET_OPTIONS[reportId]?.[widget.id]}
                    onCloned={onCloned}
                  />
                )
              }
            />

            {showLogic && <LogicPanel report={report} />}
          </>
        )}
      </div>
    </main>
  );
}

function asOf(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `today, ${time}` : date.toLocaleString();
}
