/**
 * The Dashboard — the first screen a user sees after launch (docs/10 §2), laid
 * out card for card as the signed-off "AI Dashboard" artifact is, in the three
 * layouts it offers (docs/10 §1.5, adopted 2026-09-04) — plus My View, the
 * reader's own board of charts they kept (docs/10 §1.6, MyViewBoard.tsx).
 *
 * -- Every number here is real -----------------------------------------------
 * Each card is one request to `/api/home/overview/:slot` (services/overview.ts):
 * vetted SQL, fanned out per school, merged and formatted server-side, returned
 * as chart-spec widgets. Nothing on this screen is a placeholder figure, and no
 * figure is computed in the browser. The layout only decides WHICH cards are
 * asked for and where they sit.
 *
 * [MANDATORY] ADR-015 / CODING_GUIDELINES §4: the app renders SPECS. Values
 * arrive pre-formatted so the screen and any export cannot format the same
 * number differently, and nothing here is ever rendered as markup.
 *
 * -- What is deliberately not here ------------------------------------------------
 * The artifact carries no Ask-AI bar and no catalogue strip, so neither is
 * drawn on this screen: Ask AI is one click away in the nav in every layout
 * (Shell.tsx) and still renders locked-with-a-path there (docs/10 §3), and every
 * report is reachable through Module Wise Analysis and the cards' own Report
 * buttons. The notices about scope and partial data STAY: they only appear
 * when something is wrong, and a dashboard that hides that is the
 * success-shaped failure §10 names.
 */

import type { HomeResponse, SessionResponse } from '../api/client';
import type { DashboardLayout } from '../theme/dashboardTheme';
import { useMyView } from '../myView';
import { FORMAT_SLOTS, FormatA, FormatB, FormatC } from './overview/formats';
import { MyViewBoard } from './overview/MyViewBoard';
import { overviewCardOf } from './overview/registry';
import { useOverview } from './overview/useOverview';

interface Props {
  session: SessionResponse;
  /** Null until the KPI strip lands; the cards do not wait for it. */
  home: HomeResponse | null;
  loading: boolean;
  /** The scope the cards are fetched with. */
  schoolIds: readonly string[];
  /** The year every card queries — the reader's choice, or the server's resolved year. */
  academicYear: string | null;
  layout: DashboardLayout;
  onOpen: (reportId: string) => void;
}

export function Dashboard({ session, home, loading, schoolIds, academicYear, layout, onOpen }: Props): JSX.Element {
  const myView = useMyView();
  /**
   * Which cards to fetch. The three product layouts name theirs up front
   * (`FORMAT_SLOTS`); My View's are whatever the reader kept, so its list is
   * derived from the board — each card's slots, deduplicated, so four saved
   * gauges are still one request (registry.tsx).
   *
   * A saved card whose key this build no longer knows contributes no slot,
   * which is the right answer: the board says so in its place rather than
   * fetching for a card it cannot draw.
   */
  const slots =
    layout === 'MY'
      ? [...new Set(myView.charts.flatMap((chart) => overviewCardOf(chart)?.slots ?? []))]
      : FORMAT_SLOTS[layout];
  const states = useOverview(slots, schoolIds, academicYear);
  /**
   * Null while the strip is still loading. Rendered as a dash rather than as
   * today's date: "as of" is a claim about how current the data is, and the one
   * thing this component must not do is invent one.
   */
  const asOf = home === null ? null : dateLabel(home.spec.meta.as_of ?? home.spec.meta.generated_at);
  const props = {
    states,
    session,
    year: academicYear,
    asOf,
    scopeCount: home?.spec.meta.scope.length ?? schoolIds.length,
    onOpen,
  };

  return (
    <main className="skPage">
      {/* docs/02 §6: a school dropped from scope is surfaced, never silently filtered. */}
      {session.dropped_from_scope.length > 0 && (
        <div className="notice mb-4">
          {session.dropped_from_scope.length} school(s) in your token are not available for
          analytics right now and have been left out of your scope.
        </div>
      )}
      {/* ADR-011: a school that failed inside a fan-out is annotated, not dropped. */}
      {home !== null && home.degraded_schools.length > 0 && (
        <div className="notice mb-4">
          Some schools could not be reached, so these totals are partial:{' '}
          {home.degraded_schools.map((d) => d.school_id).join(', ')}.
        </div>
      )}
      {(home?.partial_metrics ?? []).map((metric) => (
        <div key={metric.label} className="notice mb-4">
          {metric.label} for {home?.academic_year ?? 'this year'} does not include{' '}
          {metric.schools.join(', ')} — no data is recorded there for that year yet.
        </div>
      ))}
      {loading && <div className="pageContext" style={{ margin: '0 0 8px' }}>refreshing…</div>}

      {layout === 'MY' ? (
        <MyViewBoard ctx={props} schoolIds={schoolIds} academicYear={academicYear} />
      ) : layout === 'A' ? (
        <FormatA {...props} />
      ) : layout === 'B' ? (
        <FormatB {...props} />
      ) : (
        <FormatC {...props} />
      )}

      <p className="skFine">
        Scope comes from the launch token the ERP signed. It cannot be widened from this browser,
        every query is constrained to it, and all school data is read-only.
      </p>
    </main>
  );
}

function dateLabel(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
