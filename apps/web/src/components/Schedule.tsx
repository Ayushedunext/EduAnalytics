/**
 * Schedule — "send me this report every Monday at 7:30, on WhatsApp".
 *
 * The screen for scheduled delivery (docs/11 phase 4; docs/06 §7). A reader
 * picks a report they can already open, the days and the time they want it, and
 * where it should arrive. Nothing else: this is the request, and the request is
 * the whole feature until the server side of it exists.
 *
 * -- What this screen is honest about ------------------------------------------
 *
 * 1. It does not send. There is no scheduler, no PDF job and no channel worker
 *    behind these rows yet, so every row says so and the page says so once at
 *    the top. A saved schedule is a draft on this device (schedules.ts). A page
 *    that showed "Active ● next run Monday" over nothing would be the worst
 *    version of this feature — the reader would stop checking their inbox.
 *
 * 2. It does not claim a channel works. Whether a school can send on email or
 *    WhatsApp is the server's answer (`/api/settings`, services/channels.ts),
 *    and it is `not_connected` for every school today. The option is shown
 *    either way — docs/10 §3, "locked ≠ hidden" — with the missing piece named
 *    and Settings one click away, exactly as the AI lock does it.
 *
 * 3. It does not widen scope. A schedule records the schools the reader had
 *    selected when they saved it, as a statement of what the report covers; the
 *    delivery run will resolve scope from the owner's session at send time
 *    (Invariant 2), so this list is a label and never an authorisation.
 *
 * -- Why the report list is both catalogs --------------------------------------
 * A reader schedules what they read, and half of what they read is their own
 * (My Reports). Offering only the predefined dashboards would mean the report
 * someone built for exactly this purpose is the one report they cannot have
 * delivered.
 */

import { useEffect, useState } from 'react';
import {
  getSettings,
  listMyReports,
  type ChannelRow,
  type DashboardCard,
  type SessionResponse,
} from '../api/client';
import { Icon } from './Icon';
import {
  describeSchedule,
  nextRun,
  useSchedules,
  SCHEDULE_TIME_NOTE,
  WEEKDAYS,
  type DeliveryChannel,
  type NewSchedule,
  type ReportSchedule,
  type ScheduleReportKind,
  type Weekday,
} from '../schedules';

interface Props {
  session: SessionResponse;
  /** The served catalog, already filtered by what this session may open. */
  dashboards: readonly DashboardCard[];
  schoolIds: readonly string[];
  /** The path off a channel that is not connected — the same destination as the AI lock. */
  onOpenSettings: () => void;
}

/** One entry in the report picker, from either catalog. */
interface ReportOption {
  readonly id: string;
  readonly kind: ScheduleReportKind;
  readonly title: string;
}

const CHANNEL_META: Record<DeliveryChannel, { label: string; icon: string; hint: string; placeholder: string }> = {
  email: {
    label: 'Email',
    icon: '✉️',
    hint: 'The report arrives as a branded PDF attachment.',
    placeholder: 'principal@school.edu',
  },
  whatsapp: {
    label: 'WhatsApp',
    icon: '📱',
    hint: 'A short summary message with the PDF attached.',
    placeholder: '+91 98765 43210',
  },
};

/** The presets that cover most of what a school actually asks for. */
const DAY_PRESETS: readonly { label: string; days: readonly Weekday[] }[] = [
  { label: 'Every school day', days: [1, 2, 3, 4, 5] },
  { label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
  { label: 'Mondays only', days: [1] },
];

export function Schedule({ session, dashboards, schoolIds, onOpenSettings }: Props): JSX.Element {
  const schedules = useSchedules();
  /**
   * The catalogs the picker offers. Both are optional to the page: a reader who
   * has no custom reports, or whose list failed to load, can still schedule a
   * dashboard — so a failure here narrows the picker and says so, rather than
   * taking the screen down with it.
   */
  const [mine, setMine] = useState<ReportOption[]>([]);
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [loadNote, setLoadNote] = useState<string | null>(null);
  /** `null` = closed · `'new'` = the blank form · a schedule = editing that one. */
  const [editing, setEditing] = useState<ReportSchedule | 'new' | null>(null);

  useEffect(() => {
    listMyReports()
      .then(({ reports }) => {
        setMine(reports.map((r) => ({ id: r.id, kind: 'custom' as const, title: r.name })));
      })
      .catch(() => {
        setLoadNote('Your own reports could not be listed — the predefined dashboards are still schedulable.');
      });
    getSettings()
      .then((settings) => { setChannels(settings.channels); })
      .catch(() => {
        /* The connection state is advice, not a gate here. Left null, the form
           simply does not claim either way — see `channelState`. */
      });
  }, []);

  const options: ReportOption[] = [
    ...dashboards
      .filter((d) => d.status === 'available')
      .map((d) => ({ id: d.id, kind: 'predefined' as const, title: d.title })),
    ...mine,
  ];

  const inScope = channels?.filter((c) => schoolIds.includes(c.school_id)) ?? [];

  /**
   * What a channel can do for the schools ON SCREEN, not for the org.
   *
   * A channel belongs to a school (ADR-024), so with four schools selected the
   * answer is rarely a simple yes: the connected ones would receive their
   * report and the rest would not. The form names the schools that would go
   * silent rather than flattening that into one green tick.
   */
  function channelState(channel: DeliveryChannel): { connected: boolean; missing: string[] } {
    const rows = inScope.filter((c) => c.channel === channel);
    const missing = rows.filter((r) => r.status !== 'connected').map((r) => r.school_name);
    return { connected: rows.length > 0 && missing.length === 0, missing };
  }

  /** Nothing has been set up yet, so the panel is showing the worked examples. */
  const showingExamples = schedules.all.some((s) => s.example === true);

  const schoolName = (id: string): string =>
    session.scope.find((s) => s.school_id === id)?.school_name ?? id;

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[1100px]">
        <div className="reportsHead">
          <div className="min-w-0">
            <h1 className="page-title">Schedule</h1>
            <div className="page-sub">
              Have a report delivered to you on the days and at the time you choose — by email or
              on WhatsApp.
            </div>
          </div>
          {editing === null && (
            <button type="button" className="btn btnPrimary" onClick={() => { setEditing('new'); }}>
              ＋ New schedule
            </button>
          )}
        </div>

        {loadNote !== null && <div className="notice mt-4">{loadNote}</div>}

        {editing !== null && (
          <ScheduleForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? null : editing}
            options={options}
            schoolIds={schoolIds}
            channelState={channelState}
            onOpenSettings={onOpenSettings}
            onCancel={() => { setEditing(null); }}
            onSave={(draft) => {
              if (editing === 'new') schedules.add(draft);
              else schedules.update({ ...editing, ...draft });
              setEditing(null);
            }}
          />
        )}

        <section className="card reportsPanel mt-4">
          <h3 className="reportsPanelTitle">Your schedules</h3>
          {showingExamples && (
            /* Said before the rows, not after them: a reader who takes the
               first row for their own has already been misled by the time a
               footnote explains it. */
            <p className="schedPanelNote">
              These three are <b>examples</b>, to show what a schedule looks like. Press{' '}
              <b>Use this</b> on one to make it yours, or start a new one above.
            </p>
          )}

          {schedules.all.length === 0 ? (
            <p className="reportsEmpty">
              No schedules yet. Press <b>＋ New schedule</b> to have a report reach you on a day and
              time that suits you — a fee-collection summary every Monday morning, say, or
              attendance every school day at 10:30.
            </p>
          ) : (
            <div className="schedList">
              {schedules.all.map((schedule) => {
                const meta = CHANNEL_META[schedule.channel];
                const { missing } = channelState(schedule.channel);
                const next = nextRun(schedule.days, schedule.time);
                return (
                  <div key={schedule.id} className={`schedRow${schedule.paused ? ' schedRow--paused' : ''}`}>
                    <span className="schedRowIcon" aria-hidden="true">{meta.icon}</span>
                    <div className="schedRowBody">
                      <div className="schedRowTitle">
                        {schedule.reportTitle}
                        {schedule.reportKind === 'custom' && <span className="schedTag">My report</span>}
                      </div>
                      <div className="schedRowWhen">
                        <Icon name="clock" />
                        {describeSchedule(schedule.days, schedule.time)} · {meta.label} ·{' '}
                        {schedule.recipient}
                      </div>
                      <div className="schedRowMeta">
                        {schedule.schoolIds.length === 0
                          ? 'Scope: as selected at send time'
                          : `Covers ${schedule.schoolIds.map(schoolName).join(', ')}`}
                        {schedule.paused
                          ? ' · Paused'
                          : next === null
                            ? ''
                            : ` · Would run ${next}`}
                      </div>
                      {missing.length > 0 && (
                        <div className="schedRowWarn">
                          {meta.label} is not connected for {missing.join(', ')} —{' '}
                          <button type="button" className="schedLink" onClick={onOpenSettings}>
                            set it up in Settings
                          </button>
                          .
                        </div>
                      )}
                    </div>
                    <span className="pill soon">
                      {schedule.example === true ? 'Example' : 'Not sending yet'}
                    </span>
                    {schedule.example === true ? (
                      <div className="schedRowActions">
                        <button
                          type="button"
                          className="btn btnOutline"
                          onClick={() => { setEditing(schedule); }}
                        >
                          Use this
                        </button>
                        <button type="button" className="btn btnGhost" onClick={schedules.dismissExamples}>
                          Dismiss
                        </button>
                      </div>
                    ) : (
                      <div className="schedRowActions">
                        <button
                          type="button"
                          className="btn btnGhost"
                          onClick={() => { schedules.setPaused(schedule.id, !schedule.paused); }}
                        >
                          {schedule.paused ? 'Resume' : 'Pause'}
                        </button>
                        <button
                          type="button"
                          className="btn btnOutline"
                          onClick={() => { setEditing(schedule); }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btnGhost"
                          onClick={() => { schedules.remove(schedule.id); }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* The disclaimer sits at the foot of the screen, after the thing it is
            about — but it is also on every row as a pill, because a row is what
            a reader looks at a week from now. */}
        <div className="schedNote">
          <span className="schedNoteIcon">🛠️</span>
          <div>
            <b>Nothing is being delivered yet.</b> Scheduled sending is still being built — this
            screen sets up what you want and keeps it on this device, and no email or WhatsApp
            message has gone to anyone. When delivery goes live, a scheduled report is re-run
            against fresh data and sent as the same branded PDF the Export button produces
            (docs/06 §6), on the channels your school has connected in Settings ▸ Messaging.
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The form, as one card in four steps: which report, which days, what time,
 * where to.
 *
 * Held in local state and handed back complete, so an abandoned edit changes
 * nothing — the list is only ever written by `onSave`.
 */
function ScheduleForm({
  initial,
  options,
  schoolIds,
  channelState,
  onOpenSettings,
  onCancel,
  onSave,
}: {
  initial: ReportSchedule | null;
  options: readonly ReportOption[];
  schoolIds: readonly string[];
  channelState: (channel: DeliveryChannel) => { connected: boolean; missing: string[] };
  onOpenSettings: () => void;
  onCancel: () => void;
  onSave: (draft: NewSchedule) => void;
}): JSX.Element {
  const [reportKey, setReportKey] = useState(
    initial === null ? (options[0] === undefined ? '' : optionKey(options[0])) : `${initial.reportKind}:${initial.reportId}`,
  );
  const [days, setDays] = useState<readonly Weekday[]>(initial?.days ?? [1]);
  const [time, setTime] = useState(initial?.time ?? '08:00');
  const [channel, setChannel] = useState<DeliveryChannel>(initial?.channel ?? 'email');
  const [recipient, setRecipient] = useState(initial?.recipient ?? '');
  /** Only after a failed submit — a form that scolds while you are still typing is worse than one that waits. */
  const [showErrors, setShowErrors] = useState(false);

  const report = options.find((o) => optionKey(o) === reportKey);
  const state = channelState(channel);
  const meta = CHANNEL_META[channel];

  const problems: string[] = [];
  if (report === undefined) problems.push('Pick the report you want delivered.');
  if (days.length === 0) problems.push('Pick at least one day of the week.');
  if (!isValidRecipient(channel, recipient)) {
    problems.push(
      channel === 'email'
        ? 'Enter the email address the report should go to.'
        : 'Enter the WhatsApp number with its country code, e.g. +91 98765 43210.',
    );
  }

  function toggleDay(day: Weekday): void {
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]));
  }

  function submit(): void {
    if (problems.length > 0 || report === undefined) {
      setShowErrors(true);
      return;
    }
    onSave({
      reportId: report.id,
      reportKind: report.kind,
      reportTitle: report.title,
      days,
      time,
      channel,
      recipient: recipient.trim(),
      schoolIds: [...schoolIds],
    });
  }

  return (
    <section className="card schedForm mt-4">
      <h3 className="stepTitle">{initial === null ? 'New schedule' : `Edit — ${initial.reportTitle}`}</h3>

      {/* ① The report. */}
      <div className="schedField">
        <label className="schedLabel" htmlFor="sched-report">
          Which report
        </label>
        {options.length === 0 ? (
          <p className="stepText">
            No reports are available to schedule yet — open Dashboard once so the catalog loads.
          </p>
        ) : (
          <select
            id="sched-report"
            className="schedSelect"
            value={reportKey}
            onChange={(event) => { setReportKey(event.target.value); }}
          >
            {options.map((option) => (
              <option key={optionKey(option)} value={optionKey(option)}>
                {option.title}
                {option.kind === 'custom' ? ' · my report' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* ② The days. Toggles rather than a "frequency" dropdown: a school that
          wants Monday and Thursday is not an exotic case, and a dropdown of
          canned frequencies cannot say it. */}
      <div className="schedField">
        <span className="schedLabel">Which days</span>
        <div className="schedDays" role="group" aria-label="Days of the week">
          {WEEKDAYS.map((weekday) => {
            const on = days.includes(weekday.day);
            return (
              <button
                key={weekday.day}
                type="button"
                className={`schedDay${on ? ' on' : ''}`}
                aria-pressed={on}
                aria-label={weekday.long}
                onClick={() => { toggleDay(weekday.day); }}
              >
                {weekday.short}
              </button>
            );
          })}
        </div>
        <div className="schedPresets">
          {DAY_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="schedPreset"
              onClick={() => { setDays(preset.days); }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* ③ The time. */}
      <div className="schedField">
        <label className="schedLabel" htmlFor="sched-time">
          What time
        </label>
        <div className="schedTimeRow">
          <input
            id="sched-time"
            type="time"
            className="schedTime"
            value={time}
            onChange={(event) => { setTime(event.target.value); }}
          />
          <span className="schedHint">{SCHEDULE_TIME_NOTE}</span>
        </div>
      </div>

      {/* ④ Where it goes. */}
      <div className="schedField">
        <span className="schedLabel">Where to send it</span>
        <div className="schedChannels">
          {(Object.keys(CHANNEL_META) as DeliveryChannel[]).map((id) => {
            const info = CHANNEL_META[id];
            const status = channelState(id);
            return (
              <label key={id} className={`schedChannel${channel === id ? ' on' : ''}`}>
                <input
                  type="radio"
                  name="sched-channel"
                  value={id}
                  checked={channel === id}
                  onChange={() => { setChannel(id); }}
                />
                <span className="schedChannelIcon" aria-hidden="true">{info.icon}</span>
                <span className="schedChannelBody">
                  <b>{info.label}</b>
                  <span className="schedChannelHint">{info.hint}</span>
                </span>
                {status.connected && <span className="pill live">● Connected</span>}
              </label>
            );
          })}
        </div>

        <input
          type={channel === 'email' ? 'email' : 'tel'}
          className="schedInput"
          placeholder={meta.placeholder}
          value={recipient}
          autoComplete="off"
          aria-label={channel === 'email' ? 'Email address' : 'WhatsApp number'}
          onChange={(event) => { setRecipient(event.target.value); }}
        />

        {state.missing.length > 0 && (
          /* Locked ≠ hidden (docs/10 §3): the choice stays available and the
             missing piece is named, with the place to fix it one click away. */
          <p className="schedHint mt-2">
            {meta.label} is not connected for {state.missing.join(', ')}. You can still set this up
            now —{' '}
            <button type="button" className="schedLink" onClick={onOpenSettings}>
              connect it in Settings ▸ Messaging
            </button>{' '}
            before delivery goes live.
          </p>
        )}
      </div>

      {/* What the reader just asked for, in one sentence, before they commit to it. */}
      {report !== undefined && days.length > 0 && (
        <p className="schedSummary">
          <b>{report.title}</b> → {describeSchedule(days, time)} → {meta.label}
          {recipient.trim() === '' ? '' : ` to ${recipient.trim()}`}
        </p>
      )}

      {showErrors && problems.length > 0 && (
        <div className="notice mt-3">
          {problems.map((problem) => (
            <div key={problem}>{problem}</div>
          ))}
        </div>
      )}

      <div className="stepActions">
        <button type="button" className="btn btnPrimary" onClick={submit}>
          {initial === null ? 'Save schedule' : 'Save changes'}
        </button>
        <button type="button" className="btn btnGhost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** Two catalogs, one picker — an id alone would collide between them. */
function optionKey(option: ReportOption): string {
  return `${option.kind}:${option.id}`;
}

/**
 * Deliberately loose. The point is to catch an empty box or an obvious typo
 * before it is saved, not to adjudicate what a valid address is — the sender
 * will reject what it cannot deliver to, and a stricter pattern here would
 * refuse addresses and numbers that are perfectly real.
 */
function isValidRecipient(channel: DeliveryChannel, value: string): boolean {
  const trimmed = value.trim();
  if (channel === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  return /^\+?[\d][\d\s-]{7,17}$/.test(trimmed);
}
