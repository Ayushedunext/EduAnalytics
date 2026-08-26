/**
 * Tests for the Home overview's dashboard-preview cards (services/home.ts,
 * `buildHomePreviews`).
 *
 * The thing worth testing here is the ORCHESTRATION, not any one dashboard's
 * numbers -- those are `services/dashboards.ts`'s job and already covered by
 * dashboards.test.ts. So `buildDashboard` itself is mocked: what matters is
 * that (1) Home previews every `available` dashboard in the catalog's own
 * order, (2) it takes the LEAD widget and no other, and (3) one dashboard
 * failing -- no permission, no data, a degraded school, anything
 * `buildDashboard` throws for -- must not blank the other five (the same
 * partial-failure reasoning as ADR-011, one level up).
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

const buildDashboard = vi.fn();

vi.mock('../src/services/dashboards.js', () => ({
  DASHBOARD_IDS,
  isDashboardId: (value: string) => (DASHBOARD_IDS as readonly string[]).includes(value),
  buildDashboard: (...args: unknown[]) => buildDashboard(...args),
}));

const { buildHomePreviews } = await import('../src/services/home.js');

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

function specWith(widgets: ChartSpec['widgets']): { spec: ChartSpec; logic: unknown; degraded: []; degraded_schools: [] } {
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

function build() {
  return buildHomePreviews({
    session: SESSION,
    schoolIds: ['stmarksmb'],
    academicYear: '2026-27',
    asOfDate: '2026-08-26',
    correlationId: 'corr-1',
  });
}

beforeEach(() => {
  buildDashboard.mockReset();
});

describe('one dashboard failing does not blank the rest', () => {
  it('previews every available dashboard, in the catalog order', async () => {
    buildDashboard.mockImplementation(({ reportId }: { reportId: string }) =>
      Promise.resolve(specWith([{ id: `kpi-${reportId}`, type: 'kpi', label: reportId, value: '1', tone: 'neutral' }])),
    );

    const { previews } = await build();

    expect(previews.map((p) => p.id)).toEqual([
      'fee-collection',
      'fee-defaulters',
      'staff-overview',
      'admissions-funnel',
      'attendance-analytics',
      'enrollment-overview',
    ]);
    expect(previews.every((p) => p.status === 'ok')).toBe(true);
  });

  it('prefers the lead CHART over the lead KPI -- Home\'s KPI strip already has the numbers', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'kpi-lead', type: 'kpi', label: 'Realised', value: '₹1L', tone: 'positive' },
        { id: 'kpi-second', type: 'kpi', label: 'Outstanding', value: '₹2L', tone: 'warning' },
        { id: 'bar-first', type: 'bar', title: 'By class', x: 'classname', y: 'n', data: [{ classname: 'I', n: 1 }] },
        { id: 'donut-second', type: 'donut', title: 'By mode', label_field: 'k', value_field: 'n', data: [{ k: 'a', n: 1 }] },
      ]),
    );

    const { previews } = await build();
    for (const preview of previews) {
      expect((preview.widget as { id: string }).id).toBe('bar-first');
    }
  });

  it('falls back to the lead KPI when a dashboard has no chart widget at all', async () => {
    buildDashboard.mockResolvedValue(
      specWith([
        { id: 'kpi-lead', type: 'kpi', label: 'Candidates', value: '0', tone: 'neutral' },
        { id: 'kpi-second', type: 'kpi', label: 'Admitted', value: '0', tone: 'neutral' },
      ]),
    );

    const { previews } = await build();
    for (const preview of previews) {
      expect((preview.widget as { id: string }).id).toBe('kpi-lead');
    }
  });

  it('reports a refused dashboard as blocked with its reason, and keeps the rest ok', async () => {
    buildDashboard.mockImplementation(({ reportId }: { reportId: string }) => {
      if (reportId === 'fee-defaulters') {
        return Promise.reject(
          new PlatformError({
            code: 'PERMISSION_DENIED',
            message: 'This session does not have permission to view this report.',
          }),
        );
      }
      return Promise.resolve(specWith([{ id: 'kpi-1', type: 'kpi', label: reportId, value: '1', tone: 'neutral' }]));
    });

    const { previews } = await build();

    const blocked = previews.find((p) => p.id === 'fee-defaulters');
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.widget).toBeNull();
    expect(blocked?.reason).toBe('This session does not have permission to view this report.');

    const others = previews.filter((p) => p.id !== 'fee-defaulters');
    expect(others.every((p) => p.status === 'ok')).toBe(true);
  });

  it('falls back to a generic reason for a non-platform error', async () => {
    buildDashboard.mockImplementation(({ reportId }: { reportId: string }) => {
      if (reportId === 'staff-overview') return Promise.reject(new Error('boom'));
      return Promise.resolve(specWith([{ id: 'kpi-1', type: 'kpi', label: reportId, value: '1', tone: 'neutral' }]));
    });

    const { previews } = await build();
    const failed = previews.find((p) => p.id === 'staff-overview');
    expect(failed?.status).toBe('blocked');
    expect(failed?.reason).toBe('This dashboard could not be loaded.');
  });
});
