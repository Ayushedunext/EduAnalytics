/**
 * The three layouts of the Dashboard, card for card as the artifact lays them
 * out (docs/10 §1.5). Each format names the slots it fetches; a card that is
 * not on a format is never requested for it.
 */

import type { ReactElement } from 'react';
import type { SessionResponse } from '../../api/client';
import type { SlotState } from './useOverview';
import {
  AdmissionsCard,
  AreaCard,
  BigChartCard,
  CustomerCard,
  FeeHeadsCard,
  GaugeCards,
  GaugesCCard,
  InboxCard,
  LatePayersCard,
  ModesCard,
  MonthlyCard,
  RingsCard,
  SparkCard,
  TeamCards,
  TilesCard,
  TopSchoolsCard,
} from './cards';
import { Icon } from '../Icon';

export const FORMAT_SLOTS = {
  A: ['tiles', 'rings', 'monthly', 'admissions_by_school', 'weekly_receipts', 'weekly_attendance', 'top_schools', 'fee_heads'],
  B: ['years', 'students_by_year', 'att_status', 'top_students', 'gauges', 'late_payers', 'pending_top'],
  C: ['tiles', 'area', 'modes', 'rings', 'late_weekly'],
} as const;

export interface FormatProps {
  states: Record<string, SlotState>;
  session: SessionResponse;
  year: string | null;
  /** Null until the KPI strip lands — the cards mount before it. */
  asOf: string | null;
  scopeCount: number;
  onOpen: (reportId: string) => void;
}

/** Format A · View 2: the artifact's 24-column grid. */
export function FormatA({ states, year, asOf, onOpen }: FormatProps): ReactElement {
  return (
    <div className="gridA">
      <TilesCard state={states['tiles']} className="slotTiles" />
      <RingsCard state={states['rings']} year={year} asOf={asOf} onOpen={onOpen} />
      {/* One column, two charts of equal height — see `.slotBars` in dashboard.css. */}
      <div className="slotBars stackBars">
        <MonthlyCard state={states['monthly']} onOpen={onOpen} />
        <AdmissionsCard state={states['admissions_by_school']} onOpen={onOpen} />
      </div>
      <SparkCard state={states['weekly_receipts']} kpiId="kpi-week-receipts" lineId="line-week-receipts" className="slotSpark" slot={1} title="Weekly receipts" slotKey="weekly_receipts" reportId="fee-collection" />
      <SparkCard state={states['weekly_attendance']} kpiId="kpi-week-attendance" lineId="line-week-attendance" className="slotSpark" slot={2} title="Weekly attendance" slotKey="weekly_attendance" reportId="attendance-analytics" />
      <TopSchoolsCard state={states['top_schools']} onOpen={onOpen} />
      <FeeHeadsCard state={states['fee_heads']} />
    </div>
  );
}

/** Format B · View 1: three charts, members, four gauges, table and inbox. */
export function FormatB({ states, onOpen }: FormatProps): ReactElement {
  return (
    <>
      <div className="row3">
        <BigChartCard state={states['years']} widgetId="line-years" title="Billed and collected, year by year" slot={0} onOpen={onOpen} reportId="trend-analysis" slotKey="years" />
        <BigChartCard state={states['students_by_year']} widgetId="bar-years" title="Students on roll, year by year" slot={2} onOpen={onOpen} reportId="trend-analysis" slotKey="students_by_year" />
        <BigChartCard state={states['att_status']} widgetId="donut-status" title="Attendance recorded" slot={0} onOpen={onOpen} reportId="attendance-analytics" slotKey="att_status" />
      </div>
      <h2 className="h2B">Highest attendance</h2>
      <div className="row4">
        <TeamCards state={states['top_students']} />
      </div>
      <div className="row4" style={{ marginTop: 16 }}>
        <GaugeCards state={states['gauges']} />
      </div>
      <div className="row21">
        <LatePayersCard state={states['late_payers']} />
        <InboxCard state={states['pending_top']} />
      </div>
    </>
  );
}

/** Format C · View 3: profile, tiles, area with legend toggles, donut, gauges, sparkline. */
export function FormatC({ states, session, year, asOf, scopeCount, onOpen }: FormatProps): ReactElement {
  return (
    <div className="mainC">
      <div className="card skProfile slotProfile">
        <span className="skAvatar skAvatar--big">{initials(session.user.name)}</span>
        <div>
          <b>{session.user.name}</b>
          <small>WELCOME TO DASHBOARD</small>
          <div className="meta">
            <span>{session.user.role.toUpperCase()}</span>
            <span>{String(scopeCount)} {scopeCount === 1 ? 'SCHOOL' : 'SCHOOLS'}</span>
            <span>{today()}</span>
          </div>
        </div>
      </div>
      <TilesCard state={states['tiles']} className="slotCompany" title="Students, staff and admissions" ids={['tile-students', 'tile-staff', 'tile-admissions']} notes={false} />
      <AreaCard state={states['area']} />
      <ModesCard state={states['modes']} onOpen={onOpen} />
      <div className="dgh">
        <div>
          <h3>Money and presence</h3>
          <div className="sub">Fee realisation and today’s attendance against the year · as of {asOf ?? '—'}</div>
        </div>
        <span className="life">AY {year ?? '—'} <Icon name="clock" /></span>
      </div>
      <GaugesCCard rings={states['rings']} tiles={states['tiles']} />
      <CustomerCard state={states['late_weekly']} />
    </div>
  );
}

function initials(name: string): string {
  return name.trim().split(/\s+/).map((p) => p[0] ?? '').join('').slice(0, 2).toUpperCase();
}

function today(): string {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
}
