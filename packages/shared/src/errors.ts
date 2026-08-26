/**
 * Platform error taxonomy.
 *
 * Contract source: CODING_GUIDELINES §6 (structured `{code, message, details?}`
 * with stable machine-readable codes; user-facing translation happens in the
 * SPA) and §10 (fail loud, degrade soft).
 *
 * Authored here because the taxonomy did not previously exist anywhere in the
 * doc set (AUDIT_REPORT C7). Codes are STABLE: the SPA switches on them for
 * user-facing copy, so renaming one is a breaking change.
 *
 * [MANDATORY] CODING_GUIDELINES §6: "Never leak SQL, stack traces, hostnames,
 * or another tenant's identifiers in error payloads." That is enforced
 * structurally below — diagnostics live on `PlatformError.diagnostics`, which
 * `toWireError()` drops. Anything a client may see must be in `details`, and
 * `details` is a flat map of scalars so a stray object cannot smuggle a
 * connection string into a response.
 */

/** Stable, client-visible error codes. Never renamed; only added to. */
export const ERROR_CODES = {
  // ── Launch & session (docs/02 §6, ADR-029) ────────────────────────────
  LAUNCH_TOKEN_INVALID: 'LAUNCH_TOKEN_INVALID',
  LAUNCH_TOKEN_EXPIRED: 'LAUNCH_TOKEN_EXPIRED',
  LAUNCH_TOKEN_REPLAYED: 'LAUNCH_TOKEN_REPLAYED',
  JWKS_UNAVAILABLE: 'JWKS_UNAVAILABLE',
  SESSION_INVALID: 'SESSION_INVALID',
  CSRF_CHECK_FAILED: 'CSRF_CHECK_FAILED',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',

  // ── Scope & authorization (Invariant 2, ADR-007) ──────────────────────
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  // ── Data plane (Invariant 3, ADR-008/011/013) ─────────────────────────
  SQL_REJECTED: 'SQL_REJECTED',
  ROW_CAP_EXCEEDED: 'ROW_CAP_EXCEEDED',
  QUERY_TIMEOUT: 'QUERY_TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  TENANT_UNAVAILABLE: 'TENANT_UNAVAILABLE',
  FANOUT_LIMIT_EXCEEDED: 'FANOUT_LIMIT_EXCEEDED',
  /** Not a failure: a partial success annotated per school (ADR-011). */
  PARTIAL_FAILURE: 'PARTIAL_FAILURE',

  // ── Reporting (ADR-018/019/020) ───────────────────────────────────────
  REPORT_NOT_FOUND: 'REPORT_NOT_FOUND',
  INVALID_CHART_SPEC: 'INVALID_CHART_SPEC',
  DRILL_PATH_INVALID: 'DRILL_PATH_INVALID',
  DRILL_DEPTH_EXCEEDED: 'DRILL_DEPTH_EXCEEDED',

  // ── Report definitions / clone-to-edit (ADR-018/019, AUDIT_REPORT A8/C17) ─
  REPORT_DEFINITION_NOT_FOUND: 'REPORT_DEFINITION_NOT_FOUND',
  REPORT_DEFINITION_FORBIDDEN: 'REPORT_DEFINITION_FORBIDDEN',
  REPORT_VERSION_NOT_FOUND: 'REPORT_VERSION_NOT_FOUND',

  // ── AI gating (Invariant 5, ADR-017) ──────────────────────────────────
  AI_NOT_ACTIVE: 'AI_NOT_ACTIVE',
  AI_QUOTA_EXCEEDED: 'AI_QUOTA_EXCEEDED',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',

  // ── Agents (ADR-024/025) ──────────────────────────────────────────────
  TEMPLATE_NOT_APPROVED: 'TEMPLATE_NOT_APPROVED',
  CHANNEL_NOT_CONNECTED: 'CHANNEL_NOT_CONNECTED',
  GUARDRAIL_BLOCKED: 'GUARDRAIL_BLOCKED',

  // ── Generic ───────────────────────────────────────────────────────────
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Only scalars — see the leak note in the module docblock. */
export type ErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

/** The wire shape. Exactly what a client receives; nothing else. */
export interface WireError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: ErrorDetails;
  readonly correlation_id?: string;
}

/**
 * Internal error. `diagnostics` is for operational logs only and is dropped by
 * `toWireError`. Put the SQL statement, the replica hostname, the driver error
 * — anything an operator needs and a tenant must not see — there.
 */
export class PlatformError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: ErrorDetails;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;

  constructor(args: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetails;
    diagnostics?: Readonly<Record<string, unknown>>;
    correlationId?: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = 'PlatformError';
    this.code = args.code;
    this.httpStatus = HTTP_STATUS_BY_CODE[args.code];
    if (args.details !== undefined) this.details = args.details;
    if (args.diagnostics !== undefined) this.diagnostics = args.diagnostics;
    if (args.correlationId !== undefined) this.correlationId = args.correlationId;
  }

  /** Strip everything a client must not see. */
  toWireError(): WireError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.correlationId === undefined ? {} : { correlation_id: this.correlationId }),
    };
  }
}

/**
 * HTTP status per code.
 *
 * Note AI_NOT_ACTIVE → 403: Invariant 5 and ADR-017 require every `/api/ai/*`
 * request to return 403 when `ai_status != active`. UI locks are cosmetic on
 * top of this.
 */
const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  LAUNCH_TOKEN_INVALID: 401,
  LAUNCH_TOKEN_EXPIRED: 401,
  LAUNCH_TOKEN_REPLAYED: 401,
  JWKS_UNAVAILABLE: 503,
  SESSION_INVALID: 401,
  CSRF_CHECK_FAILED: 403,
  WEBHOOK_SIGNATURE_INVALID: 401,

  SCOPE_VIOLATION: 403,
  PERMISSION_DENIED: 403,

  SQL_REJECTED: 400,
  ROW_CAP_EXCEEDED: 413,
  QUERY_TIMEOUT: 504,
  RATE_LIMITED: 429,
  TENANT_NOT_FOUND: 404,
  TENANT_UNAVAILABLE: 503,
  FANOUT_LIMIT_EXCEEDED: 400,
  PARTIAL_FAILURE: 200,

  REPORT_NOT_FOUND: 404,
  INVALID_CHART_SPEC: 500,
  DRILL_PATH_INVALID: 400,
  DRILL_DEPTH_EXCEEDED: 400,

  REPORT_DEFINITION_NOT_FOUND: 404,
  REPORT_DEFINITION_FORBIDDEN: 403,
  REPORT_VERSION_NOT_FOUND: 404,

  AI_NOT_ACTIVE: 403,
  AI_QUOTA_EXCEEDED: 429,
  AI_PROVIDER_ERROR: 502,

  TEMPLATE_NOT_APPROVED: 400,
  CHANNEL_NOT_CONNECTED: 400,
  GUARDRAIL_BLOCKED: 409,

  VALIDATION_FAILED: 400,
  INTERNAL: 500,
};

/**
 * A scope violation. Deliberately does NOT put the offending school ids in
 * `details`: naming another tenant's identifier back to a caller who was not
 * allowed to ask about it is precisely what CODING_GUIDELINES §6 forbids. The
 * ids go to `diagnostics` and to the audit record (docs/08 §7), where they
 * belong.
 */
export function scopeViolation(args: {
  requested: readonly string[];
  scope: readonly string[];
  correlationId?: string;
}): PlatformError {
  return new PlatformError({
    code: ERROR_CODES.SCOPE_VIOLATION,
    message: 'Requested schools are outside the scope granted by your launch token.',
    diagnostics: { requested: args.requested, scope: args.scope },
    ...(args.correlationId === undefined ? {} : { correlationId: args.correlationId }),
  });
}

/** Coerce an unknown thrown value into a PlatformError without leaking it. */
export function toPlatformError(err: unknown, correlationId?: string): PlatformError {
  if (err instanceof PlatformError) return err;
  return new PlatformError({
    code: ERROR_CODES.INTERNAL,
    message: 'An internal error occurred.',
    diagnostics: { raw: err instanceof Error ? err.message : String(err) },
    ...(correlationId === undefined ? {} : { correlationId }),
    cause: err,
  });
}
