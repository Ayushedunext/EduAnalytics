/**
 * Send-time channel resolution — the same `resolveChannel` function
 * apps/orchestrator's Settings screen and publish-time flow lint use
 * (@sap/agent-graph, ADR-034), queried here against agent-runtime's own
 * Drizzle handle. One function, two callers, never two answers.
 */

import { and, eq } from 'drizzle-orm';
import { resolveChannel, type ChannelId, type EffectiveChannel } from '@sap/agent-graph';
import * as agentDbSchema from '@sap/agent-graph/db-schema';
import { db } from '../db/client.js';

export async function resolveEffectiveChannel(
  orgId: string,
  schoolId: string,
  channel: ChannelId,
): Promise<EffectiveChannel> {
  const [schoolRow] = await db
    .select({ status: agentDbSchema.schoolChannels.status, provider: agentDbSchema.schoolChannels.provider, detail: agentDbSchema.schoolChannels.detail })
    .from(agentDbSchema.schoolChannels)
    .where(and(eq(agentDbSchema.schoolChannels.schoolId, schoolId), eq(agentDbSchema.schoolChannels.channel, channel)));

  const [orgRow] = await db
    .select({ status: agentDbSchema.orgChannels.status, provider: agentDbSchema.orgChannels.provider, detail: agentDbSchema.orgChannels.detail })
    .from(agentDbSchema.orgChannels)
    .where(and(eq(agentDbSchema.orgChannels.orgId, orgId), eq(agentDbSchema.orgChannels.channel, channel)));

  return resolveChannel(
    schoolRow === undefined ? undefined : { ...schoolRow, provider: schoolRow.provider ?? null, detail: schoolRow.detail ?? null },
    orgRow === undefined ? undefined : { ...orgRow, provider: orgRow.provider ?? null, detail: orgRow.detail ?? null },
  );
}
