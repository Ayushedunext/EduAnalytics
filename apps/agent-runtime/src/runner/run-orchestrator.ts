/**
 * The run orchestrator — walks one run's graph as a PERSISTED STATE MACHINE
 * (ADR-022). Every step forward is committed to `run_steps`/`agent_runs`
 * before moving on, so a crash mid-walk resumes from the last completed node
 * rather than losing progress or re-running a completed step.
 *
 * [MANDATORY] CODING_GUIDELINES §5: a Wait node becomes a DELAYED QUEUE JOB
 * (`agentQueue.add('advance-run', ..., { delay })`), never a `setTimeout` or a
 * sleeping thread — the process can restart between now and the wait firing
 * and nothing is lost, because the job lives in Redis and the run's position
 * lives in `agent_runs.current_node_id`, not in this function's call stack.
 *
 * [MANDATORY] CODING_GUIDELINES §11: a guardrail block or a provider failure
 * is a structured `run_steps.error` + `message_log` row, never a thrown
 * exception that aborts the walk — the run still reaches an End node.
 */

import { eq } from 'drizzle-orm';
import {
  agentGraphSchema,
  isMessageAction,
  type AgentGraph,
  type AgentNode,
} from '@sap/agent-graph';
import * as agentDbSchema from '@sap/agent-graph/db-schema';
import { db } from '../db/client.js';
import { checkGuardrails, recordRunOutcome } from '../guardrails/guardrails.js';
import { agentQueue } from '../queue/queue.js';

type RunRow = typeof agentDbSchema.agentRuns.$inferSelect;

export async function advanceRun(runId: string): Promise<void> {
  const [run] = await db.select().from(agentDbSchema.agentRuns).where(eq(agentDbSchema.agentRuns.runId, runId));
  if (run === undefined || run.status === 'completed' || run.status === 'failed') return;

  const [version] = await db
    .select()
    .from(agentDbSchema.agentVersions)
    .where(eq(agentDbSchema.agentVersions.id, run.agentVersionId));
  if (version === undefined) {
    await failRun(run, 'agent version no longer exists');
    return;
  }

  const graph = agentGraphSchema.parse(version.graphJson);
  const outgoing = buildOutgoingIndex(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const startNodeId = run.currentNodeId;
  if (startNodeId === null) {
    await failRun(run, 'run has no starting node');
    return;
  }
  /**
   * Explicitly typed `string`, not inferred: TS widens a loop-reassigned `let`
   * back to its declared type on each back-edge, and the declared type of
   * `run.currentNodeId` is `string | null`. Fixing the annotation here — once
   * — is what lets every use of `currentNodeId` inside the loop below stay a
   * plain `string`.
   */
  let currentNodeId: string = startNodeId;

  // Walk forward one node at a time, persisting after each step, until an End
  // node, a Wait node (which returns early — the queue resumes this run), or
  // a structural problem (no single next node) is reached.
  for (;;) {
    const nextIds = outgoing.get(currentNodeId) ?? [];
    if (nextIds.length === 0) {
      await failRun(run, `node "${currentNodeId}" has no outgoing edge — flow linting should have caught this`);
      return;
    }

    const nodeId = nextIds.length === 1 ? nextIds[0] : await pickBranch(byId, currentNodeId, run, nextIds, graph);
    if (nodeId === undefined) {
      await failRun(run, `branch node "${currentNodeId}" produced no matching edge`);
      return;
    }
    const node = byId.get(nodeId);
    if (node === undefined) {
      await failRun(run, `edge points at unknown node "${nodeId}"`);
      return;
    }

    if (node.data.kind === 'end' || node.data.kind === 'escalate_end') {
      const stepId = await createStep(run.runId, nodeId);
      await finalizeStep(stepId, 'succeeded', null, null);
      await completeRun(run);
      return;
    }

    if (node.data.kind === 'wait') {
      const delayMs = computeWaitDelayMs(node.data);
      const stepId = await createStep(run.runId, nodeId);
      await finalizeStep(stepId, 'succeeded', null, { delay_ms: delayMs });
      await db
        .update(agentDbSchema.agentRuns)
        .set({ status: 'waiting', currentNodeId: nodeId })
        .where(eq(agentDbSchema.agentRuns.runId, run.runId));
      await agentQueue.add('advance-run', { kind: 'advance-run', runId: run.runId }, { delay: delayMs });
      return;
    }

    /**
     * The step row is created BEFORE execution, not after: `executeNode` may
     * write a `message_log` row that foreign-keys to this step
     * (`insertMessageLog`), so the step must already exist. It starts
     * `running` and is finalized with the real outcome once execution
     * returns — a crash between the two leaves an honestly-`running` step
     * rather than no record at all.
     */
    const stepId = await createStep(run.runId, nodeId);
    const outcome = await executeNode(node, run, stepId);
    await finalizeStep(stepId, outcome.status, outcome.payloadIn ?? null, outcome.payloadOut ?? null, outcome.error);

    currentNodeId = nodeId;
    await db
      .update(agentDbSchema.agentRuns)
      .set({ currentNodeId })
      .where(eq(agentDbSchema.agentRuns.runId, run.runId));
  }
}

/**
 * Plain target lists, for the single-next-node walk above. A node with more
 * than one outgoing edge (only `if_else` today) is resolved by `pickBranch`,
 * which re-reads `graph.edges` directly for the branch label — this index
 * only answers "how many ways out does this node have".
 */
function buildOutgoingIndex(graph: AgentGraph): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = map.get(edge.source) ?? [];
    list.push(edge.target);
    map.set(edge.source, list);
  }
  return map;
}

async function pickBranch(
  byId: Map<string, AgentNode>,
  currentNodeId: string,
  run: RunRow,
  candidateIds: string[],
  graph: AgentGraph,
): Promise<string | undefined> {
  const node = byId.get(currentNodeId);
  if (node?.data.kind !== 'if_else') return candidateIds[0];

  const record = run.recordRef as Record<string, unknown>;
  const fieldValue = record[node.data.field];
  const result = compare(fieldValue, node.data.op, node.data.value);
  const wantedBranch = result ? 'true' : 'false';

  const edge = graph.edges.find((e) => e.source === currentNodeId && e.branch === wantedBranch);
  return edge?.target;
}

function compare(a: unknown, op: string, b: string | number): boolean {
  const left = typeof a === 'number' ? a : Number(a);
  const right = typeof b === 'number' ? b : Number(b);
  switch (op) {
    case '>=':
      return left >= right;
    case '>':
      return left > right;
    case '<=':
      return left <= right;
    case '<':
      return left < right;
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    default:
      return false;
  }
}

function computeWaitDelayMs(data: { mode: string; minutes?: number | undefined; until_time?: string | undefined }): number {
  if (data.mode === 'duration') return (data.minutes ?? 60) * 60_000;

  // 'until_time': minutes remaining today in Asia/Kolkata until HH:mm, or
  // until that time tomorrow if it has already passed.
  const [hh, mm] = (data.until_time ?? '14:00').split(':').map(Number);
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const currentHour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const currentMinute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const nowMinutes = currentHour * 60 + currentMinute;
  const targetMinutes = (hh ?? 14) * 60 + (mm ?? 0);
  const diff = targetMinutes - nowMinutes;
  return (diff > 0 ? diff : diff + 24 * 60) * 60_000;
}

interface NodeOutcome {
  readonly status: 'succeeded' | 'failed' | 'skipped';
  readonly payloadIn?: Record<string, unknown>;
  readonly payloadOut?: Record<string, unknown>;
  readonly error?: string;
}

async function executeNode(node: AgentNode, run: RunRow, stepId: number): Promise<NodeOutcome> {
  switch (node.data.kind) {
    case 'dedup_guard':
      return { status: 'succeeded', payloadOut: { note: 'enforced at run creation via agent_runs.dedup_key (ADR-025)' } };

    case 'log':
      console.log(`[agent-runtime] run ${run.runId} log: ${node.data.message}`);
      return { status: 'succeeded', payloadOut: { message: node.data.message } };

    case 'notify_staff':
      // Internal notification only — no external provider dependency, so this
      // is genuinely implementable today, unlike the message channels below.
      console.log(`[agent-runtime] run ${run.runId} notify_staff(${node.data.role}): ${node.data.message}`);
      return { status: 'succeeded', payloadOut: { role: node.data.role, delivered: 'logged' } };

    case 'erp_notify':
      // Declared per docs/07 §2 but contingent on an ERP notification API that
      // is not a confirmed input (docs/11 §2 item 7) — refused at publish time
      // by validate.ts, so reaching this case is an internal inconsistency.
      return { status: 'failed', error: 'ERP notification API not available (docs/11 §2 item 7)' };

    default:
      if (isMessageAction(node.data)) return executeMessageAction(node, run, stepId);
      return { status: 'failed', error: `node kind "${node.data.kind}" has no executor` };
  }
}

async function executeMessageAction(node: AgentNode, run: RunRow, stepId: number): Promise<NodeOutcome> {
  if (!isMessageAction(node.data)) return { status: 'failed', error: 'not a message node' };

  const guard = await checkGuardrails({ schoolId: run.schoolId });
  const record = run.recordRef as Record<string, unknown>;
  const recipient = record['parent_phone'];

  const baseLog = {
    runId: run.runId,
    runStepId: stepId,
    schoolId: run.schoolId,
    channel: node.data.primary,
    templateId: node.data.template_id,
    recipient: typeof recipient === 'string' ? recipient : '(unknown)',
  };

  if (guard.blocked) {
    await insertMessageLog({ ...baseLog, status: guard.reason === 'quiet_hours' ? 'skipped_quiet_hours' : 'skipped_cap' });
    return { status: 'skipped', error: `guardrail: ${guard.reason}` };
  }

  if (typeof recipient !== 'string' || recipient === '') {
    /** docs/11 §2 item 10: no contact column exists in the catalogued schema
     * yet, so this fires for every real record today — see this file's
     * module doc and the trigger evaluator's. A structured, logged non-send,
     * never a fabricated phone number. */
    await insertMessageLog({ ...baseLog, status: 'failed', error: 'no parent contact information available (docs/11 §2 item 10)' });
    return { status: 'failed', error: 'no recipient contact information available' };
  }

  /**
   * No BSP/SMTP/DLT integration is wired yet (docs/11 §2 items 4/8 — provider
   * choice and whether the ERP already has a sender relationship are still
   * open). This is the one point in the whole pipeline where a real provider
   * call would go; everything upstream of it (guardrails, dedup, template
   * resolution, branch selection) is real and already exercised end to end in
   * dry-run.
   */
  await insertMessageLog({ ...baseLog, status: 'failed', error: 'messaging provider not yet connected (docs/11 §2 items 4/8)' });
  return { status: 'failed', error: 'messaging provider not yet connected' };
}

async function insertMessageLog(fields: {
  runId: string;
  runStepId: number;
  schoolId: string;
  channel: 'email' | 'sms' | 'whatsapp';
  templateId: string;
  recipient: string;
  status: 'sent' | 'failed' | 'skipped_dedup' | 'skipped_quiet_hours' | 'skipped_cap' | 'skipped_guardrail';
  error?: string;
}): Promise<void> {
  await db.insert(agentDbSchema.messageLog).values({
    runId: fields.runId,
    runStepId: fields.runStepId,
    schoolId: fields.schoolId,
    channel: fields.channel,
    templateId: fields.templateId,
    recipient: fields.recipient,
    status: fields.status,
    ...(fields.error === undefined ? {} : { error: fields.error }),
  });
}

async function createStep(runId: string, nodeId: string): Promise<number> {
  const [result] = await db.insert(agentDbSchema.runSteps).values({ runId, nodeId, status: 'running' });
  return result.insertId;
}

async function finalizeStep(
  stepId: number,
  status: 'succeeded' | 'failed' | 'skipped',
  payloadIn: Record<string, unknown> | null,
  payloadOut: Record<string, unknown> | null,
  error?: string,
): Promise<void> {
  await db
    .update(agentDbSchema.runSteps)
    .set({ status, payloadIn, payloadOut, ...(error === undefined ? {} : { error }) })
    .where(eq(agentDbSchema.runSteps.id, stepId));
}

async function completeRun(run: RunRow): Promise<void> {
  await db
    .update(agentDbSchema.agentRuns)
    .set({ status: 'completed', finishedAt: new Date() })
    .where(eq(agentDbSchema.agentRuns.runId, run.runId));
  await recordRunOutcome(run.agentId, true);
}

async function failRun(run: RunRow, reason: string): Promise<void> {
  console.error(`[agent-runtime] run ${run.runId} failed: ${reason}`);
  await db
    .update(agentDbSchema.agentRuns)
    .set({ status: 'failed', finishedAt: new Date() })
    .where(eq(agentDbSchema.agentRuns.runId, run.runId));
  await recordRunOutcome(run.agentId, false);
}
