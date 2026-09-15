/**
 * The orchestrator's BullMQ PRODUCER side for agents (CODING_GUIDELINES §23,
 * decided 2026-09-15). This service only schedules/removes repeatable jobs at
 * publish/pause/delete time (`syncSchedule`) — it never runs a `Worker` and
 * never processes a job itself; apps/agent-runtime is the only consumer (see
 * that service's src/main.ts doc comment). Two services, one queue, one
 * contract (@sap/agent-graph's queue-contract.ts).
 *
 * -- Why plain connection options, not a shared IORedis instance ------------
 * apps/orchestrator already depends on ioredis ^6 for cache/result-cache.ts.
 * BullMQ's own dependency range is narrower. Handing BullMQ a pre-built
 * client instance would make it call methods on a client version it was never
 * tested against; handing it plain `{host, port, ...}` options lets BullMQ
 * construct its OWN client from its OWN nested, compatible ioredis — the two
 * Redis usages in this process share a server, never a client library
 * version.
 */

import { Queue } from 'bullmq';
import { AGENT_QUEUE_NAME, type EvaluateTriggerJob } from '@sap/agent-graph';
import { config } from '../config.js';

function connectionOptionsFromUrl(url: string): { host: string; port: number; password?: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    ...(parsed.password === '' ? {} : { password: parsed.password }),
  };
}

const agentQueue = new Queue<EvaluateTriggerJob>(AGENT_QUEUE_NAME, {
  connection: connectionOptionsFromUrl(config.REDIS_URL),
});

/**
 * Create, update or remove an agent's repeatable trigger job.
 *
 * Pass `null` for `schedule` to stop scheduling it (pause, unpublish, or
 * delete) — always removing any EXISTING repeatable definition first, because
 * BullMQ tracks repeatable jobs by their pattern, not by `jobId` alone: a
 * changed cron string would otherwise leave the old schedule still firing
 * alongside the new one.
 */
export async function syncAgentSchedule(
  agentId: string,
  schedule: { cron: string; tz: string } | null,
): Promise<void> {
  const existing = await agentQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.id === agentId) {
      await agentQueue.removeRepeatableByKey(job.key);
    }
  }

  if (schedule === null) return;

  await agentQueue.add(
    'evaluate-trigger',
    { kind: 'evaluate-trigger', agentId },
    { repeat: { pattern: schedule.cron, tz: schedule.tz }, jobId: agentId },
  );
}

/** Run an agent's trigger evaluation immediately (the builder's "Test run" /
 * manual-trigger path), independent of its schedule. */
export async function enqueueImmediateEvaluation(agentId: string): Promise<void> {
  await agentQueue.add('evaluate-trigger', { kind: 'evaluate-trigger', agentId });
}
