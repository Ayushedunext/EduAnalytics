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

function query(key: string, rows: Record<string, unknown>[]): QueryResult {
  return { key, description: `${key} description`, sql: `SELECT 1 AS ${key}`, status: 'ok', rows };
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
            { quarter: 'Q1', seq: 1, defaulters: 44, outstanding: 10 },
            { quarter: 'Q2', seq: 2, defaulters: 31, outstanding: 20 },
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
            { classname: 'IX', seq: 9, defaulters: 12, outstanding: 5 },
            { classname: 'X', seq: 10, defaulters: 19, outstanding: 8 },
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
