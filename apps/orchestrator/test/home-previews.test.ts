/**
 * Tests for the Home overview's dashboard-preview cards (services/home.ts,
 * `buildHomePreview`).
 *
 * The thing worth testing here is what a preview PROMISES, not any one
 * dashboard's numbers -- those are `services/dashboards.ts`'s job and are
 * already covered by dashboards.test.ts. So `buildDashboard` itself is mocked,
 * and what is asserted is:
 *
 *   1. A preview asks for ONE query -- the dashboard's declared lead query --
 *      and not the whole report. This is the fix that took Home from 45 queries
 *      to 9, and it is invisible in the response, so only a test can hold it.
 *   2. `DASHBOARD_LEAD_QUERY` is total over `DASHBOARD_IDS`. A dashboard added
 *      without an entry would fall through to `undefined`, and `query_keys:
 *      [undefined]` is rejected by the MCP server as an unknown query -- a card
 *      that fails in production and nowhere else.
 *   3. It takes the lead CHART, never a KPI, when both come back.
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
const { DASHBOARD_LEAD_QUERY: REAL_LEAD_QUERY, DASHBOARD_IDS: REAL_DASHBOARD_IDS } = await import(
  '../src/services/dashboards.js'
);

const buildDashboard = vi.fn();

vi.mock('../src/services/dashboards.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/dashboards.js')>();
  return {
    ...actual,
    DASHBOARD_IDS,
    isDashboardId: (value: string) => (DASHBOARD_IDS as readonly string[]).includes(value),
    buildDashboard: (...args: unknown[]) => buildDashboard(...args),
  };
});

const { buildHomePreview } = await import('../src/services/home.js');

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
});

describe('a preview costs one query, not a whole dashboard', () => {
  it('[MANDATORY] declares a lead query for every dashboard', () => {
    // An id with no entry would send `query_keys: [undefined]`, which the MCP
    // server refuses as an unknown query -- a card broken in production only.
    for (const id of REAL_DASHBOARD_IDS) {
      expect(REAL_LEAD_QUERY[id], `no lead query declared for ${id}`).toBeTruthy();
    }
  });

  it('asks buildDashboard for only that dashboard’s lead query', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'bar-x', type: 'bar', title: 'By class', x: 'c', y: 'n', data: [{ c: 'I', n: 1 }] },
      ]),
    );

    await build('fee-collection');

    expect(buildDashboard).toHaveBeenCalledTimes(1);
    expect(buildDashboard.mock.calls[0]?.[0]).toMatchObject({
      reportId: 'fee-collection',
      queryKeys: [REAL_LEAD_QUERY['fee-collection']],
    });
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
  it('prefers the lead CHART over a KPI -- Home’s KPI strip already has the numbers', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'kpi-lead', type: 'kpi', label: 'Realised', value: '₹1L', tone: 'positive' },
        { id: 'bar-first', type: 'bar', title: 'By class', x: 'c', y: 'n', data: [{ c: 'I', n: 1 }] },
      ]),
    );

    const preview = await build('fee-collection');
    expect((preview.widget as { id: string }).id).toBe('bar-first');
    expect(preview.status).toBe('ok');
  });

  it('falls back to the lead KPI when the lead query produced no chart', async () => {
    buildDashboard.mockResolvedValue(
      specWith([{ id: 'kpi-lead', type: 'kpi', label: 'Candidates', value: '0', tone: 'neutral' }]),
    );

    const preview = await build('admissions-funnel');
    expect((preview.widget as { id: string }).id).toBe('kpi-lead');
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
