/**
 * Tests for the Home overview's dashboard-preview cards (services/home.ts,
 * `buildHomePreview`).
 *
 * The thing worth testing here is what a preview PROMISES, not any one
 * dashboard's numbers -- those are `services/dashboards.ts`'s job and are
 * already covered by dashboards.test.ts. So `buildDashboard` itself is mocked,
 * and what is asserted is:
 *
 *   1. A preview asks for ONE query -- and not the whole report. This is the
 *      fix that took Home from 45 queries to 9, and it is invisible in the
 *      response, so only a test can hold it. WHICH query depends on whether the
 *      report has a curated drill path: its drill-ENTRY statement if so, its
 *      lead one if not.
 *   2. `DASHBOARD_LEAD_QUERY` is total over `DASHBOARD_IDS`, and
 *      `DASHBOARD_DRILL_QUERY` agrees with `DRILL_PATHS` in BOTH directions. A
 *      dashboard added without a lead entry falls through to `undefined`, and
 *      `query_keys: [undefined]` is rejected by the MCP server as an unknown
 *      query -- a card that fails in production and nowhere else. A path with
 *      no drill query is worse than that, because it does not fail at all: the
 *      card quietly draws a non-drillable chart under a report advertising
 *      three levels.
 *   3. With a path it takes the drill-entry widget BY ID; without one it takes
 *      the lead chart over a KPI, as before.
 *   4. A dashboard that cannot be read is reported as `blocked` WITH its reason
 *      rather than thrown, so one dead card cannot take the request down -- the
 *      same partial-failure reasoning as ADR-011, one level up. This matters
 *      more now than it did when previews were batched: each card is its own
 *      HTTP request, so a throw here would be a 500 the SPA renders as nothing.
 */

import './env-defaults.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@sap/shared';
import type { ChartSpec } from '@sap/chart-spec';

const DASHBOARD_IDS = [
  'enrollment-overview',
  'fee-collection',
  'fee-defaulters',
  'staff-overview',
  'admissions-funnel',
  'attendance-analytics',
] as const;

/**
 * The real table, not a stand-in: assertion (2) is only worth anything if it
 * checks what production uses. The mock below re-exports it unchanged.
 */
const {
  DASHBOARD_LEAD_QUERY: REAL_LEAD_QUERY,
  DASHBOARD_DRILL_QUERY: REAL_DRILL_QUERY,
  DASHBOARD_IDS: REAL_DASHBOARD_IDS,
  DRILL_PATHS: REAL_DRILL_PATHS,
} = await import('../src/services/dashboards.js');

const buildDashboard = vi.fn();

/**
 * Reports to pretend have NO curated drill path, for this run only.
 *
 * Needed because every dashboard on the grid now has one (`DRILL_PATHS` gained
 * Staff Overview and Transport on 2026-08-31), so the preview builder's
 * no-path branch has no real subject left. That branch is not dead code — it is
 * what a dashboard joining the grid BEFORE it grows a path would take, and it
 * must keep drawing that report's lead chart inert rather than reaching for a
 * drill-entry widget no builder emits. Faking the absence is the only way to
 * hold it, and faking it explicitly is better than deleting the tests and
 * discovering the branch was broken the next time a card is added.
 */
const noPathFor = new Set<string>();

vi.mock('../src/services/dashboards.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/dashboards.js')>();
  return {
    ...actual,
    DASHBOARD_IDS,
    isDashboardId: (value: string) => (DASHBOARD_IDS as readonly string[]).includes(value),
    drillPathFor: (id: Parameters<typeof actual.drillPathFor>[0]) =>
      noPathFor.has(id) ? undefined : actual.drillPathFor(id),
    buildDashboard: (...args: unknown[]) => buildDashboard(...args),
  };
});

const { buildHomePreview, previewableDashboards } = await import('../src/services/home.js');

const SESSION = {
  sub: 'erp-user-3001',
  name: 'P. Nair',
  role: 'ACCOUNTANT' as const,
  org_id: 'stmarks',
  school_ids: ['stmarksmb'],
  default_school: 'stmarksmb',
  perms: ['fees.read'],
  permission_class: 'test',
};

function specWith(widgets: ChartSpec['widgets']): {
  spec: ChartSpec;
  logic: unknown;
  degraded: [];
  degraded_schools: [];
} {
  return {
    spec: {
      spec_version: 1,
      title: 'x',
      widgets,
      meta: { scope: [], generated_at: '2026-08-19T10:00:00.000Z', served_from: 'replica' },
    },
    logic: { source: '', scope: [], filters: [], group_by: [], charts: [], queries: [], notes: [] },
    degraded: [],
    degraded_schools: [],
  };
}

function build(reportId: string) {
  return buildHomePreview({
    session: SESSION,
    schoolIds: ['stmarksmb'],
    reportId: reportId as (typeof DASHBOARD_IDS)[number],
    academicYear: '2026-27',
    asOfDate: '2026-08-26',
    correlationId: 'corr-1',
  });
}

beforeEach(() => {
  buildDashboard.mockReset();
  noPathFor.clear();
});

describe('a preview costs one query, not a whole dashboard', () => {
  it('[MANDATORY] declares a lead query for every dashboard', () => {
    // An id with no entry would send `query_keys: [undefined]`, which the MCP
    // server refuses as an unknown query -- a card broken in production only.
    for (const id of REAL_DASHBOARD_IDS) {
      expect(REAL_LEAD_QUERY[id], `no lead query declared for ${id}`).toBeTruthy();
    }
  });

  /**
   * [MANDATORY] The two tables must agree in BOTH directions.
   *
   * A path with no drill query makes the card fall back to the lead chart and
   * render something inert under a report that advertises three levels — the
   * success-shaped failure, since nothing errors. A drill query with no path is
   * the mirror image: the card fetches the drill statement and then looks for a
   * widget id that no builder emits.
   */
  it('[MANDATORY] declares a drill query for exactly the reports that drill', () => {
    for (const id of Object.keys(REAL_DRILL_PATHS)) {
      expect(REAL_DRILL_QUERY[id as keyof typeof REAL_DRILL_QUERY], `${id} drills but declares no drill query`).toBeTruthy();
    }
    for (const id of Object.keys(REAL_DRILL_QUERY)) {
      expect(REAL_DRILL_PATHS[id as keyof typeof REAL_DRILL_PATHS], `${id} declares a drill query but has no drill path`).toBeTruthy();
    }
  });

  it('asks for the DRILL-ENTRY query where the report drills', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'bar-school', type: 'bar', title: 'By school', x: 's', y: 'n', data: [{ s: 'A', n: 1 }] },
      ]),
    );

    await build('fee-collection');

    /**
     * NOT the lead query. Fee Collection's page opens with receipts by month,
     * a line; the grid card must draw the chart a click descends from, which is
     * demand by school and comes from a different statement.
     */
    expect(buildDashboard).toHaveBeenCalledTimes(1);
    expect(buildDashboard.mock.calls[0]?.[0]).toMatchObject({
      reportId: 'fee-collection',
      queryKeys: [REAL_DRILL_QUERY['fee-collection']],
    });
    expect(REAL_DRILL_QUERY['fee-collection']).not.toBe(REAL_LEAD_QUERY['fee-collection']);
  });

  it('asks for the LEAD query where the report does not drill', async () => {
    noPathFor.add('staff-overview');
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'bar-dept', type: 'bar', title: 'By dept', x: 'd', y: 'n', data: [{ d: 'X', n: 1 }] },
      ]),
    );

    await build('staff-overview');

    // A gridded report with no path keeps its own lead chart and renders inert,
    // rather than fetching a drill statement whose widget no builder emits.
    expect(buildDashboard.mock.calls[0]?.[0]).toMatchObject({
      reportId: 'staff-overview',
      queryKeys: [REAL_LEAD_QUERY['staff-overview']],
    });
  });

  /**
   * Every card on the grid drills. This is the actual goal of the curated six —
   * a card that draws a chart nobody can click is a card that lies about what
   * happens when you click it — and it is worth asserting rather than assuming,
   * because adding a seventh card is exactly when it would stop being true.
   */
  it('[MANDATORY] every dashboard on the grid has a drill path', () => {
    for (const card of previewableDashboards()) {
      expect(REAL_DRILL_PATHS[card.id], `${card.id} is on the grid but does not drill`).toBeTruthy();
      expect(REAL_DRILL_QUERY[card.id], `${card.id} is on the grid but has no drill query`).toBeTruthy();
    }
  });

  it('passes the request’s own scope and filters through untouched', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'bar-x', type: 'bar', title: 'By class', x: 'c', y: 'n', data: [{ c: 'I', n: 1 }] },
      ]),
    );

    await build('staff-overview');

    expect(buildDashboard.mock.calls[0]?.[0]).toMatchObject({
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-26',
      session: SESSION,
    });
  });
});

describe('what a card shows', () => {
  /**
   * By ID, not by type, once a path exists. One statement can feed more than
   * one widget — `by_component` builds Fee Collection's school bars AND its
   * fee-head table — so "the first bar" is no longer a reliable way to find the
   * drill entry, and the wrong pick hands the card a chart with no `drill_dim`.
   */
  it('takes the drill-entry widget by id, not merely the first chart', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'table-component', type: 'table', title: 'By head', columns: [{ field: 'c', label: 'C' }], rows: [{ c: 'Tuition' }] },
        { id: 'bar-decoy', type: 'bar', title: 'Decoy', x: 'c', y: 'n', data: [{ c: 'I', n: 1 }] },
        { id: 'bar-school', type: 'bar', title: 'By school', x: 's', y: 'n', data: [{ s: 'A', n: 1 }] },
      ]),
    );

    const preview = await build('fee-collection');
    expect((preview.widget as { id: string }).id).toBe('bar-school');
    expect(preview.status).toBe('ok');
  });

  it('prefers the lead CHART over a KPI where there is no path -- the strip already has the numbers', async () => {
    noPathFor.add('staff-overview');
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'kpi-lead', type: 'kpi', label: 'Headcount', value: '228', tone: 'neutral' },
        { id: 'bar-first', type: 'bar', title: 'By dept', x: 'c', y: 'n', data: [{ c: 'I', n: 1 }] },
      ]),
    );

    const preview = await build('staff-overview');
    expect((preview.widget as { id: string }).id).toBe('bar-first');
    expect(preview.status).toBe('ok');
  });

  it('falls back to the lead KPI when the lead query produced no chart', async () => {
    noPathFor.add('staff-overview');
    buildDashboard.mockResolvedValue(
      specWith([{ id: 'kpi-lead', type: 'kpi', label: 'Headcount', value: '0', tone: 'neutral' }]),
    );

    const preview = await build('staff-overview');
    expect((preview.widget as { id: string }).id).toBe('kpi-lead');
  });

  /**
   * A built dashboard that is simply NOT on the curated grid has no preview.
   * The grid is six cards (services/home.ts `DASHBOARD_GRID`); Admissions
   * Funnel is `available` and reachable from the sidebar, and asking for its
   * card is a caller bug rather than a state the screen should render.
   */
  it('refuses a built dashboard that the grid does not draw', async () => {
    await expect(build('admissions-funnel')).rejects.toThrow(PlatformError);
    expect(buildDashboard).not.toHaveBeenCalled();
  });

  it('carries the catalog’s own title and icon, not the report’s', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'bar-x', type: 'bar', title: 'By class', x: 'c', y: 'n', data: [{ c: 'I', n: 1 }] },
      ]),
    );

    const preview = await build('fee-defaulters');
    expect(preview.title).toBe('Fee Defaulters');
    expect(preview.icon).toBe('⏳');
  });
});

describe('a card that cannot be read says why, and does not throw', () => {
  it('reports a refused dashboard as blocked with its reason', async () => {
    buildDashboard.mockRejectedValue(
      new PlatformError({
        code: 'PERMISSION_DENIED',
        message: 'This session does not have permission to view this report.',
      }),
    );

    const preview = await build('fee-defaulters');
    expect(preview.status).toBe('blocked');
    expect(preview.widget).toBeNull();
    expect(preview.reason).toBe('This session does not have permission to view this report.');
  });

  it('falls back to a generic reason for a non-platform error', async () => {
    buildDashboard.mockRejectedValue(new Error('boom'));

    const preview = await build('staff-overview');
    expect(preview.status).toBe('blocked');
    // Never the raw error: 'boom' is a stack-trace detail, not something to
    // print on a school's dashboard.
    expect(preview.reason).toBe('This dashboard could not be loaded.');
  });

  it('refuses an id that is not a previewable dashboard at all', async () => {
    // A caller bug, not a state a card can describe -- so this one DOES throw.
    await expect(build('exam-performance')).rejects.toThrow(PlatformError);
    expect(buildDashboard).not.toHaveBeenCalled();
  });
});
