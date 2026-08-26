/**
 * Audit event contract.
 *
 * Contract source: docs/08 §7 (the chokepoint table) · CODING_GUIDELINES §13
 * ([MANDATORY] audit trail; "audit writes are part of the feature's definition
 * of done, not a follow-up").
 *
 * Why a shared discriminated union: the events are written from ~8 different
 * chokepoints across four services, and schools are promised answers to
 * questions like "prove the parent was informed at 10:31" and "who looked at
 * this student's fee detail" (docs/08 §7). That only holds if every writer
 * produces the same shape.
 *
 * [MANDATORY] CODING_GUIDELINES §13 separates two streams. This is the AUDIT
 * stream. Operational logs are a different concern and must never carry SQL
 * parameter values containing personal data, message bodies, tokens, or keys.
 * The BYOK key and launch tokens are log-forbidden values in both streams.
 */

/** Common envelope on every audit event. */
export interface AuditBase {
  /** ISO 8601 UTC. */
  readonly at: string;
  /** Token `sub` — the acting user. */
  readonly actor_sub: string;
  readonly org_id: string;
  /** Propagated through MCP calls, queue messages and logs (§5). */
  readonly correlation_id: string;
}

/** docs/08 §7: "Report/dashboard view — user, school-set, report id, filters". */
export interface ReportViewedEvent extends AuditBase {
  readonly kind: 'report.viewed';
  readonly report_id: string;
  readonly school_ids: readonly string[];
  readonly filters: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * docs/08 §7: "Every executed SQL — statement, school_id, caller, rows
 * returned, duration". Written at the MCP layer, which is the single chokepoint
 * every school-data read passes through (ADR-006).
 */
export interface SqlExecutedEvent extends AuditBase {
  readonly kind: 'sql.executed';
  readonly school_id: string;
  readonly statement: string;
  readonly rows_returned: number;
  readonly duration_ms: number;
  /** Which MCP tool ran it, e.g. 'run_query'. */
  readonly tool: string;
  /** True when the row cap truncated the result (ADR-008). */
  readonly truncated: boolean;
}

/** docs/08 §7: "Drill click — level + drill context (who viewed which slice)". */
export interface DrillClickedEvent extends AuditBase {
  readonly kind: 'drill.clicked';
  readonly report_id: string;
  readonly school_ids: readonly string[];
  readonly level: 1 | 2 | 3;
  readonly context: readonly { readonly dim: string; readonly value: string }[];
}

/** docs/08 §7: "PDF export — report, school-set, drill path if any". */
export interface ExportedEvent extends AuditBase {
  readonly kind: 'report.exported';
  readonly report_id: string;
  readonly school_ids: readonly string[];
  readonly format: 'pdf';
  readonly drill_path?: readonly string[];
}

/** docs/08 §7: "AI query — question, tools invoked, per-school token usage". */
export interface AiQueryEvent extends AuditBase {
  readonly kind: 'ai.query';
  readonly school_ids: readonly string[];
  readonly question: string;
  readonly tools_invoked: readonly string[];
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens?: number;
}

/** A rejected scope request. Records what was asked (docs/08 §3: "logged"). */
export interface ScopeViolationEvent extends AuditBase {
  readonly kind: 'scope.violation';
  readonly requested: readonly string[];
  readonly scope: readonly string[];
  /** Which layer caught it — both check independently (ADR-007). */
  readonly layer: 'orchestrator' | 'mcp';
}

/**
 * A change to a custom report definition (ADR-018) — clone, save-from-AI,
 * visual/SQL edit, rollback, delete. Not `report.viewed`/`report.exported`,
 * which are reused unchanged for custom reports (their shape is already
 * origin-agnostic); this event is for changes to the DEFINITION itself, one
 * kind with an `action` field rather than five near-duplicate kinds, matching
 * `ConfigChangedEvent`'s convention below.
 */
export interface ReportDefinitionChangedEvent extends AuditBase {
  readonly kind: 'report_definition.changed';
  readonly report_id: string;
  readonly school_ids: readonly string[];
  readonly action: 'cloned' | 'saved_from_ai' | 'updated_visual' | 'updated_sql' | 'rolled_back' | 'deleted';
  readonly base_report_id?: string;
  readonly version: number;
}

/** docs/08 §7: "Config changes — key save/replace/disable, channel connect, agent publish". */
export interface ConfigChangedEvent extends AuditBase {
  readonly kind: 'config.changed';
  readonly subject:
    | 'ai_key'
    | 'ai_status'
    | 'channel'
    | 'agent'
    | 'report_visibility'
    | 'template';
  readonly action: string;
  readonly school_id?: string;
  /** Never the value itself — keys and tokens are log-forbidden (§13). */
  readonly summary: string;
}

export type AuditEvent =
  | ReportViewedEvent
  | SqlExecutedEvent
  | DrillClickedEvent
  | ExportedEvent
  | AiQueryEvent
  | ScopeViolationEvent
  | ConfigChangedEvent
  | ReportDefinitionChangedEvent;

export type AuditEventKind = AuditEvent['kind'];

/**
 * The sink every service writes through. Deliberately narrow: an audit write
 * must not be skippable, and must not be able to fail a request silently — the
 * implementation is responsible for durability, not the caller.
 */
export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}
