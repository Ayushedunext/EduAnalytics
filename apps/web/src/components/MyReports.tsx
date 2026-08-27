/**
 * My Reports — custom reports and saved AI snapshots (ADR-018, docs/06 §3).
 *
 * Two tables, not one list, and the split is the report's ORIGIN
 * (`source_kind`): a clone of a predefined dashboard carries a lineage —
 * which dashboard, which version of your edits — while an Ask AI snapshot
 * carries none of that and instead answers "when did I save this". Columns
 * that would be permanently blank for half the rows are the reason these are
 * two tables rather than one with holes in it (docs/10 §3's reports screen).
 *
 * Lists everything this user owns, plus anything a colleague shared to
 * `school`/`trust` visibility. The list carries no scope control of its own:
 * opening a report resolves scope the same way every other report does
 * (`getCustomReport`, effective scope intersected with the viewer's token
 * scope — AUDIT_REPORT A8), so there is nothing here that could offer a stale
 * or wrong scope to pick from. The Scope column is therefore a statement of
 * what the report was SAVED against, not a control.
 */

import { useEffect, useState } from 'react';
import {
  ApiFailure,
  cloneReport,
  customReportPdfUrl,
  duplicateReport,
  listMyReports,
  listReportSources,
  type CustomReportSummary,
  type ReportSource,
} from '../api/client';

interface Props {
  schoolIds: readonly string[];
  academicYear: string | null;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
}

const VISIBILITY_LABEL: Record<CustomReportSummary['shared_flag'], string> = {
  private: 'Private',
  school: 'Shared · school',
  trust: 'Shared · trust',
};

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function MyReports({ schoolIds, academicYear, onOpen, onEdit }: Props): JSX.Element {
  const [reports, setReports] = useState<CustomReportSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = (): void => {
    listMyReports()
      .then((data) => { setReports(data.reports); })
      .catch((err: unknown) => {
        // Fail loud (§10): an empty list here would read as "you have no reports".
        setError(err instanceof Error ? err.message : 'Could not load My Reports.');
      });
  };

  useEffect(load, []);

  const custom = reports?.filter((r) => r.source_kind === 'predefined_clone') ?? [];
  const aiSaved = reports?.filter((r) => r.source_kind === 'ai_saved') ?? [];

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[1900px]">
        <div className="reportsHead">
          <div className="min-w-0">
            <h1 className="page-title">My Reports</h1>
            <div className="page-sub">
              Custom reports (clones you own — logic always visible) and saved AI snapshots · all
              re-run with fresh data
            </div>
          </div>
          <button type="button" className="btn btnPrimary" onClick={() => { setCreating(true); }}>
            ＋ New custom report
          </button>
        </div>

        {error !== null && <div className="notice mb-4">{error}</div>}

        {creating && academicYear !== null && (
          <NewReportPanel
            schoolIds={schoolIds}
            academicYear={academicYear}
            onCancel={() => { setCreating(false); }}
            onCreated={onOpen}
          />
        )}
        {creating && academicYear === null && (
          <div className="notice mb-4">
            The academic year is still loading — open Home once, then try again.
          </div>
        )}

        {reports === null ? (
          <div className="mt-8 text-[13px] text-[var(--color-muted)] animate-pulse">
            {error === null ? 'Loading your reports…' : ''}
          </div>
        ) : (
          <>
            <section className="card reportsPanel">
              <h3 className="reportsPanelTitle">Custom reports</h3>
              {custom.length === 0 ? (
                <p className="reportsEmpty">
                  No custom reports yet — press <b>＋ New custom report</b> above, or open any
                  dashboard and tap <b>⧉ Clone &amp; customise</b>.
                </p>
              ) : (
                <div className="reportsTableWrap">
                  <table className="reportsTable">
                    <thead>
                      <tr>
                        <th>Report</th>
                        <th>Cloned from</th>
                        <th>Scope</th>
                        <th>Version</th>
                        <th className="ta-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {custom.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <b>{r.name}</b> <span className="typebadge tb-custom">CUSTOM</span>
                            <ReportMeta report={r} />
                          </td>
                          <td className="nowrap">{r.base_report_title ?? '—'}</td>
                          <td><Scope report={r} /></td>
                          <td className="nowrap">
                            v{r.current_version} <span className="dot">·</span> {shortDate(r.updated_at)}
                          </td>
                          <td className="ta-right">
                            <RowActions
                              report={r}
                              schoolIds={schoolIds}
                              onOpen={onOpen}
                              onEdit={onEdit}
                              onDuplicated={onOpen}
                              onError={setError}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="card reportsPanel mt-4">
              <h3 className="reportsPanelTitle">AI report snapshots</h3>
              {aiSaved.length === 0 ? (
                <p className="reportsEmpty">
                  Ask the AI a question, then tap <b>💾 Save as report</b> — it appears here, and
                  re-runs its own saved SQL every time you open it.
                </p>
              ) : (
                <div className="reportsTableWrap">
                  <table className="reportsTable">
                    <thead>
                      <tr>
                        <th>Report</th>
                        <th>School scope</th>
                        <th>Saved</th>
                        <th className="ta-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aiSaved.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <b>{r.name}</b> <span className="typebadge tb-ai">AI</span>
                            <ReportMeta report={r} />
                          </td>
                          <td><Scope report={r} /></td>
                          <td className="nowrap">{shortDate(r.updated_at)}</td>
                          <td className="ta-right">
                            <RowActions
                              report={r}
                              schoolIds={schoolIds}
                              openLabel="Re-run"
                              onOpen={onOpen}
                              onEdit={onEdit}
                              onDuplicated={onOpen}
                              onError={setError}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

/**
 * The two things about a row that are true regardless of which table it is in,
 * and that the prototype's columns have no home for: who can see it, and
 * whether it is yours at all. Kept under the name rather than as columns —
 * they qualify the report's identity, they are not another axis to scan down.
 */
function ReportMeta({ report }: { report: CustomReportSummary }): JSX.Element {
  return (
    <div className="reportsRowMeta">
      {VISIBILITY_LABEL[report.shared_flag]}
      {!report.is_owner && (
        <>
          <span className="dot">·</span>shared with you
        </>
      )}
    </div>
  );
}

/**
 * Saved scope, by name. An empty list is shown as a stated absence rather than
 * a blank cell: a report whose saved schools have all left the registry is a
 * real (if rare) state, and a blank cell would read as a rendering bug.
 */
function Scope({ report }: { report: CustomReportSummary }): JSX.Element {
  if (report.school_scope.length === 0) return <span className="reportsMuted">no schools available</span>;
  return <>{report.school_scope.map((s) => s.school_name).join(' · ')}</>;
}

function RowActions({
  report,
  schoolIds,
  openLabel = 'View',
  onOpen,
  onEdit,
  onDuplicated,
  onError,
}: {
  report: CustomReportSummary;
  schoolIds: readonly string[];
  openLabel?: string;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicated: (id: string) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  return (
    <div className="reportsActions">
      <button type="button" className="chipbtn" onClick={() => { onOpen(report.id); }}>
        {openLabel}
      </button>
      {/* Editing is owner-only server-side; showing it to a viewer of a shared
          report would promise a screen that refuses them (docs/10 §3). */}
      {report.is_owner && (
        <button type="button" className="chipbtn" onClick={() => { onEdit(report.id); }}>
          ✎ Edit
        </button>
      )}
      <button
        type="button"
        className="chipbtn"
        disabled={busy}
        onClick={() => {
          const name = window.prompt('Name the copy', `${report.name} (copy)`);
          if (name === null || name.trim() === '') return;
          setBusy(true);
          duplicateReport(report.id, name.trim())
            .then((copy) => { onDuplicated(copy.id); })
            .catch((err: unknown) => {
              onError(err instanceof ApiFailure ? err.message : 'Could not copy this report.');
            })
            .finally(() => { setBusy(false); });
        }}
      >
        {busy ? '…' : '⧉ Clone'}
      </button>
      <a className="chipbtn" href={customReportPdfUrl(report.id, schoolIds, { logic: true })}>
        ⬇ PDF
      </a>
    </div>
  );
}

/**
 * "＋ New custom report" — start a report without first going to find the
 * dashboard it comes from.
 *
 * The sources are the server's own catalog (`GET /api/reports/sources`), and
 * creating one goes through the SAME clone path the dashboard's own "⧉ Clone
 * & customise" button uses — including its run-once-before-persisting check,
 * so a source whose filters do not work here fails loudly instead of saving a
 * report nobody can open. What is new is the entry point, not a second way to
 * build a report: a parallel builder with its own SQL would be the query
 * knowledge in `dashboards.ts` copied, and free to drift from it.
 */
function NewReportPanel({
  schoolIds,
  academicYear,
  onCancel,
  onCreated,
}: {
  schoolIds: readonly string[];
  academicYear: string;
  onCancel: () => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  const [sources, setSources] = useState<ReportSource[] | null>(null);
  const [picked, setPicked] = useState<ReportSource | null>(null);
  const [name, setName] = useState('');
  const [year, setYear] = useState(academicYear);
  const [asOf, setAsOf] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listReportSources()
      .then((data) => { setSources(data.sources); })
      .catch((err: unknown) => {
        setError(err instanceof ApiFailure ? err.message : 'Could not load the report sources.');
      });
  }, []);

  const choose = (source: ReportSource): void => {
    setPicked(source);
    setName(`${source.title} (my copy)`);
    setError(null);
  };

  return (
    <section className="card reportsPanel newReportPanel mb-4">
      <div className="reportsPanelHead">
        <h3 className="reportsPanelTitle">New custom report</h3>
        <button type="button" className="reportsPanelClose" onClick={onCancel} aria-label="Cancel">
          ✕
        </button>
      </div>

      {error !== null && <div className="notice mb-3">{error}</div>}

      {picked === null ? (
        <>
          <p className="reportsEmpty">
            Pick what to build it from. You get your own editable copy — the original dashboard is
            never changed.
          </p>
          {sources === null ? (
            <div className="text-[13px] text-[var(--color-muted)] animate-pulse">Loading sources…</div>
          ) : (
            <div className="sourceGrid">
              {sources.map((s) => (
                <button key={s.report_id} type="button" className="sourceCard" onClick={() => { choose(s); }}>
                  <span className="sourceCardIcon">{s.icon}</span>
                  <span className="min-w-0">
                    <b>{s.title}</b>
                    <span className="sourceCardBlurb">{s.blurb}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="sourcePicked">
            <span className="sourceCardIcon">{picked.icon}</span>
            <span className="min-w-0">
              <b>{picked.title}</b>
              <span className="sourceCardBlurb">{picked.blurb}</span>
            </span>
            <button type="button" className="chipbtn" onClick={() => { setPicked(null); }}>
              Change
            </button>
          </div>

          <div className="newReportFields">
            <label className="widgetCloneField">
              Name
              <input value={name} onChange={(e) => { setName(e.target.value); }} />
            </label>
            {/* Only the filters this source declares — offering one it does not
                take would put a pill on screen that narrows nothing, which is
                exactly what the server refuses (dashboards.ts REPORT_FILTERS). */}
            {picked.filters.academic_year && (
              <label className="widgetCloneField">
                Academic year
                <input value={year} onChange={(e) => { setYear(e.target.value); }} placeholder="2026-27" />
              </label>
            )}
            {picked.filters.as_of && (
              <label className="widgetCloneField">
                As of
                <input
                  type="date"
                  value={asOf}
                  onChange={(e) => { setAsOf(e.target.value); }}
                />
              </label>
            )}
          </div>

          <div className="reportsActions mt-3">
            <button type="button" className="chipbtn" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="chipbtn chipbtn--ai"
              disabled={saving || name.trim() === '' || (picked.filters.academic_year && year.trim() === '')}
              onClick={() => {
                setSaving(true);
                setError(null);
                cloneReport({
                  base_report_id: picked.report_id,
                  name: name.trim(),
                  academic_year: picked.filters.academic_year ? year.trim() : academicYear,
                  school_ids: schoolIds,
                  ...(picked.filters.as_of && asOf !== '' ? { as_of: asOf } : {}),
                })
                  .then((created) => { onCreated(created.id); })
                  .catch((err: unknown) => {
                    setError(err instanceof ApiFailure ? err.message : 'Could not create that report.');
                  })
                  .finally(() => { setSaving(false); });
              }}
            >
              {saving ? 'Creating…' : 'Create report'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
