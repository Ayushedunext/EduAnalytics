/**
 * Messaging channels — what each school can actually send on.
 *
 * Contract source: docs/07 §4 · ADR-024 ("messaging channels are school-owned;
 * approved-template-only sending") · docs/10 §2, "Settings — Messaging channels
 * (school)".
 *
 * -- Scope applies here too ----------------------------------------------------
 * A channel row belongs to a school, so reading or changing one is a school-data
 * question in every sense that matters for authorisation, even though the row
 * lives in the platform database. Callers pass the school ids the request
 * already resolved against the session (middleware/scope.ts), and this module
 * never widens them.
 *
 * -- What is NOT here ----------------------------------------------------------
 * Credentials — still, and that has not softened. What HAS changed (ADR-035) is
 * where the line falls for email. Connecting SMS means a DLT entity with a
 * registered sender id; WhatsApp means a BSP account with a verified WABA and
 * approved templates; each has its own vault, its own verification call and,
 * per docs/07 §4, its own multi-week provisioning programme. Email means a
 * host, a port and a from-address — and those are DEPLOYMENT configuration
 * (@sap/mailer, read from the environment), not a per-school secret. So this
 * module still records STATE only: `provider = 'SMTP'` says which transport
 * applies to a school, and says nothing about how to reach it. A "Connect"
 * button that captured a password would still be writing a secret into a table
 * with no encryption behind it, which is why the one below captures none.
 */

import type { RowDataPacket } from 'mysql2';
import { ERROR_CODES, PlatformError, type Role } from '@sap/shared';
import { SMTP_PROVIDER, resolveChannel, type ChannelRowState } from '@sap/agent-graph';
import { platformDb } from '../db/platform-db.js';
import { auditSink } from '../db/audit.js';
import { config } from '../config.js';

export const CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type ChannelId = (typeof CHANNELS)[number];

export function isChannelId(value: string): value is ChannelId {
  return (CHANNELS as readonly string[]).includes(value);
}

/** Display metadata, server-side, so screen and PDF cannot disagree (ADR-015). */
const CHANNEL_META: Record<ChannelId, { title: string; icon: string; requirement: string }> = {
  email: {
    title: 'Email (SMTP)',
    icon: '✉️',
    /**
     * Reworded 2026-09-21 (ADR-035). It used to read "needs the school's SMTP
     * host and a from-address", which described a per-school credential this
     * platform was never going to hold. The transport is the deployment's, so
     * what an admin is actually deciding here is whether this school sends
     * email at all.
     */
    requirement: 'Sends through the platform’s configured mail transport — no credentials needed here.',
  },
  sms: {
    title: 'SMS (DLT)',
    icon: '💬',
    requirement:
      'Needs a DLT-registered entity, an approved sender ID and approved templates (TRAI rules).',
  },
  whatsapp: {
    title: 'WhatsApp Business',
    icon: '📱',
    requirement: 'Needs a BSP account, a verified WABA and approved message templates.',
  },
};

export interface ChannelRow {
  readonly school_id: string;
  readonly school_name: string;
  readonly channel: ChannelId;
  readonly title: string;
  readonly icon: string;
  readonly status: 'connected' | 'not_connected';
  readonly detail: string | null;
  readonly requirement: string;
  /**
   * Which level this school's status actually resolved from (ADR-034):
   * `school` — this school has its own override row; `org` — falling back to
   * the trust default; `none` — neither is connected. Lets Settings show "via
   * trust default" instead of leaving an admin to guess why a channel they
   * never configured shows Connected.
   */
  readonly source: 'school' | 'org' | 'none';
}

/**
 * Effective channel resolution (ADR-034): a school's own `school_channels`
 * row wins when present; otherwise the org's `org_channels` default applies.
 * One function, called everywhere a channel's status matters (Settings, the
 * agent builder's flow lint, publish-time checks) — never re-derived inline,
 * for the same "one function, unit-tested" reason ADR-028 required of
 * `permission_class`.
 */
export async function readChannels(orgId: string, scope: readonly { school_id: string; school_name: string }[]): Promise<ChannelRow[]> {
  if (scope.length === 0) return [];

  const ids = scope.map((s) => s.school_id);
  const [schoolRows] = await platformDb.query<RowDataPacket[]>(
    `SELECT school_id, channel, status, provider, detail
       FROM school_channels
      WHERE school_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  const [orgRows] = await platformDb.query<RowDataPacket[]>(
    `SELECT channel, status, provider, detail FROM org_channels WHERE org_id = ?`,
    [orgId],
  );

  const bySchoolKey = new Map<string, RowDataPacket>();
  for (const row of schoolRows) bySchoolKey.set(`${String(row['school_id'])}:${String(row['channel'])}`, row);
  const byOrgChannel = new Map<string, RowDataPacket>();
  for (const row of orgRows) byOrgChannel.set(String(row['channel']), row);

  /**
   * Built from the CHANNEL list, not from the rows returned. A school with no
   * row for WhatsApp has not connected WhatsApp — that is a state to show, not a
   * record to omit. Rendering only what the table happens to contain would make
   * an unprovisioned channel invisible, which is the opposite of what an admin
   * needs to see (docs/10 §3, locked ≠ hidden).
   */
  const out: ChannelRow[] = [];
  for (const school of scope) {
    for (const channel of CHANNELS) {
      const meta = CHANNEL_META[channel];
      const effective = resolveChannel(
        toChannelRowState(bySchoolKey.get(`${school.school_id}:${channel}`)),
        toChannelRowState(byOrgChannel.get(channel)),
      );

      out.push({
        school_id: school.school_id,
        school_name: school.school_name,
        channel,
        title: meta.title,
        icon: meta.icon,
        status: effective.status,
        detail: effective.detail ?? effective.provider,
        requirement: meta.requirement,
        source: effective.source,
      });
    }
  }
  return out;
}

function toChannelRowState(row: RowDataPacket | undefined): ChannelRowState | undefined {
  if (row === undefined) return undefined;
  const provider = row['provider'];
  const detail = row['detail'];
  return {
    status: row['status'] === 'connected' ? 'connected' : 'not_connected',
    provider: provider === null || provider === undefined ? null : String(provider),
    detail: detail === null || detail === undefined ? null : String(detail),
  };
}

/** The set of channels connected (school override or org default) for one
 * school — what the agent builder's flow lint checks a message node against. */
export async function connectedChannelIds(orgId: string, schoolId: string): Promise<Set<ChannelId>> {
  const rows = await readChannels(orgId, [{ school_id: schoolId, school_name: schoolId }]);
  return new Set(rows.filter((r) => r.status === 'connected').map((r) => r.channel));
}

/**
 * Disconnect a channel.
 *
 * Admin-only, like the AI key: docs/08 §7 files "channel connect/disconnect"
 * under the same config-change heading as key save/replace, and a disconnect is
 * destructive in a way a report view is not — docs/07 §4 says a disconnect
 * "flags dependent agents until reconnected or edited", so one click can stop a
 * school's fee reminders going out.
 *
 * `connectChannel` below is its counterpart — for email only, for the reason
 * ADR-035 gives. SMS and WhatsApp still have none, and still for the original
 * reason: connecting them requires credentials this platform cannot yet hold
 * safely, and a button that flipped the flag without them would claim a school
 * can send messages it cannot.
 */
export async function disconnectChannel(args: {
  schoolId: string;
  channel: ChannelId;
  actorSub: string;
  orgId: string;
  role: Role;
  correlationId: string;
}): Promise<void> {
  if (args.role !== 'ADMIN') {
    throw new PlatformError({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: 'Contact your admin to change messaging channels.',
      details: { required_role: 'ADMIN' },
      correlationId: args.correlationId,
    });
  }

  await platformDb.query(
    `INSERT INTO school_channels (school_id, channel, status, provider, detail, updated_by)
     VALUES (?, ?, 'not_connected', NULL, NULL, ?)
     ON DUPLICATE KEY UPDATE
       status     = 'not_connected',
       provider   = NULL,
       detail     = NULL,
       updated_by = VALUES(updated_by)`,
    [args.schoolId, args.channel, args.actorSub],
  );

  await auditSink.write({
    kind: 'config.changed',
    at: new Date().toISOString(),
    actor_sub: args.actorSub,
    org_id: args.orgId,
    correlation_id: args.correlationId,
    subject: 'channel',
    action: 'disconnected',
    school_id: args.schoolId,
    summary: `${args.channel} disconnected`,
  });
}

/**
 * Connect a channel.
 *
 * Email only (ADR-035). This writes STATE — `status = 'connected'`,
 * `provider = 'SMTP'` — and captures nothing else, because there is nothing
 * else to capture: where the transport is and how to authenticate to it is
 * deployment configuration that the operator already holds, and which this
 * platform must never copy into a school row.
 *
 * SMS and WhatsApp are refused here rather than silently ignored. A button that
 * flipped the flag for WhatsApp would put a school one click from an agent that
 * publishes, fires, and fails at every send — the flow lint would pass, because
 * the lint reads exactly this state.
 *
 * Admin-only, like the AI key and like `disconnectChannel`: docs/08 §7 files
 * "channel connect/disconnect" under the same config-change heading as key
 * save/replace.
 */
export async function connectChannel(args: {
  schoolId: string;
  channel: ChannelId;
  actorSub: string;
  orgId: string;
  role: Role;
  correlationId: string;
}): Promise<void> {
  if (args.role !== 'ADMIN') {
    throw new PlatformError({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: 'Contact your admin to change messaging channels.',
      details: { required_role: 'ADMIN' },
      correlationId: args.correlationId,
    });
  }

  if (args.channel !== 'email') {
    throw new PlatformError({
      code: ERROR_CODES.CHANNEL_NOT_CONNECTED,
      message:
        args.channel === 'sms'
          ? 'SMS needs a DLT-registered entity and an approved sender ID before it can be connected.'
          : 'WhatsApp needs a verified Business account and approved message templates before it can be connected.',
      details: { channel: args.channel, blocked_by: 'docs/11 §2 items 4/8' },
      correlationId: args.correlationId,
    });
  }

  await platformDb.query(
    `INSERT INTO school_channels (school_id, channel, status, provider, detail, updated_by)
     VALUES (?, ?, 'connected', ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status     = 'connected',
       provider   = VALUES(provider),
       detail     = VALUES(detail),
       updated_by = VALUES(updated_by)`,
    [
      args.schoolId,
      args.channel,
      SMTP_PROVIDER,
      /**
       * The from-address, shown on the Settings row. ADR-035's trade-off is
       * that one deployment-wide address sends for every school until per-org
       * configuration exists, and it says that belongs on screen rather than
       * left for an admin to read off a received header.
       */
      `Sends from ${config.SMTP_FROM}`,
      args.actorSub,
    ],
  );

  await auditSink.write({
    kind: 'config.changed',
    at: new Date().toISOString(),
    actor_sub: args.actorSub,
    org_id: args.orgId,
    correlation_id: args.correlationId,
    subject: 'channel',
    action: 'connected',
    school_id: args.schoolId,
    summary: `${args.channel} connected (${SMTP_PROVIDER})`,
  });
}
