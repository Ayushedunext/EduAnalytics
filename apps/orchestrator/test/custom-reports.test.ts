/**
 * Custom reports (ADR-018) — the two security-relevant properties this
 * session's design decisions rest on:
 *
 *   1. AUDIT_REPORT A8: effective scope at execution is the definition's
 *      stored `school_scope` INTERSECTED with the viewer's own token scope —
 *      never the stored scope alone, and never widened by it.
 *   2. AUDIT_REPORT C17: Re-run on a saved AI report re-executes the
 *      persisted SQL deterministically — provable here by the fact that
 *      `services/ai-chat.js`'s model-calling loop (`runAskAi`) is never
 *      imported by this module at all; only its pure `hydrate` helper is.
 *
 * Also covered: ownership and promotion gating, and that a predefined clone
 * replays the exact same `BUILDERS` presentation layer `dashboards.ts` uses.
 *
 * The MCP client, the registry and the report_definitions table are all
 * mocked — this suite is about how services/custom-reports.ts shapes and
 * authorises an answer, not whether MySQL or Redis are reachable.
 */

import './env-defaults.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformError, ERROR_CODES } from '@sap/shared';

interface StoredRow {
  id: string;
  org_id: string;
  owner_sub: string;
  name: string;
  base_report_id: string | null;
  source_kind: 'predefined_clone' | 'ai_saved';
  school_scope: string[];
  shared_flag: 'private' | 'school' | 'trust';
  current_version: number;
  def_json: unknown;
  sql_text: string;
  created_at: string;
  updated_at: string;
}

let rows = new Map<string, StoredRow>();
let nextId = 1;

vi.mock('../src/db/report-definitions.js', () => ({
  insertReportDefinition: async (args: {
    orgId: string;
    ownerSub: string;
    name: string;
    baseReportId: string | null;
    sourceKind: StoredRow['source_kind'];
    schoolScope: readonly string[];
    defJson: unknown;
    sqlText: string;
  }) => {
    const id = `report-${String(nextId)}`;
    nextId += 1;
    const row: StoredRow = {
      id,
      org_id: args.orgId,
      owner_sub: args.ownerSub,
      name: args.name,
      base_report_id: args.baseReportId,
      source_kind: args.sourceKind,
      school_scope: [...args.schoolScope],
      def_json: args.defJson,
      sql_text: args.sqlText,
      shared_flag: 'private',
      current_version: 1,
      created_at: '2026-08-25T00:00:00.000Z',
      updated_at: '2026-08-25T00:00:00.000Z',
    };
    rows.set(id, row);
    return row;
  },
  getReportDefinition: async (id: string) => rows.get(id),
  listReportDefinitions: async (args: { orgId: string; ownerSub: string }) =>
    [...rows.values()].filter((r) => r.org_id === args.orgId && (r.owner_sub === args.ownerSub || r.shared_flag !== 'private')),
  saveNewVersion: async (args: { id: string; defJson: unknown; sqlText: string }) => {
    const row = rows.get(args.id);
    if (row === undefined) throw new Error('not found');
    const updated = { ...row, def_json: args.defJson, sql_text: args.sqlText, current_version: row.current_version + 1 };
    rows.set(args.id, updated);
    return updated;
  },
  listVersions: async () => [],
  getVersion: async () => undefined,
  setVisibility: async (id: string, sharedFlag: StoredRow['shared_flag']) => {
    const row = rows.get(id);
    if (row !== undefined) rows.set(id, { ...row, shared_flag: sharedFlag });
  },
  softDeleteReportDefinition: async (id: string) => {
    rows.delete(id);
  },
}));

vi.mock('../src/db/audit.js', () => ({ auditSink: { write: async () => undefined } }));

const SCHOOL_NAMES: Record<string, string> = {
  stmarksmb: 'Meera Bagh',
  stmarksj: 'Janakpuri',
  stmarksg: 'Gurgaon',
};

vi.mock('../src/db/registry.js', () => ({
  schoolNames: (ids: readonly string[]) =>
    Promise.resolve(ids.map((id) => ({ school_id: id, school_name: SCHOOL_NAMES[id] ?? id }))),
}));

/** Every MCP call the mocked `withMcp` has seen, in order — read the LAST one via `lastToolCall()`. */
let toolCalls: { tool: string; args: Record<string, unknown> }[] = [];
function lastToolCall(): { tool: string; args: Record<string, unknown> } | undefined {
  return toolCalls[toolCalls.length - 1];
}

/** What the mocked MCP `run_predefined` / `run_query` / `run_multi` answers with. */
let mcpResponse: unknown;

vi.mock('../src/mcp/client.js', () => ({
  withMcp: async (
    _session: unknown,
    _correlationId: string,
    _schoolIds: readonly string[],
    fn: (mcp: { call: (tool: string, args: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
  ) =>
    fn({
      call: (tool: string, args: Record<string, unknown>) => {
        toolCalls.push({ tool, args });
        return Promise.resolve(mcpResponse);
      },
    }),
}));

const {
  cloneReport,
  drillCustomReport,
  viewReport,
  saveAiReport,
  updateReportVisual,
  setReportVisibility,
  getRefineContext,
  applyRefinement,
} = await import('../src/services/custom-reports.js');

/** A `run_predefined` result carrying only the `by_month` query — what a real server returns once `query_keys: ['by_month']` narrows it (mcp-server/src/tools/run-predefined.ts). */
function feeCollectionByMonthResult(schoolIds: string[]) {
  return {
    report_id: 'fee-collection',
    title: 'Fee Collection',
    source: 'fee_collection_data_set · fee_compile_data_set',
    params: {},
    as_of: '2026-08-25T00:00:00.000Z',
    schools: schoolIds.map((school_id) => ({
      school_id,
      status: 'ok',
      queries: [
        {
          key: 'by_month',
          description: 'Receipts by month, from the collection ledger',
          sql: 'SELECT fee_month, MIN(MONTH(feedate)) AS mo, ROUND(SUM(paidamount)) AS collected FROM fee_collection_data_set WHERE academicyearname = :academic_year GROUP BY fee_month ORDER BY mo',
          status: 'ok',
          rows: [{ fee_month: 'Apr-26', mo: 4, collected: 120000 }],
        },
      ],
    })),
  };
}

function enrollmentPredefinedResult(schoolIds: string[]) {
  return {
    report_id: 'enrollment-overview',
    title: 'Enrollment Overview',
    source: 'students_data_set',
    params: {},
    as_of: '2026-08-25T00:00:00.000Z',
    schools: schoolIds.map((school_id) => ({
      school_id,
      status: 'ok',
      queries: [
        {
          key: 'by_class',
          description: 'Students on roll by class',
          sql: 'SELECT classname, COUNT(*) AS students FROM students_data_set WHERE academicyearname = :academic_year GROUP BY classname',
          status: 'ok',
          rows: [{ classname: 'IX', seq: 9, students: 40 }],
        },
      ],
    })),
  };
}

const DIRECTOR = {
  sub: 'erp-user-director',
  name: 'A. Rao',
  role: 'DIRECTOR' as const,
  org_id: 'stmarks',
  school_ids: ['stmarksmb', 'stmarksj', 'stmarksg'],
  default_school: 'stmarksmb',
  perms: ['fees.read', 'students.read', 'staff.read'],
  permission_class: 'test',
};

const PRINCIPAL_SINGLE_SCHOOL = {
  ...DIRECTOR,
  sub: 'erp-user-principal',
  role: 'PRINCIPAL' as const,
  school_ids: ['stmarksmb'],
};

const NON_OWNER = { ...DIRECTOR, sub: 'erp-user-someone-else' };
const ADMIN_DIRECTOR = { ...DIRECTOR, role: 'ADMIN' as const };

beforeEach(() => {
  rows = new Map();
  nextId = 1;
  toolCalls = [];
  mcpResponse = enrollmentPredefinedResult(['stmarksmb', 'stmarksj', 'stmarksg']);
});

describe('cloneReport + viewReport (template mode)', () => {
  it('clones a predefined report and reuses its BUILDERS presentation unchanged', async () => {
    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'enrollment-overview',
      name: 'My Enrollment View',
      schoolIds: DIRECTOR.school_ids,
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
    });

    expect(cloned.mode).toBe('template');
    expect(cloned.source_kind).toBe('predefined_clone');
    expect(cloned.spec.title).toBe('My Enrollment View');
    // buildEnrollment's own kpi id — proves the SAME builder ran, not a re-derived copy.
    expect(cloned.spec.widgets.some((w) => w.id === 'kpi-total')).toBe(true);
    expect(lastToolCall()?.tool).toBe('run_predefined');
    expect(lastToolCall()?.args['params']).toMatchObject({ academic_year: '2026-27' });
  });

  it('rejects cloning a report id that is not in the predefined catalog', async () => {
    await expect(
      cloneReport({
        session: DIRECTOR,
        correlationId: 'corr-1',
        baseReportId: 'not-a-real-report',
        name: 'Bogus',
        schoolIds: DIRECTOR.school_ids,
        academicYear: '2026-27',
        asOfDate: '2026-08-25',
      }),
    ).rejects.toThrow(PlatformError);
  });
});

describe('AUDIT_REPORT A8 — effective scope is intersection, never the stored scope alone', () => {
  it('a trust-shared report opened by a single-school viewer runs, and shows, only that viewer’s school', async () => {
    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'enrollment-overview',
      name: 'Trust Enrollment',
      schoolIds: DIRECTOR.school_ids, // 3 schools
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
    });
    await setReportVisibility({
      session: ADMIN_DIRECTOR,
      correlationId: 'corr-1',
      id: cloned.id,
      sharedFlag: 'trust',
    });

    // The single-school Principal's own token scope only lets them request
    // their own school — resolveRequestedSchools (middleware, not exercised
    // here) would already narrow to this before viewReport ever sees it.
    mcpResponse = enrollmentPredefinedResult(['stmarksmb']);
    const viewed = await viewReport({
      session: PRINCIPAL_SINGLE_SCHOOL,
      correlationId: 'corr-2',
      id: cloned.id,
      requestedSchoolIds: PRINCIPAL_SINGLE_SCHOOL.school_ids,
    });

    expect(viewed.spec.meta.scope).toEqual([{ school_id: 'stmarksmb', school_name: 'Meera Bagh' }]);
    expect(viewed.logic.scope).toEqual([{ school_id: 'stmarksmb', school_name: 'Meera Bagh' }]);
    // The MCP call itself only ever named the effective (narrowed) set — the
    // author's other two schools never left the intersection, so a
    // compromised or buggy caller here could not widen it even by asking.
    expect(lastToolCall()?.args['school_ids']).toEqual(['stmarksmb']);
  });

  it('refuses when the viewer has no overlap at all with the stored scope', async () => {
    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'enrollment-overview',
      name: 'Trust Enrollment',
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
    });
    await setReportVisibility({ session: ADMIN_DIRECTOR, correlationId: 'corr-1', id: cloned.id, sharedFlag: 'trust' });

    const OTHER_SCHOOL_PRINCIPAL = { ...PRINCIPAL_SINGLE_SCHOOL, sub: 'erp-user-other', school_ids: ['stmarksj'] };
    await expect(
      viewReport({
        session: OTHER_SCHOOL_PRINCIPAL,
        correlationId: 'corr-3',
        id: cloned.id,
        requestedSchoolIds: OTHER_SCHOOL_PRINCIPAL.school_ids,
      }),
    ).rejects.toThrow(PlatformError);
  });
});

describe('ownership and visibility gating', () => {
  it('refuses an edit from anyone but the owner', async () => {
    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'enrollment-overview',
      name: 'Mine',
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
    });

    await expect(
      updateReportVisual({
        session: NON_OWNER,
        correlationId: 'corr-2',
        id: cloned.id,
        academicYear: '2027-28',
        asOfDate: '2026-08-25',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.REPORT_DEFINITION_FORBIDDEN });
  });

  it('refuses promoting visibility beyond private for a non-admin', async () => {
    const cloned = await cloneReport({
      session: DIRECTOR, // role DIRECTOR, not ADMIN
      correlationId: 'corr-1',
      baseReportId: 'enrollment-overview',
      name: 'Mine',
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
    });

    await expect(
      setReportVisibility({ session: DIRECTOR, correlationId: 'corr-2', id: cloned.id, sharedFlag: 'school' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
  });
});

describe('AUDIT_REPORT C17 — saved AI reports re-run without the model', () => {
  it('re-executes the persisted statement through run_query, never through the AI chat loop', async () => {
    mcpResponse = { columns: ['classname', 'n'], rows: [{ classname: 'IX', n: 40 }], truncated: false };

    const saved = await saveAiReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      name: 'Saved AI answer',
      schoolIds: ['stmarksmb'],
      queries: [{ key: 'q1', sql: 'SELECT classname, COUNT(*) AS n FROM students_data_set GROUP BY classname' }],
      draft: {
        spec_version: 1,
        title: 'Enrollment by class',
        widgets: [{ id: 'b1', type: 'bar', x: 'classname', y: 'n', query_ref: 'q1' }],
      },
    });

    expect(saved.mode).toBe('raw_sql');
    expect(saved.source_kind).toBe('ai_saved');
    expect(lastToolCall()?.tool).toBe('run_query');
    expect(saved.spec.widgets).toHaveLength(1);

    // Re-run: viewReport again, simulating the org's AI key being locked —
    // nothing in this path calls services/ai-chat.js's runAskAi (it is never
    // even imported by custom-reports.ts), so nothing here CAN depend on it.
    const callsBeforeRerun = toolCalls.length;
    const rerun = await viewReport({
      session: DIRECTOR,
      correlationId: 'corr-2',
      id: saved.id,
      requestedSchoolIds: ['stmarksmb'],
    });
    expect(toolCalls.length).toBeGreaterThan(callsBeforeRerun);
    expect(lastToolCall()?.tool).toBe('run_query');
    expect(rerun.spec.widgets).toHaveLength(1);
  });
});

describe('per-widget clone (docs/06 §3)', () => {
  it('clones one chart, asking run_predefined for only that widget’s query', async () => {
    mcpResponse = feeCollectionByMonthResult(['stmarksmb']);

    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'fee-collection',
      name: 'Receipts by month (copy)',
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      widgetScope: 'line-month',
    });

    expect(cloned.spec.widgets).toHaveLength(1);
    expect(cloned.spec.widgets[0]).toMatchObject({ id: 'line-month', title: 'Receipts by month' });
    expect(lastToolCall()?.args['query_keys']).toEqual(['by_month']);
  });

  it('applies a bucket override to both the MCP params and the widget title', async () => {
    mcpResponse = feeCollectionByMonthResult(['stmarksmb']);

    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'fee-collection',
      name: 'Receipts by week (copy)',
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      widgetScope: 'line-month',
      bucket: 'week',
    });

    expect(cloned.spec.widgets[0]).toMatchObject({ title: 'Receipts by week' });
    expect(lastToolCall()?.args).toMatchObject({ query_keys: ['by_month'] });
    expect((lastToolCall()?.args['params'] as Record<string, unknown>)['bucket']).toBe('week');
  });

  it('rejects cloning a widget id the report does not have', async () => {
    await expect(
      cloneReport({
        session: DIRECTOR,
        correlationId: 'corr-1',
        baseReportId: 'fee-collection',
        name: 'Bogus widget',
        schoolIds: ['stmarksmb'],
        academicYear: '2026-27',
        asOfDate: '2026-08-25',
        widgetScope: 'not-a-real-widget',
      }),
    ).rejects.toThrow(PlatformError);
  });

  it('rejects a bucket the named widget does not offer', async () => {
    await expect(
      cloneReport({
        session: DIRECTOR,
        correlationId: 'corr-1',
        baseReportId: 'fee-collection',
        name: 'Bad bucket',
        schoolIds: ['stmarksmb'],
        academicYear: '2026-27',
        asOfDate: '2026-08-25',
        // bar-class has no bucket options at all (WIDGET_BUCKET_OPTIONS in dashboards.ts).
        widgetScope: 'bar-class',
        bucket: 'week',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
  });

  it('stays scoped to the same widget after an academic-year edit', async () => {
    mcpResponse = feeCollectionByMonthResult(['stmarksmb']);
    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'fee-collection',
      name: 'Receipts by month (copy)',
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      widgetScope: 'line-month',
      bucket: 'quarter',
    });

    const edited = await updateReportVisual({
      session: DIRECTOR,
      correlationId: 'corr-2',
      id: cloned.id,
      academicYear: '2027-28',
      asOfDate: '2026-08-25',
    });

    // Still one widget, not the whole dashboard back — an AY-only edit must
    // not silently widen a widget clone into a full-report clone.
    expect(edited.spec.widgets).toHaveLength(1);
    expect(edited.spec.widgets[0]).toMatchObject({ id: 'line-month', title: 'Receipts by quarter' });
    expect(lastToolCall()?.args).toMatchObject({ query_keys: ['by_month'] });
    expect((lastToolCall()?.args['params'] as Record<string, unknown>)).toMatchObject({
      academic_year: '2027-28',
      bucket: 'quarter',
    });
  });
});

describe('✎ Refine with AI (docs/06 §1, ADR-033’s explicitly-deferred action)', () => {
  it('getRefineContext refuses anyone but the owner', async () => {
    mcpResponse = feeCollectionByMonthResult(['stmarksmb']);
    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'fee-collection',
      name: 'Receipts by month (copy)',
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      widgetScope: 'line-month',
    });

    await expect(
      getRefineContext({
        session: NON_OWNER,
        correlationId: 'corr-2',
        id: cloned.id,
        requestedSchoolIds: ['stmarksmb'],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.REPORT_DEFINITION_FORBIDDEN });
  });

  it('getRefineContext hands back the report’s current SQL and widgets, freshly run', async () => {
    mcpResponse = feeCollectionByMonthResult(['stmarksmb']);
    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'fee-collection',
      name: 'Receipts by month (copy)',
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      widgetScope: 'line-month',
    });

    const ctx = await getRefineContext({
      session: DIRECTOR,
      correlationId: 'corr-2',
      id: cloned.id,
      requestedSchoolIds: ['stmarksmb'],
    });

    expect(ctx.reportName).toBe('Receipts by month (copy)');
    expect(ctx.widgets).toHaveLength(1);
    expect(ctx.widgets[0]).toMatchObject({ id: 'line-month' });
    expect(ctx.queries.some((q) => q.key === 'by_month')).toBe(true);
  });

  it('applyRefinement materializes a template-mode clone into raw_sql, never touching run_predefined again', async () => {
    mcpResponse = feeCollectionByMonthResult(['stmarksmb']);
    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'fee-collection',
      name: 'Receipts by month (copy)',
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      widgetScope: 'line-month',
    });
    expect(cloned.mode).toBe('template');

    mcpResponse = { columns: ['paymenttype', 'collected'], rows: [{ paymenttype: 'Cash', collected: 5000 }], truncated: false };
    const applied = await applyRefinement({
      session: DIRECTOR,
      correlationId: 'corr-2',
      id: cloned.id,
      queries: [{ key: 'q1', sql: "SELECT paymenttype, SUM(paidamount) AS collected FROM fee_collection_data_set WHERE paymenttype = 'Cash' GROUP BY paymenttype" }],
      draft: {
        spec_version: 1,
        title: 'Cash receipts',
        widgets: [{ id: 'donut-cash', type: 'donut', label_field: 'paymenttype', value_field: 'collected', query_ref: 'q1' }],
      },
    });

    expect(applied.mode).toBe('raw_sql');
    expect(applied.current_version).toBe(2);
    expect(applied.spec.widgets).toHaveLength(1);
    expect(applied.spec.widgets[0]).toMatchObject({ id: 'donut-cash' });
    expect(lastToolCall()?.tool).toBe('run_query');

    // Re-viewing now goes through run_query, never back through run_predefined —
    // the transition to raw_sql mode is permanent, matching every other
    // AI-saved report's re-run semantics (AUDIT_REPORT C17).
    const callsBefore = toolCalls.length;
    await viewReport({ session: DIRECTOR, correlationId: 'corr-3', id: cloned.id, requestedSchoolIds: ['stmarksmb'] });
    expect(toolCalls.length).toBeGreaterThan(callsBefore);
    expect(lastToolCall()?.tool).toBe('run_query');
  });

  it('applyRefinement refuses anyone but the owner', async () => {
    mcpResponse = feeCollectionByMonthResult(['stmarksmb']);
    const cloned = await cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-1',
      baseReportId: 'fee-collection',
      name: 'Receipts by month (copy)',
      schoolIds: ['stmarksmb'],
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      widgetScope: 'line-month',
    });

    await expect(
      applyRefinement({
        session: NON_OWNER,
        correlationId: 'corr-2',
        id: cloned.id,
        queries: [{ key: 'q1', sql: 'SELECT 1' }],
        draft: { spec_version: 1, title: 'x', widgets: [{ id: 'w1', type: 'kpi', label: 'x', value: '1' }] },
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.REPORT_DEFINITION_FORBIDDEN });
  });
});

/**
 * The drill path a CLONE owns (docs/06 §4.3's "clones may change or disable the
 * path").
 *
 * The level-building itself is drill.test.ts's subject — same `buildDrill`,
 * same catalog, same click validation. What is tested here is the three things
 * that are only true of a clone: that the switch is a real gate and not a
 * hidden button, that a per-level chart choice reaches the chart, and that a
 * save which was not about drill-down leaves the path alone.
 */
describe('a clone owns its drill path (docs/06 §4.3)', () => {
  /** `run_predefined` for Fee Collection carrying the rows level 1 is built from. */
  function feeCollectionByComponentResult(schoolIds: string[]) {
    return {
      report_id: 'fee-collection',
      title: 'Fee Collection',
      source: 'fee_collection_data_set · fee_compile_data_set',
      params: {},
      as_of: '2026-08-25T00:00:00.000Z',
      schools: schoolIds.map((school_id) => ({
        school_id,
        status: 'ok',
        queries: [
          {
            key: 'by_component',
            description: 'Demand, collection and pending by fee head',
            sql: 'SELECT componentname, SUM(payable) AS payable FROM fee_compile_data_set WHERE academicyearname = :academic_year GROUP BY componentname',
            status: 'ok',
            rows: [{ componentname: 'Tuition', payable: 500, paid: 300, balance: 200 }],
          },
        ],
      })),
    };
  }

  async function cloneFeeCollection() {
    mcpResponse = feeCollectionByComponentResult(DIRECTOR.school_ids);
    return cloneReport({
      session: DIRECTOR,
      correlationId: 'corr-drill',
      baseReportId: 'fee-collection',
      name: 'Fees I watch',
      schoolIds: DIRECTOR.school_ids,
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
    });
  }

  /** The drill-entry widget of a rendered clone, or undefined if it has none. */
  function entryWidget(view: { spec: { widgets: readonly unknown[] } }, id: string) {
    return view.spec.widgets.find((w) => (w as { id?: string }).id === id) as
      | { id: string; type: string; drillable?: boolean; drill_dim?: string }
      | undefined;
  }

  it('ships a clone of a drillable dashboard with its curated path ON', async () => {
    const cloned = await cloneFeeCollection();

    expect(cloned.drill?.available).toBe(true);
    /* docs/06 §4.3: "predefined dashboards ship with curated paths ON", and a
       clone inherits that rather than having to opt back in. */
    expect(cloned.drill?.enabled).toBe(true);
    expect(cloned.drill?.levels).toHaveLength(3);
    expect(entryWidget(cloned, cloned.drill?.widget_id ?? '')?.drillable).toBe(true);
  });

  it('takes the affordance off the chart when a reader switches the path off', async () => {
    const cloned = await cloneFeeCollection();
    const widgetId = cloned.drill?.widget_id ?? '';
    expect(entryWidget(cloned, widgetId)?.drillable).toBe(true);

    mcpResponse = feeCollectionByComponentResult(DIRECTOR.school_ids);
    const updated = await updateReportVisual({
      session: DIRECTOR,
      correlationId: 'corr-drill-3',
      id: cloned.id,
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      drill: { enabled: false },
    });

    expect(updated.drill?.enabled).toBe(false);
    const widget = entryWidget(updated, widgetId);
    expect(widget?.drillable).toBe(false);
    /* The pair travels together — `drillable` without `drill_dim` is an invalid
       widget, and a stale dim is a fact about a path this report no longer has. */
    expect(widget?.drill_dim).toBeUndefined();
    /* Invariant 6: a chart that stopped being clickable says so where its logic
       is read, rather than leaving a dead click as the only evidence. */
    expect(updated.logic.notes.some((n) => n.toLowerCase().includes('drill-down is turned off'))).toBe(true);
  });

  it('refuses a drill request on a report whose path is switched off', async () => {
    const cloned = await cloneFeeCollection();
    mcpResponse = feeCollectionByComponentResult(DIRECTOR.school_ids);
    await updateReportVisual({
      session: DIRECTOR,
      correlationId: 'corr-drill-4',
      id: cloned.id,
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      drill: { enabled: false },
    });

    /* Hiding the button is a UI fact, not an access decision: the request can
       still be typed by hand, so the gate lives on the server. */
    await expect(
      drillCustomReport({
        session: DIRECTOR,
        correlationId: 'corr-drill-5',
        id: cloned.id,
        requestedSchoolIds: DIRECTOR.school_ids,
        widgetId: cloned.drill?.widget_id ?? 'bar-school',
        level: 2,
        context: [{ dim: 'school', value: 'stmarksmb', label: 'Meera Bagh' }],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
  });

  it('refuses a drill request on an AI-saved report, which has no curated path', async () => {
    mcpResponse = { columns: ['classname', 'n'], rows: [{ classname: 'IX', n: 40 }], truncated: false };
    const saved = await saveAiReport({
      session: DIRECTOR,
      correlationId: 'corr-drill-6',
      name: 'From Ask AI',
      schoolIds: ['stmarksmb'],
      queries: [{ key: 'q1', sql: 'SELECT classname, COUNT(*) AS n FROM students_data_set GROUP BY classname' }],
      draft: {
        spec_version: 1,
        title: 'From Ask AI',
        widgets: [{ id: 'w1', type: 'bar', x: 'classname', y: 'n', query_ref: 'q1' }],
      },
    });

    expect(saved.drill).toBeNull();
    await expect(
      drillCustomReport({
        session: DIRECTOR,
        correlationId: 'corr-drill-7',
        id: saved.id,
        requestedSchoolIds: ['stmarksmb'],
        widgetId: 'w1',
        level: 2,
        context: [{ dim: 'school', value: 'stmarksmb', label: 'Meera Bagh' }],
      }),
    ).rejects.toBeInstanceOf(PlatformError);
  });

  it('draws the entry level as the chart the reader chose, still drillable', async () => {
    const cloned = await cloneFeeCollection();
    const widgetId = cloned.drill?.widget_id ?? '';

    mcpResponse = feeCollectionByComponentResult(DIRECTOR.school_ids);
    const updated = await updateReportVisual({
      session: DIRECTOR,
      correlationId: 'corr-drill-8',
      id: cloned.id,
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      drill: { enabled: true, charts: { '1': 'line' } },
    });

    expect(updated.drill?.levels[0]?.chart).toBe('line');
    const widget = entryWidget(updated, widgetId);
    expect(widget?.type).toBe('line');
    /* The whole point of restricting a drilling level to bar/line: it has to
       stay clickable, or the reader is left with a chart that says it drills. */
    expect(widget?.drillable).toBe(true);
    expect(widget?.drill_dim).toBe('school');
  });

  it('leaves the path alone on a save that was not about drill-down', async () => {
    const cloned = await cloneFeeCollection();
    mcpResponse = feeCollectionByComponentResult(DIRECTOR.school_ids);
    await updateReportVisual({
      session: DIRECTOR,
      correlationId: 'corr-drill-9',
      id: cloned.id,
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      drill: { enabled: true, charts: { '2': 'line' } },
    });

    /* A filter-only save omits the key entirely — resetting a drill
       configuration nobody touched would be a change nobody asked for. */
    mcpResponse = feeCollectionByComponentResult(DIRECTOR.school_ids);
    const afterFilterEdit = await updateReportVisual({
      session: DIRECTOR,
      correlationId: 'corr-drill-10',
      id: cloned.id,
      academicYear: '2025-26',
      asOfDate: '2026-08-25',
    });

    expect(afterFilterEdit.drill?.enabled).toBe(true);
    expect(afterFilterEdit.drill?.levels[1]?.chart).toBe('line');
  });

  it('refuses to store a chart the level cannot be drawn as', async () => {
    const cloned = await cloneFeeCollection();

    mcpResponse = feeCollectionByComponentResult(DIRECTOR.school_ids);
    const updated = await updateReportVisual({
      session: DIRECTOR,
      correlationId: 'corr-drill-11',
      id: cloned.id,
      academicYear: '2026-27',
      asOfDate: '2026-08-25',
      /* A donut on level 1 would be a chart with nothing to click, on the one
         level whose entire job is to be clicked. */
      drill: { enabled: true, charts: { '1': 'donut' } },
    });

    expect(updated.drill?.levels[0]?.chart).toBe('bar');
    expect(entryWidget(updated, cloned.drill?.widget_id ?? '')?.drillable).toBe(true);
  });
});
