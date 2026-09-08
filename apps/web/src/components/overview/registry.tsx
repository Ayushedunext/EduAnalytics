/**
 * Which Dashboard card is which — the table My View reads to redraw a card the
 * reader kept.
 *
 * -- Why a table and not "render the widget" ----------------------------------
 * A saved chart could have been redrawn from its widget alone, and for the
 * simple ones that would even look right. It would be wrong for the rest: the
 * concentric rings, the four gauges, the two-gauge Data Graphic and the two
 * tables are ARRANGEMENTS this product composes out of several widgets, and a
 * board that redrew "Attendance and fee realisation" as one donut would be
 * showing the reader a chart they never saved. So My View mounts the SAME
 * component the Dashboard mounts, with the same props, and the two cannot
 * drift.
 *
 * -- Why the keys look like this ----------------------------------------------
 * `${slot}:${widgetId}` — exactly `chartKey` in myView.ts for an overview
 * source, so a saved reference resolves by lookup rather than by a second
 * parsing rule kept in step by hand. A key absent from this table is a card
 * this build no longer draws; the board says so and offers to drop it, rather
 * than rendering an empty frame (§10: never a success-shaped failure).
 *
 * `slots` is what the board must FETCH for that card, which is not always one:
 * the Data Graphic reads the rings slot and the tiles slot together.
 */

import type { ReactElement } from 'react';
import type { SessionResponse } from '../../api/client';
import type { MyViewChart } from '../../myView';
import type { SlotState } from './useOverview';
import {
  AdmissionsCard,
  AreaCard,
  BigChartCard,
  CustomerCard,
  FeeHeadsCard,
  GaugeCard,
  GaugesCCard,
  InboxCard,
  LatePayersCard,
  ModesCard,
  MonthlyCard,
  RingsCard,
  SparkCard,
  TopSchoolsCard,
} from './cards';

export interface OverviewCardCtx {
  readonly states: Record<string, SlotState>;
  readonly session: SessionResponse;
  readonly year: string | null;
  readonly asOf: string | null;
  readonly scopeCount: number;
  readonly onOpen: (reportId: string) => void;
}

export interface OverviewCardDef {
  /** The `/api/home/overview/:slot` requests this card needs. */
  readonly slots: readonly string[];
  /** How many of the board's twelve columns it wants. */
  readonly span: 4 | 6 | 8 | 12;
  readonly render: (ctx: OverviewCardCtx) => ReactElement;
}

/**
 * The card a saved reference names, or `undefined` for one this build no longer
 * draws. The single place the `overview:` prefix `chartKey` writes is stripped,
 * so no caller has to know how the two spellings relate.
 */
export function overviewCardOf(chart: MyViewChart): OverviewCardDef | undefined {
  if (chart.source.kind !== 'overview') return undefined;
  return OVERVIEW_CARDS[`${chart.source.slot}:${chart.source.widgetId}`];
}

export const OVERVIEW_CARDS: Readonly<Record<string, OverviewCardDef>> = {
  // -- View 2's cards --------------------------------------------------------
  'rings:rings': {
    slots: ['rings'],
    span: 6,
    render: (c) => <RingsCard state={c.states['rings']} year={c.year} asOf={c.asOf} onOpen={c.onOpen} />,
  },
  'monthly:bar-month': {
    slots: ['monthly'],
    span: 6,
    render: (c) => <MonthlyCard state={c.states['monthly']} onOpen={c.onOpen} />,
  },
  'admissions_by_school:bar-school-admissions': {
    slots: ['admissions_by_school'],
    span: 6,
    render: (c) => <AdmissionsCard state={c.states['admissions_by_school']} onOpen={c.onOpen} />,
  },
  'weekly_receipts:line-week-receipts': {
    slots: ['weekly_receipts'],
    span: 4,
    render: (c) => (
      <SparkCard state={c.states['weekly_receipts']} kpiId="kpi-week-receipts" lineId="line-week-receipts" slot={1} title="Weekly receipts" slotKey="weekly_receipts" reportId="fee-collection" />
    ),
  },
  'weekly_attendance:line-week-attendance': {
    slots: ['weekly_attendance'],
    span: 4,
    render: (c) => (
      <SparkCard state={c.states['weekly_attendance']} kpiId="kpi-week-attendance" lineId="line-week-attendance" slot={2} title="Weekly attendance" slotKey="weekly_attendance" reportId="attendance-analytics" />
    ),
  },
  'top_schools:table-schools': {
    slots: ['top_schools'],
    span: 6,
    render: (c) => <TopSchoolsCard state={c.states['top_schools']} onOpen={c.onOpen} />,
  },
  'fee_heads:donut-heads': {
    slots: ['fee_heads'],
    span: 12,
    render: (c) => <FeeHeadsCard state={c.states['fee_heads']} />,
  },

  // -- View 1's cards --------------------------------------------------------
  'years:line-years': {
    slots: ['years'],
    span: 6,
    render: (c) => (
      <BigChartCard state={c.states['years']} widgetId="line-years" title="Billed and collected, year by year" slot={0} onOpen={c.onOpen} reportId="trend-analysis" slotKey="years" />
    ),
  },
  'students_by_year:bar-years': {
    slots: ['students_by_year'],
    span: 6,
    render: (c) => (
      <BigChartCard state={c.states['students_by_year']} widgetId="bar-years" title="Students on roll, year by year" slot={2} onOpen={c.onOpen} reportId="trend-analysis" slotKey="students_by_year" />
    ),
  },
  'att_status:donut-status': {
    slots: ['att_status'],
    span: 6,
    render: (c) => (
      <BigChartCard state={c.states['att_status']} widgetId="donut-status" title="Attendance recorded" slot={0} onOpen={c.onOpen} reportId="attendance-analytics" slotKey="att_status" />
    ),
  },
  'gauges:gauge-students': {
    slots: ['gauges'],
    span: 4,
    render: (c) => <GaugeCard state={c.states['gauges']} rateId="gauge-students-rate" countId="gauge-students" slot={4} />,
  },
  'gauges:gauge-attendance': {
    slots: ['gauges'],
    span: 4,
    render: (c) => <GaugeCard state={c.states['gauges']} rateId="gauge-attendance-rate" countId="gauge-attendance" slot={5} />,
  },
  'gauges:gauge-admissions': {
    slots: ['gauges'],
    span: 4,
    render: (c) => <GaugeCard state={c.states['gauges']} rateId="gauge-admissions-rate" countId="gauge-admissions" slot={1} />,
  },
  'gauges:gauge-staff': {
    slots: ['gauges'],
    span: 4,
    render: (c) => <GaugeCard state={c.states['gauges']} rateId="gauge-staff-rate" countId="gauge-staff" slot={0} />,
  },
  'late_payers:table-late-payers': {
    slots: ['late_payers'],
    span: 8,
    render: (c) => <LatePayersCard state={c.states['late_payers']} />,
  },
  'pending_top:table-pending': {
    slots: ['pending_top'],
    span: 4,
    render: (c) => <InboxCard state={c.states['pending_top']} />,
  },

  // -- View 3's cards --------------------------------------------------------
  'area:line-receipts': {
    slots: ['area'],
    span: 8,
    render: (c) => <AreaCard state={c.states['area']} series="line-receipts" />,
  },
  'area:line-staff': {
    slots: ['area'],
    span: 8,
    render: (c) => <AreaCard state={c.states['area']} series="line-staff" />,
  },
  'area:line-attendance': {
    slots: ['area'],
    span: 8,
    render: (c) => <AreaCard state={c.states['area']} series="line-attendance" />,
  },
  'modes:donut-mode': {
    slots: ['modes'],
    span: 4,
    render: (c) => <ModesCard state={c.states['modes']} onOpen={c.onOpen} />,
  },
  'rings:gauges-c': {
    slots: ['rings', 'tiles'],
    span: 6,
    render: (c) => <GaugesCCard rings={c.states['rings']} tiles={c.states['tiles']} />,
  },
  'late_weekly:line-late-week': {
    slots: ['late_weekly'],
    span: 6,
    render: (c) => <CustomerCard state={c.states['late_weekly']} />,
  },
};
