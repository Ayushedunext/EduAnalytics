/**
 * The trigger evaluator — the ONLY place this service reads school data, and
 * it does so exactly the way every report does: a vetted, literal SELECT
 * through the MCP server's `run_query` tool (ADR-006/023, docs/07 §3).
 *
 * The statement for each `FETCH_SOURCES` entry lives in `@sap/agent-graph`'s
 * `FETCH_SOURCE_SQL` (fetch-source-sql.ts), not here — shared with
 * apps/orchestrator's `testRunAgent` (the builder's "Test run" button) so a
 * schedule-driven run and a live test-run can never quietly answer the same
 * declared source with two different queries.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { FETCH_SOURCE_SQL, UNPOPULATED_FIELDS, agentGraphSchema } from '@sap/agent-graph';
import * as agentDbSchema from '@sap/agent-graph/db-schema';
import { db } from '../db/client.js';
import { withAgentMcp } from '../mcp/client.js';
import { agentQueue } from '../queue/queue.js';

interface RunQueryResult {
  rows: Record<string, unknown>[];
}

/**
 * One tick for one agent: fetch matched records for its trigger's data node,
 * create a run per NEW record (the UNIQUE `dedup_key` constraint is what makes
 * "new" mean "not already created for this agent+node+record+date" — ADR-025),
 * and enqueue each new run's first advance.
 *
 * Called by the BullMQ worker processing `evaluate-trigger` jobs
 * (src/main.ts); the repeatable job itself is scheduled by the orchestrator at
 * publish time (services/agents.ts `syncSchedule`), keyed by agent id.
 */
export async function evaluateAgent(agentId: string): Promise<{ matched: number; runsCreated: number }> {
  const [agent] = await db
    .select()
    .from(agentDbSchema.agents)
    .where(and(eq(agentDbSchema.agents.id, agentId), eq(agentDbSchema.agents.status, 'active'), isNull(agentDbSchema.agents.deletedAt)));

  if (agent === undefined) return { matched: 0, runsCreated: 0 };

  const [version] = await db
    .select()
    .from(agentDbSchema.agentVersions)
    .where(and(eq(agentDbSchema.agentVersions.agentId, agentId), eq(agentDbSchema.agentVersions.version, agent.currentVersion)));

  if (version === undefined) return { matched: 0, runsCreated: 0 };

  const graph = agentGraphSchema.parse(version.graphJson);
  const fetchNode = graph.nodes.find((n) => n.data.kind === 'fetch_records');
  if (fetchNode === undefined || fetchNode.data.kind !== 'fetch_records') {
    console.error(`[agent-runtime] agent ${agentId} has no fetch_records node; nothing to evaluate`);
    return { matched: 0, runsCreated: 0 };
  }

  const sql = FETCH_SOURCE_SQL[fetchNode.data.source];
  if (sql === undefined) {
    console.error(`[agent-runtime] agent ${agentId}: source "${fetchNode.data.source}" has no evaluator yet`);
    return { matched: 0, runsCreated: 0 };
  }

  const today = new Date().toISOString().slice(0, 10);
  let matched = 0;
  let runsCreated = 0;

  for (const schoolId of agent.schoolIds) {
    const correlationId = randomUUID();
    const result = await withAgentMcp(
      {
        agentId,
        orgId: agent.orgId,
        role: version.publishedRole,
        perms: version.publishedPerms,
        schoolIds: [schoolId],
        correlationId,
      },
      (mcp) => mcp.call<RunQueryResult>('run_query', { school_id: schoolId, sql }),
    );

    for (const row of result.rows) {
      matched += 1;

      /**
       * Source-agnostic on purpose: every `FETCH_SOURCES` entry's SQL already
       * aliases its columns to that source's declared `fields`
       * (@sap/agent-graph), so the row IS the record — spread as-is, with every
       * CONTACT field forced to `null` because no source can supply one
       * (docs/11 §2 item 10), rather than trusting a query to remember to.
       *
       * Forced from `UNPOPULATED_FIELDS` rather than field by field, so the day
       * item 10 is answered the list empties in one place and the real columns
       * flow straight through.
       */
      const recordRef: Record<string, unknown> = { ...row };
      for (const field of UNPOPULATED_FIELDS) recordRef[field] = null;
      const studentId = row['student_id'];

      /** docs/07 §3: "auto-derived DEDUP KEY (agent+node+record+date)". */
      const dedupKey = `${fetchNode.id}:${String(studentId)}:${today}`;
      const runId = randomUUID();

      try {
        await db.insert(agentDbSchema.agentRuns).values({
          runId,
          agentId,
          agentVersionId: version.id,
          schoolId,
          recordRef,
          dedupKey,
          status: 'running',
          currentNodeId: fetchNode.id,
        });
      } catch (err) {
        /**
         * ER_DUP_ENTRY on `uq_agent_run_dedup` means this exact record was
         * already turned into a run today — the guardrail firing as a
         * database mechanism (ADR-025), not an error to report.
         */
        if (isDuplicateKeyError(err)) continue;
        throw err;
      }

      runsCreated += 1;
      await agentQueue.add('advance-run', { kind: 'advance-run', runId });
    }
  }

  return { matched, runsCreated };
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ER_DUP_ENTRY';
}
