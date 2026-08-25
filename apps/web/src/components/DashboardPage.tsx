/**
 * A predefined dashboard.
 *
 * Contract source: docs/06 §2–3 · ADR-015 (the page renders a spec, and only a
 * spec) · ADR-019 / Invariant 6 (the Logic panel is part of the report).
 *
 * [MANDATORY] CODING_GUIDELINES §17: "Every report surface exposes the standard
 * affordances: 🧠 View logic, ⧉ Clone, ⬇ PDF, scope line. A new report surface
 * missing them is incomplete, not minimal."
 *
 * Logic and the scope line are here and real. Clone (ADR-018) and PDF (ADR-021)
 * are rendered DISABLED with the reason, rather than omitted: docs/10 §3's
 * "locked ≠ hidden" applies to unbuilt affordances as much as to gated ones, and
 * a user who cannot see that cloning is coming will not ask for it. They need
 * `report_definitions` and the Puppeteer path respectively.
 *
 * Every widget is drawn by the shared renderer in `@sap/chart-spec/react` — the
 * same layer the PDF path will use (ADR-021), so screen and export cannot
 * diverge. This file draws no chart of its own.
 */

import { useEffect, useState } from 'react';
import { ChartSpecView } from '@sap/chart-spec/react';
import {
  getReport,
  reportPdfUrl,
  type DashboardResponse,
  type SessionResponse,
} from '../api/client';

interface Props {
  session: SessionResponse;
  reportId: string;
  schoolIds: readonly string[];
  academicYear: string | null;
  onBack: () => void;
  onAskAI: (seedQuestion: string) => void;
}

export function DashboardPage({
  session,
  reportId,
  schoolIds,
  academicYear,
  onBack,
  onAskAI,
}: Props): JSX.Element {
  const [report, setReport] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLogic, setShowLogic] = useState(false);

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
      <div className="px-7 py-6 max-w-[1180px]">
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
                className="chipbtn disabled"
                disabled
                title="Cloning needs the saved-report store (ADR-018) — not built yet"
              >
                ⧉ Clone &amp; customise
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
            <ChartSpecView spec={report.spec} />

            {showLogic && <LogicPanel report={report} />}
          </>
        )}
      </div>
    </main>
  );
}

/**
 * docs/06 §3: "plain-language chips (Source · Scope · Filters · Group-by ·
 * Chart) + the generated SQL, read-only. Scope line states it is injected from
 * the token and cannot be widened."
 *
 * This is Invariant 6 on screen. A Principal has to be able to answer "where
 * does this number come from?", and the answer is the statement itself.
 */
function LogicPanel({ report }: { report: DashboardResponse }): JSX.Element {
  const { logic } = report;
  return (
    <section className="card logicPanel" aria-label="Report logic">
      <h3 className="specPanelTitle">Report logic</h3>

      <dl className="logicChips">
        <Chip label="Source" value={logic.source} />
        <Chip
          label="Scope"
          value={`${logic.scope.map((s) => s.school_name).join(', ')} — injected from your launch token, read-only`}
        />
        <Chip label="Filters" value={logic.filters.map((f) => `${f.label}: ${f.value}`).join(' · ')} />
        <Chip label="Group by" value={logic.group_by.join(' · ')} />
        <Chip label="Charts" value={[...new Set(logic.charts)].join(' · ')} />
        <Chip label="Served from" value={`${report.spec.meta.served_from} (three-tier order)`} />
      </dl>

      {logic.notes.map((note) => (
        <p key={note} className="logicNote">
          {note}
        </p>
      ))}

      <h4 className="logicSqlHeading">Generated SQL</h4>
      {logic.queries.map((query) => (
        <div key={query.key} className="logicQuery">
          <div className="logicQueryTitle">
            {query.key} — {query.description}
          </div>
          {/* Rendered as text, never as markup (§4). */}
          <pre className="logicSql">{query.sql}</pre>
        </div>
      ))}
    </section>
  );
}

function Chip({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="logicChip">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function asOf(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `today, ${time}` : date.toLocaleString();
}
