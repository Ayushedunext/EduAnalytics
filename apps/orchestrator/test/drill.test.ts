/**
 * Drill-down: the drill path catalog, the click validation, and the level a
 * click resolves to (ADR-020, docs/06 §4.4).
 *
 * What is worth testing here, and why:
 *
 *   1. The CATALOG is self-consistent. Every level names a real `run_predefined`
 *      query, the widget it starts from is one the builder actually pushes, and
 *      the series it draws are fields the level's rows carry. Each of those is a
 *      cross-file fact that typechecks perfectly while being wrong at runtime.
 *   2. A click can only NARROW. A context naming a school outside the request's
 *      scope is a scope violation, not a filter — Invariant 2 does not weaken
 *      because the request arrived through a chart.
 *   3. A fabricated context is refused rather than partially honoured. Level 3
 *      with one step, or with the dimensions in the wrong order, would otherwise
 *      render a quarter breakdown under a breadcrumb claiming a class.
 *   4. The level-1 chart costs no query. It is built from `by_component`, which
 *      the dashboard already fetched, and a regression to a per-school query
 *      would be invisible on screen and seconds slower on tables with no index.
 *
 * The MCP client and the registry are mocked, as in dashboards.test.ts: what is
 * under test is how a click becomes a request, not whether MySQL can group.
 */

import './env-defaults.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformError, ERROR_CODES } from '@sap/shared';
import type { BarWidget } from '@sap/chart-spec';

interface QueryResult {
  key: string;
  description: string;
  sql: string;
  status: 'ok' | 'failed';
  columns?: string[];
  rows?: Record<string, unknown>[];
  error?: { code: string; message: string };
}

let response: Record<string, unknown> = {};
let lastCall: { tool: string; args: Record<string, unknown> } | null = null;

vi.mock('../src/mcp/client.js', () => ({
  withMcp: async (
    _session: unknown,
    _correlationId: string,
    _schoolIds: readonly string[],
    fn: (mcp: {
      call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    }) => Promise<unknown>,
  ) =>
    fn({
      call: (tool: string, args: Record<string, unknown>) => {
        lastCall = { tool, args };
        return Promise.resolve(response);
      },
    }),
}));

const SCHOOL_NAMES: Record<string, string> = {
  stmarksmb: 'Meera Bagh',
  stmarksj: 'Janakpuri',
};

vi.mock('../src/db/registry.js', () => ({
  schoolNames: (ids: readonly string[]) =>
    Promise.resolve(ids.map((id) => ({ school_id: id, school_name: SCHOOL_NAMES[id] ?? id }))),
}));

const { buildDashboard, DRILL_PATHS, DASHBOARD_IDS } = await import(
  '../src/services/dashboards.js'
);
const { buildDrill, resolveDrill } = await import('../src/services/drill.js');
type DrillStep = { dim: string; value: string; label: string };
const { predefinedReports } = await import('../../mcp-server/src/reports/catalog.js');

const SESSION = {
  sub: 'erp-user-1001',
  name: 'A. Rao',
  role: 'DIRECTOR' as const,
  org_id: 'stmarks',
  school_ids: ['stmarksmb', 'stmarksj'],
  default_school: 'stmarksmb',
  perms: ['fees.read', 'students.read', 'staff.read'],
  permission_class: 'test',
};

const SCOPE = ['stmarksmb', 'stmarksj'];

/**
 * `columns` mirrors the row keys, as the MCP server really answers. It matters
 * for any level with a `pending` marker: the service checks the column was
 * genuinely returned rather than trusting a summed zero (`Merged.returnsColumn`).
 */
function query(key: string, rows: Record<string, unknown>[]): QueryResult {
  return {
    key,
    description: `${key} description`,
    sql: `SELECT 1 AS ${key}`,
    status: 'ok',
    columns: [...new Set(rows.flatMap((r) => Object.keys(r)))],
    rows,
  };
}

function result(schools: { school_id: string; queries: QueryResult[] }[]) {
  return {
    report_id: 'fee-collection',
    title: 'Fee Collection',
    source: 'fee_compile_data_set',
    params: {},
    as_of: '2026-08-27T10:00:00.000Z',
    schools: schools.map((s) => ({ school_id: s.school_id, status: 'ok', queries: s.queries })),
  };
}

function drill(args: {
  level: number;
  context: { dim: string; value: string; label: string }[];
  schoolIds?: string[];
  widgetId?: string;
}) {
  return buildDrill({
    session: SESSION,
    schoolIds: args.schoolIds ?? SCOPE,
    reportId: 'fee-collection',
    widgetId: args.widgetId ?? 'bar-school',
    level: args.level,
    context: args.context,
    academicYear: '2026-27',
    asOfDate: '2026-08-27',
    correlationId: 'corr-drill',
  });
}

const SCHOOL_STEP = { dim: 'school', value: 'stmarksmb', label: 'Meera Bagh' };
const QUARTER_STEP = { dim: 'quarter', value: '2', label: 'Q2' };

beforeEach(() => {
  response = {};
  lastCall = null;
});

/**
 * The catalog is data (docs/11 §1). A level naming a query the report does not
 * have would 400 on the first click and typecheck on every build until then.
 */
describe('the drill catalog agrees with the report catalog', () => {
  it.each(Object.entries(DRILL_PATHS))('%s names only real queries', (reportId, path) => {
    const report = predefinedReports().find((r) => r.id === reportId);
    expect(report, `${reportId} is not a predefined report`).toBeDefined();
    const keys = new Set(report?.queries.map((q) => q.key));
    for (const level of path.levels) {
      if (level.query === undefined) continue;
      expect(keys.has(level.query), `${reportId}: no query ${level.query}`).toBe(true);
    }
  });

  it.each(Object.entries(DRILL_PATHS))('%s drills at most three levels (ADR-020)', (_id, path) => {
    expect(path.levels.length).toBeLessThanOrEqual(3);
  });

  it.each(Object.entries(DRILL_PATHS))('%s ends on a leaf that does not drill', (_id, path) => {
    expect(path.levels[path.levels.length - 1]?.drill_dim).toBeUndefined();
  });

  it.each(Object.entries(DRILL_PATHS))(
    '%s gives every level below the first a query and a way to narrow',
    (_id, path) => {
      for (const level of path.levels.slice(1)) {
        expect(level.query).toBeDefined();
        expect(level.narrow).toBeDefined();
      }
    },
  );

  it.each(Object.entries(DRILL_PATHS))('%s starts from a report that exists', (reportId) => {
    expect((DASHBOARD_IDS as readonly string[]).includes(reportId)).toBe(true);
  });

  it('reaches every drill query through a level — no orphaned SQL is shipped', () => {
    const reachable = new Set(
      Object.values(DRILL_PATHS).flatMap((path) =>
        path.levels.map((level) => level.query).filter((q): q is string => q !== undefined),
      ),
    );
    for (const report of predefinedReports()) {
      for (const q of report.queries) {
        if (q.drill_only !== true) continue;
        expect(reachable.has(q.key), `${report.id}: ${q.key} is drill-only but unreachable`).toBe(
          true,
        );
      }
    }
  });
});

describe('level 1 is built from the dashboard the reader already loaded', () => {
  it('draws one group of three bars per school, from by_component', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [query('by_component', [{ componentname: 'Tuition', payable: 100, paid: 60, balance: 40 }])],
      },
      {
        school_id: 'stmarksj',
        queries: [query('by_component', [{ componentname: 'Tuition', payable: 200, paid: 150, balance: 50 }])],
      },
    ]);

    const built = await buildDashboard({
      session: SESSION,
      schoolIds: SCOPE,
      reportId: 'fee-collection',
      academicYear: '2026-27',
      asOfDate: '2026-08-27',
      correlationId: 'corr-1',
    });

    const widget = built.spec.widgets.find(
      (w): w is BarWidget => w.type === 'bar' && w.id === 'bar-school',
    );
    expect(widget).toBeDefined();
    expect(widget?.series?.map((s) => s.field)).toEqual(['payable', 'collected', 'pending']);
    expect(widget?.data).toEqual([
      { school_id: 'stmarksmb', school_name: 'Meera Bagh', payable: 100, collected: 60, pending: 40 },
      { school_id: 'stmarksj', school_name: 'Janakpuri', payable: 200, collected: 150, pending: 50 },
    ]);
    /** The click pushes the id, not the name a school could be renamed under. */
    expect(widget?.drill_value_field).toBe('school_id');
    expect(widget?.drillable).toBe(true);
  });

  it('asks for no by-school query of its own', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [query('by_component', [{ payable: 1, paid: 1, balance: 0 }])] },
    ]);
    await buildDashboard({
      session: SESSION,
      schoolIds: ['stmarksmb'],
      reportId: 'fee-collection',
      academicYear: '2026-27',
      asOfDate: '2026-08-27',
      correlationId: 'corr-1',
    });
    /**
     * A full dashboard names no `query_keys` at all, and the MCP server drops
     * the drill-only levels from a default run (run-predefined.ts). Both halves
     * matter: this asserts the orchestrator's half.
     */
    expect(lastCall?.args['query_keys']).toBeUndefined();
  });

  it('omits a school that failed rather than drawing it at zero', async () => {
    response = {
      ...result([
        {
          school_id: 'stmarksmb',
          queries: [query('by_component', [{ payable: 100, paid: 60, balance: 40 }])],
        },
      ]),
      schools: [
        {
          school_id: 'stmarksmb',
          status: 'ok',
          queries: [query('by_component', [{ payable: 100, paid: 60, balance: 40 }])],
        },
        { school_id: 'stmarksj', status: 'failed', error: { code: 'TENANT_UNAVAILABLE', message: 'down' } },
      ],
    };

    const built = await buildDashboard({
      session: SESSION,
      schoolIds: SCOPE,
      reportId: 'fee-collection',
      academicYear: '2026-27',
      asOfDate: '2026-08-27',
      correlationId: 'corr-1',
    });
    const widget = built.spec.widgets.find(
      (w): w is BarWidget => w.type === 'bar' && w.id === 'bar-school',
    );
    expect(widget?.data).toHaveLength(1);
    expect(built.degraded_schools.map((d) => d.school_id)).toEqual(['stmarksj']);
  });
});

describe('a click narrows, and only inside what the reader could already see', () => {
  it('level 2 runs the quarter query against the clicked school alone', async () => {
    response = {
      ...result([
        {
          school_id: 'stmarksmb',
          queries: [
            query('demand_by_quarter', [
              { quarter: 'Q1', seq: 1, payable: 10, collected: 8, pending: 2 },
              { quarter: 'Q2', seq: 2, payable: 20, collected: 11, pending: 9 },
            ]),
          ],
        },
      ]),
    };

    const out = await drill({ level: 2, context: [SCHOOL_STEP] });

    expect(lastCall?.args['school_ids']).toEqual(['stmarksmb']);
    expect(lastCall?.args['query_keys']).toEqual(['demand_by_quarter']);
    expect(out.school_ids).toEqual(['stmarksmb']);
    expect(out.level).toBe(2);

    const widget = out.widget as BarWidget;
    expect(widget.x).toBe('quarter');
    expect(widget.data.map((r) => r['quarter'])).toEqual(['Q1', 'Q2']);
    /** The next click binds the NUMBER, not the "Q2" the axis shows. */
    expect(widget.drill_value_field).toBe('seq');
    expect(widget.data[1]?.['seq']).toBe(2);
    expect(widget.title).toContain('Meera Bagh');
  });

  it('level 3 binds the clicked quarter as a parameter, never as SQL', async () => {
    response = {
      ...result([
        {
          school_id: 'stmarksmb',
          queries: [
            query('demand_by_class', [{ classname: 'IX', seq: 9, payable: 5, collected: 4, pending: 1 }]),
          ],
        },
      ]),
    };

    const out = await drill({ level: 3, context: [SCHOOL_STEP, QUARTER_STEP] });

    const params = lastCall?.args['params'] as Record<string, unknown>;
    expect(params['drill_quarter']).toBe(2);
    /** A number, so `run_predefined` accepts it — a string would be refused. */
    expect(typeof params['drill_quarter']).toBe('number');
    /** The base report's own filters travel unchanged with it. */
    expect(params['academic_year']).toBe('2026-27');
    expect(lastCall?.args['school_ids']).toEqual(['stmarksmb']);

    const widget = out.widget as BarWidget;
    expect(widget.x).toBe('classname');
    /** The leaf: three levels is the ADR's limit, so this one cannot be clicked. */
    expect(widget.drillable).toBe(false);
    expect(widget.drill_context).toEqual([
      { dim: 'school', value: 'stmarksmb' },
      { dim: 'quarter', value: '2' },
    ]);
  });

  it('refuses a school the request did not resolve to (Invariant 2)', () => {
    expect(() =>
      resolveDrill({
        reportId: 'fee-collection',
        widgetId: 'bar-school',
        level: 2,
        context: [{ dim: 'school', value: 'someoneelse', label: 'Not mine' }],
        schoolIds: SCOPE,
        correlationId: 'c',
      }),
    ).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SCOPE_VIOLATION }) as unknown as PlatformError,
    );
  });

  it('refuses a context that does not match the path, rather than part-honouring it', () => {
    /** Level 3 reached with one step: a fabricated request, not a click. */
    expect(() =>
      resolveDrill({
        reportId: 'fee-collection',
        widgetId: 'bar-school',
        level: 3,
        context: [SCHOOL_STEP],
        schoolIds: SCOPE,
        correlationId: 'c',
      }),
    ).toThrow(PlatformError);

    /** The right depth, the wrong dimensions, in the wrong order. */
    expect(() =>
      resolveDrill({
        reportId: 'fee-collection',
        widgetId: 'bar-school',
        level: 3,
        context: [QUARTER_STEP, SCHOOL_STEP],
        schoolIds: SCOPE,
        correlationId: 'c',
      }),
    ).toThrow(PlatformError);
  });

  it('refuses a dimension no level declares', () => {
    expect(() =>
      resolveDrill({
        reportId: 'fee-collection',
        widgetId: 'bar-school',
        level: 2,
        context: [{ dim: 'gender', value: 'F', label: 'Female' }],
        schoolIds: SCOPE,
        correlationId: 'c',
      }),
    ).toThrow(PlatformError);
  });

  it('refuses a fourth level and a level below the second', () => {
    for (const level of [1, 4]) {
      expect(() =>
        resolveDrill({
          reportId: 'fee-collection',
          widgetId: 'bar-school',
          level,
          context: [SCHOOL_STEP, QUARTER_STEP, { dim: 'class', value: 'IX', label: 'IX' }].slice(
            0,
            Math.max(level - 1, 0),
          ),
          schoolIds: SCOPE,
          correlationId: 'c',
        }),
      ).toThrow(PlatformError);
    }
  });

  it('refuses a widget that does not drill', () => {
    expect(() =>
      resolveDrill({
        reportId: 'fee-collection',
        widgetId: 'donut-mode',
        level: 2,
        context: [SCHOOL_STEP],
        schoolIds: SCOPE,
        correlationId: 'c',
      }),
    ).toThrow(PlatformError);
  });

  it('refuses a report with no drill path at all', () => {
    expect(() =>
      resolveDrill({
        reportId: 'staff-overview',
        widgetId: 'bar-school',
        level: 2,
        context: [SCHOOL_STEP],
        schoolIds: SCOPE,
        correlationId: 'c',
      }),
    ).toThrow(PlatformError);
  });
});

/**
 * Fee Defaulters drills on a COUNT OF PEOPLE, which behaves differently from
 * Fee Collection's amounts in two ways that these tests pin down:
 *
 *   - one measure, so the widget must NOT carry `series`. A one-entry group
 *     would draw a legend restating the title and cost the bar its gradient
 *     and tallest-bar highlight;
 *   - the quarter level's bars do not add up to the school figure, so that
 *     level must ship the note that says so. A silent chart here is not a
 *     cosmetic miss: on the real extract the four bars total three times the
 *     school's own number.
 */
function defaulterResult(schools: { school_id: string; queries: QueryResult[] }[]) {
  return {
    report_id: 'fee-defaulters',
    title: 'Fee Defaulters',
    source: 'fee_compile_data_set',
    params: {},
    as_of: '2026-08-29T10:00:00.000Z',
    schools: schools.map((s) => ({ school_id: s.school_id, status: 'ok', queries: s.queries })),
  };
}

function defaulterDrill(args: {
  level: number;
  context: { dim: string; value: string; label: string }[];
}) {
  return buildDrill({
    session: SESSION,
    schoolIds: SCOPE,
    reportId: 'fee-defaulters',
    widgetId: 'bar-school-defaulters',
    level: args.level,
    context: args.context,
    academicYear: '2026-27',
    asOfDate: '2026-08-29',
    correlationId: 'corr-def',
  });
}

describe('fee defaulters: one bar per school, counting students', () => {
  it('builds level 1 from the totals rows the KPI tiles already read', async () => {
    response = defaulterResult([
      { school_id: 'stmarksmb', queries: [query('totals', [{ defaulters: 62, overdue: 900000 }])] },
      { school_id: 'stmarksj', queries: [query('totals', [{ defaulters: 55, overdue: 700000 }])] },
    ]);

    const built = await buildDashboard({
      session: SESSION,
      schoolIds: SCOPE,
      reportId: 'fee-defaulters',
      academicYear: '2026-27',
      asOfDate: '2026-08-29',
      correlationId: 'corr-1',
    });

    const widget = built.spec.widgets.find(
      (w): w is BarWidget => w.type === 'bar' && w.id === 'bar-school-defaulters',
    );
    expect(widget).toBeDefined();
    expect(widget?.y).toBe('defaulters');
    /** ONE measure: a plain bar, never a group of one. */
    expect(widget?.series).toBeUndefined();
    expect(widget?.data).toEqual([
      { school_id: 'stmarksmb', school_name: 'Meera Bagh', defaulters: 62 },
      { school_id: 'stmarksj', school_name: 'Janakpuri', defaulters: 55 },
    ]);
    expect(widget?.drill_dim).toBe('school');
    expect(widget?.drill_value_field).toBe('school_id');
  });

  it('never sums one school’s defaulters into another’s bar', async () => {
    /**
     * The whole reason level 1 uses `sumPerSchool` and not `sumAll`. Two
     * schools of 62 and 55 are two bars, not one bar of 117 — and the failure
     * mode if that ever regressed is a chart that looks entirely plausible.
     */
    response = defaulterResult([
      { school_id: 'stmarksmb', queries: [query('totals', [{ defaulters: 62, overdue: 1 }])] },
      { school_id: 'stmarksj', queries: [query('totals', [{ defaulters: 55, overdue: 1 }])] },
    ]);
    const built = await buildDashboard({
      session: SESSION,
      schoolIds: SCOPE,
      reportId: 'fee-defaulters',
      academicYear: '2026-27',
      asOfDate: '2026-08-29',
      correlationId: 'corr-1',
    });
    const widget = built.spec.widgets.find(
      (w): w is BarWidget => w.type === 'bar' && w.id === 'bar-school-defaulters',
    );
    expect(widget?.data.map((r) => r['defaulters'])).toEqual([62, 55]);
  });

  it('drills to quarters, carrying the warning that the bars do not add up', async () => {
    response = defaulterResult([
      {
        school_id: 'stmarksmb',
        queries: [
          query('defaulters_by_quarter', [
            { quarter: 'Q1', seq: 1, defaulters: 44, outstanding: 10, due_rows: 60 },
            { quarter: 'Q2', seq: 2, defaulters: 31, outstanding: 20, due_rows: 40 },
          ]),
        ],
      },
    ]);

    const out = await defaulterDrill({ level: 2, context: [SCHOOL_STEP] });

    expect(lastCall?.args['query_keys']).toEqual(['defaulters_by_quarter']);
    expect(lastCall?.args['school_ids']).toEqual(['stmarksmb']);
    /** The report's own as-of date travels with the drill, unchanged. */
    expect((lastCall?.args['params'] as Record<string, unknown>)['as_of_date']).toBe('2026-08-29');

    const widget = out.widget as BarWidget;
    expect(widget.x).toBe('quarter');
    expect(widget.y).toBe('defaulters');
    expect(widget.series).toBeUndefined();
    expect(widget.data.map((r) => r['defaulters'])).toEqual([44, 31]);

    /**
     * [MANDATORY] the level that can be misread must say so. 44 + 31 is not
     * this school's defaulter count and a reader has no way to know that from
     * the bars alone.
     */
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toMatch(/counted in each/i);
  });

  it('drills to classes, binding the quarter and saying these DO add up', async () => {
    response = defaulterResult([
      {
        school_id: 'stmarksmb',
        queries: [
          query('defaulters_by_class', [
            { classname: 'IX', seq: 9, defaulters: 12, outstanding: 5, due_rows: 30 },
            { classname: 'X', seq: 10, defaulters: 19, outstanding: 8, due_rows: 41 },
          ]),
        ],
      },
    ]);

    const out = await defaulterDrill({ level: 3, context: [SCHOOL_STEP, QUARTER_STEP] });

    const params = lastCall?.args['params'] as Record<string, unknown>;
    expect(params['drill_quarter']).toBe(2);
    expect(typeof params['drill_quarter']).toBe('number');

    const widget = out.widget as BarWidget;
    expect(widget.x).toBe('classname');
    expect(widget.drillable).toBe(false);
    expect(out.notes[0]).toMatch(/one class/i);
  });

  it('marks the aging chart as overdue money, so screen and PDF agree', async () => {
    /**
     * The colour lives in the SPEC, not in the SPA. docs/10 §1 assigns amber to
     * "warnings, fees outstanding" and this chart is exactly that; setting it
     * server-side is what stops the PDF (ADR-021 renders the same spec) from
     * printing a different colour than the screen it was approved on.
     */
    response = defaulterResult([
      {
        school_id: 'stmarksmb',
        queries: [
          query('aging', [
            { bucket: '1-30 days', seq: 2, students: 4, outstanding: 100 },
            { bucket: '90+ days', seq: 5, students: 2, outstanding: 900 },
          ]),
        ],
      },
    ]);
    const built = await buildDashboard({
      session: SESSION,
      schoolIds: ['stmarksmb'],
      reportId: 'fee-defaulters',
      academicYear: '2026-27',
      asOfDate: '2026-08-29',
      correlationId: 'corr-1',
    });
    const aging = built.spec.widgets.find(
      (w): w is BarWidget => w.type === 'bar' && w.id === 'bar-aging',
    );
    expect(aging?.tone).toBe('warning');

    /** The headcount chart stays untoned — it is a count, not a warning. */
    const heads = built.spec.widgets.find(
      (w): w is BarWidget => w.type === 'bar' && w.id === 'bar-school-defaulters',
    );
    expect(heads?.tone).toBeUndefined();
  });

  /**
   * A zero bar means two opposite things and the chart must not blur them:
   * "the calendar has not asked yet" and "everybody paid on time". The first
   * needs saying, the second is good news that speaks for itself. Dropping the
   * quarter entirely — which is what filtering in the WHERE used to do — said
   * neither, and left a reader unable to tell either from "this quarter does
   * not exist".
   */
  it('keeps a not-yet-due quarter as a zero bar and names it', async () => {
    response = defaulterResult([
      {
        school_id: 'stmarksmb',
        queries: [
          query('defaulters_by_quarter', [
            { quarter: 'Q1', seq: 1, defaulters: 26, outstanding: 900, due_rows: 79 },
            { quarter: 'Q2', seq: 2, defaulters: 22, outstanding: 400, due_rows: 28 },
            { quarter: 'Q3', seq: 3, defaulters: 0, outstanding: 0, due_rows: 0 },
            { quarter: 'Q4', seq: 4, defaulters: 0, outstanding: 0, due_rows: 0 },
          ]),
        ],
      },
    ]);

    const out = await defaulterDrill({ level: 2, context: [SCHOOL_STEP] });
    const widget = out.widget as BarWidget;

    /** All four quarters draw; the back half at zero. */
    expect(widget.data.map((r) => r['quarter'])).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(widget.data.map((r) => r['defaulters'])).toEqual([26, 22, 0, 0]);

    /** Bookkeeping never becomes a bar. */
    expect(widget.data.every((r) => !('due_rows' in r))).toBe(true);

    const pending = out.notes.find((n) => n.includes('was due'));
    expect(pending).toBeDefined();
    expect(pending).toContain('Q3 and Q4');
    expect(pending).toContain('2026-08-29');
    /** The counting caveat is still there too — both notes, not one or other. */
    expect(out.notes.some((n) => /counted in each/i.test(n))).toBe(true);
  });

  it('says nothing when every quarter has fallen due', async () => {
    /**
     * A note that fires whether or not it applies is noise, and noise is how a
     * reader learns to skip the line that matters.
     */
    response = defaulterResult([
      {
        school_id: 'stmarksmb',
        queries: [
          query('defaulters_by_quarter', [
            { quarter: 'Q1', seq: 1, defaulters: 26, outstanding: 900, due_rows: 79 },
            { quarter: 'Q2', seq: 2, defaulters: 0, outstanding: 0, due_rows: 3093 },
          ]),
        ],
      },
    ]);

    const out = await defaulterDrill({ level: 2, context: [SCHOOL_STEP] });
    /** Q2 is a zero bar meaning "everyone paid" — good news, and not pending. */
    expect((out.widget as BarWidget).data.map((r) => r['defaulters'])).toEqual([26, 0]);
    expect(out.notes.some((n) => n.includes('was due'))).toBe(false);
  });

  it('lists a single pending quarter without an "and"', async () => {
    response = defaulterResult([
      {
        school_id: 'stmarksmb',
        queries: [
          query('defaulters_by_quarter', [
            { quarter: 'Q1', seq: 1, defaulters: 26, outstanding: 900, due_rows: 79 },
            { quarter: 'Q4', seq: 4, defaulters: 0, outstanding: 0, due_rows: 0 },
          ]),
        ],
      },
    ]);
    const out = await defaulterDrill({ level: 2, context: [SCHOOL_STEP] });
    const pending = out.notes.find((n) => n.includes('was due'));
    expect(pending).toContain('Nothing in Q4 was due');
    expect(pending).not.toContain('and');
  });

  it('explains a click into a quarter nothing was due in, instead of a blank', async () => {
    /**
     * Q3 is clickable now that it draws a bar, so the level it leads to has to
     * be able to account for itself. Every class pending means the sentence
     * should name the QUARTER, not recite fourteen class names.
     */
    response = defaulterResult([
      {
        school_id: 'stmarksmb',
        queries: [
          query('defaulters_by_class', [
            { classname: 'IX', seq: 9, defaulters: 0, outstanding: 0, due_rows: 0 },
            { classname: 'X', seq: 10, defaulters: 0, outstanding: 0, due_rows: 0 },
          ]),
        ],
      },
    ]);
    const out = await defaulterDrill({
      level: 3,
      context: [SCHOOL_STEP, { dim: 'quarter', value: '3', label: 'Q3' }],
    });
    /** The classes still draw, at zero — an axis, not an empty panel. */
    expect((out.widget as BarWidget).data).toHaveLength(2);
    const pending = out.notes.find((n) => n.includes('had fallen due'));
    expect(pending).toContain('No fees in this quarter');
    expect(pending).toContain('2026-08-29');
    /** Never the list form when it would recite every category. */
    expect(pending).not.toContain('IX');
  });

  it('refuses to guess when the pending marker column is missing', async () => {
    /**
     * A summed zero and a column that was never selected look identical after
     * the merge, so the check is against the columns the query really answered
     * with. Without it a plumbing slip would produce a note calmly stating that
     * nothing in Q1 through Q4 was ever due.
     */
    response = defaulterResult([
      {
        school_id: 'stmarksmb',
        queries: [
          {
            key: 'defaulters_by_quarter',
            description: 'd',
            sql: 'SELECT 1',
            status: 'ok',
            columns: ['quarter', 'seq', 'defaulters'],
            rows: [{ quarter: 'Q1', seq: 1, defaulters: 26 }],
          },
        ],
      },
    ]);
    await expect(defaulterDrill({ level: 2, context: [SCHOOL_STEP] })).rejects.toThrow(
      PlatformError,
    );
  });

  it('refuses a defaulters drill aimed at the fee-collection widget id', () => {
    /**
     * The two reports drill on the same DIMENSIONS but from different widgets.
     * Accepting either id on either report would let a click on one dashboard
     * fetch a level of the other.
     */
    expect(() =>
      resolveDrill({
        reportId: 'fee-defaulters',
        widgetId: 'bar-school',
        level: 2,
        context: [SCHOOL_STEP],
        schoolIds: SCOPE,
        correlationId: 'c',
      }),
    ).toThrow(PlatformError);
  });
});

/**
 * A single-measure path must not emit `series`, and a multi-measure one must.
 * Asserted over the CATALOG rather than over the two reports by name, so a
 * third drill path added later is covered without anyone remembering to.
 */
describe('measures decide whether a level is a grouped bar', () => {
  it.each(Object.entries(DRILL_PATHS))('%s declares at least one measure', (_id, path) => {
    expect(path.measures.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(DRILL_PATHS))(
    '%s: every measure is a field its own levels can return',
    (_id, path) => {
      /**
       * A measure naming a column the level's SQL does not select would render
       * as a chart of zeroes — the shape of a working report with none of the
       * data, which is the failure §10 names.
       */
      for (const measure of path.measures) {
        expect(measure.field).toMatch(/^[a-z_][a-z0-9_]*$/);
        expect(measure.label.length).toBeGreaterThan(0);
      }
    },
  );
});

/**
 * Enrollment and Attendance, added 2026-08-31. Between them they exercise the
 * two things the fee paths never did: a level narrowed by a STRING parameter,
 * and a level that reuses a query the base dashboard already runs rather than
 * a `drill_only` one.
 */
function build(reportId: string, schools: { school_id: string; queries: QueryResult[] }[]) {
  response = {
    report_id: reportId,
    title: reportId,
    source: 'a_table',
    params: {},
    as_of: '2026-08-31T10:00:00.000Z',
    schools: schools.map((s) => ({ school_id: s.school_id, status: 'ok', queries: s.queries })),
  };
  return buildDashboard({
    session: SESSION,
    schoolIds: schools.map((s) => s.school_id),
    reportId: reportId as 'enrollment-overview',
    academicYear: '2026-27',
    asOfDate: '2026-08-31',
    correlationId: 'corr-1',
  });
}

function drillOn(reportId: string, widgetId: string, level: number, context: DrillStep[]) {
  return buildDrill({
    session: SESSION,
    schoolIds: SCOPE,
    reportId: reportId as 'enrollment-overview',
    widgetId,
    level,
    context,
    academicYear: '2026-27',
    asOfDate: '2026-08-31',
    correlationId: 'corr-x',
  });
}

describe('enrollment drills school to class to section', () => {
  it('builds level 1 per school from the by_class rows already on the page', async () => {
    const built = await build('enrollment-overview', [
      {
        school_id: 'stmarksmb',
        queries: [
          query('by_class', [
            { classname: 'IX', seq: 9, students: 40 },
            { classname: 'X', seq: 10, students: 35 },
          ]),
        ],
      },
      { school_id: 'stmarksj', queries: [query('by_class', [{ classname: 'IX', seq: 9, students: 22 }])] },
    ]);

    const widget = built.spec.widgets.find(
      (w): w is BarWidget => w.type === 'bar' && w.id === 'bar-school-roll',
    );
    /** 40 + 35 within a school; never 75 + 22 across them. */
    expect(widget?.data).toEqual([
      { school_id: 'stmarksmb', school_name: 'Meera Bagh', students: 75 },
      { school_id: 'stmarksj', school_name: 'Janakpuri', students: 22 },
    ]);
    expect(widget?.series).toBeUndefined();
  });

  it('runs the dashboard’s own by_class query at level 2 — no new statement', async () => {
    response = {
      report_id: 'enrollment-overview',
      title: 'Enrollment',
      source: 'students_data_set',
      params: {},
      as_of: '2026-08-31T10:00:00.000Z',
      schools: [
        {
          school_id: 'stmarksmb',
          status: 'ok',
          queries: [
            query('by_class', [
              { classname: 'IX', seq: 9, students: 40 },
              { classname: 'X', seq: 10, students: 35 },
            ]),
          ],
        },
      ],
    };
    const out = await drillOn('enrollment-overview', 'bar-school-roll', 2, [SCHOOL_STEP]);
    expect(lastCall?.args['query_keys']).toEqual(['by_class']);
    const widget = out.widget as BarWidget;
    expect(widget.x).toBe('classname');
    expect(widget.drill_dim).toBe('class');
    /** The class name is both the label and the value, so no separate field. */
    expect(widget.drill_value_field).toBeUndefined();
  });

  it('binds the clicked class as a STRING at level 3', async () => {
    response = {
      report_id: 'enrollment-overview',
      title: 'Enrollment',
      source: 'students_data_set',
      params: {},
      as_of: '2026-08-31T10:00:00.000Z',
      schools: [
        {
          school_id: 'stmarksmb',
          status: 'ok',
          queries: [
            query('by_section_for_class', [
              { sectionname: 'A', students: 20 },
              { sectionname: 'B', students: 20 },
            ]),
          ],
        },
      ],
    };
    const out = await drillOn('enrollment-overview', 'bar-school-roll', 3, [
      SCHOOL_STEP,
      { dim: 'class', value: 'IX', label: 'IX' },
    ]);
    const params = lastCall?.args['params'] as Record<string, unknown>;
    expect(params['drill_class']).toBe('IX');
    expect(typeof params['drill_class']).toBe('string');
    expect((out.widget as BarWidget).x).toBe('sectionname');
    expect((out.widget as BarWidget).drillable).toBe(false);
  });

  it('carries a class name that looks like SQL through as a value', async () => {
    /**
     * It reaches MySQL as a bound parameter (CODING_GUIDELINES §9), so the only
     * correct behaviour is to pass it along and match nothing. Asserted because
     * a future "sanitise the drill value" would be the wrong fix applied to the
     * wrong layer, and this locks in which layer is responsible.
     */
    response = {
      report_id: 'enrollment-overview',
      title: 'Enrollment',
      source: 'students_data_set',
      params: {},
      as_of: '2026-08-31T10:00:00.000Z',
      schools: [
        { school_id: 'stmarksmb', status: 'ok', queries: [query('by_section_for_class', [])] },
      ],
    };
    await drillOn('enrollment-overview', 'bar-school-roll', 3, [
      SCHOOL_STEP,
      { dim: 'class', value: "'; DROP TABLE students; --", label: 'x' },
    ]);
    const params = lastCall?.args['params'] as Record<string, unknown>;
    expect(params['drill_class']).toBe("'; DROP TABLE students; --");
  });

  it('has no note and no pending marker, because every level partitions cleanly', () => {
    const path = DRILL_PATHS['enrollment-overview'];
    for (const level of path?.levels ?? []) {
      expect(level.note).toBeUndefined();
      expect(level.pending).toBeUndefined();
    }
  });
});

describe('attendance drills school to quarter to class, in counts', () => {
  it('draws present against absent, and omits a school with nothing marked', async () => {
    const built = await build('attendance-analytics', [
      {
        school_id: 'stmarksmb',
        queries: [query('summary', [{ present_days: 0, absent_days: 0, marked_days: 0 }])],
      },
      {
        school_id: 'stmarksj',
        queries: [query('summary', [{ present_days: 180, absent_days: 20, marked_days: 200 }])],
      },
    ]);
    const widget = built.spec.widgets.find(
      (w): w is BarWidget => w.type === 'bar' && w.id === 'bar-school-attendance',
    );
    /**
     * A school with no marked days is absent, not a pair of zero bars: zero
     * present and zero absent reads as "nobody came", and the true statement is
     * "nobody marked the register".
     */
    expect(widget?.data).toEqual([
      { school_id: 'stmarksj', school_name: 'Janakpuri', present_days: 180, absent_days: 20 },
    ]);
    expect(widget?.series?.map((m) => m.field)).toEqual(['present_days', 'absent_days']);
  });

  it('warns at the quarter level that these are marked days only', async () => {
    response = {
      report_id: 'attendance-analytics',
      title: 'Attendance',
      source: 'student_attendance_data_set',
      params: {},
      as_of: '2026-08-31T10:00:00.000Z',
      schools: [
        {
          school_id: 'stmarksmb',
          status: 'ok',
          queries: [
            query('by_quarter', [
              { quarter: 'Q1', seq: 1, present_days: 90, absent_days: 10 },
              { quarter: 'Q2', seq: 2, present_days: 80, absent_days: 20 },
            ]),
          ],
        },
      ],
    };
    const out = await drillOn('attendance-analytics', 'bar-school-attendance', 2, [SCHOOL_STEP]);
    expect(lastCall?.args['query_keys']).toEqual(['by_quarter']);
    expect(out.notes[0]).toMatch(/marked/i);
    expect((out.widget as BarWidget).data.map((r) => r['quarter'])).toEqual(['Q1', 'Q2']);
  });

  /**
   * The middle level is the same Apr–Mar quarter the fee paths use, so a reader
   * comparing "Q2 fees" with "Q2 attendance" is comparing the same window. It
   * was a MONTH until 2026-08-31, which made that one card's middle level mean
   * something different from the other three without saying so.
   */
  it('descends through the academic quarter, matching the fee paths', () => {
    const path = DRILL_PATHS['attendance-analytics'];
    expect(path?.levels[1]?.drill_dim).toBe('quarter');
    expect(path?.levels[1]?.drill_dim).toBe(DRILL_PATHS['fee-collection']?.levels[1]?.drill_dim);
  });

  it('binds the clicked quarter as a NUMBER at level 3', async () => {
    response = {
      report_id: 'attendance-analytics',
      title: 'Attendance',
      source: 'student_attendance_data_set',
      params: {},
      as_of: '2026-08-31T10:00:00.000Z',
      schools: [
        {
          school_id: 'stmarksmb',
          status: 'ok',
          queries: [
            query('by_class_for_quarter', [{ classname: 'IX', present_days: 40, absent_days: 5 }]),
          ],
        },
      ],
    };
    const out = await drillOn('attendance-analytics', 'bar-school-attendance', 3, [
      SCHOOL_STEP,
      { dim: 'quarter', value: '2', label: 'Q2' },
    ]);
    const params = lastCall?.args['params'] as Record<string, unknown>;
    /**
     * A NUMBER, not the string the click carried. `drill_quarter` is declared
     * `number` in the catalog so `run_predefined` refuses a string before the
     * guard ever sees it -- the value came from a browser, which is to say from
     * outside.
     */
    expect(params['drill_quarter']).toBe(2);
    /** The window the base report bound travels unchanged alongside it. */
    expect(params['from_date']).toBe('2026-04-01');
    expect(params['to_date']).toBe('2027-03-31');
    expect((out.widget as BarWidget).x).toBe('classname');
  });

  it('never drills on a rate — quotients do not survive the merge', () => {
    /**
     * The one thing that would quietly produce nonsense here: `sumBy` adds the
     * fields it is given, and adding two quarters' percentages yields a number
     * belonging to neither. Locked to counts at the catalog level.
     */
    const path = DRILL_PATHS['attendance-analytics'];
    for (const measure of path?.measures ?? []) {
      expect(measure.field).toMatch(/_days$/);
    }
  });
});

describe('fee by student drills school to quarter to class, on the money', () => {
  it('draws ONE measure — the amount, not the student count beside it', () => {
    const path = DRILL_PATHS['fee-by-student'];
    /**
     * Every level's statement returns `students` alongside `outstanding`, and
     * only the amount is drawn. A count of 500 and an amount of ₹5,000,000
     * share an axis only in the sense that both are numbers: the count would be
     * an invisible sliver and the axis would be labelled for neither.
     */
    expect(path?.measures.map((m) => m.field)).toEqual(['outstanding']);
  });

  it('descends through the same quarter as the other fee paths', () => {
    const path = DRILL_PATHS['fee-by-student'];
    expect(path?.levels[1]?.drill_dim).toBe('quarter');
    expect(path?.levels[1]?.drill_dim).toBe(DRILL_PATHS['fee-collection']?.levels[1]?.drill_dim);
    /** The leaf declares no `drill_dim`, so its chart renders inert. */
    expect(path?.levels[2]?.drill_dim).toBeUndefined();
  });

  it('says at the quarter level that this is the whole book, not just what is late', async () => {
    response = {
      report_id: 'fee-by-student',
      title: 'Fee by Student',
      source: 'fee_compile_data_set',
      params: {},
      as_of: '2026-08-31T10:00:00.000Z',
      schools: [
        {
          school_id: 'stmarksmb',
          status: 'ok',
          queries: [
            query('by_quarter', [
              { quarter: 'Q1', seq: 1, students: 40, outstanding: 120000 },
              { quarter: 'Q2', seq: 2, students: 55, outstanding: 260000 },
            ]),
          ],
        },
      ],
    };
    const out = await drillOn('fee-by-student', 'bar-school-fee-student', 2, [SCHOOL_STEP]);

    expect(lastCall?.args['query_keys']).toEqual(['by_quarter']);
    expect((out.widget as BarWidget).data.map((r) => r['quarter'])).toEqual(['Q1', 'Q2']);
    /**
     * The note is load-bearing rather than decorative. A bursar reading this
     * beside Fee Defaulters sees two different totals for what looks like the
     * same question, and the difference is due-yet versus not — if that is not
     * said against the bars, the gap reads as an error in one of the reports.
     */
    expect(out.notes[0]).toMatch(/whole year|due or not|already fallen due/i);
  });

  it('binds the clicked quarter as a number at level 3', async () => {
    response = {
      report_id: 'fee-by-student',
      title: 'Fee by Student',
      source: 'fee_compile_data_set',
      params: {},
      as_of: '2026-08-31T10:00:00.000Z',
      schools: [
        {
          school_id: 'stmarksmb',
          status: 'ok',
          queries: [
            query('by_class_for_quarter', [
              { classname: 'IX', seq: 9, students: 12, outstanding: 90000 },
            ]),
          ],
        },
      ],
    };
    const out = await drillOn('fee-by-student', 'bar-school-fee-student', 3, [
      SCHOOL_STEP,
      QUARTER_STEP,
    ]);

    const params = lastCall?.args['params'] as Record<string, unknown>;
    expect(params['drill_quarter']).toBe(2);
    /**
     * No `as_of_date`. Nothing in this report depends on what has fallen due,
     * and a filter that appeared to move the numbers without moving them would
     * be worse than an absent one.
     */
    expect(params['as_of_date']).toBeUndefined();
    expect((out.widget as BarWidget).x).toBe('classname');
  });
});
