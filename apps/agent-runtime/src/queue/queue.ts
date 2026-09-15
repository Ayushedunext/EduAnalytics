/**
 * BullMQ wiring (CODING_GUIDELINES §23, decided 2026-09-15: BullMQ against the
 * platform's existing Redis). See @sap/agent-graph's queue-contract.ts for the
 * job shapes this producer/consumer pair agree on.
 *
 * `maxRetriesPerRequest: null` is BullMQ's own documented requirement for the
 * ioredis connection a Worker/blocking client uses — without it a Worker's
 * internal blocking commands can throw under reconnect instead of waiting.
 */

import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { AGENT_QUEUE_NAME, type AgentQueueJob } from '@sap/agent-graph';
import { config } from '../config.js';

export function createConnection(): ConnectionOptions {
  return new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null }) as unknown as ConnectionOptions;
}

const connection = createConnection();

/** This service is also a PRODUCER: a Wait node re-enqueues its own resume as
 * a delayed job (ADR-022 — "delayed queue jobs, not threads"), and a freshly
 * matched trigger record is enqueued for its first advance immediately. */
export const agentQueue = new Queue<AgentQueueJob>(AGENT_QUEUE_NAME, { connection });

export function startAgentWorker(
  processor: (job: AgentQueueJob) => Promise<void>,
): Worker<AgentQueueJob> {
  return new Worker<AgentQueueJob>(
    AGENT_QUEUE_NAME,
    async (job) => {
      await processor(job.data);
    },
    { connection, concurrency: 10 },
  );
}
