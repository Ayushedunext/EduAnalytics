/**
 * Workflow Agents — CRUD, publish, dry-run test, and the fleet view the Home
 * screen's "Agents" nav item opens into (docs/07, ADR-022 through ADR-025).
 *
 * -- Division of labour with apps/agent-runtime -------------------------------
 * This service owns everything an admin does WITH an agent while looking at a
 * screen: create, edit the draft graph, publish (which validates + versions +
 * schedules), pause/resume, test-run (dry, sends nothing), and read run
 * history. It never executes a graph — apps/agent-runtime is the only process
 * that does that, consuming the same `agents`/`agent_versions`/`agent_runs`
 * rows this service writes, via the same `@sap/agent-graph` Drizzle schema
 * (CODING_GUIDELINES §9). Publishing is the handoff: it writes an immutable
 * `agent_versions` row and calls `syncAgentSchedule`, which is a BullMQ
 * PRODUCER call (../queue/agent-queue.ts) — nothing here processes a job.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import {
  AGENT_TEMPLATES,
  FETCH_SOURCE_SQL,
  SEED_APPROVED_TEMPLATE_IDS,
  agentGraphSchema,
  findTemplate,
  validateGraph,
  type AgentGraph,
  type ChannelId,
} from '@sap/agent-graph';
import * as agentDbSchema from '@sap/agent-graph/db-schema';
import { ERROR_CODES, PlatformError, type Role } from '@sap/shared';
import { agentsDb } from '../db/agents-db.js';
import { readChannels } from './channels.js';
import { auditSink } from '../db/audit.js';
import { syncAgentSchedule, enqueueImmediateEvaluation } from '../queue/agent-queue.js';
import { withMcp, type RunMultiResult } from '../mcp/client.js';
import type { SessionClaims } from '../auth/session.js';

/** Informational only — real enforcement is apps/agent-runtime's guardrails.ts
 * (its own config, potentially per-deployment). ADR-025's own worked example. */
const DEFAULT_DAILY_MESSAGE_CAP_PER_SCHOOL = 2000;

function requireOwnership(agent: { orgId: string } | undefined, orgId: string, correlationId: string): asserts agent {
  if (agent === undefined || agent.orgId !== orgId) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'That agent does not exist.',
      correlationId,
    });
  }
}

// ---------------------------------------------------------------------------
// Fleet view (Agents Home)
// ---------------------------------------------------------------------------

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly status: 'draft' | 'active' | 'paused';
  readonly schedule_label: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string | null;
}

export interface AgentsHomeResponse {
  readonly kpis: {
    readonly active_agents: number;
    readonly runs_this_week: number;
    readonly success_rate_pct: number | null;
    readonly messages_today: number;
    readonly messages_cap: number;
  };
  readonly agents: readonly AgentSummary[];
  readonly templates: readonly {
    readonly id: string;
    readonly title: string;
    readonly blurb: string;
    readonly icon: string;
    readonly runnable: boolean;
  }[];
}

export async function readAgentsHome(
  orgId: string,
  scope: readonly { school_id: string; school_name: string }[],
): Promise<AgentsHomeResponse> {
  const schoolIdSet = new Set(scope.map((s) => s.school_id));

  const rows = await agentsDb
    .select()
    .from(agentDbSchema.agents)
    .where(and(eq(agentDbSchema.agents.orgId, orgId), isNull(agentDbSchema.agents.deletedAt)));

  const inScope = rows.filter((r) => r.schoolIds.some((id) => schoolIdSet.has(id)));
  const agentIds = inScope.map((a) => a.id);

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentRuns =
    agentIds.length === 0
      ? []
      : await agentsDb
          .select({ status: agentDbSchema.agentRuns.status, agentId: agentDbSchema.agentRuns.agentId })
          .from(agentDbSchema.agentRuns)
          .where(gte(agentDbSchema.agentRuns.startedAt, weekAgo));
  const runsForOrg = recentRuns.filter((r) => agentIds.includes(r.agentId));
  const finished = runsForOrg.filter((r) => r.status === 'completed' || r.status === 'failed');
  const successRate = finished.length === 0 ? null : Math.round((finished.filter((r) => r.status === 'completed').length / finished.length) * 1000) / 10;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const sentToday =
    agentIds.length === 0
      ? []
      : await agentsDb
          .select({ schoolId: agentDbSchema.messageLog.schoolId })
          .from(agentDbSchema.messageLog)
          .where(and(eq(agentDbSchema.messageLog.status, 'sent'), gte(agentDbSchema.messageLog.sentAt, todayStart)));

  const summaries: AgentSummary[] = [];
  for (const agent of inScope) {
    const [lastRun] = await agentsDb
      .select({ status: agentDbSchema.agentRuns.status, startedAt: agentDbSchema.agentRuns.startedAt })
      .from(agentDbSchema.agentRuns)
      .where(eq(agentDbSchema.agentRuns.agentId, agent.id))
      .orderBy(desc(agentDbSchema.agentRuns.startedAt))
      .limit(1);

    const [version] =
      agent.currentVersion === 0
        ? []
        : await agentsDb
            .select({ scheduleJson: agentDbSchema.agentVersions.scheduleJson })
            .from(agentDbSchema.agentVersions)
            .where(and(eq(agentDbSchema.agentVersions.agentId, agent.id), eq(agentDbSchema.agentVersions.version, agent.currentVersion)));

    const scheduleLabel =
      version?.scheduleJson !== undefined && version.scheduleJson !== null && typeof version.scheduleJson === 'object'
        ? ((version.scheduleJson as Record<string, unknown>)['label'] as string | undefined) ?? null
        : null;

    summaries.push({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      schedule_label: scheduleLabel,
      last_run_at: lastRun?.startedAt?.toISOString() ?? null,
      last_run_status: lastRun?.status ?? null,
    });
  }

  return {
    kpis: {
      active_agents: inScope.filter((a) => a.status === 'active').length,
      runs_this_week: runsForOrg.length,
      success_rate_pct: successRate,
      messages_today: sentToday.length,
      messages_cap: DEFAULT_DAILY_MESSAGE_CAP_PER_SCHOOL * Math.max(scope.length, 1),
    },
    agents: summaries,
    templates: AGENT_TEMPLATES.map((t) => ({ id: t.id, title: t.title, blurb: t.blurb, icon: t.icon, runnable: t.runnable })),
  };
}

// ---------------------------------------------------------------------------
// Create / read / edit draft
// ---------------------------------------------------------------------------

export interface AgentDetail {
  readonly id: string;
  readonly name: string;
  readonly status: 'draft' | 'active' | 'paused';
  readonly school_ids: readonly string[];
  readonly current_version: number;
  readonly graph: AgentGraph | Record<string, unknown>;
}

export async function createAgent(args: {
  orgId: string;
  actorSub: string;
  name: string;
  schoolIds: readonly string[];
  templateId?: string;
}): Promise<AgentDetail> {
  const id = randomUUID();
  const template = args.templateId !== undefined ? findTemplate(args.templateId) : undefined;
  const graph = template?.buildGraph() ?? { nodes: [], edges: [] };

  await agentsDb.insert(agentDbSchema.agents).values({
    id,
    orgId: args.orgId,
    schoolIds: [...args.schoolIds],
    name: args.name,
    status: 'draft',
    createdBy: args.actorSub,
    draftGraphJson: graph,
  });

  return { id, name: args.name, status: 'draft', school_ids: args.schoolIds, current_version: 0, graph };
}

export async function getAgent(orgId: string, agentId: string, correlationId: string): Promise<AgentDetail> {
  const [agent] = await agentsDb.select().from(agentDbSchema.agents).where(eq(agentDbSchema.agents.id, agentId));
  requireOwnership(agent, orgId, correlationId);

  let graph: AgentGraph | Record<string, unknown> = { nodes: [], edges: [] };
  if (agent.draftGraphJson !== null && agent.draftGraphJson !== undefined) {
    graph = agent.draftGraphJson as Record<string, unknown>;
  } else if (agent.currentVersion > 0) {
    const [version] = await agentsDb
      .select({ graphJson: agentDbSchema.agentVersions.graphJson })
      .from(agentDbSchema.agentVersions)
      .where(and(eq(agentDbSchema.agentVersions.agentId, agentId), eq(agentDbSchema.agentVersions.version, agent.currentVersion)));
    if (version !== undefined) graph = version.graphJson as Record<string, unknown>;
  }

  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    school_ids: agent.schoolIds,
    current_version: agent.currentVersion,
    graph,
  };
}

export async function updateAgentDraft(args: {
  orgId: string;
  agentId: string;
  correlationId: string;
  name?: string;
  schoolIds?: readonly string[];
  graph: Record<string, unknown>;
}): Promise<void> {
  const [agent] = await agentsDb.select().from(agentDbSchema.agents).where(eq(agentDbSchema.agents.id, args.agentId));
  requireOwnership(agent, args.orgId, args.correlationId);

  await agentsDb
    .update(agentDbSchema.agents)
    .set({
      draftGraphJson: args.graph,
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.schoolIds === undefined ? {} : { schoolIds: [...args.schoolIds] }),
    })
    .where(eq(agentDbSchema.agents.id, args.agentId));
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

function scheduleFromGraph(graph: AgentGraph): { cron: string; tz: string; label: string } | null {
  const trigger = graph.nodes.find((n) => n.data.kind === 'schedule');
  if (trigger === undefined || trigger.data.kind !== 'schedule') return null;
  return { cron: trigger.data.cron, tz: trigger.data.tz, label: trigger.data.label };
}

export async function publishAgent(args: {
  orgId: string;
  agentId: string;
  actorSub: string;
  role: Role;
  perms: readonly string[];
  correlationId: string;
}): Promise<AgentDetail> {
  const [agent] = await agentsDb.select().from(agentDbSchema.agents).where(eq(agentDbSchema.agents.id, args.agentId));
  requireOwnership(agent, args.orgId, args.correlationId);

  const parsed = agentGraphSchema.safeParse(agent.draftGraphJson);
  if (!parsed.success) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'This flow is not complete enough to publish yet.',
      correlationId: args.correlationId,
    });
  }
  const graph = parsed.data;

  /**
   * Flow lint (docs/07 §6) needs connected-channel state PER SCHOOL this
   * agent deploys to; a channel referenced by a message node must be
   * connected for every one of them, or publishing would silently under-serve
   * whichever school lacks it. Intersecting is the conservative reading of
   * "publishing an agent that references a disconnected channel is refused"
   * (ADR-024) when an agent spans more than one school.
   */
  let connectedEverywhere: Set<ChannelId> | null = null;
  for (const schoolId of agent.schoolIds) {
    const rows = await readChannels(args.orgId, [{ school_id: schoolId, school_name: schoolId }]);
    const connected = new Set(rows.filter((r) => r.status === 'connected').map((r) => r.channel));
    connectedEverywhere = connectedEverywhere === null ? connected : intersect(connectedEverywhere, connected);
  }

  const lint = validateGraph(graph, {
    connectedChannels: connectedEverywhere ?? new Set(),
    approvedTemplateIds: new Set(SEED_APPROVED_TEMPLATE_IDS),
  });
  if (!lint.ok) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: lint.errors[0]?.message ?? 'This flow has a problem.',
      details: { error_count: lint.errors.length },
      diagnostics: { errors: lint.errors },
      correlationId: args.correlationId,
    });
  }

  const nextVersion = agent.currentVersion + 1;
  const schedule = scheduleFromGraph(graph);

  await agentsDb.insert(agentDbSchema.agentVersions).values({
    agentId: args.agentId,
    version: nextVersion,
    graphJson: graph,
    scheduleJson: schedule ?? { kind: 'manual' },
    publishedRole: args.role,
    publishedPerms: [...args.perms],
    publishedBy: args.actorSub,
  });

  await agentsDb
    .update(agentDbSchema.agents)
    .set({ currentVersion: nextVersion, status: 'active', consecutiveFailures: 0 })
    .where(eq(agentDbSchema.agents.id, args.agentId));

  await syncAgentSchedule(args.agentId, schedule);

  await auditSink.write({
    kind: 'config.changed',
    at: new Date().toISOString(),
    actor_sub: args.actorSub,
    org_id: args.orgId,
    correlation_id: args.correlationId,
    subject: 'agent',
    action: 'published',
    summary: `${agent.name} published as v${nextVersion}`,
  });

  return getAgent(args.orgId, args.agentId, args.correlationId);
}

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set([...a].filter((x) => b.has(x)));
}

// ---------------------------------------------------------------------------
// Pause / resume
// ---------------------------------------------------------------------------

export async function setAgentActive(args: {
  orgId: string;
  agentId: string;
  actorSub: string;
  active: boolean;
  correlationId: string;
}): Promise<void> {
  const [agent] = await agentsDb.select().from(agentDbSchema.agents).where(eq(agentDbSchema.agents.id, args.agentId));
  requireOwnership(agent, args.orgId, args.correlationId);
  if (agent.currentVersion === 0) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Publish this agent before turning it on.',
      correlationId: args.correlationId,
    });
  }

  await agentsDb
    .update(agentDbSchema.agents)
    .set({ status: args.active ? 'active' : 'paused', ...(args.active ? { consecutiveFailures: 0 } : {}) })
    .where(eq(agentDbSchema.agents.id, args.agentId));

  if (args.active) {
    const [version] = await agentsDb
      .select({ scheduleJson: agentDbSchema.agentVersions.scheduleJson })
      .from(agentDbSchema.agentVersions)
      .where(and(eq(agentDbSchema.agentVersions.agentId, args.agentId), eq(agentDbSchema.agentVersions.version, agent.currentVersion)));
    const schedule = version?.scheduleJson as { kind: string; cron?: string; tz?: string } | undefined;
    await syncAgentSchedule(args.agentId, schedule?.kind === 'schedule' ? { cron: schedule.cron ?? '', tz: schedule.tz ?? 'Asia/Kolkata' } : null);
  } else {
    await syncAgentSchedule(args.agentId, null);
  }

  await auditSink.write({
    kind: 'config.changed',
    at: new Date().toISOString(),
    actor_sub: args.actorSub,
    org_id: args.orgId,
    correlation_id: args.correlationId,
    subject: 'agent',
    action: args.active ? 'resumed' : 'paused',
    summary: `${agent.name} ${args.active ? 'resumed' : 'paused'}`,
  });
}

// ---------------------------------------------------------------------------
// Test run (dry — sends nothing)
// ---------------------------------------------------------------------------

export interface TestRunResult {
  readonly matched_count: number;
  readonly sample: readonly Record<string, unknown>[];
  readonly note: string;
}

/**
 * The builder's "Test run (dry — sends nothing)" button. Evaluates the
 * draft's fetch node against TODAY's real data on the replica, through the
 * SAME MCP tool surface a published agent's trigger evaluator uses — but
 * under the live admin's own session/scope, and creates no `agent_runs` row
 * and sends no message. docs/07 §6.
 */
export async function testRunAgent(args: {
  orgId: string;
  agentId: string;
  session: SessionClaims;
  correlationId: string;
}): Promise<TestRunResult> {
  const [agent] = await agentsDb.select().from(agentDbSchema.agents).where(eq(agentDbSchema.agents.id, args.agentId));
  requireOwnership(agent, args.orgId, args.correlationId);

  const parsed = agentGraphSchema.safeParse(agent.draftGraphJson);
  const fetchNode = parsed.success ? parsed.data.nodes.find((n) => n.data.kind === 'fetch_records') : undefined;
  const sql = fetchNode?.data.kind === 'fetch_records' ? FETCH_SOURCE_SQL[fetchNode.data.source] : undefined;
  if (sql === undefined) {
    return { matched_count: 0, sample: [], note: 'This data source cannot be test-run yet.' };
  }

  const targetSchools = agent.schoolIds.filter((id) => args.session.school_ids.includes(id));
  if (targetSchools.length === 0) {
    return { matched_count: 0, sample: [], note: 'None of this agent’s schools are in your current scope.' };
  }

  const result = await withMcp(args.session, args.correlationId, targetSchools, (mcp) =>
    mcp.call<RunMultiResult>('run_multi', { school_ids: targetSchools, sql, merge: 'tagged_union' }),
  );

  return {
    matched_count: result.rows.length,
    sample: result.rows.slice(0, 10),
    note: 'Sends nothing. Counts and sample rows are live, read from the replica just now.',
  };
}

// ---------------------------------------------------------------------------
// Runs & history
// ---------------------------------------------------------------------------

export async function listAgentRuns(orgId: string, agentId: string, correlationId: string) {
  const [agent] = await agentsDb.select().from(agentDbSchema.agents).where(eq(agentDbSchema.agents.id, agentId));
  requireOwnership(agent, orgId, correlationId);

  return agentsDb
    .select()
    .from(agentDbSchema.agentRuns)
    .where(eq(agentDbSchema.agentRuns.agentId, agentId))
    .orderBy(desc(agentDbSchema.agentRuns.startedAt))
    .limit(50);
}

export async function getRunSteps(orgId: string, agentId: string, runId: string, correlationId: string) {
  const [agent] = await agentsDb.select().from(agentDbSchema.agents).where(eq(agentDbSchema.agents.id, agentId));
  requireOwnership(agent, orgId, correlationId);

  return agentsDb.select().from(agentDbSchema.runSteps).where(eq(agentDbSchema.runSteps.runId, runId));
}

export { enqueueImmediateEvaluation };
