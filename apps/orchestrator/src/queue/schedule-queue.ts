/**
 * The schedules queue (ADR-037) — producer AND consumer, both in this service.
 *
 * -- Why this one is not like the agents queue --------------------------------
 * `queue/agent-queue.ts` is producer-only on purpose: apps/agent-runtime is the
 * single consumer of the `agents` queue, so "who executes an agent" has one
 * answer. Scheduled delivery is the opposite shape. A delivery re-runs a report
 * definition, renders it through Puppeteer and reads the report catalog — all
 * of which live HERE, and none of which apps/agent-runtime has or should gain.
 * Moving the worker there would mean a second copy of the reporting stack in a
 * service whose whole job is walking agent graphs. So: a SEPARATE queue with a
 * separate name, consumed where the work already is. The rule the agents queue
 * follows — one queue, one consumer — is intact; it is one queue each.
 *
 * -- Why repeatable jobs and not a cron library or a ticker -------------------
 * [MANDATORY] CODING_GUIDELINES §5 / ADR-022: unattended timing is a delayed or
 * repeatable QUEUE job, never a `setTimeout` or a sleeping thread. The process
 * can restart between now and 07:30 and nothing is lost, because the schedule
 * lives in Redis and the request lives in `report_schedules` — not in this
 * module's memory. It also means a deployment running two orchestrator replicas
 * fires each schedule once rather than twice, which a per-process timer could
 * never promise.
 */

import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';

export const SCHEDULE_QUEUE_NAME = 'report-schedules';

/** The one job kind this queue carries. A named union, so adding a second
 * (a digest, a retry) is a compile error everywhere it must be handled. */
export interface DeliverScheduleJob {
  readonly kind: 'deliver-schedule';
  readonly scheduleId: string;
  /** `manual` is the Send-now path: the same code, honestly labelled (ADR-037). */
  readonly trigger: 'schedule' | 'manual';
}

/**
 * `maxRetriesPerRequest: null` is BullMQ's documented requirement for the
 * ioredis connection a Worker uses — without it the Worker's blocking commands
 * can throw under reconnect instead of waiting. Same note as
 * apps/agent-runtime's queue.ts, same reason.
 */
function createConnection(): ConnectionOptions {
  return new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null }) as unknown as ConnectionOptions;
}

const connection = createConnection();

const scheduleQueue = new Queue<DeliverScheduleJob>(SCHEDULE_QUEUE_NAME, { connection });

/**
 * Weekdays + a time → a cron pattern BullMQ can repeat on.
 *
 * `Date#getDay` numbering (0 = Sunday) is also cron's, which is why the SPA,
 * `report_schedules.days` and this expression can all count days the same way
 * without a translation table nobody would remember to keep correct.
 *
 * Exported for its own test: an off-by-one here sends a weekly report on the
 * wrong day, silently, for as long as nobody checks which day it arrived.
 */
export function cronFor(days: readonly number[], timeOfDay: string): string {
  const [hh, mm] = timeOfDay.split(':');
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  return `${String(Number(mm ?? '0'))} ${String(Number(hh ?? '0'))} * * ${sorted.join(',')}`;
}

/**
 * Create, update or remove a schedule's repeatable job.
 *
 * Pass `null` to stop it firing (pause or delete) — always removing any
 * EXISTING repeatable definition first, because BullMQ tracks repeatable jobs
 * by their pattern rather than by `jobId` alone: a schedule edited from Monday
 * to Friday would otherwise keep firing on Monday as well. `syncAgentSchedule`
 * learned this the same way; the comment is repeated rather than cross-
 * referenced because the failure is silent and expensive — a school receiving
 * two copies of a report on two different days with no error anywhere.
 */
export async function syncScheduleJob(
  scheduleId: string,
  schedule: { days: readonly number[]; timeOfDay: string; tz: string } | null,
): Promise<void> {
  for (const job of await scheduleQueue.getRepeatableJobs()) {
    if (job.id === scheduleId) await scheduleQueue.removeRepeatableByKey(job.key);
  }

  if (schedule === null) return;

  await scheduleQueue.add(
    'deliver-schedule',
    { kind: 'deliver-schedule', scheduleId, trigger: 'schedule' },
    {
      repeat: { pattern: cronFor(schedule.days, schedule.timeOfDay), tz: schedule.tz },
      jobId: scheduleId,
    },
  );
}

/** "Send now" — the same job, off the clock, labelled as what it is. */
export async function enqueueImmediateDelivery(scheduleId: string): Promise<void> {
  await scheduleQueue.add('deliver-schedule', { kind: 'deliver-schedule', scheduleId, trigger: 'manual' });
}

export function startScheduleWorker(
  processor: (job: DeliverScheduleJob) => Promise<void>,
): Worker<DeliverScheduleJob> {
  return new Worker<DeliverScheduleJob>(
    SCHEDULE_QUEUE_NAME,
    async (job) => {
      await processor(job.data);
    },
    {
      /**
       * Deliberately low, where the agents worker runs at 10. Every job here
       * renders a PDF, and ADR-037's accepted trade-off is that scheduled
       * renders share one Chromium with readers clicking "⬇ PDF". Two at a time
       * keeps a morning's deliveries moving without turning the browser into
       * the thing that makes an interactive export slow.
       */
      connection,
      concurrency: 2,
    },
  );
}
