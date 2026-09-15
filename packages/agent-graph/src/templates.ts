/**
 * The template gallery (docs/07 §6: "absence alert, fee reminder 30/60/90,
 * low attendance monthly, exam low-marks, library overdue, birthday wishes,
 * admission follow-up, teacher-absent→substitute, transport broadcast").
 *
 * "Agent templates are data; the gallery grows without releases" (docs/07
 * §8) — this array is that data. `absence-alert` and `fee-reminder`'s
 * `buildGraph` produce graphs apps/agent-runtime can actually run today
 * (their triggers and fetch sources are in
 * `RUNNABLE_TRIGGER_KINDS`/`FETCH_SOURCES`); the rest render in the gallery
 * per docs/07 §6 but `buildGraph` returns `null` for them — "not built yet",
 * not hidden, matching this codebase's locked-≠-hidden convention (docs/10
 * §3) applied to a gallery tile instead of a nav row. See docs/11's
 * 2026-09-15 entry for which of the remaining seven are genuinely
 * data-blocked (Exam low marks, Transport broadcast) versus just unbuilt.
 */

import type { AgentGraph } from './types.js';

export interface AgentTemplate {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly icon: string;
  readonly runnable: boolean;
  /** `null` when this template has no buildable graph yet (see module doc). */
  readonly buildGraph: () => AgentGraph | null;
}

function absenceAlertGraph(): AgentGraph {
  return {
    nodes: [
      {
        id: 'trigger',
        position: { x: 0, y: 0 },
        data: { kind: 'schedule', cron: '30 10 * * 1-6', tz: 'Asia/Kolkata', label: 'Every school day · 10:30' },
      },
      {
        id: 'fetch',
        position: { x: 0, y: 120 },
        data: { kind: 'fetch_records', source: 'students_absent_today' },
      },
      {
        id: 'dedup',
        position: { x: 0, y: 240 },
        data: { kind: 'dedup_guard' },
      },
      {
        id: 'condition',
        position: { x: 0, y: 360 },
        data: { kind: 'if_else', field: 'consecutive_days', op: '>=', value: 3 },
      },
      {
        id: 'action-true',
        position: { x: -220, y: 500 },
        data: {
          kind: 'message',
          channels: ['whatsapp', 'sms'],
          primary: 'whatsapp',
          fallback: 'sms',
          template_id: 'absence-3rd-day',
          template_preview:
            'Dear parent, {{student.name}} ({{student.class}}) has been absent for {{days}} consecutive days. Please contact the school office.',
          also_notify_staff: true,
        },
      },
      {
        id: 'action-false',
        position: { x: 220, y: 500 },
        data: {
          kind: 'message',
          channels: ['whatsapp'],
          primary: 'whatsapp',
          fallback: 'sms',
          template_id: 'absence-today',
          template_preview: 'Dear parent, your ward {{student.name}} ({{student.class}}) is absent today.',
          also_notify_staff: false,
        },
      },
      { id: 'end-true', position: { x: -220, y: 640 }, data: { kind: 'end' } },
      { id: 'end-false', position: { x: 220, y: 640 }, data: { kind: 'end' } },
    ],
    edges: [
      { id: 'e-trigger-fetch', source: 'trigger', target: 'fetch' },
      { id: 'e-fetch-dedup', source: 'fetch', target: 'dedup' },
      { id: 'e-dedup-condition', source: 'dedup', target: 'condition' },
      { id: 'e-condition-true', source: 'condition', target: 'action-true', branch: 'true' },
      { id: 'e-condition-false', source: 'condition', target: 'action-false', branch: 'false' },
      { id: 'e-true-end', source: 'action-true', target: 'end-true' },
      { id: 'e-false-end', source: 'action-false', target: 'end-false' },
    ],
  };
}

/**
 * Second runnable template, added 2026-09-15. Same 8-node shape as
 * `absenceAlertGraph` (one trigger, one fetch, dedup, one if/else, two
 * message branches, two ends) — the fetch source's own `HAVING days_overdue
 * >= 30` floor (trigger-evaluator.ts) is what "30/60/90" actually means
 * here: every matched row already cleared the 30-day mark, and the
 * condition below only decides how loudly to say so.
 */
function feeReminderGraph(): AgentGraph {
  return {
    nodes: [
      {
        id: 'trigger',
        position: { x: 0, y: 0 },
        data: { kind: 'schedule', cron: '0 9 * * 1', tz: 'Asia/Kolkata', label: 'Every Monday · 9:00' },
      },
      {
        id: 'fetch',
        position: { x: 0, y: 120 },
        data: { kind: 'fetch_records', source: 'fee_defaulters_30_60_90' },
      },
      { id: 'dedup', position: { x: 0, y: 240 }, data: { kind: 'dedup_guard' } },
      {
        id: 'condition',
        position: { x: 0, y: 360 },
        data: { kind: 'if_else', field: 'days_overdue', op: '>=', value: 60 },
      },
      {
        id: 'action-true',
        position: { x: -220, y: 500 },
        data: {
          kind: 'message',
          channels: ['whatsapp', 'sms'],
          primary: 'whatsapp',
          fallback: 'sms',
          template_id: 'fee-reminder-60plus',
          template_preview:
            'Dear parent, {{student.name}} ({{student.class}}) has fee dues of ₹{{fee.balance_amount}} overdue by {{fee.days_overdue}} days. Please clear at the earliest to avoid further escalation.',
          also_notify_staff: true,
        },
      },
      {
        id: 'action-false',
        position: { x: 220, y: 500 },
        data: {
          kind: 'message',
          channels: ['whatsapp'],
          primary: 'whatsapp',
          fallback: 'sms',
          template_id: 'fee-reminder-30-59',
          template_preview:
            'Dear parent, a gentle reminder that {{student.name}}’s ({{student.class}}) fee dues of ₹{{fee.balance_amount}} are now overdue by {{fee.days_overdue}} days.',
          also_notify_staff: false,
        },
      },
      { id: 'end-true', position: { x: -220, y: 640 }, data: { kind: 'end' } },
      { id: 'end-false', position: { x: 220, y: 640 }, data: { kind: 'end' } },
    ],
    edges: [
      { id: 'e-trigger-fetch', source: 'trigger', target: 'fetch' },
      { id: 'e-fetch-dedup', source: 'fetch', target: 'dedup' },
      { id: 'e-dedup-condition', source: 'dedup', target: 'condition' },
      { id: 'e-condition-true', source: 'condition', target: 'action-true', branch: 'true' },
      { id: 'e-condition-false', source: 'condition', target: 'action-false', branch: 'false' },
      { id: 'e-true-end', source: 'action-true', target: 'end-true' },
      { id: 'e-false-end', source: 'action-false', target: 'end-false' },
    ],
  };
}

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: 'absence-alert',
    title: 'Absence alert',
    blurb: "WhatsApp parents of today's absentees",
    icon: '⚠️',
    runnable: true,
    buildGraph: absenceAlertGraph,
  },
  {
    id: 'fee-reminder',
    title: 'Fee reminder',
    blurb: 'Aging-based nudges at 30/60/90 days',
    icon: '💰',
    runnable: true,
    buildGraph: feeReminderGraph,
  },
  {
    id: 'low-attendance',
    title: 'Low attendance',
    blurb: 'Monthly alert when < 75%',
    icon: '📉',
    runnable: false,
    buildGraph: () => null,
  },
  {
    id: 'exam-low-marks',
    title: 'Exam low marks',
    blurb: 'Notify parents after results are published',
    icon: '📝',
    runnable: false,
    buildGraph: () => null,
  },
  {
    id: 'library-overdue',
    title: 'Library overdue',
    blurb: 'Return reminders via SMS',
    icon: '📚',
    runnable: false,
    buildGraph: () => null,
  },
  {
    id: 'birthday-wishes',
    title: 'Birthday wishes',
    blurb: 'Auto-greet students & staff',
    icon: '🎂',
    runnable: false,
    buildGraph: () => null,
  },
  {
    id: 'admission-followup',
    title: 'Admission follow-up',
    blurb: 'Nudge enquiries that stalled before admission',
    icon: '🎓',
    runnable: false,
    buildGraph: () => null,
  },
  {
    id: 'teacher-absent-substitute',
    title: 'Teacher absent',
    blurb: 'Alert coordinator to arrange substitute',
    icon: '🧑‍🏫',
    runnable: false,
    buildGraph: () => null,
  },
  {
    id: 'transport-broadcast',
    title: 'Transport broadcast',
    blurb: 'Route delay/change notices to affected parents',
    icon: '🚌',
    runnable: false,
    buildGraph: () => null,
  },
];

export function findTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id);
}

/**
 * Stands in for the Template Manager's create → submit → approved pipeline
 * (docs/07 §4, ADR-024), which is not built yet — there is no UI anywhere in
 * this slice that could get a NEW template approved. These two ids (the ones
 * `absenceAlertGraph` above references) are the only templates any agent can
 * reference and still pass publish-time flow linting today. Extending this
 * list by hand, here, is deliberate: it keeps "approved template" meaning
 * something real (docs/11's 2026-09-15 entry lists the Template Manager as
 * unbuilt) rather than a check that always passes.
 */
export const SEED_APPROVED_TEMPLATE_IDS: readonly string[] = [
  'absence-3rd-day',
  'absence-today',
  'fee-reminder-60plus',
  'fee-reminder-30-59',
];
