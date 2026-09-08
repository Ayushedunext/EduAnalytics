/**
 * The app chrome, in the three layouts the Dashboard offers (docs/10 §1.5,
 * 2026-09-04). One menu bar, identical in every layout — a horizontal gradient
 * bar with the org mark, the menu, the scope controls and the reader's avatar
 * on one line (product owner's review, 2026-09-04) — over a frame that differs
 * per layout. The nav items, the scope picker and the year control are the
 * SAME objects everywhere, so a reader switching layouts never loses a control.
 *
 * -- What did not change from the Sidebar/Topbar this replaces -----------------
 * [MANDATORY] docs/10 §3, "locked ≠ hidden": Ask AI renders with a lock and a
 * path to unlock (Settings) rather than disappearing. Every other row is a
 * place you can go — the server withholds dashboards nobody can open
 * (`servedDashboards`, services/home.ts), so this menu never has to.
 *
 * [MANDATORY] docs/10 §3, "scope is always on screen": the picker chip is in
 * the chrome in every layout, and it NARROWS within the launch token's scope,
 * never widens it — the list it offers is `/api/session`'s, built from the
 * verified token, and an empty selection is refused rather than read as "all"
 * (@sap/shared scope.ts makes the same choice server-side).
 *
 * The two pinned reports (Trend Analysis, Comparative Analysis) keep rows of
 * their own by id, read out of the catalog so their titles stay the server's
 * words; everything else lives behind Module Wise Analysis (Modules.tsx).
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { DashboardCard, SessionResponse } from '../api/client';
import type { DashboardLayout } from '../theme/dashboardTheme';
import { Icon, type IconName } from './Icon';

/** The reports that keep a menu row of their own, in order (see header). */
const PINNED: readonly string[] = ['trend-analysis', 'fee-comparative'];

interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly locked?: boolean;
  readonly title?: string;
}

interface Props {
  layout: DashboardLayout;
  session: SessionResponse;
  selected: readonly string[];
  onSelect: (schoolIds: string[]) => void;
  academicYear: string | null;
  academicYears: readonly string[];
  onSelectYear: (academicYear: string) => void;
  dashboards: readonly DashboardCard[];
  active: string;
  onNavigate: (id: string) => void;
  /** Rendered above the frame — the Dashboard's layout and theme controls. */
  controls?: ReactNode | undefined;
  children: ReactNode;
}

export function Shell({
  layout,
  session,
  selected,
  onSelect,
  academicYear,
  academicYears,
  onSelectYear,
  dashboards,
  active,
  onNavigate,
  controls,
  children,
}: Props): ReactElement {
  const aiActive = session.ai_status === 'active';
  const items: NavItem[] = [
    { id: 'home', label: 'Dashboard', icon: 'home' },
    ...PINNED.flatMap((id): NavItem[] => {
      const card = dashboards.find((d) => d.id === id);
      if (card === undefined || card.status !== 'available') return [];
      return [{ id: card.id, label: card.title, icon: id === 'trend-analysis' ? 'chart' : 'layers', title: card.blurb }];
    }),
    { id: 'modules', label: 'Module Wise Analysis', icon: 'grid', title: 'All reports, grouped by fees, students, staff, attendance, transport and exams' },
    {
      id: 'ask',
      label: 'Ask AI',
      icon: 'chat',
      locked: !aiActive,
      title: aiActive ? 'Ask AI about your schools' : 'Complete AI setup in Settings',
    },
    { id: 'my-reports', label: 'My Reports', icon: 'save', title: 'Your cloned dashboards and saved Ask AI reports' },
    /* Beside Settings, and before it: scheduling a report is something a reader
       does with a report, not a thing they configure once — but it shares the
       messaging channels Settings owns, so the two sit together. */
    { id: 'schedule', label: 'Schedule', icon: 'clock', title: 'Have a report delivered on the days and at the time you choose' },
    { id: 'settings', label: 'Settings', icon: 'gear' },
  ];

  const nav = items.map((item) => (
    <a
      key={item.id}
      className={`${active === item.id ? 'on' : ''}${item.locked === true ? ' locked' : ''}`}
      title={item.title}
      role="button"
      tabIndex={item.locked === true ? -1 : 0}
      aria-disabled={item.locked === true}
      onClick={() => {
        if (item.locked !== true) onNavigate(item.id);
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && item.locked !== true) {
          event.preventDefault();
          onNavigate(item.id);
        }
      }}
    >
      <Icon name={item.locked === true ? 'lock' : item.icon} />
      <span>{item.label}</span>
    </a>
  ));

  const scope = (
    <ScopeControls
      session={session}
      selected={selected}
      onSelect={onSelect}
      academicYear={academicYear}
      academicYears={academicYears}
      onSelectYear={onSelectYear}
    />
  );

  const foot = (
    <div className="skFoot">
      Signed in via the ERP · {titleCase(session.user.role)} · read-only data
    </div>
  );

  /**
   * ONE menu bar for all three layouts (product owner, 2026-09-04): the org
   * mark, the menu, the scope controls and the reader's avatar, on one line, in
   * the layout's own gradient. The layouts still differ in everything below
   * it — the frame, the type, the cards — but a reader switching between them
   * finds the same bar in the same place.
   */
  const bar = (
    <header className="skBar">
      <div className="skLogo">
        <span><Icon name="bolt" /></span>
        {session.org_name}
      </div>
      <nav className="skBarNav">{nav}</nav>
      <div className="skBarRight">
        {scope}
        <span className="skAvatar" title={`${session.user.name} · ${session.user.role}`}>
          {initials(session.user.name)}
        </span>
      </div>
    </header>
  );

  /* My View is the reader's own board and has no frame of its own; it takes
     View 1's plain shell rather than inventing a fourth chrome for it. */
  if (layout === 'B' || layout === 'MY') {
    return (
      <div className="app">
        {controls}
        {bar}
        <div className="skMain">{children}</div>
        {foot}
      </div>
    );
  }

  return (
    <div className="app">
      {controls}
      <div className={`skFrame${layout === 'C' ? ' skFrame--side' : ''}`}>
        {bar}
        <div className="skMain">{children}</div>
      </div>
      {foot}
    </div>
  );
}

/**
 * School picker, academic year and nothing else — the two filters that apply to
 * every screen (a report's own "Compare with" stays with that report,
 * DashboardPage.tsx). Logic unchanged from the Topbar it came out of.
 */
function ScopeControls({
  session,
  selected,
  onSelect,
  academicYear,
  academicYears,
  onSelectYear,
}: {
  session: SessionResponse;
  selected: readonly string[];
  onSelect: (schoolIds: string[]) => void;
  academicYear: string | null;
  academicYears: readonly string[];
  onSelectYear: (academicYear: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const multi = session.scope.length > 1;

  useEffect(() => {
    if (!open) return undefined;
    function onDocumentClick(event: MouseEvent): void {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => { document.removeEventListener('mousedown', onDocumentClick); };
  }, [open]);

  function toggle(schoolId: string): void {
    const next = selected.includes(schoolId)
      ? selected.filter((id) => id !== schoolId)
      : [...selected, schoolId];
    // Never an empty selection -- see the header.
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
    <div className="skScope">
      {multi ? (
        <div className="skScopePick" ref={ref}>
          <button
            type="button"
            className="skChip skChip--btn"
            onClick={() => { setOpen((o) => !o); }}
            aria-expanded={open}
            aria-haspopup="true"
          >
            <Icon name="school" />
            <span>{label}</span>
            <span aria-hidden="true">▾</span>
          </button>
          {open && (
            <div className="skPicker" role="group" aria-label="Schools in scope">
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
              <button
                type="button"
                className="skPickerAll"
                onClick={() => { onSelect(session.scope.map((s) => s.school_id)); }}
              >
                All schools
              </button>
            </div>
          )}
        </div>
      ) : (
        /* No picker for a single-school user -- but the scope is still on
           screen, because it always is (docs/10 §2). */
        <span className="skChip">
          <Icon name="school" />
          <span>{session.scope[0]?.school_name ?? '—'}</span>
        </span>
      )}

      {academicYears.length > 1 ? (
        <label className="skChip skChip--select">
          <Icon name="calendar" />
          <span className="sr-only">Academic year</span>
          <select value={academicYear ?? ''} onChange={(event) => { onSelectYear(event.target.value); }}>
            {academicYears.map((year) => (
              <option key={year} value={year}>
                AY {year}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="skChip">
          <Icon name="calendar" />
          <span>AY {academicYear ?? '—'}</span>
        </span>
      )}
    </div>
  );
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
