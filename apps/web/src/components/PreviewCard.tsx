/**
 * One dashboard as a live PREVIEW CARD: its own chart, at card size, clickable
 * through to the full report.
 *
 * Extracted from Home.tsx on 2026-09-01, when Module Wise Analysis became a
 * second screen that draws these. It is the same card on both — same chart,
 * same drill, same colour — because a Fee Defaulters card that behaved one way
 * on Dashboard and another inside the Fees module would be two cards a reader
 * has to learn separately.
 *
 * -- The card's own chrome (2026-09-04) ----------------------------------------
 * Title and the chart's own subtitle on the left; on the right the per-chart
 * TYPE MENU (bar · line · area · donut · pie · spiral · radar) and the way to
 * the report. The type menu is this card's state and this card's only: a
 * reader flipping Attendance to a pie is choosing a projection of the same
 * figures for this render (vivid.tsx), and the choice is never written to the
 * spec, a saved report or a PDF.
 *
 * -- Colour ------------------------------------------------------------------
 * `slot` is the card's POSITION on the grid, cycled through the page palette
 * so ten cards read as ten subjects. It can never overrule meaning: a widget's
 * own `tone` (Fee Defaulters' overdue money, its defaulter counts) wins inside
 * the renderer, so a card cannot repaint a warning in the lead colour.
 */

import { useCallback, useState } from 'react';
import {
  ChartTypeSelect,
  WidgetSpecView,
  defaultChartTypeOf,
  type ChartType,
  type DrillTarget,
} from '@sap/chart-spec/react';
import type { Widget } from '@sap/chart-spec';
import type { HomePreview, DashboardCard } from '../api/client';
import { DrillTrail, useDrill, widgetIdOf } from './Drill';

/**
 * A dashboard's own lead CHART, live -- the same bar/line/donut
 * `buildDashboard` would draw first on the full report (services/home.ts,
 * `buildHomePreview`), rendered here at card size (`compact`, widgets.tsx).
 * Clicking the card's head opens that report.
 */
export function PreviewCard({
  card,
  kind,
  slot = 0,
  preview,
  schoolIds,
  academicYear,
  onOpen,
}: {
  card: DashboardCard;
  /**
   * The chart kind this card will hold, from the server (`/api/home` `grid`).
   * It sizes the card's slot in the bento (`pcard--${kind}`) and has to be
   * known before the chart is — every card is its own request, and sizing from
   * the widget would mean ten equal skeletons reflowing as the charts landed.
   */
  kind?: 'bar' | 'line' | 'donut' | undefined;
  /** Palette slot, by position on the grid — see the header. */
  slot?: number | undefined;
  preview: HomePreview | undefined;
  schoolIds: readonly string[];
  academicYear: string | null;
  onOpen: (reportId: string) => void;
}): JSX.Element {
  /**
   * A drill failure is said INSIDE the card that failed. Five other cards are
   * fine, and a banner across the top would report a whole-screen problem where
   * there is a one-card one (ADR-011's reasoning, one level down).
   */
  const [drillError, setDrillError] = useState<string | null>(null);
  const [chartType, setChartType] = useState<ChartType | null>(null);
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
  const subtitle = shown !== null && 'title' in shown && typeof shown.title === 'string' ? shown.title : null;
  const type = chartType ?? (shown === null ? null : defaultChartTypeOf(shown));

  /**
   * Opening the full report is the HEAD's click; drilling is the CHART's. A
   * bar click bubbles, so a card-wide handler would also navigate away from the
   * card it just drilled, and the reader would never see the level they asked
   * for. So the head opens, the body drills, and empty chart space does nothing.
   */
  return (
    <div className={`card pcard${kind === undefined ? '' : ` pcard--${kind}`}`}>
      <div
        className="pcardHead"
        role="button"
        tabIndex={0}
        onClick={() => { onOpen(card.id); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(card.id);
          }
        }}
      >
        <div className="pcardTitle">
          <h3>
            <span className="pcardIc" aria-hidden="true">{card.icon}</span>
            {card.title}
          </h3>
          {subtitle !== null && <div className="sub">{subtitle}</div>}
        </div>
        <div className="tools">
          {type !== null && (
            <ChartTypeSelect value={type} onChange={(next) => { setChartType(next); }} />
          )}
          <span className="tinybtn dark">Report →</span>
        </div>
      </div>
      <div className="pcardBody">
        {preview === undefined ? (
          <div className="skeleton skeletonPreview" />
        ) : shown !== null ? (
          <>
            <WidgetSpecView
              widget={shown}
              compact
              slot={slot}
              chartType={type ?? undefined}
              /**
               * The renderer reports WHICH value was clicked; deciding what to
               * fetch is this screen's job, because the drill path is a
               * server-side catalog (DRILL_PATHS) and the spec carries only the
               * dimension, never a query. The id is `baseId`: the level-1
               * widget's, which keyed the drill and stays the key below it.
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
