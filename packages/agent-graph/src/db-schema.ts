/**
 * Drizzle schema for the agent + channel tables.
 *
 * Single source of truth for both writers: `apps/orchestrator`'s
 * `services/agents.ts`/`services/channels.ts` (CRUD, builder API) and
 * `apps/agent-runtime` (scheduler, evaluator, runner) both import this rather
 * than each declaring their own column shapes — CODING_GUIDELINES §9's
 * 2026-09-15 ORM decision names this file specifically for exactly that
 * reason.
 *
 * This is a QUERY-LAYER schema, not the migration source of truth: the actual
 * DDL lives in `db/platform/migrations/0008_org_channels.sql` and
 * `0009_agents.sql`, hand-written in this project's existing style (no
 * drizzle-kit migration generation — see docs/11's 2026-09-15 entry: Drizzle
 * was chosen specifically because it layers onto hand-written SQL migrations
 * without imposing its own). Keep the two in sync by hand; a mismatch shows up
 * immediately as a query against a column that does not exist.
 */

import {
  bigint,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';

/**
 * `school_channels` predates this package (migration 0005, ADR-024) and its
 * writes still go through apps/orchestrator's hand-written mysql2 SQL
 * (services/channels.ts `disconnectChannel`) — this definition exists so
 * apps/agent-runtime can READ it at send time via the same Drizzle handle it
 * already has, through the shared `resolveChannel` function (ADR-034), not to
 * migrate its writer.
 */
export const schoolChannels = mysqlTable('school_channels', {
  schoolId: varchar('school_id', { length: 128 }).notNull(),
  channel: mysqlEnum('channel', ['email', 'sms', 'whatsapp']).notNull(),
  status: mysqlEnum('status', ['connected', 'not_connected']).notNull().default('not_connected'),
  provider: varchar('provider', { length: 128 }),
  detail: varchar('detail', { length: 255 }),
  updatedBy: varchar('updated_by', { length: 128 }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const orgChannels = mysqlTable('org_channels', {
  orgId: varchar('org_id', { length: 128 }).notNull(),
  channel: mysqlEnum('channel', ['email', 'sms', 'whatsapp']).notNull(),
  status: mysqlEnum('status', ['connected', 'not_connected']).notNull().default('not_connected'),
  provider: varchar('provider', { length: 128 }),
  detail: varchar('detail', { length: 255 }),
  updatedBy: varchar('updated_by', { length: 128 }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const agents = mysqlTable('agents', {
  id: varchar('id', { length: 64 }).primaryKey(),
  orgId: varchar('org_id', { length: 128 }).notNull(),
  schoolIds: json('school_ids').$type<string[]>().notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  status: mysqlEnum('status', ['draft', 'active', 'paused']).notNull().default('draft'),
  currentVersion: int('current_version').notNull().default(0),
  draftGraphJson: json('draft_graph_json'),
  draftScheduleJson: json('draft_schedule_json'),
  consecutiveFailures: int('consecutive_failures').notNull().default(0),
  createdBy: varchar('created_by', { length: 128 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

export const agentVersions = mysqlTable('agent_versions', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  agentId: varchar('agent_id', { length: 64 }).notNull(),
  version: int('version').notNull(),
  /** Validated against `@sap/agent-graph`'s `agentGraphSchema` before this row
   * is ever written — see services/agents.ts `publishAgent`. */
  graphJson: json('graph_json').notNull(),
  scheduleJson: json('schedule_json').notNull(),
  publishedRole: mysqlEnum('published_role', [
    'DIRECTOR',
    'PRINCIPAL',
    'TEACHER',
    'ACCOUNTANT',
    'ADMIN',
  ]).notNull(),
  publishedPerms: json('published_perms').$type<string[]>().notNull(),
  publishedBy: varchar('published_by', { length: 128 }).notNull(),
  publishedAt: timestamp('published_at').notNull().defaultNow(),
});

export const agentRuns = mysqlTable('agent_runs', {
  runId: varchar('run_id', { length: 64 }).primaryKey(),
  agentId: varchar('agent_id', { length: 64 }).notNull(),
  agentVersionId: bigint('agent_version_id', { mode: 'number', unsigned: true }).notNull(),
  schoolId: varchar('school_id', { length: 128 }).notNull(),
  recordRef: json('record_ref').$type<Record<string, unknown>>().notNull(),
  dedupKey: varchar('dedup_key', { length: 255 }).notNull(),
  status: mysqlEnum('status', ['running', 'waiting', 'completed', 'failed']).notNull().default('running'),
  currentNodeId: varchar('current_node_id', { length: 128 }),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  finishedAt: timestamp('finished_at'),
});

export const runSteps = mysqlTable('run_steps', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  runId: varchar('run_id', { length: 64 }).notNull(),
  nodeId: varchar('node_id', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['pending', 'running', 'succeeded', 'failed', 'skipped'])
    .notNull()
    .default('pending'),
  payloadIn: json('payload_in').$type<Record<string, unknown> | null>(),
  payloadOut: json('payload_out').$type<Record<string, unknown> | null>(),
  error: varchar('error', { length: 255 }),
  ts: timestamp('ts').notNull().defaultNow(),
});

export const messageLog = mysqlTable('message_log', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  runId: varchar('run_id', { length: 64 }).notNull(),
  runStepId: bigint('run_step_id', { mode: 'number', unsigned: true }).notNull(),
  schoolId: varchar('school_id', { length: 128 }).notNull(),
  channel: mysqlEnum('channel', ['email', 'sms', 'whatsapp']).notNull(),
  templateId: varchar('template_id', { length: 128 }),
  /** Contact PII — see 0009_agents.sql header note. Never logged operationally. */
  recipient: varchar('recipient', { length: 255 }).notNull(),
  status: mysqlEnum('status', [
    'sent',
    'failed',
    'skipped_dedup',
    'skipped_quiet_hours',
    'skipped_cap',
    'skipped_guardrail',
  ]).notNull(),
  providerRef: varchar('provider_ref', { length: 255 }),
  error: varchar('error', { length: 255 }),
  sentAt: timestamp('sent_at').notNull().defaultNow(),
});
