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

/**
 * A fan-out that several schools answered — rows already tagged with their own
 * `school_id`, exactly as `run_multi` returns them (ADR-011, tools/run-multi.ts).
 *
 * Needed because the single-school `ok()` above cannot express the case the
 * `partial_metrics` tests are about: schools whose data reaches DIFFERENT
 * academic years, which is what a trust mid-rollover actually looks like.
 */
function okMulti(rows: (Record<string, unknown> & { school_id: string })[]) {
  const schoolIds = [...new Set(rows.map((r) => r.school_id))];
  return {
    rows,
    columns: Object.keys(rows[0] ?? {}),
    truncated: false,
    masked_columns: [],
    per_school: schoolIds.map((school_id) => ({
      school_id,
      status: 'ok',
      rows: rows.filter((r) => r.school_id === school_id).length,
    })) as SchoolStatus[],
    schools_succeeded: schoolIds.length,
    schools_failed: 0,
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

/**
 * Distinct names per school, not one name for all of them.
 *
 * It used to answer "Meera Bagh" for every id. That was harmless while nothing
 * asserted on a name and quietly dangerous the moment something did — a test
 * checking that the right school is named passes against ANY school when every
 * school has the same name. `stmarksmb` keeps its name so the single-school
 * cases below read as they did.
 */
vi.mock('../src/db/registry.js', () => ({
  schoolNames: (ids: readonly string[]) =>
    Promise.resolve(
      ids.map((id) => ({
        school_id: id,
        school_name:
          { stmarksg: 'World School', stmarksj: 'Janakpuri', stmarksmb: 'Meera Bagh' }[id] ?? id,
      })),
    ),
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
    (
      w,
    ): w is {
      type: 'kpi';
      id: string;
      label: string;
      value: string;
      tone?: string;
      breakdown?: { label: string; value: string; tone?: string }[];
    } => w.type === 'kpi',
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
      ok([{ ay: '2026-27', payable: 5000000, paid: 3060000, n: 1940000 }]),
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
      ok([{ ay: '2026-27', payable: 5000000, paid: 3060000, n: 1940000 }]),
      refused('PERMISSION_DENIED', 'no students'),
    ];

    const summary = await build();
    const fees = kpis(summary.spec).find((w) => w.id === 'kpi-fees');
    expect(fees).toBeDefined();
    expect(fees?.label).toBe('Total fees · 2026-27');
    expect(fees?.value).toBe('₹50.0L');
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
        { ay: '2025-26', payable: 100, paid: 0, n: 100 },
        { ay: '2026-27', payable: 5000000, paid: 3060000, n: 1940000 },
      ]),
      refused('PERMISSION_DENIED', 'no students'),
    ];

    const summary = await build();
    expect(summary.academic_year).toBe('2026-27');
    const fees = kpis(summary.spec).find((w) => w.id === 'kpi-fees');
    expect(fees?.value).toBe('₹50.0L');
  });

  it('does not report a permission refusal as an unreachable school', async () => {
    queue = [
      refused('PERMISSION_DENIED', 'no students'),
      refused('PERMISSION_DENIED', 'no staff'),
      ok([{ ay: '2026-27', payable: 800000, paid: 300000, n: 500000 }]),
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
      ok([{ ay: '2026-27', payable: 194_000_000, paid: 160_000_000, n: 34_000_000 }]),
      ok([{ ym: '2026-07', marked: 84_000, present: 78_120 }]),
    ];

    const summary = await build();

    expect(summary.academic_year).toBe('2026-27');
    /**
     * The order IS the contract: docs/10 §2's summary cards read students,
     * staff, attendance, fees — and, since 2026-09-03, fee realisation — and
     * Home renders `spec.widgets` in the order the server emits them. A
     * reordering here would silently re-rank the screen, and since 2026-09-01
     * order is the ONLY ranking the strip has, the first tile having dropped its
     * double-width hero treatment (docs/10 §3).
     *
     * Realisation sits immediately after the fee tile because it is that tile's
     * two halves as a rate — 160 over 194 — and a reader meets the fraction
     * before the quotient.
     */
    expect(kpis(summary.spec).map((w) => w.value)).toEqual([
      '3,929',
      '228',
      '93.0%',
      '₹19.4Cr',
      '82.5%',
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
      ok([{ ay: '2026-27', payable: 10, paid: 5, n: 5 }]),
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
      ok([{ ay: '2026-27', payable: 10, paid: 5, n: 5 }]),
      ok([]),
    ];
    const summary = await build();

    // 0% attendance is a claim that every child was absent. Nobody claimed it.
    expect(kpis(summary.spec).map((w) => w.value)).not.toContain('0.0%');
    expect(summary.blocked_metrics).toContainEqual({
      label: 'Student attendance',
      // Names the YEAR, since 2026-09-03: the tile follows the topbar's academic
      // year rather than a rolling three-month window pinned to today, so "in
      // the last three months" no longer describes what was looked at.
      reason: 'No attendance has been marked for these schools in 2026-27',
      kind: 'no_data',
    });
  });

  /**
   * A year the statement never reached is reported as exactly that.
   *
   * `attendanceByMonth` fetches the current academic year and the one before it
   * and no further (a cost decision — Home is the screen every user loads). For
   * anything older the truthful answer is that the tile did not look, and
   * claiming "nothing was marked" on the strength of a query that never covered
   * the year would be asserting a fact this service does not have — the same
   * error as summing an absent year into a confident zero.
   */
  it('does not claim an empty register for a year it never queried', async () => {
    queue = [
      ok([{ ay: '2019-20', n: 10 }]),
      ok([{ n: 2 }]),
      ok([{ ay: '2019-20', payable: 10, paid: 5, n: 5 }]),
      ok([]),
    ];
    const summary = await build();

    const attendance = summary.blocked_metrics.find((b) => b.label === 'Student attendance');
    expect(attendance?.reason).toContain('current and previous academic year');
    expect(attendance?.reason).not.toContain('No attendance has been marked');
  });

  it('separates a refusal from an empty register', async () => {
    queue = [
      ok([{ ay: '2026-27', n: 10 }]),
      ok([{ n: 2 }]),
      ok([{ ay: '2026-27', payable: 10, paid: 5, n: 5 }]),
      refused('PERMISSION_DENIED', 'This session does not have access to students data.'),
    ];
    const summary = await build();
    const entry = summary.blocked_metrics.find((b) => b.label === 'Student attendance');

    // `not_permitted` means a different token would see it; `no_data` does not.
    expect(entry?.kind).toBe('not_permitted');
    expect(summary.degraded_schools).toEqual([]);
  });
});

/**
 * The four summary cards each carry a breakdown of their own figure
 * (chart-spec `kpi.breakdown`). What is tested here is not the arithmetic but
 * the HONESTY rule the rest of this file is about, applied one level down: a
 * part must describe what the data actually said, and where the data cannot
 * say, the part must admit it rather than guess.
 */
describe('the summary cards break their figure down', () => {
  it('names the gender mix in the ERP’s own words, not a fixed pair', async () => {
    queue = [
      ok([
        { ay: '2026-27', gender: 'MALE', n: 2100 },
        { ay: '2026-27', gender: 'FEMALE', n: 1829 },
        // A previous year must not leak into this year's parts.
        { ay: '2025-26', gender: 'MALE', n: 9999 },
      ]),
      ok([{ stafftype: 'CONFIRMATION', n: 228 }]),
      ok([{ ay: '2026-27', payable: 10, paid: 5, n: 5 }]),
      ok([{ ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await build();
    const students = kpis(summary.spec).find((w) => w.id === 'kpi-students');

    expect(students?.value).toBe('3,929');
    expect(students?.breakdown).toEqual([
      { label: 'Male', value: '2,100' },
      { label: 'Female', value: '1,829' },
    ]);
  });

  it('reports a gender value it has never seen rather than folding it in', async () => {
    queue = [
      ok([
        { ay: '2026-27', gender: 'M', n: 10 },
        { ay: '2026-27', gender: 'F', n: 8 },
        { ay: '2026-27', gender: 'OTHER', n: 3 },
        { ay: '2026-27', gender: '', n: 1 },
      ]),
      ok([{ stafftype: 'CONFIRMATION', n: 2 }]),
      ok([{ ay: '2026-27', payable: 10, paid: 5, n: 5 }]),
      ok([{ ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await build();
    const students = kpis(summary.spec).find((w) => w.id === 'kpi-students');

    /**
     * Four categories, three parts allowed. The tail COLLAPSES into "Other"
     * rather than being dropped: the moment a category vanishes silently the
     * parts stop accounting for the total printed above them, and a reader
     * cannot see that it happened. 3 + 1 = 4.
     */
    expect(students?.breakdown).toEqual([
      { label: 'M', value: '10' },
      { label: 'F', value: '8' },
      { label: 'Other', value: '4' },
    ]);
  });

  it('splits staff by employment type and NAMES the ones it cannot classify', async () => {
    queue = [
      ok([{ ay: '2026-27', gender: 'MALE', n: 10 }]),
      ok([
        { stafftype: 'CONFIRMATION', n: 120 },
        { stafftype: 'CONTRACTUAL', n: 40 },
        { stafftype: 'PROBATION', n: 18 },
        // The opaque codes the real extract carries. No mapping exists.
        { stafftype: 'S0011', n: 35 },
        { stafftype: 'S004AD', n: 15 },
      ]),
      ok([{ ay: '2026-27', payable: 10, paid: 5, n: 5 }]),
      ok([{ ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await build();
    const staff = kpis(summary.spec).find((w) => w.id === 'kpi-staff');

    expect(staff?.value).toBe('228');
    /**
     * The 50 staff behind S0011/S004AD are neither guessed into a bucket nor
     * dropped. Guessing produces two authoritative-looking wrong numbers;
     * dropping makes the parts quietly fail to account for the 228 above them.
     * Naming them is the only option that stays true.
     */
    expect(staff?.breakdown).toEqual([
      { label: 'Permanent', value: '120' },
      { label: 'Not permanent', value: '58' },
      { label: 'Unclassified', value: '50' },
    ]);
  });

  it('shows no staff split at all when every type is an opaque code', async () => {
    queue = [
      ok([{ ay: '2026-27', gender: 'MALE', n: 10 }]),
      ok([
        { stafftype: 'S0011', n: 35 },
        { stafftype: 'S004AD', n: 15 },
      ]),
      ok([{ ay: '2026-27', payable: 10, paid: 5, n: 5 }]),
      ok([{ ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await build();
    const staff = kpis(summary.spec).find((w) => w.id === 'kpi-staff');

    // "Permanent 0 / Not permanent 0 / Unclassified 50" is not information.
    // The headcount stands alone rather than under three misleading parts.
    expect(staff?.value).toBe('50');
    expect(staff?.breakdown).toBeUndefined();
  });

  it('splits attendance into present and absent STUDENT-DAYS', async () => {
    queue = [
      ok([{ ay: '2026-27', gender: 'MALE', n: 10 }]),
      ok([{ stafftype: 'CONFIRMATION', n: 2 }]),
      ok([{ ay: '2026-27', payable: 10, paid: 5, n: 5 }]),
      ok([{ ym: '2026-07', marked: 84_000, present: 78_120 }]),
    ];

    const summary = await build();
    const tile = kpis(summary.spec).find((w) => w.id === 'kpi-attendance');

    /**
     * Labelled "days", because that is what they are. Under a tile reading
     * "Student attendance · Jul 2026", a part called "Present" would be read as
     * a headcount for today — off by the number of school days in the month.
     *
     * Absent is marked − present, so a day NOBODY marked is in neither part.
     * That is the same denominator the rate uses and the same caveat Attendance
     * Analytics carries.
     */
    expect(tile?.value).toBe('93.0%');
    expect(tile?.breakdown).toEqual([
      { label: 'Present days', value: '78,120' },
      { label: 'Absent days', value: '5,880' },
    ]);
  });

  it('leads fees with the demand and splits it into collected and pending', async () => {
    queue = [
      ok([{ ay: '2026-27', gender: 'MALE', n: 10 }]),
      ok([{ stafftype: 'CONFIRMATION', n: 2 }]),
      ok([{ ay: '2026-27', payable: 194_000_000, paid: 160_000_000, n: 34_000_000 }]),
      ok([{ ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await build();
    const fees = kpis(summary.spec).find((w) => w.id === 'kpi-fees');

    /**
     * The headline is the DEMAND, not the arrears it used to show. "₹3.4Cr
     * outstanding" alone is alarming against a small book and unremarkable
     * against a large one; the reader needs the book.
     */
    expect(fees?.value).toBe('₹19.4Cr');
    expect(fees?.breakdown).toEqual([
      { label: 'Collected', value: '₹16.0Cr', tone: 'positive' },
      { label: 'Pending', value: '₹3.4Cr', tone: 'warning' },
    ]);
    // Amber lives on the pending PART. On the tile it would never switch off,
    // and a signal that never varies is not a signal.
    expect(fees?.tone).toBe('neutral');
  });

  it('does not draw a breakdown from a single category', async () => {
    queue = [
      // One gender value: the "split" would restate the total under a second
      // label, which the schema refuses (`kpi.breakdown` requires two parts).
      ok([{ ay: '2026-27', gender: 'MALE', n: 3929 }]),
      ok([{ stafftype: 'CONFIRMATION', n: 2 }]),
      ok([{ ay: '2026-27', payable: 10, paid: 5, n: 5 }]),
      ok([{ ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await build();
    const students = kpis(summary.spec).find((w) => w.id === 'kpi-students');

    expect(students?.value).toBe('3,929');
    expect(students?.breakdown).toBeUndefined();
  });
});

/**
 * The years the topbar's academic-year control offers (`academic_years`).
 *
 * These exist because of a real report, and it is worth stating as plainly as
 * the students-read-as-zero bug at the top of this file. A development extract
 * held fee data for 2026-27 and a student roll that stopped at 2025-26. The
 * summary resolved the year from the roll — correctly — and the topbar printed
 * it as a read-only chip, so next year's ₹92Cr of demand was being served by the
 * API and was unreachable from the UI. Nobody could see it and nothing said why.
 *
 * The rule these pin down: the DEFAULT prefers the roll, and the OPTIONS are the
 * union, so a year that exists in either metric can always be reached.
 */
describe('the academic years offered', () => {
  it('offers every year either metric holds, newest first', async () => {
    queue = [
      ok([
        { ay: '2024-25', gender: 'Girl', n: 1800 },
        { ay: '2025-26', gender: 'Girl', n: 1900 },
      ]),
      ok([{ stafftype: 'CONFIRMATION', n: 2 }]),
      ok([
        { ay: '2025-26', payable: 100, paid: 90, n: 10 },
        { ay: '2026-27', payable: 200, paid: 20, n: 180 },
      ]),
      ok([{ ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await build();

    expect(summary.academic_years).toEqual(['2026-27', '2025-26', '2024-25']);
  });

  /**
   * The reported bug, as a test. A roll that has not rolled over must not hide
   * the year the fee book has already moved to.
   */
  it('offers a fee year the student roll has never heard of', async () => {
    queue = [
      ok([{ ay: '2025-26', gender: 'Girl', n: 1900 }]),
      ok([{ stafftype: 'CONFIRMATION', n: 2 }]),
      ok([
        { ay: '2025-26', payable: 100, paid: 99, n: 1 },
        { ay: '2026-27', payable: 200, paid: 20, n: 180 },
      ]),
      ok([{ ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await build();

    // The default still comes from the roll: a default is a claim about which
    // year the reader means, and demand raised in advance is weaker evidence.
    expect(summary.academic_year).toBe('2025-26');
    // ...but the fee year is reachable, which is the whole point.
    expect(summary.academic_years).toContain('2026-27');
  });

  /**
   * [MANDATORY] The control must never open showing a value that is not one of
   * its own options — a select whose current value is absent from its list
   * renders blank in every browser, which reads as "no year" on a page whose
   * every number depends on one.
   */
  it('always contains the year the summary resolved to', async () => {
    queue = [
      ok([{ ay: '2025-26', gender: 'Girl', n: 1900 }]),
      ok([{ stafftype: 'CONFIRMATION', n: 2 }]),
      ok([{ ay: '2026-27', payable: 200, paid: 20, n: 180 }]),
      ok([{ ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await build();

    expect(summary.academic_year).not.toBeNull();
    expect(summary.academic_years).toContain(summary.academic_year);
  });

  /**
   * A metric that was REFUSED contributes no years, for the same reason it
   * contributes no number: rows nobody was allowed to read are not evidence
   * about what the school holds.
   */
  it('ignores years from a metric that could not be read', async () => {
    queue = [
      refused('PERMISSION_DENIED', 'no students'),
      refused('PERMISSION_DENIED', 'no staff'),
      ok([{ ay: '2026-27', payable: 200, paid: 20, n: 180 }]),
      refused('PERMISSION_DENIED', 'no attendance'),
    ];

    const summary = await build();

    expect(summary.academic_years).toEqual(['2026-27']);
  });

  /**
   * Neither metric that CARRIES a year could be read, but staff could — so
   * there is a summary, and it has no year to resolve and none to offer.
   *
   * The staff statement groups by `stafftype` and not by academic year, which is
   * the point: a staff roll is a headcount as of now, not a fact about a year.
   * The Topbar renders the read-only chip in this case rather than an empty
   * select (`academicYears.length > 1`).
   *
   * Note this is the only way to reach an empty list. All four metrics refused
   * throws instead — there is no summary at all then, which is the honest answer
   * and is covered at the top of this file.
   */
  it('offers nothing when no metric that carries a year could be read', async () => {
    queue = [
      refused('PERMISSION_DENIED', 'no students'),
      ok([{ stafftype: 'CONFIRMATION', n: 2 }]),
      refused('PERMISSION_DENIED', 'no fees'),
      refused('PERMISSION_DENIED', 'no attendance'),
    ];

    const summary = await build();

    expect(summary.academic_year).toBeNull();
    expect(summary.academic_years).toEqual([]);
  });
});

/**
 * The strip follows the topbar's year.
 *
 * The grid's preview cards already took the year as a request parameter, so
 * before this the control moved the charts and left the tiles behind: next
 * year's charts under last year's totals, with nothing on screen saying the two
 * were about different years. Both look equally authoritative, which is what
 * makes it a trust bug rather than a cosmetic one.
 */
describe('a requested academic year', () => {
  const twoYears = () => [
    ok([
      { ay: '2025-26', gender: 'Girl', n: 1900 },
      { ay: '2026-27', gender: 'Girl', n: 2100 },
    ]),
    ok([{ stafftype: 'CONFIRMATION', n: 2 }]),
    ok([
      { ay: '2025-26', payable: 1000000, paid: 990000, n: 10000 },
      { ay: '2026-27', payable: 2000000, paid: 200000, n: 1800000 },
    ]),
    ok([{ ym: '2026-07', marked: 100, present: 81 }]),
  ];

  function buildFor(academicYear: string) {
    return buildHomeSummary({
      session: SESSION,
      schoolIds: ['stmarksmb'],
      academicYear,
      correlationId: 'corr-1',
    });
  }

  it('rebuilds every year-bearing tile for the year asked for', async () => {
    queue = twoYears();

    const summary = await buildFor('2025-26');

    expect(summary.academic_year).toBe('2025-26');
    expect(kpis(summary.spec).find((w) => w.id === 'kpi-fees')?.label).toBe('Total fees · 2025-26');
    expect(kpis(summary.spec).find((w) => w.id === 'kpi-fees')?.value).toBe('₹10.0L');
    expect(kpis(summary.spec).find((w) => w.id === 'kpi-students')?.value).toBe('1,900');
  });

  it('defaults to the derived year when none is asked for', async () => {
    queue = twoYears();

    const summary = await buildHomeSummary({
      session: SESSION,
      schoolIds: ['stmarksmb'],
      correlationId: 'corr-1',
    });

    expect(summary.academic_year).toBe('2026-27');
    expect(kpis(summary.spec).find((w) => w.id === 'kpi-students')?.value).toBe('2,100');
  });

  /**
   * [MANDATORY] The rule this whole file exists for, at a new entry point. A
   * year with no rows must never be summed into a confident `0` — the reader
   * would be told the school has no children, in the same typeface as every true
   * number beside it.
   */
  it('blocks a tile whose metric has nothing for the requested year', async () => {
    queue = [
      // The roll has not been rolled over; the fee book has.
      ok([{ ay: '2025-26', gender: 'Girl', n: 1900 }]),
      ok([{ stafftype: 'CONFIRMATION', n: 2 }]),
      ok([
        { ay: '2025-26', payable: 1000000, paid: 990000, n: 10000 },
        { ay: '2026-27', payable: 2000000, paid: 200000, n: 1800000 },
      ]),
      ok([{ ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await buildFor('2026-27');

    // The fee tile is the reason to be looking at 2026-27 at all.
    expect(kpis(summary.spec).find((w) => w.id === 'kpi-fees')?.value).toBe('₹20.0L');
    // The students tile says so instead of reading zero.
    expect(kpis(summary.spec).map((w) => w.id)).not.toContain('kpi-students');
    expect(kpis(summary.spec).map((w) => w.value)).not.toContain('0');
    const students = summary.blocked_metrics.find((b) => b.label === 'Students');
    expect(students?.kind).toBe('no_data');
    // The reason names the YEAR — "no students" alone reads as an outage.
    expect(students?.reason).toContain('2026-27');
  });

  /**
   * A year the data does not have at all — a stale bookmark, a hand-edited URL.
   * It falls back rather than rendering a strip of zeros, and says which year it
   * fell back to, so the control cannot end up showing a value it did not use.
   */
  it('falls back to the derived year when the requested one has no data', async () => {
    queue = twoYears();

    const summary = await buildFor('2011-12');

    expect(summary.academic_year).toBe('2026-27');
    expect(summary.academic_years).not.toContain('2011-12');
    expect(kpis(summary.spec).find((w) => w.id === 'kpi-students')?.value).toBe('2,100');
  });
});

/**
 * A total must never claim schools that contributed nothing to it.
 *
 * The reported bug, and the reason this is worth its own describe block: three
 * schools were selected, one had rolled its student roll over to 2025-26 and two
 * had not, the strip resolved to 2025-26 because that is the newest year ANY of
 * them had — and then printed "Students · 3 schools — 1,760" while 4,801
 * children in the other two schools contributed nothing at all.
 *
 * Nothing failed. No query was refused, no school was unreachable, no value was
 * null. The number was simply wrong by a factor of four, in the same typeface as
 * every true number beside it — CODING_GUIDELINES §10's worst class of bug, and
 * one that is invisible on any extract where the schools were rolled over
 * together.
 */
describe('a figure that covers only some of the selected schools', () => {
  const THREE = ['stmarksg', 'stmarksj', 'stmarksmb'];

  function buildThree(academicYear?: string) {
    return buildHomeSummary({
      session: { ...SESSION, school_ids: THREE, perms: ['fees.read', 'students.read'] },
      schoolIds: THREE,
      ...(academicYear === undefined ? {} : { academicYear }),
      correlationId: 'corr-1',
    });
  }

  /** One school rolled over, two not — the shape that produced the bug. */
  const unevenRollover = () => [
    okMulti([
      { school_id: 'stmarksj', ay: '2025-26', gender: 'Girl', n: 1760 },
      { school_id: 'stmarksg', ay: '2024-25', gender: 'Girl', n: 1297 },
      { school_id: 'stmarksmb', ay: '2024-25', gender: 'Girl', n: 3504 },
    ]),
    okMulti([{ school_id: 'stmarksj', stafftype: 'CONFIRMATION', n: 2 }]),
    okMulti([
      { school_id: 'stmarksj', ay: '2025-26', payable: 100, paid: 90, n: 10 },
      { school_id: 'stmarksg', ay: '2025-26', payable: 100, paid: 90, n: 10 },
      { school_id: 'stmarksmb', ay: '2025-26', payable: 100, paid: 90, n: 10 },
    ]),
    okMulti([{ school_id: 'stmarksj', ym: '2026-07', marked: 100, present: 81 }]),
  ];

  it('names the schools missing from the figure', async () => {
    queue = unevenRollover();

    const summary = await buildThree();

    expect(summary.academic_year).toBe('2025-26');
    const students = summary.partial_metrics.find((m) => m.label === 'Students');
    expect(students).toBeDefined();
    // Named, not counted — a director asking "which of my schools is in this?"
    // is not helped by "2".
    expect(students?.schools).toHaveLength(2);
  });

  /**
   * [MANDATORY] The tile has to be honest standing alone. It is what gets
   * screenshotted and quoted; a caveat above it does not travel with it.
   */
  it('does not let the tile claim three schools for a one-school figure', async () => {
    queue = unevenRollover();

    const summary = await buildThree();
    const students = kpis(summary.spec).find((w) => w.id === 'kpi-students');

    expect(students?.value).toBe('1,760');
    expect(students?.label).toBe('Students · 1 of 3 schools');
    expect(students?.label).not.toBe('Students · 3 schools');
  });

  /**
   * The metrics are annotated INDEPENDENTLY. A trust can have next year's fee
   * demand raised for every school while only one has enrolled its students,
   * which is exactly the fixture above — so the fee tile must carry no caveat.
   */
  it('says nothing about a metric every school does cover', async () => {
    queue = unevenRollover();

    const summary = await buildThree();

    expect(summary.partial_metrics.map((m) => m.label)).toEqual(['Students']);
  });

  it('says nothing at all when every school covers the year', async () => {
    queue = [
      okMulti([
        { school_id: 'stmarksj', ay: '2025-26', gender: 'Girl', n: 1760 },
        { school_id: 'stmarksg', ay: '2025-26', gender: 'Girl', n: 1297 },
        { school_id: 'stmarksmb', ay: '2025-26', gender: 'Girl', n: 3504 },
      ]),
      okMulti([{ school_id: 'stmarksj', stafftype: 'CONFIRMATION', n: 2 }]),
      okMulti([{ school_id: 'stmarksj', ay: '2025-26', payable: 100, paid: 90, n: 10 }]),
      okMulti([{ school_id: 'stmarksj', ym: '2026-07', marked: 100, present: 81 }]),
    ];

    const summary = await buildThree();
    const students = kpis(summary.spec).find((w) => w.id === 'kpi-students');

    expect(students?.value).toBe('6,561');
    expect(students?.label).toBe('Students · 3 schools');
    expect(summary.partial_metrics.filter((m) => m.label === 'Students')).toEqual([]);
  });

  /**
   * Picking the year the laggards DO have clears the caveat and moves it to
   * whichever metric is now short — the annotation follows the year on screen
   * rather than being a fixed property of the selection.
   */
  it('follows the year the reader picked', async () => {
    queue = unevenRollover();

    const summary = await buildThree('2024-25');

    expect(summary.academic_year).toBe('2024-25');
    const students = kpis(summary.spec).find((w) => w.id === 'kpi-students');
    expect(students?.value).toBe('4,801');
    expect(students?.label).toBe('Students · 2 of 3 schools');
    // The fee book is 2025-26 only, so at 2024-25 it is the one with nothing.
    expect(summary.blocked_metrics.map((b) => b.label)).toContain('Total fees');
  });
});
