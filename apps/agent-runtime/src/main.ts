/**
 * agent-runtime entry point.
 *
 * This process owns exactly one BullMQ `Worker` — the only place either job
 * kind (`evaluate-trigger`, `advance-run`) is consumed. The orchestrator is a
 * PRODUCER only: it enqueues/updates repeatable `evaluate-trigger` jobs at
 * publish/pause time (services/agents.ts `syncSchedule`) but never processes
 * one itself, keeping "who executes an agent" answerable by one service
 * (docs/01 §3-style separation of concerns, applied to this new component).
 */

import { assertPlatformDbReachable } from './db/client.js';
import { evaluateAgent } from './evaluator/trigger-evaluator.js';
import { advanceRun } from './runner/run-orchestrator.js';
import { startAgentWorker } from './queue/queue.js';

await assertPlatformDbReachable();
console.log('[agent-runtime] platform DB reachable');

const worker = startAgentWorker(async (job) => {
  switch (job.kind) {
    case 'evaluate-trigger': {
      const { matched, runsCreated } = await evaluateAgent(job.agentId);
      console.log(`[agent-runtime] agent ${job.agentId}: ${matched} matched, ${runsCreated} new run(s)`);
      return;
    }
    case 'advance-run':
      await advanceRun(job.runId);
      return;
  }
});

worker.on('failed', (job, err) => {
  console.error(`[agent-runtime] job ${job?.id ?? '?'} (${job?.data.kind ?? '?'}) failed:`, err);
});

console.log('[agent-runtime] worker listening on the "agents" queue');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void worker.close().then(() => process.exit(0));
  });
}
