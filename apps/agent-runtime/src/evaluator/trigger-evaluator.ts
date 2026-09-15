/**
 * The trigger evaluator — the ONLY place this service reads school data, and
 * it does so exactly the way every report does: a vetted, literal SELECT
 * through the MCP server's `run_query` tool (ADR-006/023, docs/07 §3).
 *
 * -- Why the SQL lives here, not on the fetch-source catalog ------------------
 * `@sap/agent-graph`'s `FETCH_SOURCES` names WHAT an agent can ask for; the
 * literal SQL that answers it is a platform-authored statement the same way
 * `services/dashboards.ts`'s `METRIC_SQL` is for predefined dashboards — kept
 * next to the thing that RUNS it, not the shared type contract.
 *
 * -- The one runnable source today: `students_absent_today` -------------------
 * Against the real, catalogued schema (`apps/mcp-server/src/schema/erp-v1.ts`):
 * `student_attendance_data_set` is not unique on (student, date) and its
 * `academicyearname` cannot be trusted, so this statement filters on
 * `attendancedate` (text, `YYYY-MM-DD`) and `statusname = 'Absent'` only, per
 * that schema's own column notes. `consecutive_days` is a TRAILING-WINDOW
 * approximation (count of distinct absent dates in the last 7 calendar days),
 * not a true unbroken-run calculation — the same kind of stated simplification
 * docs/06's drill per-level notes make for other counts that read like one
 * thing and are actually another. A real consecutive-run calculation is a
 * follow-up, not a blocker for proving the trigger→run pipeline end to end.
 *
 * `parent_phone` is always null — see @sap/agent-graph's FETCH_SOURCES comment
 * and docs/11 §2 item 10 (no contact column exists in the catalogued schema).
 */

import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { agentGraphSchema, type FetchSourceId } from '@sap/agent-graph';
import * as agentDbSchema from '@sap/agent-graph/db-schema';
import { db } from '../db/client.js';
import { withAgentMcp } from '../mcp/client.js';
import { agentQueue } from '../queue/queue.js';

const FETCH_SOURCE_SQL: Partial<Record<FetchSourceId, string>> = {
  students_absent_today: `
    SELECT s.studentid AS student_id, s.studentname AS student_name,
           s.classname AS class, s.sectionname AS section,
           (SELECT COUNT(DISTINCT a2.attendancedate)
              FROM student_attendance_data_set a2
             WHERE a2.studentid = s.studentid
               AND a2.statusname = 'Absent'
               AND a2.attendancedate BETWEEN DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 6 DAY), '%Y-%m-%d')
                                          AND DATE_FORMAT(CURDATE(), '%Y-%m-%d')
           ) AS consecutive_days
      FROM (
        SELECT DISTINCT studentid, studentname, classname, sectionname
          FROM student_attendance_data_set
         WHERE attendancedate = DATE_FORMAT(CURDATE(), '%Y-%m-%d')
           AND statusname = 'Absent'
      ) s
  `.trim(),
};

interface FetchedRow {
  student_id: number | string;
  student_name: string;
  class: string;
  section: string;
  consecutive_days: number;
}

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

    for (const raw of result.rows) {
      const row = raw as unknown as FetchedRow;
      matched += 1;

      const recordRef = {
        student_id: row.student_id,
        student_name: row.student_name,
        class: row.class,
        section: row.section,
        parent_phone: null as string | null,
        consecutive_days: row.consecutive_days,
      };

      /** docs/07 §3: "auto-derived DEDUP KEY (agent+node+record+date)". */
      const dedupKey = `${fetchNode.id}:${String(row.student_id)}:${today}`;
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
