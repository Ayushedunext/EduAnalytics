/**
 * The workflow-agent graph contract (ADR-022, docs/07 §2).
 *
 * [MANDATORY] CODING_GUIDELINES §20: the agent graph schema is a protected
 * architectural contract. Changing a node's shape here is an ADR, not a
 * refactor, because three independent consumers read it: the builder UI
 * (renders + edits it), the orchestrator (validates + persists it as
 * `agent_versions.graph_json`), and apps/agent-runtime (walks it as a
 * persisted state machine). One drifted consumer is a graph the builder can
 * save and the runtime cannot run.
 *
 * -- Why `message` is one action node, not three (whatsapp/sms/email) --------
 * docs/07 §2's palette lists WhatsApp/SMS/Email as separate entries, but §4 is
 * explicit that "every message action node presents checkboxes of the
 * school's channels" — singular node, plural channels — and the reference
 * builder screens (docs/11 Artifacts) show exactly one action box per branch
 * with WhatsApp/SMS/Email checkboxes and one template box, not three stacked
 * nodes. Modelling three node types would mean a school picking "WhatsApp
 * with SMS fallback" by wiring two separate nodes together with fallback
 * semantics the graph shape doesn't otherwise express. One node with a
 * `channels`/`primary`/`fallback` triple matches what schools actually
 * configure and what the screens actually show.
 */

import { z } from 'zod';

export const CHANNEL_IDS = ['email', 'sms', 'whatsapp'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

// ---------------------------------------------------------------------------
// Triggers — exactly one per graph (docs/07 §2).
// ---------------------------------------------------------------------------

export const TRIGGER_TYPES = [
  'schedule',
  'data_condition',
  'email_received',
  'erp_event',
  'manual',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/**
 * A schedule is itself either plain time-based or fused with a data
 * condition ("at 10:30, find absentees" — docs/07 §2 note that these two
 * "combine naturally"). Representing that as one `schedule` trigger node
 * whose `data` field is populated is simpler than a compound node type, and
 * is exactly what the canonical example does: a `schedule` trigger feeding
 * straight into a `fetch_records` data node.
 */
export const scheduleTriggerSchema = z.object({
  kind: z.literal('schedule'),
  /** Standard 5-field cron, always interpreted in `tz` (docs/07 §2: "school TZ"). */
  cron: z.string().min(1),
  tz: z.string().min(1).default('Asia/Kolkata'),
  /** Display only, e.g. "Every school day · 10:30" — never parsed back from this. */
  label: z.string().min(1),
});
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;

export const manualTriggerSchema = z.object({ kind: z.literal('manual') });

/**
 * `email_received` and `erp_event` are declared for the palette (docs/07 §2)
 * but have no evaluator yet (docs/11's 2026-09-15 entry: "IMAP/webhook
 * triggers" explicitly deferred) — the type exists so a graph referencing one
 * is well-formed and the builder can show it as "not runnable yet" rather
 * than the type system having no name for it at all.
 */
export const emailTriggerSchema = z.object({ kind: z.literal('email_received'), mailbox: z.string().min(1) });
export const erpEventTriggerSchema = z.object({ kind: z.literal('erp_event'), event: z.string().min(1) });

export const triggerDataSchema = z.discriminatedUnion('kind', [
  scheduleTriggerSchema,
  manualTriggerSchema,
  emailTriggerSchema,
  erpEventTriggerSchema,
]);
export type TriggerData = z.infer<typeof triggerDataSchema>;

// ---------------------------------------------------------------------------
// Data — read-only, through MCP tools only (ADR-006/023). No node type here
// ever gains a "write" variant; that is the whole point of ADR-023.
// ---------------------------------------------------------------------------

/**
 * The catalog of things an agent can fetch. `runnable: false` entries are
 * declared for the builder's template gallery (docs/07 §6 names all nine) but
 * have no MCP-backed evaluator in apps/agent-runtime yet — publishing one is
 * refused (see validate.ts) rather than silently no-op-ing.
 */
export const FETCH_SOURCES = {
  students_absent_today: {
    label: 'Students absent today',
    runnable: true,
    /**
     * run_query columns the evaluator's SELECT is expected to return.
     *
     * `parent_phone` is listed because docs/07 §1's canonical example
     * templates on `{{parent.phone}}` — but no parent/guardian contact column
     * exists anywhere in `apps/mcp-server/src/schema/erp-v1.ts`'s catalogued
     * schema today (checked while building this evaluator, 2026-09-15). The
     * evaluator returns `parent_phone: null` rather than inventing a column
     * name, the same "cannot usefully be stubbed" discipline docs/11 §2 item 6
     * applies to schema at large. This is a real, tracked gap, not an
     * oversight — see docs/11's 2026-09-15 entry.
     */
    fields: ['student_id', 'student_name', 'class', 'section', 'parent_phone', 'consecutive_days'],
  },
  fee_defaulters_30_60_90: {
    label: 'Fee defaulters (30/60/90 days)',
    runnable: true,
    /**
     * Second runnable source (after `students_absent_today`), added 2026-09-15
     * against the same real table the Fee Defaulters dashboard already reads
     * (`fee_compile_data_set`, mcp-server/src/reports/catalog.ts's
     * `FEE_DEFAULTERS`) — the evaluator's SQL mirrors that report's aging-band
     * logic, aggregated per student rather than per band. `parent_phone` is
     * null for the same reason as the absence source: docs/11 §2 item 10.
     */
    fields: ['student_id', 'student_name', 'class', 'section', 'balance_amount', 'days_overdue', 'parent_phone'],
  },
  attendance_below_threshold: {
    label: 'Attendance % dropped below threshold',
    runnable: false,
    fields: ['student_id', 'student_name', 'class', 'attendance_pct', 'parent_phone'],
  },
  library_overdue: {
    label: 'Library books overdue',
    runnable: false,
    fields: ['student_id', 'student_name', 'book_title', 'days_overdue', 'parent_phone'],
  },
} as const;
export type FetchSourceId = keyof typeof FETCH_SOURCES;
export function isFetchSourceId(value: string): value is FetchSourceId {
  return Object.prototype.hasOwnProperty.call(FETCH_SOURCES, value);
}

export const fetchRecordsDataSchema = z.object({
  kind: z.literal('fetch_records'),
  source: z.custom<FetchSourceId>((v) => typeof v === 'string' && isFetchSourceId(v)),
});
export const computeDataSchema = z.object({
  kind: z.literal('compute'),
  /** e.g. "consecutive_days" derived from the fetched rows. Display-level for v1. */
  expression: z.string().min(1),
});
export const dataNodeDataSchema = z.discriminatedUnion('kind', [fetchRecordsDataSchema, computeDataSchema]);
export type DataNodeData = z.infer<typeof dataNodeDataSchema>;

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

export const COMPARATORS = ['>=', '>', '<=', '<', '==', '!='] as const;
export type Comparator = (typeof COMPARATORS)[number];

export const ifElseDataSchema = z.object({
  kind: z.literal('if_else'),
  field: z.string().min(1),
  op: z.enum(COMPARATORS),
  value: z.union([z.string(), z.number()]),
});

export const waitDataSchema = z.object({
  kind: z.literal('wait'),
  /**
   * [MANDATORY] CODING_GUIDELINES §5: "Wait nodes are delayed queue jobs, not
   * timers or sleeping threads" (ADR-022). This is config only — the runtime
   * (apps/agent-runtime/src/runner) is what turns it into a BullMQ delayed
   * job, never a `setTimeout`.
   */
  mode: z.enum(['duration', 'until_time']),
  minutes: z.number().int().positive().optional(),
  until_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

/** Always-on per docs/07 §5, but represented as an explicit node so its
 * position in the flow is visible on the canvas, matching the reference
 * screens' "Skip if already notified today" box. */
export const dedupGuardDataSchema = z.object({ kind: z.literal('dedup_guard') });

export const logicNodeDataSchema = z.discriminatedUnion('kind', [
  ifElseDataSchema,
  waitDataSchema,
  dedupGuardDataSchema,
]);
export type LogicNodeData = z.infer<typeof logicNodeDataSchema>;

// ---------------------------------------------------------------------------
// Actions — the only side effects an agent may have (ADR-023).
// ---------------------------------------------------------------------------

export const messageActionDataSchema = z.object({
  kind: z.literal('message'),
  channels: z.array(z.enum(CHANNEL_IDS)).min(1),
  primary: z.enum(CHANNEL_IDS),
  /** Delivery-failure fallback (docs/07 §4). Absent = no fallback. */
  fallback: z.enum(CHANNEL_IDS).optional(),
  /** Approved-template-only sending (ADR-024) — never free text on a regulated channel. */
  template_id: z.string().min(1),
  /** Rendered preview text with `{{variable}}` slots — display only; the
   * template's own approved body is the source of truth at send time. */
  template_preview: z.string().min(1),
  also_notify_staff: z.boolean().default(false),
});
export type MessageActionData = z.infer<typeof messageActionDataSchema>;

/** Declared per docs/07 §2; contingent on the ERP-notify API existing at all
 * (docs/11 §2 item 7, ADR-023/027). Publishing one is refused today — see
 * validate.ts — rather than silently doing nothing. */
export const erpNotifyActionDataSchema = z.object({ kind: z.literal('erp_notify'), message: z.string().min(1) });

export const notifyStaffActionDataSchema = z.object({
  kind: z.literal('notify_staff'),
  role: z.enum(['class_teacher', 'principal', 'admin']),
  message: z.string().min(1),
});

export const logActionDataSchema = z.object({ kind: z.literal('log'), message: z.string().min(1) });

export const actionNodeDataSchema = z.discriminatedUnion('kind', [
  messageActionDataSchema,
  erpNotifyActionDataSchema,
  notifyStaffActionDataSchema,
  logActionDataSchema,
]);
export type ActionNodeData = z.infer<typeof actionNodeDataSchema>;

// ---------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------

export const endNodeDataSchema = z.object({ kind: z.enum(['end', 'escalate_end']) });
export type EndNodeData = z.infer<typeof endNodeDataSchema>;

// ---------------------------------------------------------------------------
// The node/edge/graph envelope
// ---------------------------------------------------------------------------

export const agentNodeDataSchema = z.discriminatedUnion('kind', [
  scheduleTriggerSchema,
  manualTriggerSchema,
  emailTriggerSchema,
  erpEventTriggerSchema,
  fetchRecordsDataSchema,
  computeDataSchema,
  ifElseDataSchema,
  waitDataSchema,
  dedupGuardDataSchema,
  messageActionDataSchema,
  erpNotifyActionDataSchema,
  notifyStaffActionDataSchema,
  logActionDataSchema,
  endNodeDataSchema,
]);
export type AgentNodeData = z.infer<typeof agentNodeDataSchema>;

export const agentNodeSchema = z.object({
  id: z.string().min(1),
  /** React Flow canvas position (CODING_GUIDELINES §4: React Flow is the
   * fixed builder canvas). Cosmetic — never read by the runtime. */
  position: z.object({ x: z.number(), y: z.number() }),
  data: agentNodeDataSchema,
});
export type AgentNode = z.infer<typeof agentNodeSchema>;

export const agentEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  /** TRUE/FALSE branch label for if_else, or a named branch for multi_branch. */
  branch: z.string().optional(),
});
export type AgentEdge = z.infer<typeof agentEdgeSchema>;

export const agentGraphSchema = z.object({
  nodes: z.array(agentNodeSchema).min(1),
  edges: z.array(agentEdgeSchema),
});
export type AgentGraph = z.infer<typeof agentGraphSchema>;

/** True for the four action kinds that walk through a message/notify worker. */
export function isMessageAction(data: AgentNodeData): data is MessageActionData {
  return data.kind === 'message';
}

/** Node kinds apps/agent-runtime can actually execute today. Everything else
 * in the schema is declared for the builder/template gallery but refused at
 * publish time (validate.ts) — see docs/11's 2026-09-15 entry. */
export const RUNNABLE_TRIGGER_KINDS = new Set<TriggerType>(['schedule', 'manual']);
export const RUNNABLE_ACTION_KINDS = new Set<ActionNodeData['kind']>(['message', 'log', 'notify_staff']);
