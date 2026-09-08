/**
 * Schedule — "send me this report, on these days, at this time, here".
 *
 * The first slice of scheduled delivery (docs/11 phase 4, "scheduled PDF
 * emails"; docs/06 §7, "scheduled report emails re-run definitions and attach
 * PDFs"). This module is the SCHEDULE ITSELF: what a reader asked for. It does
 * not send anything, and nothing in `apps/web` could — a delivery is a server
 * job with a clock, a PDF render and a messaging channel behind it, none of
 * which live in a browser tab.
 *
 * -- What is stored, and what is not -------------------------------------------
 * A REQUEST, never a report: which report to re-run, which weekdays, what time,
 * which channel, and the address to deliver to. No figure, no row and no SQL is
 * kept here, so a schedule can never carry data out of the scope it was made
 * in — when delivery is built, the run resolves scope server-side from the
 * owner's session exactly as every other read does (Invariant 2). The school
 * ids recorded on a schedule are the ones the reader had SELECTED when they
 * saved it, kept so the row can say what it covers; they are a display fact,
 * and the server will still intersect them with the token's scope at send time.
 *
 * -- Why localStorage, for now -------------------------------------------------
 * The same reasoning as My View and the theme choice (myView.ts,
 * theme/dashboardTheme.ts): there is no endpoint yet, and this slice is the
 * screen. The consequence is stated ON the screen rather than hidden — a
 * schedule saved here is a draft on this device, and nothing is being sent. The
 * moment `/api/schedules` exists, the functions below become its client and the
 * page does not change shape.
 *
 * A storage that refuses simply yields an empty list — never an error the
 * reader can do nothing about.
 */

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The two channels a person asks to be reached on.
 *
 * SMS is a channel the platform has (services/channels.ts) and is deliberately
 * NOT one of them: a report is a PDF, and there is no SMS in which a PDF
 * arrives. The catalog of channels is the server's; this is the subset that can
 * carry this payload.
 */
export type DeliveryChannel = 'email' | 'whatsapp';

/** 0 = Sunday … 6 = Saturday — `Date#getDay`'s numbering, not a private one. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Which endpoint a delivery would re-run: a served dashboard, or the reader's own report. */
export type ScheduleReportKind = 'predefined' | 'custom';

export interface ReportSchedule {
  readonly id: string;
  readonly reportId: string;
  readonly reportKind: ScheduleReportKind;
  /** The report's title as it read when the schedule was made — a label, never the source of truth. */
  readonly reportTitle: string;
  /** At least one; a schedule with no day is not a schedule, so the form refuses it. */
  readonly days: readonly Weekday[];
  /** 24-hour `HH:MM`, in the school's own time — see `SCHEDULE_TIME_NOTE`. */
  readonly time: string;
  readonly channel: DeliveryChannel;
  /** An email address or a phone number in international form, per `channel`. */
  readonly recipient: string;
  /** The scope in force when it was saved (see the header). */
  readonly schoolIds: readonly string[];
  /** Paused schedules stay on the list, stated — a pause is not a delete. */
  readonly paused: boolean;
  readonly createdAt: string;
  /**
   * One of the worked examples the screen opens with (`EXAMPLE_SCHEDULES`),
   * rather than something this reader set up. Marked on the row, because a list
   * that mixes the two without saying which is which is a list that has put
   * words in the reader's mouth.
   */
  readonly example?: boolean;
}

/** A schedule as the form hands it over: everything except the identity, the clock and the badge. */
export type NewSchedule = Omit<ReportSchedule, 'id' | 'createdAt' | 'paused' | 'example'>;

export const WEEKDAYS: readonly { readonly day: Weekday; readonly short: string; readonly long: string }[] = [
  { day: 1, short: 'Mon', long: 'Monday' },
  { day: 2, short: 'Tue', long: 'Tuesday' },
  { day: 3, short: 'Wed', long: 'Wednesday' },
  { day: 4, short: 'Thu', long: 'Thursday' },
  { day: 5, short: 'Fri', long: 'Friday' },
  { day: 6, short: 'Sat', long: 'Saturday' },
  { day: 0, short: 'Sun', long: 'Sunday' },
];

const STORAGE_KEY = 'sap.dashboard.schedules.v1';

/**
 * What the screen opens with, before anyone has set anything up.
 *
 * Three schedules a school would plausibly want, so the page shows what a
 * filled-in one looks like instead of an empty panel and a button. They are
 * badged "Example" on every row, they are NOT written to storage, and the first
 * time the reader changes anything — adds, edits, pauses or deletes — the list
 * becomes theirs and these are gone for good (`commit` writes the real list,
 * and `readStored` only offers these when nothing has ever been written).
 *
 * The report ids are real ones from the served catalog (services/home.ts), so
 * an example that is edited rather than deleted names a report that exists.
 */
const EXAMPLE_SCHEDULES: readonly ReportSchedule[] = [
  {
    id: 'example-fee-collection',
    reportId: 'fee-collection',
    reportKind: 'predefined',
    reportTitle: 'Fee Collection',
    days: [1],
    time: '09:00',
    channel: 'email',
    recipient: 'principal@school.edu',
    schoolIds: [],
    paused: false,
    createdAt: '2026-09-08T00:00:00.000Z',
    example: true,
  },
  {
    id: 'example-attendance',
    reportId: 'attendance-analytics',
    reportKind: 'predefined',
    reportTitle: 'Attendance Analytics',
    days: [1, 2, 3, 4, 5],
    time: '10:30',
    channel: 'whatsapp',
    recipient: '+91 98765 43210',
    schoolIds: [],
    paused: false,
    createdAt: '2026-09-08T00:00:00.000Z',
    example: true,
  },
  {
    id: 'example-defaulters',
    reportId: 'fee-defaulters',
    reportKind: 'predefined',
    reportTitle: 'Fee Defaulters',
    days: [5],
    time: '16:00',
    channel: 'email',
    recipient: 'accounts@school.edu',
    schoolIds: [],
    paused: true,
    createdAt: '2026-09-08T00:00:00.000Z',
    example: true,
  },
];

let schedules: readonly ReportSchedule[] = readStored();
const listeners = new Set<() => void>();

function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

/** `HH:MM`, 24-hour. Anything else is a stored value this app did not write. */
function isTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function readStored(): readonly ReportSchedule[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    /* Nothing has ever been written: the examples, which are not stored. */
    if (raw === null) return EXAMPLE_SCHEDULES;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    /**
     * Every entry is re-validated, not trusted — `localStorage` is the one
     * input to this app a person can edit by hand. A half-shaped entry is
     * dropped rather than repaired: a schedule missing its days or its
     * recipient is not a schedule that can be guessed at.
     */
    const out: ReportSchedule[] = [];
    for (const entry of parsed as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e['id'] !== 'string' || typeof e['reportId'] !== 'string') continue;
      const days = Array.isArray(e['days']) ? (e['days'] as unknown[]).filter(isWeekday) : [];
      if (days.length === 0 || !isTime(e['time'])) continue;
      if (e['channel'] !== 'email' && e['channel'] !== 'whatsapp') continue;
      if (typeof e['recipient'] !== 'string' || e['recipient'] === '') continue;
      out.push({
        id: e['id'],
        reportId: e['reportId'],
        reportKind: e['reportKind'] === 'custom' ? 'custom' : 'predefined',
        reportTitle: typeof e['reportTitle'] === 'string' ? e['reportTitle'] : 'Report',
        days: sortDays(days),
        time: e['time'],
        channel: e['channel'],
        recipient: e['recipient'],
        schoolIds: Array.isArray(e['schoolIds'])
          ? (e['schoolIds'] as unknown[]).filter((id): id is string => typeof id === 'string')
          : [],
        paused: e['paused'] === true,
        createdAt: typeof e['createdAt'] === 'string' ? e['createdAt'] : new Date().toISOString(),
        ...(e['example'] === true ? { example: true } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function commit(next: readonly ReportSchedule[]): void {
  schedules = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Storage refused: the list lives for this session only. */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Monday-first, so a row reads the way the picker above it is laid out. */
function sortDays(days: readonly Weekday[]): Weekday[] {
  const order = WEEKDAYS.map((w) => w.day);
  return [...new Set(days)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export interface Schedules {
  readonly all: readonly ReportSchedule[];
  readonly add: (schedule: NewSchedule) => void;
  /**
   * The whole schedule is replaced — the form edits a copy and hands it back
   * complete. Editing an EXAMPLE adopts it: it becomes the reader's own row and
   * the remaining examples go, because the panel is now a real list.
   */
  readonly update: (schedule: ReportSchedule) => void;
  readonly setPaused: (id: string, paused: boolean) => void;
  readonly remove: (id: string) => void;
  /** "Not for us" — clears the worked examples without setting anything up. */
  readonly dismissExamples: () => void;
}

/** The reader has acted, so the examples have served their purpose. */
function withoutExamples(list: readonly ReportSchedule[]): readonly ReportSchedule[] {
  return list.filter((s) => s.example !== true);
}

export function useSchedules(): Schedules {
  const current = useSyncExternalStore(subscribe, () => schedules, () => schedules);

  const add = useCallback((schedule: NewSchedule) => {
    commit([
      ...withoutExamples(schedules),
      {
        ...schedule,
        days: sortDays(schedule.days),
        /**
         * `crypto.randomUUID` where it exists, a timestamp otherwise. The id is
         * a local key and a claim about nothing — when the server owns
         * schedules it will issue its own and this one goes away.
         */
        id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `s${String(Date.now())}`,
        paused: false,
        createdAt: new Date().toISOString(),
      },
    ]);
  }, []);

  const update = useCallback((schedule: ReportSchedule) => {
    /* The edited row loses its Example badge in the map, so the filter that
       follows drops the OTHER examples and keeps this one — see `update` above. */
    commit(
      withoutExamples(
        schedules.map((s) =>
          s.id === schedule.id ? { ...schedule, days: sortDays(schedule.days), example: false } : s,
        ),
      ),
    );
  }, []);

  const setPaused = useCallback((id: string, paused: boolean) => {
    commit(schedules.map((s) => (s.id === id ? { ...s, paused } : s)));
  }, []);

  const remove = useCallback((id: string) => {
    commit(schedules.filter((s) => s.id !== id));
  }, []);

  const dismissExamples = useCallback(() => { commit(withoutExamples(schedules)); }, []);

  return { all: current, add, update, setPaused, remove, dismissExamples };
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
 * report describes actually starts.
 */
export const SCHEDULE_TIME_NOTE = 'School time (IST) — not your device’s timezone';

/**
 * The next time a schedule would fire, as a sentence.
 *
 * Computed in the browser from the reader's clock, which is exactly why it is
 * phrased as "next: Monday 7:30 AM" and not as a timestamp: it is a reading of
 * the RULE, not a promise from a scheduler. When the server owns these, the
 * next run comes back with the row and this becomes a fallback.
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
