/**
 * The MCP call context — how a session's allowed school set reaches the MCP
 * server OUT-OF-BAND.
 *
 * Contract source: ADR-007 · docs/04 §3 rail 3 · docs/08 §3 ·
 * CODING_GUIDELINES §7 [MANDATORY]: "Every tool call receives the session's
 * allowed school set out-of-band (transport/context metadata), never inside
 * model-generated content."
 *
 * -- Why a signed token rather than a plain header ---------------------------
 * "Out-of-band" only says *where* the set travels; it says nothing about who is
 * allowed to assert it. docs/08 §9 assumption 1 puts the MCP server on a private
 * subnet whose security group admits only the orchestrator, and that is real
 * defence — but it is a deployment property, and every other rail in this system
 * is a mechanism rather than an assumption (read-only grants AND AST validation;
 * scope checked at two layers). An unauthenticated header would make the MCP
 * server trust any process that can open a socket to it.
 *
 * So the orchestrator signs a short-lived context and the MCP server verifies it
 * before a tool exists to be called. Be precise about what that buys and what it
 * does not:
 *
 *   it DOES  — bind the allowed school set to a caller holding the shared
 *              secret, so a stray process on the network cannot invent a scope,
 *              and the set cannot be edited in flight;
 *   it DOES  — make the context tamper-evident in transit and expire in seconds,
 *              so a captured header is not a durable capability;
 *   it does NOT — make the MCP check independent of the orchestrator's *honesty*.
 *              The orchestrator holds the signing key, so a compromised
 *              orchestrator can sign any scope it likes.
 *
 * The independence ADR-007 asks for comes from elsewhere and must not be
 * confused with this: the MCP server resolves every tenant from the registry
 * itself, re-runs the ⊆ check with @sap/shared's `isWithinScope`, and injects the
 * tenant filter from its own resolution — it never accepts a database name,
 * host, or filter value from the caller. Two layers, one rule, checked twice.
 *
 * -- Why these claims and no more --------------------------------------------
 * Data minimisation (docs/08 §5): the MCP server needs the school set (scope),
 * `perms`/`role` (rail 6 masking and domain policies), `sub`/`org_id`
 * (audit — docs/08 §7), and the correlation id (CODING_GUIDELINES §5). It has no
 * use for the user's name, so the name does not travel.
 */

import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { safeIdSchema } from './identifiers.js';
import { ROLES } from './launch-token.js';
import { permSchema } from './launch-token.js';

/** The transport header the context rides on. Part of the contract. */
export const MCP_CONTEXT_HEADER = 'x-sap-mcp-context';

/**
 * Lifetime of a call context. Deliberately close to the 60 s launch token
 * (ADR-003) rather than the 8 h session (ADR-004): this artifact authorises one
 * tool call in flight, not a session, so a captured one should be worthless
 * almost immediately. 120 s leaves room for the 10 s query cap plus clock skew.
 */
export const MCP_CONTEXT_TTL_SECONDS = 120;

export const mcpCallContextSchema = z
  .object({
    /** Token `sub` — the acting user, for the audit trail (docs/08 §7). */
    sub: z.string().min(1),
    org_id: safeIdSchema,
    role: z.enum(ROLES),
    /**
     * [MANDATORY] The allowed set. Scope is law (Invariant 2) and immutable
     * within a session: this is a copy of the verified launch token's
     * `school_ids`, narrowed only by the orchestrator's own ⊆ check and by
     * registry servability (docs/02 §6). It is never widened anywhere.
     */
    school_ids: z.array(safeIdSchema).min(1),
    /** Domain permissions — rail 6 masking and docs/08 §4.5 policies. */
    perms: z.array(permSchema),
    /** ADR-028. Carried so cache and audit agree on the caller's visibility. */
    permission_class: z.string().min(1),
    /** CODING_GUIDELINES §5: propagated through MCP calls, queues and logs. */
    correlation_id: z.string().min(1),
  })
  .strict();

export type McpCallContext = z.infer<typeof mcpCallContextSchema>;

/** Mint a context for one MCP call. Orchestrator side. */
export async function signCallContext(
  context: McpCallContext,
  secret: Uint8Array,
): Promise<string> {
  return new SignJWT({ ...context })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${MCP_CONTEXT_TTL_SECONDS}s`)
    .sign(secret);
}

/**
 * Verify and parse a context. MCP side.
 *
 * Returns a discriminated result rather than throwing so the caller owns the
 * failure mode — the MCP server turns this into a structured protocol error and
 * an operational log line, and must not surface a crypto library's message to a
 * caller (CODING_GUIDELINES §6).
 *
 * [MANDATORY] CODING_GUIDELINES §3: the decoded payload is `unknown` until the
 * schema parses it. A valid signature proves authenticity, never shape.
 */
export async function verifyCallContext(
  raw: string,
  secret: Uint8Array,
): Promise<{ ok: true; context: McpCallContext } | { ok: false; reason: string }> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(raw, secret, { algorithms: ['HS256'] }));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'signature verification failed' };
  }
  const { iat: _iat, exp: _exp, nbf: _nbf, iss: _iss, aud: _aud, ...fields } =
    payload as Record<string, unknown>;
  const parsed = mcpCallContextSchema.safeParse(fields);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, context: parsed.data };
}
