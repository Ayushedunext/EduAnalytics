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
  'fee-by-student',
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
  DASHBOARD_PREVIEW: REAL_PREVIEW,
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

const {
  buildHomePreview,
  previewableDashboards,
  DASHBOARD_GRID: REAL_GRID,
  slotKind: realSlotKind,
} = await import('../src/services/home.js');

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

/** `slotKey` is a grid CARD key or a bare dashboard id -- both are accepted. */
function build(slotKey: string) {
  return buildHomePreview({
    session: SESSION,
    schoolIds: ['stmarksmb'],
    slotKey,
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

  it('asks for the DRILL-ENTRY query where the report drills and declares no preview', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'bar-school', type: 'bar', title: 'By school', x: 's', y: 'n', data: [{ s: 'A', n: 1 }] },
      ]),
    );

    await build('fee-by-student');

    /**
     * NOT the lead query. Fee by Student's page opens with outstanding by class;
     * a card still drawing its drill entry must draw the chart a click descends
     * from, which is outstanding by SCHOOL and comes from a different statement.
     *
     * The subject used to be Fee Collection, and moved here when Fee Collection
     * gained a `DASHBOARD_PREVIEW` entry -- this branch is the one for a gridded
     * report the preview table does not override, so it has to be tested with
     * one. Fee by Student qualifies on both counts and, like Fee Collection,
     * has a drill query that genuinely differs from its lead one, which is what
     * makes the last assertion here worth making.
     */
    expect(buildDashboard).toHaveBeenCalledTimes(1);
    expect(buildDashboard.mock.calls[0]?.[0]).toMatchObject({
      reportId: 'fee-by-student',
      queryKeys: [REAL_DRILL_QUERY['fee-by-student']],
    });
    expect(REAL_PREVIEW['fee-by-student']).toBeUndefined();
    expect(REAL_DRILL_QUERY['fee-by-student']).not.toBe(REAL_LEAD_QUERY['fee-by-student']);
  });

  /**
   * A card the grid gives a chart of its own (`DASHBOARD_PREVIEW`).
   *
   * Two things are asserted together because they are one decision: the query
   * it asks for, and the widget it takes out of the answer. Getting the first
   * right and the second wrong is the failure mode that does not look like one
   * -- the card renders a real chart built from real data, just not the chart
   * the grid meant to show.
   */
  it('asks for the DECLARED preview query and takes that widget by id', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'bar-school', type: 'bar', title: 'By school', x: 's', y: 'n', data: [{ s: 'A', n: 1 }] },
        {
          id: 'line-month',
          type: 'line',
          title: 'Receipts by month',
          x: 'm',
          y: 'collected',
          data: [{ m: 'April', collected: 1 }],
        },
      ]),
    );

    const preview = await build('fee-collection');

    expect(buildDashboard.mock.calls[0]?.[0]).toMatchObject({
      reportId: 'fee-collection',
      queryKeys: [REAL_PREVIEW['fee-collection']?.query],
    });
    // The declared widget wins over the drill entry, which is present and first.
    expect(preview.widget?.id).toBe('line-month');
    expect(preview.widget?.type).toBe('line');
  });

  /**
   * [MANDATORY] The preview table describes the GRID and only the grid, and the
   * kind it declares is the kind the SPA sizes the card's bento slot from
   * (tokens.css `.pgallery`). An entry for a report the grid does not draw is
   * dead configuration that reads as live.
   */
  it('[MANDATORY] declares previews only for gridded dashboards, with a kind', () => {
    /**
     * The REAL grid, not `previewableDashboards()`. That helper is filtered
     * through this file's mocked `DASHBOARD_IDS`, which is right for the tests
     * about the preview BUILDER and wrong here: this one is about a table that
     * describes production, and against the mock it would report every card the
     * mock leaves out as an entry for a dashboard that is not on the grid.
     */
    const onGrid = new Set<string>(REAL_GRID.map((slot) => slot.report));
    for (const [id, entry] of Object.entries(REAL_PREVIEW)) {
      expect(onGrid.has(id), id + ' declares a grid preview but is not on the grid').toBe(true);
      expect(entry?.query, id + ' declares a preview with no query').toBeTruthy();
      expect(entry?.widget_id, id + ' declares a preview with no widget id').toBeTruthy();
      expect(['bar', 'line', 'donut']).toContain(entry?.kind);
    }
  });

  /**
   * Every gridded card can be SIZED, whether or not it declares a preview.
   *
   * `previewKindFor` is what `/api/home` puts on the wire, and the SPA has no
   * fallback of its own: a card whose kind came back undefined would take the
   * grid's neutral span while its chart drew something else, which is the
   * reflow the kind exists to prevent.
   */
  it('[MANDATORY] every gridded card has a chart kind, matching any declared one', () => {
    for (const slot of REAL_GRID) {
      const kind = realSlotKind(slot);
      expect(['bar', 'line', 'donut'], slot.key + ' has no usable preview kind').toContain(kind);
      /**
       * A `drill-entry` slot is a bar by construction (level 1 is one bar per
       * school) and deliberately does NOT take the report's declared kind --
       * that is the whole point of the slot, which exists to sit beside the
       * declared chart rather than repeat it.
       */
      const declared = REAL_PREVIEW[slot.report]?.kind;
      if (slot.chart === 'drill-entry') expect(kind).toBe('bar');
      else if (declared !== undefined) expect(kind).toBe(declared);
    }
  });

  /**
   * [MANDATORY] A card key is unique, and a `drill-entry` slot names a report
   * that actually drills.
   *
   * The first is what makes two cards of one report possible at all: the SPA
   * keys its previews map by this, so a duplicate would silently draw one card's
   * chart in the other's slot -- both cards rendering, both plausible, one
   * wrong. The second is the older invariant applied to the new shape: a slot
   * pinned to a drill entry whose report has no path would fetch a statement no
   * builder emits and fall back to whatever else came back.
   */
  it('[MANDATORY] grid keys are unique and drill-entry slots really drill', () => {
    const seen = new Set<string>();
    for (const slot of REAL_GRID) {
      expect(seen.has(slot.key), 'duplicate grid key ' + slot.key).toBe(false);
      seen.add(slot.key);
      if (slot.chart === 'drill-entry') {
        expect(
          REAL_DRILL_QUERY[slot.report],
          slot.key + ' pins a drill entry but its report has no drill query',
        ).toBeTruthy();
      }
    }
  });

  /**
   * A slot pinned to the drill entry asks for the DRILL query even though its
   * report declares a preview -- that is the entire reason the slot exists, and
   * getting it wrong would draw Fee Collection's receipts curve twice.
   */
  it('a drill-entry slot declines the report’s declared preview', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'bar-school', type: 'bar', title: 'By school', x: 's', y: 'n', data: [{ s: 'A', n: 1 }] },
      ]),
    );

    await build('fee-collection--by-school');

    expect(REAL_PREVIEW['fee-collection']).toBeDefined();
    expect(buildDashboard.mock.calls[0]?.[0]).toMatchObject({
      reportId: 'fee-collection',
      queryKeys: [REAL_DRILL_QUERY['fee-collection']],
    });
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
   * Every REPORT on the grid drills -- on its own page, at all three levels.
   *
   * This used to be justified as "a card that draws a chart nobody can click
   * lies about what happens when you click it", which was the argument for
   * every card drawing its drill ENTRY. That is no longer what the grid does
   * (`DASHBOARD_PREVIEW`): five of the eight draw a trend, a ring or a bucket
   * bar instead, and those cards are inert -- a click opens the report, which is
   * what a click on any card does, so nothing lies.
   *
   * The invariant survives the change because it was never really about the
   * card. It is about what earns a place on the overview: a report the grid
   * leads with is one a reader is meant to descend into, and one that cannot be
   * descended belongs in the strip below. Worth asserting rather than assuming,
   * because adding a ninth card is exactly when it would stop being true.
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
   * By ID, not by type, whichever branch chose the chart. One statement can feed
   * more than one widget -- `by_component` builds Fee Collection's school bars
   * AND its fee-head table -- so "the first bar" is not a reliable way to find a
   * specific chart, and the wrong pick hands the card a chart with no
   * `drill_dim` or, worse, the wrong subject drawn convincingly.
   *
   * The subject is Fee by Student rather than Fee Collection because this is the
   * DRILL-ENTRY branch, and Fee Collection now takes the declared-preview branch
   * instead (`DASHBOARD_PREVIEW`); that branch has its own by-id case above.
   */
  it('takes the drill-entry widget by id, not merely the first chart', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'table-students', type: 'table', title: 'By student', columns: [{ field: 'c', label: 'C' }], rows: [{ c: 'Asha' }] },
        { id: 'bar-decoy', type: 'bar', title: 'Decoy', x: 'c', y: 'n', data: [{ c: 'I', n: 1 }] },
        { id: 'bar-school-fee-student', type: 'bar', title: 'By school', x: 's', y: 'n', data: [{ s: 'A', n: 1 }] },
      ]),
    );

    const preview = await build('fee-by-student');
    expect((preview.widget as { id: string }).id).toBe('bar-school-fee-student');
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
   * A built dashboard the GRID does not draw still previews (widened
   * 2026-09-01). It used to be refused, and that was right while Dashboard's
   * grid was the only caller; Module Wise Analysis draws every report in a
   * module, and Admissions Funnel, Library & Textbooks and the Principal's
   * Snapshot are `available` reports a reader can already open in full. Two
   * kinds of card inside one module — live charts for the gridded ones, dead
   * tiles for the rest — would have been a distinction no reader could see.
   *
   * It has no curated drill path, so it takes the LEAD branch: exactly what a
   * gridded report without a path takes, which is the point. Nothing about a
   * preview is special-cased for the module screen.
   */
  it('previews a built dashboard that the grid does not draw', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'bar-funnel', type: 'bar', title: 'Funnel', x: 's', y: 'n', data: [{ s: 'Enquiry', n: 4 }] },
      ]),
    );

    const preview = await build('admissions-funnel');

    expect(preview.status).toBe('ok');
    expect(buildDashboard.mock.calls[0]?.[0]).toMatchObject({
      reportId: 'admissions-funnel',
      queryKeys: [REAL_LEAD_QUERY['admissions-funnel']],
    });
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

  /**
   * A WITHHELD dashboard still has no preview, and that is the line the
   * widening did not cross. `exam-performance` is `blocked` -- the ERP extract
   * carries no exam data -- so there is no report to draw a card from at all.
   * Asking for one is a caller bug, not a state a card can describe, so this
   * one DOES throw. (The Exam MODULE says so on its own tile instead;
   * test/modules.test.ts holds that.)
   */
  it('refuses a withheld dashboard', async () => {
    await expect(build('exam-performance')).rejects.toThrow(PlatformError);
    expect(buildDashboard).not.toHaveBeenCalled();
  });
});
