/**
 * `reuse_seed_query` — the tool a "✎ Refine with AI" turn calls to re-run one
 * of the CURRENT report's own queries completely unchanged, instead of the
 * model retyping the SQL itself.
 *
 * Added after a live bug: asking Ask AI to redraw an existing chart as a bar
 * chart ("same data, bar format") came back with a DIFFERENT total for the
 * same year and a different set of years than the original chart — the model
 * had rewritten the SQL from scratch while "reusing" it, and a plain prompt
 * instruction to copy it verbatim was not reliable enough to stop that. This
 * tool removes the retyping step entirely: the SQL text a `reuse_seed_query`
 * call runs comes only from `ctx.seedQueries` (the orchestrator's own record
 * of the report's queries), never from the model's tool-call arguments, so
 * there is no field here for a paraphrase to sneak into.
 */

import { describe, expect, it } from 'vitest';
import './env-defaults.js';
import type { SessionClaims } from '../src/auth/session.js';

const { buildToolDefinitions, executeTool } = await import('../src/services/ai-tools.js');

const SESSION: SessionClaims = {
  sub: 'erp-user-2001',
  name: 'S. Kapoor',
  role: 'PRINCIPAL',
  org_id: 'stmarks',
  school_ids: ['stmarksmb'],
  default_school: 'stmarksmb',
  perms: [],
  permission_class: 'principal',
};

const CATALOG = { tables: [] };

describe('buildToolDefinitions — reuse_seed_query is offered only when there is something to reuse', () => {
  it('omits reuse_seed_query on a fresh (non-refining) Ask AI question', () => {
    const tools = buildToolDefinitions(['stmarksmb']);
    expect(tools.map((t) => t.name)).not.toContain('reuse_seed_query');
  });

  it('omits reuse_seed_query when seedQueryKeys is explicitly empty', () => {
    const tools = buildToolDefinitions(['stmarksmb'], []);
    expect(tools.map((t) => t.name)).not.toContain('reuse_seed_query');
  });

  it('offers reuse_seed_query, constrained to the seeded keys, when refining', () => {
    const tools = buildToolDefinitions(['stmarksmb'], ['by_year']);
    const reuse = tools.find((t) => t.name === 'reuse_seed_query');
    expect(reuse).toBeDefined();
    const schema = reuse?.input_schema as { properties: { seed_query_key: { enum: string[] } } };
    expect(schema.properties.seed_query_key.enum).toEqual(['by_year']);
  });
});

describe('executeTool — reuse_seed_query resolves SQL from ctx.seedQueries only, never from the model', () => {
  it('rejects a seed_query_key that does not match any seeded query, before touching MCP', async () => {
    await expect(
      executeTool(
        'reuse_seed_query',
        { seed_query_key: 'nonexistent', school_ids: ['stmarksmb'], query_key: 'q1' },
        {
          session: SESSION,
          correlationId: 'corr-1',
          catalog: CATALOG,
          resultCache: new Map(),
          seedQueries: [{ key: 'by_year', sql: 'SELECT academic_year, SUM(paidamount) AS collected FROM fee_collection_data_set GROUP BY academic_year ORDER BY academic_year' }],
        },
      ),
    ).rejects.toThrow(/does not match any query/);
  });

  it('rejects a query_key already used this turn, before touching MCP', async () => {
    const resultCache = new Map([
      ['q1', { columns: ['n'], rows: [{ n: 1 }], truncated: false, sql: 'SELECT 1 AS n' }],
    ]);
    await expect(
      executeTool(
        'reuse_seed_query',
        { seed_query_key: 'by_year', school_ids: ['stmarksmb'], query_key: 'q1' },
        {
          session: SESSION,
          correlationId: 'corr-1',
          catalog: CATALOG,
          resultCache,
          seedQueries: [{ key: 'by_year', sql: 'SELECT academic_year FROM fee_collection_data_set' }],
        },
      ),
    ).rejects.toThrow(/already used/);
  });

  it('has no seed_query_key match when seedQueries is absent (a fresh, non-refining turn calling it anyway)', async () => {
    await expect(
      executeTool(
        'reuse_seed_query',
        { seed_query_key: 'by_year', school_ids: ['stmarksmb'], query_key: 'q1' },
        { session: SESSION, correlationId: 'corr-1', catalog: CATALOG, resultCache: new Map() },
      ),
    ).rejects.toThrow(/does not match any query/);
  });
});
