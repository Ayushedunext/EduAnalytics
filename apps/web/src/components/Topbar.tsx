/**
 * Topbar: breadcrumb, school picker, academic year, avatar (docs/10 §2).
 *
 * [MANDATORY] docs/10 §3, "scope is always on screen". The picker chip here, the
 * scope line under every page title, and the scope printed on PDFs all read from
 * the same server-resolved session -- so what a user sees, what gets queried and
 * what appears on an exported document cannot disagree.
 *
 * The picker is multi-select, matching the prototype: a Director combines any
 * subset of their schools. Note what selecting does and does not do. It NARROWS
 * a request within the scope the launch token already granted; it can never add
 * a school. The list it offers comes from `/api/session`, which the orchestrator
 * built from the verified token — this component has no way to name a school the
 * session does not already hold, and if it somehow did, the orchestrator and the
 * MCP server would each reject it (ADR-007).
 *
 * Deselecting everything is refused rather than treated as "all schools": an
 * empty selection that silently means everything is how a UI bug becomes a
 * scope surprise (@sap/shared scope.ts makes the same choice server-side).
 */

import { useEffect, useRef, useState } from 'react';
import type { SessionResponse } from '../api/client';

interface Props {
  session: SessionResponse;
  selected: readonly string[];
  onSelect: (schoolIds: string[]) => void;
  academicYear: string | null;
  crumb: string;
}

export function Topbar({ session, selected, onSelect, academicYear, crumb }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const multi = session.scope.length > 1;

  // Close on an outside click, so the menu behaves like every other menu.
  useEffect(() => {
    if (!open) return undefined;
    function onDocumentClick(event: MouseEvent): void {
      if (pickerRef.current !== null && !pickerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => { document.removeEventListener('mousedown', onDocumentClick); };
  }, [open]);

  function toggle(schoolId: string): void {
    const next = selected.includes(schoolId)
      ? selected.filter((id) => id !== schoolId)
      : [...selected, schoolId];
    // Never allow an empty selection -- see the note above.
    if (next.length === 0) return;
    onSelect(next);
  }

  const label =
    selected.length === session.scope.length && multi
      ? `${String(selected.length)} schools`
      : selected.length === 1
        ? (session.scope.find((s) => s.school_id === selected[0])?.school_name ?? '1 school')
        : `${String(selected.length)} of ${String(session.scope.length)} schools`;

  return (
    <header className="topbar">
      <div className="crumb">{crumb}</div>
      <div className="flex-1" />

      {multi ? (
        <div className="relative" ref={pickerRef}>
          <button
            type="button"
            className="picker-btn"
            onClick={() => { setOpen((o) => !o); }}
            aria-expanded={open}
            aria-haspopup="true"
          >
            <span>🏫</span>
            <span>{label}</span>
            <span aria-hidden="true">▾</span>
          </button>

          {open && (
            <div className="picker-menu" role="group" aria-label="Schools in scope">
              {session.scope.map((school) => (
                <label key={school.school_id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(school.school_id)}
                    onChange={() => { toggle(school.school_id); }}
                  />
                  {school.school_name}
                </label>
              ))}
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  className="ay flex-1 cursor-pointer"
                  onClick={() => { onSelect(session.scope.map((s) => s.school_id)); }}
                >
                  All
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* docs/10 §2: no picker for a single-school user -- but the scope is
           still on screen, because it always is. */
        <div className="text-[13px] font-medium text-[var(--color-ink)]">
          {session.scope[0]?.school_name ?? '—'}
        </div>
      )}

      {/* The year comes from the data, not a constant: it is whatever the ERP's
          latest academic year actually is (see services/home.ts). */}
      <div className="ay">AY {academicYear ?? '—'}</div>

      <div className="avatar" title={`${session.user.name} · ${session.user.role}`}>
        {session.user.name
          .split(' ')
          .map((part) => part[0])
          .join('')
          .slice(0, 2)}
      </div>
    </header>
  );
}
