/**
 * Schedule — "send me this report, on these days, at this time, here".
 *
 * Contract source: ADR-037 · docs/06 §7 · docs/10 §2 ("Schedule").
 *
 * -- What changed, and why the file kept its shape ----------------------------
 * This module used to keep schedules in `localStorage` and said so in its own
 * doc: "the moment `/api/schedules` exists, the functions below become its
 * client and the page does not change shape." That moment is ADR-037. The
 * exported surface is deliberately the same — `useSchedules`,
 * `describeSchedule`, `nextRun`, `WEEKDAYS` — so the screen above it reads the
 * way it always did, and what moved is where the list LIVES: on the server,
 * with a queue behind it, actually sending.
 *
 * Three things went away with the browser store, none of them silently:
 *
 *  1. **The worked examples.** They existed because the panel was otherwise an
 *     empty box in front of a feature that could not run; a reader can now make
 *     a real schedule and press Send now, so a fake row claiming to be a
 *     schedule would be the only dishonest thing on the screen.
 *  2. **The device caveat.** A schedule is no longer a draft on this machine.
 *  3. **Client-side ids.** The server issues them, as the old comment predicted.
 *
 * -- What this module still does NOT decide -----------------------------------
 * Scope. `school_ids` is sent as a REQUEST — what the reader had selected when
 * they saved — and the orchestrator intersects it with the session's token
 * scope before storing it (CODING_GUIDELINES §8, ADR-037). What comes back is
 * the intersection, which is why `school_names` is read from the response
 * rather than resolved here.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  createSchedule as apiCreate,
  deleteSchedule as apiDelete,
  listSchedules as apiList,
  sendScheduleNow as apiSendNow,
  setSchedulePaused as apiSetPaused,
  updateSchedule as apiUpdate,
  ApiFailure,
  type ScheduleInput,
  type ScheduleRow,
} from './api/client';

/**
 * The two channels a person asks to be reached on.
 *
 * SMS is a channel the platform has (services/channels.ts) and is deliberately
 * NOT one of them: a report is a PDF, and there is no SMS in which a PDF
 * arrives. WhatsApp IS one of them and is shown, and refused — docs/11 §2 items
 * 4/8 gate a verified Business account and approved templates, and docs/10 §3's
 * rule is that a locked option is named, not hidden.
 */
export type DeliveryChannel = 'email' | 'whatsapp';

/** 0 = Sunday … 6 = Saturday — `Date#getDay`'s numbering, which is also cron's. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Which catalog a delivery re-runs from: a served dashboard, or the reader's own report. */
export type ScheduleReportKind = 'predefined' | 'custom';

/** The last attempt, so a row says what happened and not only what is planned. */
export interface ScheduleDelivery {
  readonly at: string;
  readonly status: string;
  readonly error: string | null;
  readonly trigger: 'schedule' | 'manual';
}

export interface ReportSchedule {
  readonly id: string;
  readonly reportId: string;
  readonly reportKind: ScheduleReportKind;
  /** The title as it read when the schedule was made — a label; the delivery re-reads the catalog's. */
  readonly reportTitle: string;
  /** At least one; a schedule with no day is not a schedule, so the form refuses it. */
  readonly days: readonly Weekday[];
  /** 24-hour `HH:MM`, in the school's own time — see `SCHEDULE_TIME_NOTE`. */
  readonly time: string;
  readonly channel: DeliveryChannel;
  readonly recipient: string;
  /** The scope it was SAVED with — re-validated at send time, so a label only. */
  readonly schoolIds: readonly string[];
  readonly schoolNames: readonly string[];
  /** Paused schedules stay on the list, stated — a pause is not a delete. */
  readonly paused: boolean;
  readonly createdAt: string;
  readonly lastDelivery: ScheduleDelivery | null;
}

/** A schedule as the form hands it over: everything except what the server owns. */
export type NewSchedule = Omit<
  ReportSchedule,
  'id' | 'createdAt' | 'paused' | 'schoolNames' | 'lastDelivery'
>;

export const WEEKDAYS: readonly { readonly day: Weekday; readonly short: string; readonly long: string }[] = [
  { day: 1, short: 'Mon', long: 'Monday' },
  { day: 2, short: 'Tue', long: 'Tuesday' },
  { day: 3, short: 'Wed', long: 'Wednesday' },
  { day: 4, short: 'Thu', long: 'Thursday' },
  { day: 5, short: 'Fri', long: 'Friday' },
  { day: 6, short: 'Sat', long: 'Saturday' },
  { day: 0, short: 'Sun', long: 'Sunday' },
];

function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

/**
 * The server's row, as this app's shape.
 *
 * Re-validated rather than cast, for the reason every trust boundary in this
 * codebase is (CODING_GUIDELINES §10): an over-the-wire object is a statement
 * about syntax. A malformed `days` here would render a row claiming a day the
 * server never stored.
 */
function fromRow(row: ScheduleRow): ReportSchedule {
  return {
    id: row.id,
    reportId: row.report_id,
    reportKind: row.report_kind === 'custom' ? 'custom' : 'predefined',
    reportTitle: row.report_title,
    days: sortDays(row.days.filter(isWeekday)),
    time: row.time,
    channel: row.channel === 'whatsapp' ? 'whatsapp' : 'email',
    recipient: row.recipient,
    schoolIds: row.school_ids,
    schoolNames: row.school_names,
    paused: row.paused,
    createdAt: row.created_at,
    lastDelivery: row.last_delivery,
  };
}

function toInput(schedule: NewSchedule): ScheduleInput {
  return {
    report_id: schedule.reportId,
    report_kind: schedule.reportKind,
    report_title: schedule.reportTitle,
    days: [...schedule.days],
    time: schedule.time,
    channel: schedule.channel,
    recipient: schedule.recipient,
    school_ids: [...schedule.schoolIds],
  };
}

/** Monday-first, so a row reads the way the picker above it is laid out. */
function sortDays(days: readonly Weekday[]): Weekday[] {
  const order = WEEKDAYS.map((w) => w.day);
  return [...new Set(days)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export interface Schedules {
  readonly all: readonly ReportSchedule[];
  /** First load only — an action in flight must not blank the list underneath it. */
  readonly loading: boolean;
  /**
   * The last refusal, in the server's own words.
   *
   * Surfaced rather than swallowed because the refusals here are ones a reader
   * can act on — "WhatsApp needs a verified Business account", "none of those
   * schools are in your access" — and a save that quietly did nothing is the
   * success-shaped failure CODING_GUIDELINES §10 calls the worst bug class.
   */
  readonly error: string | null;
  readonly add: (schedule: NewSchedule) => Promise<boolean>;
  readonly update: (id: string, schedule: NewSchedule) => Promise<boolean>;
  readonly setPaused: (id: string, paused: boolean) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  /** Queues the same delivery a firing would run — the row's outcome follows. */
  readonly sendNow: (id: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

export function useSchedules(): Schedules {
  const [all, setAll] = useState<readonly ReportSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { schedules } = await apiList();
      setAll(schedules.map(fromRow));
      setError(null);
    } catch (failure) {
      setError(messageOf(failure, 'Your schedules could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Every mutation re-reads the list instead of patching it locally.
   *
   * The server decides things this app cannot — the scope it actually captured,
   * the id, whether a schedule is still the reader's — so a locally-patched row
   * would be this app's guess at what was stored. One extra round trip on an
   * action a reader takes a few times a term is a cheap price for the list
   * always being the server's answer.
   */
  const add = useCallback(
    async (schedule: NewSchedule) => {
      try {
        await apiCreate(toInput(schedule));
        await refresh();
        return true;
      } catch (failure) {
        setError(messageOf(failure, 'That schedule could not be saved.'));
        return false;
      }
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, schedule: NewSchedule) => {
      try {
        await apiUpdate(id, toInput(schedule));
        await refresh();
        return true;
      } catch (failure) {
        setError(messageOf(failure, 'That change could not be saved.'));
        return false;
      }
    },
    [refresh],
  );

  const setPaused = useCallback(
    async (id: string, paused: boolean) => {
      try {
        await apiSetPaused(id, paused);
        await refresh();
      } catch (failure) {
        setError(messageOf(failure, 'That schedule could not be changed.'));
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await apiDelete(id);
        await refresh();
      } catch (failure) {
        setError(messageOf(failure, 'That schedule could not be deleted.'));
      }
    },
    [refresh],
  );

  const sendNow = useCallback(
    async (id: string) => {
      try {
        await apiSendNow(id);
        setError(null);
        /**
         * Deliberately NOT refreshed here. The delivery is queued and renders a
         * PDF; re-reading the list a millisecond later would show the PREVIOUS
         * attempt beside a "Sending…" that had already been replaced. The row
         * says it is sending, and the reader refreshes when they want the
         * outcome.
         */
      } catch (failure) {
        setError(messageOf(failure, 'That report could not be sent.'));
      }
    },
    [],
  );

  return { all, loading, error, add, update, setPaused, remove, sendNow, refresh };
}

function messageOf(failure: unknown, fallback: string): string {
  return failure instanceof ApiFailure ? failure.message : fallback;
}

/**
 * "Every school day · 7:30 AM" — one function, so the list row, the form's
 * summary line and anything printed later cannot phrase the same schedule two
 * different ways.
 */
export function describeSchedule(days: readonly Weekday[], time: string): string {
  const set = new Set(days);
  const label =
    set.size === 7
      ? 'Every day'
      : set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d as Weekday))
        ? 'Every school day'
        : set.size === 2 && set.has(0) && set.has(6)
          ? 'Weekends'
          : WEEKDAYS.filter((w) => set.has(w.day)).map((w) => w.short).join(', ');
  return `${label} · ${formatTime(time)}`;
}

/** 24-hour in the field, 12-hour on the row — the way a time is read aloud here. */
export function formatTime(time: string): string {
  const [h, m] = time.split(':');
  const hour = Number(h ?? '0');
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(twelve)}:${m ?? '00'} ${suffix}`;
}

/**
 * Stated wherever a time is entered. The delivery clock is the SCHOOL's, not
 * the reader's browser: a trust director sitting in another timezone who asks
 * for 7:30 means the school's 7:30, because that is when the school day the
 * report describes actually starts. The server stores `Asia/Kolkata` on the row
 * and BullMQ repeats against it, so this note describes what really happens.
 */
export const SCHEDULE_TIME_NOTE = 'School time (IST) — not your device’s timezone';

/**
 * The next time a schedule would fire, as a sentence.
 *
 * Computed in the browser from the reader's clock, which is why it is phrased
 * as "next: Monday 7:30 AM" and not as a timestamp: it is a reading of the
 * RULE, and the rule is kept in the school's timezone rather than this device's.
 * For a reader sitting in IST — nearly all of them — the two agree.
 */
export function nextRun(days: readonly Weekday[], time: string, from: Date = new Date()): string | null {
  if (days.length === 0) return null;
  const set = new Set(days);
  const [h, m] = time.split(':');
  for (let ahead = 0; ahead < 8; ahead += 1) {
    const day = new Date(from);
    day.setDate(day.getDate() + ahead);
    day.setHours(Number(h ?? '0'), Number(m ?? '0'), 0, 0);
    if (!set.has(day.getDay() as Weekday)) continue;
    if (day.getTime() <= from.getTime()) continue;
    const when =
      ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : day.toLocaleDateString(undefined, { weekday: 'long' });
    return `${when} at ${formatTime(time)}`;
  }
  return null;
}

/**
 * What a delivery's recorded status means, in a sentence a school admin can act
 * on.
 *
 * The stored values are the platform's (`schedule_deliveries.status`), and each
 * skip names its own reason on purpose — "not sent" with no reason is the state
 * nobody can do anything about. This is the one place they are translated, so
 * the row, a future history panel and anything printed cannot word them
 * differently.
 */
export function describeDelivery(delivery: ScheduleDelivery): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  switch (delivery.status) {
    case 'sent':
      return { tone: 'ok', text: delivery.trigger === 'manual' ? 'Sent (you asked for it)' : 'Sent' };
    case 'skipped_paused':
      return { tone: 'warn', text: 'Skipped — the schedule was paused' };
    case 'skipped_scope_empty':
      return { tone: 'warn', text: 'Skipped — no school on this schedule is available any more' };
    case 'skipped_channel_not_connected':
      return { tone: 'warn', text: 'Skipped — email is not connected for this school' };
    default:
      return { tone: 'bad', text: delivery.error ?? 'Failed' };
  }
}
