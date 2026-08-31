/**
 * Home (docs/10 §2). The greeting, ask-bar and KPI strip follow the UX
 * prototype (docs/11, Artifacts); the dashboard section below them does not —
 * see "One nav, one overview, not two navs" below for why docs/10 §2 was
 * amended to move away from the prototype's two link-tile galleries.
 *
 * -- Every number here is real -----------------------------------------------
 * The KPI row renders a hydrated chart-spec built by the orchestrator from live
 * replica data: SPA -> orchestrator -> MCP -> read replica. Nothing on this
 * screen is a placeholder figure. That matters more than it sounds: a dashboard
 * that looks finished and shows invented numbers is worse than one that admits
 * it has none, because only the second kind gets fixed.
 *
 * [MANDATORY] ADR-015 / CODING_GUIDELINES §4: the app renders SPECS. Values
 * arrive pre-formatted from the server precisely so the screen and the PDF
 * cannot format the same number differently, and nothing here is ever rendered
 * as markup.
 *
 * -- The locked ask-bar is load-bearing --------------------------------------
 * It renders locked whenever `ai_status !== 'active'` (ADR-017), and stays
 * unclickable in that state -- the lock is cosmetic on top of a real
 * server-side 403 that /api/ai/ask re-checks regardless of what this UI shows.
 * It stays visible because docs/10 §3 wants gated features discoverable: an
 * admin who cannot see it cannot learn that adding a key would unlock it. Once
 * active it opens the Ask AI screen (components/AskAI.tsx).
 *
 * -- One card state on screen now (2026-09-01) -------------------------------
 * The catalog still has three verdicts and the server still decides them, but
 * only `available` is SERVED (`servedDashboards`, services/home.ts). `coming`
 * meant the serving path was unwritten; `blocked` meant the ERP extract has no
 * such data (AUDIT_REPORT C20) -- exams today, and transport, library and
 * attendance before their extracts arrived. Neither opens for any role with any
 * key, so neither is offered: this screen lists what it can draw.
 *
 * Watching attendance leave `blocked` on 2026-08-21 is still the point of
 * keeping the verdicts apart in the catalog -- a second extract arrived, the
 * server changed one card's verdict, and no screen code changed. That is also
 * how a withheld card comes BACK: it turns `available` and the grid, the strip
 * and the sidebar all pick it up untouched.
 *
 * -- One nav, one overview, not two navs -------------------------------------
 * The sidebar is the menu (every dashboard, Ask AI, Settings — Sidebar.tsx). It
 * used to be duplicated here as a second set of link-only tiles, which meant
 * this screen and the sidebar were two menus disagreeing about nothing, just
 * saying the same thing twice. This screen's own job is to be the ONE place
 * that shows something FROM each dashboard rather than a way to each dashboard.
 *
 * -- A curated six, not everything available ---------------------------------
 * The grid used to be every `available` dashboard, which is nine cards and
 * growing — the sidebar again, drawn larger. It is now six, ranked and ordered
 * by the SERVER (`/api/home` `grid`, services/home.ts `DASHBOARD_GRID`), and
 * this component renders that order rather than re-deriving it: what the
 * overview leads with is a product decision, and a second copy of the rule here
 * would be free to disagree with the first.
 *
 * Everything else drops to the strip below, where every chip is a real click:
 * the strip is the rest of the built catalog, not a waiting room.
 *
 * -- Each card draws the chart a click DESCENDS from -------------------------
 * A card shows the report's drill-entry chart (level 1, one bar per school)
 * where the report has a curated path, and its lead chart where it does not.
 * Fee Collection is why the distinction matters: its page opens with receipts
 * by month, but the chart a reader drills into is demand by school, fed by a
 * different statement. A card drawing the first would invite a click it cannot
 * honour.
 *
 * -- Each card is its own request ---------------------------------------------
 * The cards used to arrive together, which meant the grid was only as fast as
 * its slowest dashboard — Enrollment was ready in 146 ms and sat invisible for
 * six more seconds waiting on the fee scans. Now every card fetches on its own
 * (App.tsx, routes/home.ts) and this component renders whichever have landed,
 * skeleton for the rest. Nothing here decides the order they fill in; they
 * simply appear as they are ready.
 */

import { useCallback, useState } from 'react';
import { KpiTile, WidgetSpecView, type ChartAccent, type DrillTarget } from '@sap/chart-spec/react';
import type { Widget } from '@sap/chart-spec';
import type { HomeResponse, HomePreview, SessionResponse, DashboardCard } from '../api/client';
import { DrillTrail, useDrill, widgetIdOf } from './Drill';

/**
 * Which of the four CVD-audited chart colours (widgets.tsx `ACCENT_COLOUR`)
 * a dashboard's preview chart draws in. Not a per-widget fact — the same
 * chart on its own full dashboard page still renders teal, since `accent` is
 * a presentation choice `WidgetSpecView` only honours when `compact`.
 *
 * `fee-defaulters` -> `negative` reuses a meaning docs/10 §1's token table
 * already assigns platform-wide ("Red: ... defaulter counts"); it is not a
 * colour invented for this grid. The rest alternate `primary`/`secondary`
 * (teal/mint, both inside the audited four) purely so six teal cards in a
 * row don't read as one flat colour — never a fifth hue, never decoration
 * dressed up as meaning where none exists.
 */
const PREVIEW_ACCENT: Partial<Record<string, ChartAccent>> = {
  'fee-defaulters': 'negative',
  'staff-overview': 'secondary',
  'attendance-analytics': 'secondary',
  'transport-analytics': 'secondary',
  'library-textbooks': 'secondary',
};

interface Props {
  session: SessionResponse;
  home: HomeResponse;
  loading: boolean;
  /**
   * Keyed by dashboard id, filled in one card at a time as each dashboard's own
   * request resolves (App.tsx). An id that is not present yet renders as a
   * skeleton — a card no longer waits for its neighbours.
   */
  previews: Record<string, HomePreview>;
  previewsLoading: boolean;
  /**
   * The scope the previews were fetched with. Passed rather than read off
   * `home.spec.meta.scope` so a card's drill runs against exactly the selection
   * its chart was built from — the two are the same today, and a drill that
   * quietly re-derived its own scope is how they would stop being.
   */
  schoolIds: readonly string[];
  onOpen: (reportId: string) => void;
  onAskAI: () => void;
}

export function Home({
  session,
  home,
  loading,
  previews,
  previewsLoading,
  schoolIds,
  onOpen,
  onAskAI,
}: Props): JSX.Element {
  const aiActive = session.ai_status === 'active';
  const scopeNames = home.spec.meta.scope.map((s) => s.school_name).join(' · ');
  /**
   * The grid, in the server's order (`/api/home` `grid`). Looked up rather than
   * filtered: the order is the server's ranking and re-deriving it here from
   * `status` would put the cards back in catalog order, which ranks by the
   * accident of what was built first.
   */
  const byId = new Map(home.dashboards.map((card) => [card.id, card]));
  const previewable = home.grid.flatMap((id) => {
    const card = byId.get(id);
    return card === undefined ? [] : [card];
  });
  const onGrid = new Set(home.grid);
  const more = home.dashboards.filter((card) => !onGrid.has(card.id));

  return (
    <main className="flex-1 overflow-y-auto">
      {/* Wider than every other screen's 1180px content column (Settings.tsx,
          AskAI.tsx, DashboardPage.tsx, ReportEditor.tsx all share it) -- a
          deliberate exception, not a drift. Those are single-report reading
          widths; Home is the one screen that is ITSELF a grid of cards, and a
          grid has nothing to gain from stopping short of the window on a wide
          monitor the way a filter-pills-and-table page does. */}
      <div className="px-7 py-6 max-w-[1900px]">
        <h1 className="page-title">
          {greeting()}, {session.user.role === 'DIRECTOR' ? 'Director ' : ''}
          {surname(session.user.name)}
        </h1>

        {/* docs/10 §3: scope line under the title, and an "as of" label because
            docs/03 assumption 2 accepts replica lag only if it is stated. */}
        <div className="pageContext mb-5">
          <span>{scopeNames}</span>
          <span className="dot">·</span>
          <span>data as of {asOf(home.spec.meta.as_of ?? home.spec.meta.generated_at)}</span>
          {loading && (
            <>
              <span className="dot">·</span>
              <span>refreshing…</span>
            </>
          )}
        </div>

        {/* docs/02 §6: a school dropped from scope is surfaced, never silently
            filtered. */}
        {session.dropped_from_scope.length > 0 && (
          <div className="notice mb-4">
            {session.dropped_from_scope.length} school(s) in your token are not available for
            analytics right now and have been left out of your scope.
          </div>
        )}

        {/* ADR-011: a school that failed inside a fan-out is annotated, not
            dropped -- otherwise a total quietly shrinks. */}
        {home.degraded_schools.length > 0 && (
          <div className="notice mb-4">
            Some schools could not be reached, so these totals are partial:{' '}
            {home.degraded_schools.map((d) => d.school_id).join(', ')}.
          </div>
        )}

        <div
          className={`askbar mb-5 ${aiActive ? '' : 'locked'}`}
          onClick={() => {
            if (aiActive) onAskAI();
          }}
          role={aiActive ? 'button' : undefined}
        >
          <div className="bot">✦</div>
          {/**
           * docs/10 §2: "admins get 'Set up now →', others 'ask your
           * administrator'". Two sentences for two people — telling a Teacher to
           * complete a setup they have no permission to perform sends them
           * looking for a screen that will refuse them.
           */}
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-bold tracking-wider text-[var(--color-primary)] uppercase mb-0.5">
              Ask AI
            </div>
            <div className="ph">
              {aiActive
                ? 'Ask anything about your schools… e.g. “school-wise strength, gender-wise”'
                : session.can_configure_ai
                  ? '🔒 AI reports are locked — connect your Anthropic key in Settings to unlock them (predefined dashboards work now)'
                  : '🔒 AI reports are locked — ask your administrator to set up the AI key (predefined dashboards work now)'}
            </div>
          </div>
          <div className="go">{aiActive ? 'Ask AI →' : 'Locked'}</div>
        </div>

        <div className="kpis">
          {home.spec.widgets.map((widget, index) => (
            // Same tile the predefined dashboards and Ask AI use (§20) — a KPI
            // reads identically everywhere in the product. The lead metric
            // (first in the server's own order) gets the headline treatment.
            <KpiTile key={widget.id} widget={widget} hero={index === 0 && home.spec.widgets.length > 1} />
          ))}

          {/*
            A metric the design calls for that has no source. Shown rather than
            omitted, with the reason: a tile quietly missing reads as an oversight,
            and "0%" would be actively false (CODING_GUIDELINES §10).
          */}
          {home.blocked_metrics.map((metric) => (
            <div key={metric.label} className="card kpi unavailable" title={metric.reason}>
              <b>—</b>
              <span>
                {metric.label}{' '}
                <span className="pill nodata ml-1">
                  {metric.kind === 'not_permitted' ? 'no access' : 'no data'}
                </span>
              </span>
            </div>
          ))}
        </div>

        <div className="sect">
          Your dashboards
          {previewsLoading && (
            <span className="text-[11px] font-normal normal-case tracking-normal text-[var(--color-muted)]">
              {/* Counted, not a bare "loading": the cards now arrive one by one,
                  so the honest status is how many are still outstanding rather
                  than a label that sits there until the last one lands. */}
              {`${String(previewable.length - Object.keys(previews).length)} of ${String(previewable.length)} still loading…`}
            </span>
          )}
        </div>
        <div className="pgallery">
          {previewable.map((card) => (
            <PreviewCard
              key={card.id}
              card={card}
              preview={previews[card.id]}
              schoolIds={schoolIds}
              academicYear={home.academic_year}
              onOpen={onOpen}
            />
          ))}
        </div>

        <MoreDashboards cards={more} onOpen={onOpen} />

        <p className="text-[11.5px] text-[var(--color-muted)] mt-7 leading-relaxed">
          Scope comes from the launch token the ERP signed. It cannot be widened from this browser,
          every query is constrained to it, and all school data is read-only.
        </p>
      </div>
    </main>
  );
}

/**
 * A dashboard's own lead CHART, live -- the same bar/line/donut
 * `buildDashboard` would draw first on the full report (services/home.ts,
 * `buildHomePreview`), rendered here at card size (`compact`, widgets.tsx).
 * Home's KPI strip above already carries the numbers, so the preview's job is
 * to be the thing the strip can't be: a shape. Clicking anywhere on the card
 * opens that report, same as the old link-tile did.
 */
function PreviewCard({
  card,
  preview,
  schoolIds,
  academicYear,
  onOpen,
}: {
  card: DashboardCard;
  preview: HomePreview | undefined;
  schoolIds: readonly string[];
  academicYear: string | null;
  onOpen: (reportId: string) => void;
}): JSX.Element {
  /**
   * A drill failure is said INSIDE the card that failed. The page has no notice
   * of its own for this and should not grow one: five other cards are fine, and
   * a banner across the top would report a whole-screen problem where there is
   * a one-card one (ADR-011's reasoning, one level down).
   */
  const [drillError, setDrillError] = useState<string | null>(null);
  const { drills, busy, navigate } = useDrill({
    reportId: card.id,
    schoolIds,
    academicYear,
    onError: useCallback((message: string | null) => { setDrillError(message); }, []),
  });

  const base = preview?.status === 'ok' ? preview.widget : null;
  const baseId = widgetIdOf(base);
  const drilled = baseId === null ? undefined : drills[baseId];
  /** The drilled level replaces the card's chart IN PLACE, as a panel's does. */
  const shown = (drilled?.widget ?? base) as Widget | null;

  /**
   * Opening the full report is the CARD's click; drilling is the CHART's. They
   * would otherwise fight: a bar click bubbles, so a drill would also navigate
   * away from the card it just drilled, and the reader would never see the
   * level they asked for.
   *
   * So the body stops propagation once there is anything to drill, and the head
   * — title, icon, arrow — stays the way to the report. A click on empty chart
   * space then does nothing, which is the right answer for a surface where the
   * bars are the targets.
   */
  const interactive =
    drilled !== undefined ||
    (shown !== null && 'drillable' in shown && shown.drillable === true);

  return (
    <div className="card pcard" onClick={() => { onOpen(card.id); }} role="button" tabIndex={0}>
      <div className="pcardHead">
        <span className="pcardIc">{card.icon}</span>
        <b>{card.title}</b>
        <span className="pcardGo" aria-hidden="true">→</span>
      </div>
      <div
        className="pcardBody"
        onClick={
          interactive
            ? (event) => { event.stopPropagation(); }
            : undefined
        }
      >
        {preview === undefined ? (
          <div className="skeleton skeletonPreview" />
        ) : shown !== null ? (
          <>
            <WidgetSpecView
              widget={shown}
              compact
              accent={PREVIEW_ACCENT[card.id]}
              /**
               * The renderer reports WHICH value was clicked; deciding what to
               * fetch is this screen's job, because the drill path is a
               * server-side catalog (DRILL_PATHS) and the spec carries only the
               * dimension, never a query.
               *
               * One widget per card, so the handler takes only the target --
               * `WidgetSpecView`'s single-widget form, not `ChartSpecView`'s
               * `(widget, target)`. The id is `baseId`: the level-1 widget's,
               * which is what keyed the drill in the first place and stays the
               * key at every level below it.
               */
              onDrill={(target: DrillTarget) => {
                if (baseId === null) return;
                navigate(baseId, [...(drilled?.context ?? []), target]);
              }}
            />
            {drilled !== undefined && baseId !== null && (
              <DrillTrail
                title={card.title}
                state={drilled}
                busy={busy === baseId}
                compact
                onJump={(depth) => { navigate(baseId, drilled.context.slice(0, depth)); }}
              />
            )}
            {drillError !== null && <p className="pcardError">{drillError}</p>}
          </>
        ) : (
          <span className="pcardMuted">{preview.reason ?? card.blurb}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Everything the grid does not draw. One slim row rather than full tiles: the
 * sidebar already lists each of these by name with the same status and reason
 * (Sidebar.tsx), so this strip is a reminder they exist, not the place to learn
 * about them for the first time.
 *
 * -- One kind here, and all of it is clickable --------------------------------
 * This used to hold only `coming` and `blocked` dashboards, because the grid
 * drew every `available` one. Then the grid became a curated eight
 * (services/home.ts `DASHBOARD_GRID`) and BUILT dashboards landed here beside
 * them; now the unopenable two are not served at all, so the strip is exactly
 * "the rest of the catalog" and every chip opens. The pills that used to say
 * "soon" and "no data" went with them — a strip of dead labels under a grid of
 * live charts was the thing worth removing, not the labels' wording.
 */
function MoreDashboards({
  cards,
  onOpen,
}: {
  cards: readonly DashboardCard[];
  onOpen: (reportId: string) => void;
}): JSX.Element | null {
  if (cards.length === 0) return null;
  return (
    <>
      <div className="sect">More dashboards</div>
      <div className="moreStrip">
        {cards.map((card) => {
          /**
           * Always true today, and still asked rather than assumed, for the
           * reason Sidebar.tsx gives at the same check: `status` is data off the
           * wire. An unopenable card that somehow arrives goes inert with its
           * reason on hover rather than routing to a screen that 404s -- but it
           * gets no pill, because a pill is an invitation to put the withheld
           * states back one chip at a time.
           */
          const open = card.status === 'available';
          return (
            <span
              key={card.id}
              className={`moreChip${open ? ' clickable' : ''}`}
              title={open ? `Open ${card.title}` : (card.reason ?? card.blurb)}
              role={open ? 'button' : undefined}
              tabIndex={open ? 0 : undefined}
              onClick={() => {
                if (open) onOpen(card.id);
              }}
            >
              <span aria-hidden="true">{card.icon}</span>
              {card.title}
            </span>
          );
        })}
      </div>
    </>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

function asOf(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `today, ${time}` : date.toLocaleString();
}
