/**
 * A custom report — view, edit and version history (ADR-018, docs/06 §3).
 *
 * Two edit surfaces, matching what services/custom-reports.ts actually
 * supports for each `mode` (see that file's header for the full reasoning):
 *
 *   'template' (a predefined clone) — the Visual editor: academic year / as-of
 *   date, and a bar↔line swap per chart. The SQL tab is real and shown, but
 *   read-only — it is the same vetted, `:param`-templated statement the
 *   original dashboard's Logic panel already shows.
 *
 *   'raw_sql' (an AI-saved report) — the SQL tab is the ONLY editor, and it is
 *   hand-editable: the exact statement(s) behind the chart, guarded by the
 *   same AST validator as everything else before a save is accepted.
 *
 * Reuses `LogicPanel` and `ChartSpecView` unchanged — a custom report is
 * rendered by the identical layer a predefined dashboard is (ADR-015).
 */

import { useEffect, useState } from 'react';
import { ChartSpecView } from '@sap/chart-spec/react';
import type { Widget } from '@sap/chart-spec';
import {
  ApiFailure,
  customReportPdfUrl,
  deleteReport,
  getCustomReport,
  listReportVersions,
  rollbackReport,
  setReportVisibility,
  updateReportSql,
  updateReportVisual,
  type CustomReportResponse,
  type ReportVersionSummary,
  type SessionResponse,
} from '../api/client';
import { LogicPanel } from './LogicPanel';
import { AskAiPanel } from './AskAiPanel';

interface Props {
  session: SessionResponse;
  id: string;
  schoolIds: readonly string[];
  /** My Reports' ✎ Edit lands here with the editor already open; its View does not. */
  startEditing?: boolean;
  onBack: () => void;
  onDeleted: () => void;
}

export function ReportEditor({ session, id, schoolIds, startEditing = false, onBack, onDeleted }: Props): JSX.Element {
  const [report, setReport] = useState<CustomReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLogic, setShowLogic] = useState(false);
  /**
   * Only a seed. The editor is still owner-gated by the toggle below, and by
   * the server on every write — arriving with `startEditing` set opens a panel,
   * it does not grant anything.
   */
  const [editing, setEditing] = useState(startEditing);
  const [askAiWidget, setAskAiWidget] = useState<{ id: string; title: string } | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  const load = (): void => {
    setError(null);
    getCustomReport(id, schoolIds)
      .then((data) => { setReport(data); })
      .catch((err: unknown) => {
        setError(err instanceof ApiFailure ? err.message : 'Could not load this report.');
      });
  };

  useEffect(load, [id, schoolIds]);
  useEffect(() => { setAskAiWidget(null); }, [id]);

  if (error !== null && report === null) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="px-7 py-6 max-w-[1900px]">
          <button type="button" className="backLink" onClick={onBack}>
            ← My Reports
          </button>
          <div className="notice mt-4">{error}</div>
        </div>
      </main>
    );
  }

  if (report === null) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="px-7 py-6 max-w-[1900px]">
          <div className="mt-10 text-[13px] text-[var(--color-muted)] animate-pulse">Loading…</div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto">
      {/* 1900px, matching DashboardPage.tsx -- this screen renders the same
          `.specPanels` bento grid via ChartSpecView (a cloned report is the
          identical renderer, ADR-015), so it has the same "grid wasted at a
          reading-column width" problem, not the "single reading column"
          shape a 1180px cap fits. */}
      <div className="px-7 py-6 max-w-[1900px]">
        <button type="button" className="backLink" onClick={onBack}>
          ← My Reports
        </button>

        {error !== null && <div className="notice mt-4">{error}</div>}

        <h1 className="page-title mt-3">{report.spec.title}</h1>
        <div className="pageContext">
          <span>{report.logic.scope.map((s) => s.school_name).join(' · ')}</span>
          {report.logic.filters.map((f) => (
            <span key={f.label}>
              <span className="dot">·</span> {f.label} {f.value}
            </span>
          ))}
        </div>

        <div className="affordances">
          <button type="button" className="chipbtn" onClick={() => { setShowLogic((v) => !v); }} aria-expanded={showLogic}>
            🧠 {showLogic ? 'Hide logic' : 'View logic'}
          </button>
          {report.is_owner && (
            <button type="button" className="chipbtn" onClick={() => { setEditing((v) => !v); }} aria-expanded={editing}>
              ✎ {editing ? 'Close editor' : 'Edit'}
            </button>
          )}
          <button
            type="button"
            className="chipbtn"
            onClick={() => { setShowVersions((v) => !v); }}
            aria-expanded={showVersions}
          >
            🕘 Versions (v{report.current_version})
          </button>
          <a className="chipbtn" href={customReportPdfUrl(report.id, schoolIds, { logic: true })}>
            ⬇ PDF
          </a>
          <span className="spacer" />
          {report.is_owner && (
            <VisibilityControl
              report={report}
              onChanged={(shared_flag) => { setReport({ ...report, shared_flag }); }}
              onError={setError}
            />
          )}
          {report.is_owner && report.shared_flag === 'private' && (
            <button
              type="button"
              className="chipbtn"
              onClick={() => {
                if (!window.confirm(`Delete "${report.name}"? This cannot be undone.`)) return;
                deleteReport(report.id)
                  .then(onDeleted)
                  .catch((err: unknown) => {
                    setError(err instanceof ApiFailure ? err.message : 'Could not delete this report.');
                  });
              }}
            >
              🗑 Delete
            </button>
          )}
        </div>

        {report.degraded.length > 0 && (
          <div className="notice mb-4">
            Some panels could not be produced: {report.degraded.map((d) => d.key).join(', ')}.
          </div>
        )}
        {report.degraded_schools.length > 0 && (
          <div className="notice mb-4">
            These schools could not be reached: {report.degraded_schools.map((d) => d.school_id).join(', ')}.
          </div>
        )}

        <ChartSpecView
          spec={report.spec}
          {...(report.is_owner
            ? {
                renderWidgetActions: (widget: Widget) => (
                  <button
                    type="button"
                    className={`askAiWidgetBtn ${session.ai_status === 'active' ? '' : 'disabled'}`}
                    disabled={session.ai_status !== 'active'}
                    title={
                      session.ai_status === 'active'
                        ? `Ask AI about "${widget.title ?? report.name}"`
                        : 'Complete AI setup in Settings to ask about this chart'
                    }
                    onClick={() => {
                      setAskAiWidget({ id: widget.id, title: widget.title ?? report.name });
                    }}
                  >
                    ✦ Ask AI
                  </button>
                ),
              }
            : {})}
        />

        {showLogic && <LogicPanel report={report} />}

        {askAiWidget !== null && (
          <AskAiPanel
            reportId={report.id}
            widgetTitle={askAiWidget.title}
            schoolIds={schoolIds}
            onApplied={(updated) => { setReport(updated); }}
            onClose={() => { setAskAiWidget(null); }}
          />
        )}

        {showVersions && (
          <VersionHistory
            reportId={report.id}
            onRolledBack={(updated) => {
              setReport(updated);
              setShowVersions(false);
            }}
            onError={setError}
          />
        )}

        {editing && report.is_owner && (
          <Editor
            report={report}
            onSaved={(updated) => {
              setReport(updated);
              setEditing(false);
            }}
            onError={setError}
          />
        )}
      </div>
    </main>
  );
}

function VisibilityControl({
  report,
  onChanged,
  onError,
}: {
  report: CustomReportResponse;
  onChanged: (flag: CustomReportResponse['shared_flag']) => void;
  onError: (message: string) => void;
}): JSX.Element {
  if (!report.can_promote) {
    return (
      <span className="chipbtn disabled" title="Only an admin can share a report beyond your own view of it">
        {report.shared_flag === 'private' ? 'Private' : `Shared · ${report.shared_flag}`}
      </span>
    );
  }
  return (
    <select
      className="chipbtn"
      value={report.shared_flag}
      onChange={(e) => {
        const flag = e.target.value as CustomReportResponse['shared_flag'];
        setReportVisibility(report.id, flag)
          .then(() => { onChanged(flag); })
          .catch((err: unknown) => {
            onError(err instanceof ApiFailure ? err.message : 'Could not change visibility.');
          });
      }}
    >
      <option value="private">Private</option>
      <option value="school">Shared · school</option>
      <option value="trust">Shared · trust</option>
    </select>
  );
}

function VersionHistory({
  reportId,
  onRolledBack,
  onError,
}: {
  reportId: string;
  onRolledBack: (updated: CustomReportResponse) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [versions, setVersions] = useState<ReportVersionSummary[] | null>(null);

  useEffect(() => {
    listReportVersions(reportId)
      .then((data) => { setVersions(data.versions); })
      .catch((err: unknown) => {
        onError(err instanceof ApiFailure ? err.message : 'Could not load version history.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  return (
    <section className="card mt-4 p-4">
      <h3 className="specPanelTitle">Version history</h3>
      {versions === null ? (
        <p className="text-[13px] text-[var(--color-muted)]">Loading…</p>
      ) : (
        <ul className="list-none p-0 m-0 flex flex-col gap-2">
          {versions.map((v) => (
            <li key={v.version} className="flex items-center gap-3 text-[13px]">
              <span className="font-medium">v{v.version}</span>
              <span className="text-[var(--color-muted)]">
                {v.edited_by} · {new Date(v.edited_at).toLocaleString()}
              </span>
              <button
                type="button"
                className="chipbtn"
                onClick={() => {
                  rollbackReport(reportId, v.version)
                    .then(onRolledBack)
                    .catch((err: unknown) => {
                      onError(err instanceof ApiFailure ? err.message : 'Could not roll back to that version.');
                    });
                }}
              >
                ⟲ Rollback to this version
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Visual editor (template mode) or SQL editor (raw_sql mode) — never both. */
function Editor({
  report,
  onSaved,
  onError,
}: {
  report: CustomReportResponse;
  onSaved: (updated: CustomReportResponse) => void;
  onError: (message: string) => void;
}): JSX.Element {
  return (
    <section className="card mt-4 p-4">
      <h3 className="specPanelTitle">{report.mode === 'template' ? 'Visual editor' : 'SQL editor'}</h3>
      {report.mode === 'template' ? (
        <VisualEditor report={report} onSaved={onSaved} onError={onError} />
      ) : (
        <SqlEditor report={report} onSaved={onSaved} onError={onError} />
      )}
    </section>
  );
}

function VisualEditor({
  report,
  onSaved,
  onError,
}: {
  report: CustomReportResponse;
  onSaved: (updated: CustomReportResponse) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const currentYear = report.logic.filters.find((f) => f.label === 'Academic year')?.value ?? '';
  const currentAsOf = report.logic.filters.find((f) => f.label === 'As of')?.value ?? '';
  const [academicYear, setAcademicYear] = useState(currentYear);
  const [asOf, setAsOf] = useState(currentAsOf);
  const [saving, setSaving] = useState(false);
  const hasAsOf = currentAsOf !== '';

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[var(--color-muted)]">
        This report runs the same vetted statement as the dashboard it was cloned from — only the filter
        values below are yours to change. The SQL tab under &ldquo;View logic&rdquo; shows exactly what
        will run.
      </p>
      <label className="flex items-center gap-2 text-[13px]">
        Academic year
        <input
          className="border rounded-md px-3 py-1.5 text-[13px]"
          value={academicYear}
          placeholder="2026-27"
          onChange={(e) => { setAcademicYear(e.target.value); }}
        />
      </label>
      {hasAsOf && (
        <label className="flex items-center gap-2 text-[13px]">
          As of
          <input
            type="date"
            className="border rounded-md px-3 py-1.5 text-[13px]"
            value={asOf}
            onChange={(e) => { setAsOf(e.target.value); }}
          />
        </label>
      )}
      <div>
        <button
          type="button"
          className="chipbtn chipbtn--ai"
          disabled={saving || academicYear.trim() === ''}
          onClick={() => {
            setSaving(true);
            updateReportVisual(report.id, {
              academic_year: academicYear.trim(),
              ...(hasAsOf && asOf !== '' ? { as_of: asOf } : {}),
            })
              .then(onSaved)
              .catch((err: unknown) => {
                onError(err instanceof ApiFailure ? err.message : 'Could not save these changes.');
              })
              .finally(() => { setSaving(false); });
          }}
        >
          {saving ? 'Saving…' : 'Save as a new version'}
        </button>
      </div>
    </div>
  );
}

function SqlEditor({
  report,
  onSaved,
  onError,
}: {
  report: CustomReportResponse;
  onSaved: (updated: CustomReportResponse) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const initialQueries = report.logic.queries.map((q) => ({ key: q.key, sql: q.sql }));
  const [queries, setQueries] = useState(initialQueries);
  const [saving, setSaving] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[var(--color-muted)]">
        Hand-edited SQL passes the same guard every statement on this platform does — SELECT-only, no
        placeholders, your school scope injected automatically. A statement that fails validation is
        refused before anything is saved.
      </p>
      {queries.map((q, i) => (
        <div key={q.key} className="flex flex-col gap-1">
          <div className="text-[12px] font-medium text-[var(--color-muted)]">{q.key}</div>
          <textarea
            className="border rounded-md px-3 py-2 text-[13px] font-mono"
            rows={6}
            value={q.sql}
            onChange={(e) => {
              const next = [...queries];
              next[i] = { key: q.key, sql: e.target.value };
              setQueries(next);
            }}
          />
        </div>
      ))}
      <div>
        <button
          type="button"
          className="chipbtn chipbtn--ai"
          disabled={saving || queries.some((q) => q.sql.trim() === '')}
          onClick={() => {
            setSaving(true);
            // The chart's widget/field structure does not change from an
            // editor session; only the SQL producing its rows does. The
            // draft already stored on the report is resubmitted unchanged.
            updateReportSql(report.id, {
              queries: queries.map((q) => ({ key: q.key, sql: q.sql.trim() })),
              draft: { spec_version: 1, title: report.name, widgets: draftWidgetsFrom(report) },
            })
              .then(onSaved)
              .catch((err: unknown) => {
                onError(err instanceof ApiFailure ? err.message : 'That statement was rejected.');
              })
              .finally(() => { setSaving(false); });
          }}
        >
          {saving ? 'Validating & saving…' : 'Save as a new version'}
        </button>
      </div>
    </div>
  );
}

/**
 * Reconstructs a widget draft (query_ref, no data) from the currently
 * hydrated spec. Every raw_sql report has exactly one query per widget today
 * (services/custom-reports.ts's runRawSqlMode), so the widget's own field
 * names map straight back onto the draft shape the server re-hydrates from.
 */
function draftWidgetsFrom(report: CustomReportResponse): unknown[] {
  const key = report.logic.queries[0]?.key ?? 'q1';
  return report.spec.widgets.map((w) => {
    const widget = w as { id: string; type: string; title?: string; [k: string]: unknown };
    const base = { id: widget.id, type: widget.type, ...(widget.title === undefined ? {} : { title: widget.title }) };
    switch (widget.type) {
      case 'kpi':
        return widget;
      case 'bar':
      case 'line':
        return { ...base, x: widget['x'], y: widget['y'], query_ref: key };
      case 'donut':
        return { ...base, label_field: widget['label_field'], value_field: widget['value_field'], query_ref: key };
      case 'table':
        return { ...base, columns: widget['columns'], query_ref: key };
      default:
        return widget;
    }
  });
}
