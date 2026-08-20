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
 * Credentials. Connecting a channel for real means an SMTP host and password, a
 * DLT entity with a registered sender id, or a BSP account with approved
 * templates — each with its own vault, its own verification call and, per
 * docs/07 §4, its own multi-week provisioning programme. This module records
 * STATE. A "Connect" button that captured a password today would be writing a
 * secret into a table with no encryption behind it.
 */

import type { RowDataPacket } from 'mysql2';
import { ERROR_CODES, PlatformError, type Role } from '@sap/shared';
import { platformDb } from '../db/platform-db.js';
import { auditSink } from '../db/audit.js';

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
    requirement: 'Needs the school’s SMTP host and a from-address.',
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
}

export async function readChannels(
  scope: readonly { school_id: string; school_name: string }[],
): Promise<ChannelRow[]> {
  if (scope.length === 0) return [];

  const ids = scope.map((s) => s.school_id);
  const [rows] = await platformDb.query<RowDataPacket[]>(
    `SELECT school_id, channel, status, provider, detail
       FROM school_channels
      WHERE school_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );

  const byKey = new Map<string, RowDataPacket>();
  for (const row of rows) byKey.set(`${String(row['school_id'])}:${String(row['channel'])}`, row);

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
      const row = byKey.get(`${school.school_id}:${channel}`);
      const meta = CHANNEL_META[channel];
      const provider = row?.['provider'];
      const detail = row?.['detail'];
      out.push({
        school_id: school.school_id,
        school_name: school.school_name,
        channel,
        title: meta.title,
        icon: meta.icon,
        status: row?.['status'] === 'connected' ? 'connected' : 'not_connected',
        detail:
          detail !== null && detail !== undefined
            ? String(detail)
            : provider !== null && provider !== undefined
              ? String(provider)
              : null,
        requirement: meta.requirement,
      });
    }
  }
  return out;
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
 * There is deliberately no `connect` counterpart yet. Connecting requires
 * credentials this platform cannot yet hold safely, and a button that flipped
 * the flag without them would claim a school can send messages it cannot.
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
