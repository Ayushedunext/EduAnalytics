/**
 * Regression tests for the Home summary.
 *
 * These exist because of a real bug, and the bug is worth stating plainly: an
 * accountant holds `fees.read` and not `students.read`, so the student query was
 * refused for every school, `run_multi` reported the refusal per school and
 * returned no rows, and summing no rows produced **0 students**. The screen said
 * a school with 3,929 children had none, in the same confident typeface as every
 * true number on the page.
 *
 * That is the failure mode CODING_GUIDELINES §10 calls the worst bug class in
 * this system — success-shaped failure — and it is the one this codebase writes
 * comments about everywhere. It still got in. So the rule now has tests rather
 * than only prose: a metric that could not be READ must never be rendered as a
 * VALUE.
 *
 * The MCP client is mocked because the thing under test is how this service
 * reasons about partial and refused results, not whether MySQL can count. That
 * also keeps these runnable with no database and no MCP server.
 */

/**
 * FIRST, before anything that reaches `config` — including the result cache,
 * which these tests must run without. See env-defaults.ts.
 */
import './env-defaults.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@sap/shared';

/** One school's outcome inside a fan-out (ADR-011). */
type SchoolStatus = {
  school_id: string;
  status: 'ok' | 'failed';
  rows?: number;
  error?: { code: string; message: string };
};

function ok(rows: Record<string, unknown>[], schoolId = 'stmarksmb') {
  return {
    rows,
    columns: Object.keys(rows[0] ?? {}),
    truncated: false,
    masked_columns: [],
    per_school: [{ school_id: schoolId, status: 'ok', rows: rows.length }] as SchoolStatus[],
    schools_succeeded: 1,
    schools_failed: 0,
    as_of: '2026-08-19T10:00:00.000Z',
  };
}

function refused(code: string, message: string, schoolId = 'stmarksmb') {
  return {
    rows: [],
    columns: [],
    truncated: false,
    masked_columns: [],
    per_school: [{ school_id: schoolId, status: 'failed', error: { code, message } }] as SchoolStatus[],
    schools_succeeded: 0,
    schools_failed: 1,
    as_of: '2026-08-19T10:00:00.000Z',
  };
}

/** Queued in call order: students, staff, outstanding, attendance (services/home.ts). */
let queue: unknown[] = [];

vi.mock('../src/mcp/client.js', () => ({
  withMcp: async (
    _session: unknown,
    _correlationId: string,
    _schoolIds: readonly string[],
    fn: (mcp: { call: (tool: string, args: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
  ) => {
    let index = 0;
    return fn({
      call: (_tool: string) => {
        const next = queue[index];
        index += 1;
        return Promise.resolve(next);
      },
    });
  },
}));

vi.mock('../src/db/registry.js', () => ({
  schoolNames: (ids: readonly string[]) =>
    Promise.resolve(ids.map((id) => ({ school_id: id, school_name: 'Meera Bagh' }))),
}));

const { buildHomeSummary } = await import('../src/services/home.js');

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

function build() {
  return buildHomeSummary({
    session: SESSION,
    schoolIds: ['stmarksmb'],
    correlationId: 'corr-1',
  });
}

/**
 * Home only ever emits KPI widgets, but the chart-spec union is wider (bar,
 * line, donut, table). Narrowing here rather than casting keeps the assertions
 * honest: if Home ever emits a chart, these tests stop compiling instead of
 * quietly asserting nothing.
 */
function kpis(spec: { widgets: { type: string }[] }) {
  return spec.widgets.filter(
    (w): w is { type: 'kpi'; id: string; label: string; value: string } => w.type === 'kpi',
  );
}

beforeEach(() => {
  queue = [];
});

describe('a metric that could not be read is never rendered as a number', () => {
  it('reports a refused metric as blocked rather than zero', async () => {
    queue = [
      refused('PERMISSION_DENIED', 'This session does not have access to students data.'),
      refused('PERMISSION_DENIED', 'This session does not have access to staff data.'),
      ok([{ ay: '2026-27', n: 1940000 }]),
      refused('PERMISSION_DENIED', 'This session does not have access to students data.'),
    ];

    const summary = await build();

    // The bug: these used to appear as KPI tiles reading "0".
    const labels = kpis(summary.spec).map((w) => w.label);
    expect(labels).not.toContain('Staff on roll');
    expect(labels.some((l) => l.startsWith('Students'))).toBe(false);
    expect(kpis(summary.spec).map((w) => w.value)).not.toContain('0');

    const blocked = summary.blocked_metrics.map((b) => b.label);
    expect(blocked).toContain('Students');
    expect(blocked).toContain('Staff on roll');
    expect(summary.blocked_metrics).toSatisfy((entries: { kind: string }[]) =>
      entries.every((e) => e.kind === 'not_permitted'),
    );
  });

  it('still serves the metrics the session CAN read', async () => {
    queue = [
      refused('PERMISSION_DENIED', 'no students'),
      refused('PERMISSION_DENIED', 'no staff'),
      ok([{ ay: '2026-27', n: 1940000 }]),
      refused('PERMISSION_DENIED', 'no students'),
    ];

    const summary = await build();
    const fees = kpis(summary.spec).find((w) => w.label === 'Fees outstanding');
    expect(fees).toBeDefined();
    expect(fees?.value).toBe('₹19.4L');
  });

  it('does not lose an unrelated metric when the year source is refused', async () => {
    /**
     * The second half of the same bug: the academic year was derived only from
     * the students result, so a session without `students.read` had no year —
     * and the FEES figure, which was readable, silently became 0 because no row
     * matched a null year. One missing permission corrupted an unrelated number.
     */
    queue = [
      refused('PERMISSION_DENIED', 'no students'),
      refused('PERMISSION_DENIED', 'no staff'),
      ok([
        { ay: '2025-26', n: 100 },
        { ay: '2026-27', n: 1940000 },
      ]),
      refused('PERMISSION_DENIED', 'no students'),
    ];

    const summary = await build();
    expect(summary.academic_year).toBe('2026-27');
    const fees = kpis(summary.spec).find((w) => w.label === 'Fees outstanding');
    expect(fees?.value).toBe('₹19.4L');
  });

  it('does not report a permission refusal as an unreachable school', async () => {
    queue = [
      refused('PERMISSION_DENIED', 'no students'),
      refused('PERMISSION_DENIED', 'no staff'),
      ok([{ ay: '2026-27', n: 500000 }]),
      refused('PERMISSION_DENIED', 'no students'),
    ];

    const summary = await build();
    // A refusal says nothing about replica health; calling it "could not be
    // reached" sends an accountant chasing an outage that does not exist.
    expect(summary.degraded_schools).toEqual([]);
  });

  it('DOES report a genuinely unreachable school', async () => {
    queue = [
      ok([{ ay: '2026-27', n: 3929 }]),
      ok([{ n: 228 }]),
      refused('TENANT_UNAVAILABLE', 'The query could not be completed against this school right now.'),
      ok([{ ym: '2026-07', marked: 100, present: 92 }]),
    ];

    const summary = await build();
    expect(summary.degraded_schools).toHaveLength(1);
    expect(summary.degraded_schools[0]?.school_id).toBe('stmarksmb');
  });

  it('fails loudly when the session may read nothing at all', async () => {
    queue = [
      refused('PERMISSION_DENIED', 'no students'),
      refused('PERMISSION_DENIED', 'no staff'),
      refused('PERMISSION_DENIED', 'no fees'),
      refused('PERMISSION_DENIED', 'no students'),
    ];

    // An empty page would look like an outage. A 403 says what is actually true.
    await expect(build()).rejects.toBeInstanceOf(PlatformError);
    await expect(build()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('the summary reports what it actually served', () => {
  it('builds real KPIs and labels the serving tier honestly', async () => {
    queue = [
      ok([
        { ay: '2025-26', n: 3886 },
        { ay: '2026-27', n: 3929 },
      ]),
      ok([{ n: 228 }]),
      ok([{ ay: '2026-27', n: 194_000_000 }]),
      ok([{ ym: '2026-07', marked: 84_000, present: 78_120 }]),
    ];

    const summary = await build();

    expect(summary.academic_year).toBe('2026-27');
    expect(kpis(summary.spec).map((w) => w.value)).toEqual([
      '3,929',
      '228',
      '₹19.4Cr',
      '93.0%',
    ]);
    // No Redis and no rollup store exist in this build, so claiming either would
    // be a lie the logic panel would repeat (ADR-028, docs/03 §4).
    expect(summary.spec.meta.served_from).toBe('replica');
  });

  /**
   * Attendance arrived on 2026-08-21 and these three cases replace the single
   * assertion that it never could. They are the three states the tile has, and
   * the point of testing all three is that the last two must not look alike: a
   * session that MAY NOT read attendance and a school that has NOT MARKED it
   * are different problems with different owners, and the screen has to say
   * which one it is.
   */
  it('labels the attendance tile with the month it actually covers', async () => {
    queue = [
      ok([{ ay: '2026-27', n: 10 }]),
      ok([{ n: 2 }]),
      ok([{ ay: '2026-27', n: 5 }]),
      /**
       * Two months present, and the tile must take the later one. It is the
       * LATEST MONTH IN THE DATA rather than the current calendar month, so a
       * school that stopped marking in June shows June labelled June instead of
       * an empty tile for August that reads as an outage.
       */
      ok([
        { ym: '2026-06', marked: 200, present: 100 },
        { ym: '2026-07', marked: 100, present: 81 },
      ]),
    ];
    const summary = await build();
    const tile = kpis(summary.spec).find((w) => w.id === 'kpi-attendance');
    expect(tile?.label).toBe('Student attendance · Jul 2026');
    expect(tile?.value).toBe('81.0%');
    expect(summary.blocked_metrics.map((b) => b.label)).not.toContain('Student attendance');
  });

  it('says nobody marked the register rather than showing 0%', async () => {
    queue = [
      ok([{ ay: '2026-27', n: 10 }]),
      ok([{ n: 2 }]),
      ok([{ ay: '2026-27', n: 5 }]),
      ok([]),
    ];
    const summary = await build();

    // 0% attendance is a claim that every child was absent. Nobody claimed it.
    expect(kpis(summary.spec).map((w) => w.value)).not.toContain('0.0%');
    expect(summary.blocked_metrics).toContainEqual({
      label: 'Student attendance',
      reason: 'No attendance has been marked for these schools in the last three months',
      kind: 'no_data',
    });
  });

  it('separates a refusal from an empty register', async () => {
    queue = [
      ok([{ ay: '2026-27', n: 10 }]),
      ok([{ n: 2 }]),
      ok([{ ay: '2026-27', n: 5 }]),
      refused('PERMISSION_DENIED', 'This session does not have access to students data.'),
    ];
    const summary = await build();
    const entry = summary.blocked_metrics.find((b) => b.label === 'Student attendance');

    // `not_permitted` means a different token would see it; `no_data` does not.
    expect(entry?.kind).toBe('not_permitted');
    expect(summary.degraded_schools).toEqual([]);
  });
});
