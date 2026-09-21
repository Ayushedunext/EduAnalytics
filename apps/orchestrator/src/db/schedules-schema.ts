/**
 * Drizzle schema for the schedule tables (ADR-037).
 *
 * -- Why here and not in a shared package ------------------------------------
 * `@sap/agent-graph/db-schema` holds the agent and channel tables because TWO
 * services write them and CODING_GUIDELINES §9 requires one definition when
 * that is true. Schedules have exactly one owner: this service creates them,
 * fires them and renders them, and apps/agent-runtime never touches them. §9's
 * other half — "platform-owned DBs are accessed by their owning service only" —
 * is the rule that applies, and putting a single-owner table in a shared
 * package would advertise a seam that does not exist.
 *
 * As with `db-schema.ts`, this is the QUERY layer, not the migration source of
 * truth: the DDL is `db/platform/migrations/0010_report_schedules.sql`,
 * hand-written in this project's existing style. Keep the two in step by hand;
 * a mismatch surfaces immediately as a query against a column that is not there.
 */

import { bigint, char, int, json, mysqlEnum, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';
import type { Role } from '@sap/shared';

/** `Date#getDay` numbering — 0 = Sunday. One numbering, SPA to cron. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const reportSchedules = mysqlTable('report_schedules', {
  id: varchar('id', { length: 64 }).primaryKey(),
  orgId: varchar('org_id', { length: 128 }).notNull(),
  reportId: varchar('report_id', { length: 128 }).notNull(),
  reportKind: mysqlEnum('report_kind', ['predefined', 'custom']).notNull().default('predefined'),
  reportTitle: varchar('report_title', { length: 255 }).notNull(),
  /** Captured from the creator's verified token; re-validated at send time (ADR-037). */
  schoolIds: json('school_ids').$type<string[]>().notNull(),
  days: json('days').$type<Weekday[]>().notNull(),
  timeOfDay: char('time_of_day', { length: 5 }).notNull(),
  tz: varchar('tz', { length: 64 }).notNull().default('Asia/Kolkata'),
  channel: mysqlEnum('channel', ['email', 'whatsapp']).notNull().default('email'),
  /** Contact PII — see the migration's header note. Never logged operationally. */
  recipient: varchar('recipient', { length: 255 }).notNull(),
  status: mysqlEnum('status', ['active', 'paused']).notNull().default('active'),
  createdRole: mysqlEnum('created_role', ['DIRECTOR', 'PRINCIPAL', 'TEACHER', 'ACCOUNTANT', 'ADMIN'])
    .$type<Role>()
    .notNull(),
  createdPerms: json('created_perms').$type<string[]>().notNull(),
  createdBy: varchar('created_by', { length: 128 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

export const scheduleDeliveries = mysqlTable('schedule_deliveries', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  scheduleId: varchar('schedule_id', { length: 64 }).notNull(),
  orgId: varchar('org_id', { length: 128 }).notNull(),
  /** The scope actually used, AFTER re-validation — not the schedule's stored set. */
  schoolIds: json('school_ids').$type<string[]>().notNull(),
  channel: mysqlEnum('channel', ['email', 'whatsapp']).notNull(),
  recipient: varchar('recipient', { length: 255 }).notNull(),
  triggerKind: mysqlEnum('trigger_kind', ['schedule', 'manual']).notNull().default('schedule'),
  status: mysqlEnum('status', [
    'sent',
    'failed',
    'skipped_scope_empty',
    'skipped_channel_not_connected',
    'skipped_paused',
  ]).notNull(),
  providerRef: varchar('provider_ref', { length: 255 }),
  error: varchar('error', { length: 255 }),
  durationMs: int('duration_ms', { unsigned: true }),
  sentAt: timestamp('sent_at').notNull().defaultNow(),
});
