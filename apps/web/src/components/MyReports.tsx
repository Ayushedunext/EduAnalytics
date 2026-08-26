/**
 * My Reports — clones and AI-saved reports (ADR-018, docs/06 §3).
 *
 * Lists everything this user owns, plus anything a colleague shared to
 * `school`/`trust` visibility. The list itself carries no filter/scope
 * controls of its own: opening a report resolves scope the same way every
 * other report does (`getCustomReport`, effective scope intersected with the
 * viewer's token scope — AUDIT_REPORT A8), so there is nothing here that
 * could show a stale or wrong scope to select from.
 */

import { useEffect, useState } from 'react';
import { listMyReports, type CustomReportSummary } from '../api/client';

interface Props {
  onOpen: (id: string) => void;
}

const SOURCE_LABEL: Record<CustomReportSummary['source_kind'], string> = {
  predefined_clone: 'Cloned dashboard',
  ai_saved: 'Saved from Ask AI',
};

const VISIBILITY_LABEL: Record<CustomReportSummary['shared_flag'], string> = {
  private: 'Private',
  school: 'Shared · school',
  trust: 'Shared · trust',
};

export function MyReports({ onOpen }: Props): JSX.Element {
  const [reports, setReports] = useState<CustomReportSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMyReports()
      .then((data) => {
        if (!cancelled) setReports(data.reports);
      })
      .catch((err: unknown) => {
        // Fail loud (§10): an empty list here would read as "you have no reports".
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load My Reports.');
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[980px]">
        <h1 className="page-title">My Reports</h1>
        <div className="page-sub">
          Clone any dashboard, or save an Ask AI answer, to build your own reports. Originals are never
          changed — every clone is your own editable copy.
        </div>

        {error !== null && <div className="notice mt-4">{error}</div>}

        {reports === null ? (
          <div className="mt-8 text-[13px] text-[var(--color-muted)] animate-pulse">
            {error === null ? 'Loading your reports…' : ''}
          </div>
        ) : reports.length === 0 ? (
          <div className="mt-8 text-[13px] text-[var(--color-muted)]">
            Nothing here yet. Open a dashboard and choose &ldquo;⧉ Clone &amp; customise&rdquo;, or save an
            answer from Ask AI.
          </div>
        ) : (
          <ul className="mt-6 flex flex-col gap-2 list-none p-0 m-0">
            {reports.map((r) => (
              <li key={r.id} className="card p-4 flex items-center gap-3 cursor-pointer" onClick={() => { onOpen(r.id); }}>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[14px] truncate">{r.name}</div>
                  <div className="text-[12px] text-[var(--color-muted)] mt-0.5">
                    {SOURCE_LABEL[r.source_kind]}
                    {!r.is_owner && ' · shared with you'}
                    <span className="dot">·</span>
                    {VISIBILITY_LABEL[r.shared_flag]}
                    <span className="dot">·</span>
                    updated {new Date(r.updated_at).toLocaleDateString()}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
