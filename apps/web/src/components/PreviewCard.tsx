/**
 * One dashboard as a live PREVIEW CARD: its own chart, at card size, clickable
 * through to the full report.
 *
 * Extracted from Home.tsx on 2026-09-01, when Module Wise Analysis became a
 * second screen that draws these. It is the same card on both — same chart,
 * same drill, same accent — because a Fee Defaulters card that behaved one way
 * on Dashboard and another inside the Fees module would be two cards a reader
 * has to learn separately. Home.tsx's own header carries the reasoning for what
 * a card SHOWS (the drill-entry chart where one exists, the lead chart where it
 * does not); this file is only where it now lives.
 */

import { useCallback, useState } from 'react';
import { WidgetSpecView, type ChartAccent, type DrillTarget } from '@sap/chart-spec/react';
import type { Widget } from '@sap/chart-spec';
import type { HomePreview, DashboardCard } from '../api/client';
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

/**
 * A dashboard's own lead CHART, live -- the same bar/line/donut
 * `buildDashboard` would draw first on the full report (services/home.ts,
 * `buildHomePreview`), rendered here at card size (`compact`, widgets.tsx).
 * Home's KPI strip above already carries the numbers, so the preview's job is
 * to be the thing the strip can't be: a shape. Clicking anywhere on the card
 * opens that report, same as the old link-tile did.
 */
export function PreviewCard({
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
