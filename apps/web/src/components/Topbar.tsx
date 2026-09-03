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
  /**
   * The years the selection has data for (`/api/home`). One or none renders the
   * plain chip this control has always been — a select with a single option is
   * an affordance that does nothing.
   */
  academicYears: readonly string[];
  onSelectYear: (academicYear: string) => void;
  crumb: string;
}

export function Topbar({
  session,
  selected,
  onSelect,
  academicYear,
  academicYears,
  onSelectYear,
  crumb,
}: Props): JSX.Element {
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

      {/**
        * The academic year — a CONTROL since 2026-09-03, a read-only chip before
        * that.
        *
        * The options come from the data, not a constant: they are the years the
        * selected schools actually hold (`/api/home`, `academic_years`), and the
        * one it opens on is the year the server resolved. That was already true
        * of the label; what was missing was any way to act on it. A reader whose
        * fee book has moved to next year while the roll has not could see only
        * the roll's year, with no route to the money — which is the state the
        * development extract is in today.
        *
        * It sits beside the school picker because it is the same KIND of thing:
        * a filter that applies to every screen, so it belongs in global chrome.
        * A report's own "Compare with" year does not (DashboardPage.tsx) — that
        * one applies to exactly the report that declares it, and putting it here
        * would show a dead control on ten other pages.
        *
        * A `<select>` rather than the school picker's checkbox menu: a year is
        * exactly one value, and the native control is keyboard-navigable and
        * screen-reader-labelled without this file reimplementing either.
        */}
      {academicYears.length > 1 ? (
        <label className="ay aySelect">
          <span className="sr-only">Academic year</span>
          <span aria-hidden="true">AY</span>
          <select
            value={academicYear ?? ''}
            onChange={(event) => { onSelectYear(event.target.value); }}
          >
            {academicYears.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="ay">AY {academicYear ?? '—'}</div>
      )}

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
