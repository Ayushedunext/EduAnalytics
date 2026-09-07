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
 * The hue each preview card draws its single-series chart in.
 *
 * -- Keyed by CARD, not by report (2026-09-03) -------------------------------
 * The grid draws two Fee Collection cards and two Fee Defaulters cards
 * (`DASHBOARD_GRID`), and they are not the same subject: receipts arriving over
 * the year is money coming IN, the by-school bars are money still OUT. Keyed by
 * report they would have had to share a colour, which is the one thing that
 * would make a reader think they were the same chart twice.
 *
 * -- Why this is not decoration ----------------------------------------------
 * `accent` is presentation chosen by the page, never a fact about the widget —
 * the same chart on its own report page still renders in the platform teal,
 * because `WidgetSpecView` honours this only when `compact`. And it can never
 * overrule meaning: `measureColour` lets a widget's own `tone` win, so a caller
 * cycling hues across a grid cannot repaint overdue money in the teal it used
 * for headcounts.
 *
 * What it buys is DISTINCTION. Eight cards holding eight different subjects
 * were drawing six of them in one colour, and a grid whose whole job is to be
 * scanned is exactly where that costs the most: the eye has nothing to sort by
 * until it has read every title. The hues are spread around the wheel and led
 * by the blues, so the page still reads as one product.
 *
 * -- Where a hue MEANS something, it is the meaning ---------------------------
 * Three of these are not free choices. Fee Defaulters' school bars are
 * `negative` and its ageing chart `warning`, which are the meanings docs/10 §1's
 * token table already assigns platform-wide ("amber: fees outstanding; red:
 * defaulter counts") — not colours invented for this grid. Staff Attendance is
 * `secondary` because meadow green is "present" everywhere else in the product.
 * The rest — indigo, aqua, coral, plum, violet — carry identity only, and are
 * assigned to the cards whose subject has no colour of its own.
 */
const PREVIEW_ACCENT: Partial<Record<string, ChartAccent>> = {
  /* Money arriving over the year — the brand lead, and the one chart the page
     is most often opened for. */
  'fee-collection': 'primary',
  /* Overdue money, by age. Amber is what this product means by "outstanding". */
  'fee-defaulters': 'warning',
  /* Defaulter counts per school. Red, per the token table. */
  'fee-defaulters--by-school': 'negative',
  /* Outstanding per student — money owed, but a headcount question rather than
     a severity one, so it takes an identity hue rather than the amber above. */
  'fee-by-student': 'coral',
  /* Present staff-days. Green is "present" everywhere in this product. */
  'staff-attendance': 'secondary',
  /* Roll and headcount subjects: no colour of their own, so they take the
     identity hues, spread so no two neighbours in the grid collide. */
  'staff-overview': 'aqua',
  'transport-analytics': 'indigo',
  'library-textbooks': 'plum',
  'admissions-funnel': 'violet',
  'principal-snapshot': 'indigo',
};

/*
 * `fee-collection--by-school`, `attendance-analytics` and `enrollment-overview`
 * are deliberately absent: all three draw MULTI-series or multi-category charts
 * (a grouped bar of payable/collected/pending, and two donuts), which take their
 * colours from `SERIES` by slot because there the colour is carrying series
 * identity rather than card identity. An accent would be ignored anyway; leaving
 * them out says so.
 */

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
  kind,
  slotKey,
  preview,
  schoolIds,
  academicYear,
  onOpen,
}: {
  card: DashboardCard;
  /**
   * The chart kind this card will hold, from the server (`/api/home` `grid`).
   *
   * It sizes the card's slot in the bento (`pcard--${kind}`, tokens.css
   * `.pgallery`): a trend takes a wider slot than a ring. Taken as a prop rather
   * than read off `preview.widget` because the SLOT has to be right from the
   * first paint — every card is its own request, and sizing from the widget
   * would mean eight equal skeletons reflowing the page one at a time as the
   * charts landed.
   *
   * Optional so the Module screen, which draws these cards in a plain grid of
   * its own, does not have to invent one.
   */
  kind?: 'bar' | 'line' | 'donut' | undefined;
  /**
   * This card's key on the grid (`GridCard.key`), where it has one.
   *
   * Only the ACCENT reads it: two cards of one report are two subjects and take
   * two colours (`PREVIEW_ACCENT`). Absent on the Module screen, which draws one
   * card per report and falls back to the report's own hue.
   */
  slotKey?: string | undefined;
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

  /**
   * Keyed by the card, falling back to the report — a module screen draws these
   * cards with no slot key of its own, and its Fee Collection card should still
   * be the colour the grid's is.
   */
  const accent = PREVIEW_ACCENT[slotKey ?? card.id] ?? PREVIEW_ACCENT[card.id];

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
    <div
      className={`card pcard${kind === undefined ? '' : ` pcard--${kind}`}`}
      onClick={() => { onOpen(card.id); }}
      role="button"
      tabIndex={0}
    >
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
              accent={accent}
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
