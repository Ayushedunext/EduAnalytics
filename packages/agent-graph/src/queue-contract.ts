/**
 * The BullMQ contract between the orchestrator (producer — schedules/publishes
 * jobs) and apps/agent-runtime (consumer — the only process holding a
 * `Worker`). CODING_GUIDELINES §23's 2026-09-15 queue decision: BullMQ against
 * the platform's existing Redis.
 *
 * Kept as plain constants + types, not BullMQ `Queue`/`Worker` instances —
 * each service owns its own connection lifecycle (CODING_GUIDELINES §5:
 * services are stateless / own their own clients), this module only fixes the
 * queue name and job shapes so the two sides cannot drift.
 */

export const AGENT_QUEUE_NAME = 'agents';

/**
 * One BullMQ repeatable job per ACTIVE agent, keyed by `agentId` as the
 * repeat job id so re-publishing an agent updates its existing schedule
 * instead of accumulating duplicates (services/agents.ts `syncSchedule`).
 */
export interface EvaluateTriggerJob {
  readonly kind: 'evaluate-trigger';
  readonly agentId: string;
}

/**
 * One job per run, added either immediately after a run is created (trigger
 * matched a record) or as a DELAYED job when a Wait node fires — "Wait nodes
 * are delayed queue jobs, not threads" (ADR-022, CODING_GUIDELINES §5).
 */
export interface AdvanceRunJob {
  readonly kind: 'advance-run';
  readonly runId: string;
}

export type AgentQueueJob = EvaluateTriggerJob | AdvanceRunJob;
