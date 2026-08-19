/**
 * The orchestrator's MCP client — the only way this service reaches school data.
 *
 * Contract source: ADR-006 ("no other component holds DB connectivity to school
 * data") · ADR-007 (scope out-of-band) · docs/04 §7 assumption 1 (streamable
 * HTTP on the private network) · CODING_GUIDELINES §5 [MANDATORY] ("the
 * orchestrator and agent-runtime reach school data only through MCP tools").
 *
 * -- Why a client per request, not a shared one ------------------------------
 * The allowed school set travels out-of-band, in a header fixed when the
 * transport is constructed (@sap/shared mcp-context.ts). A transport is
 * therefore bound to exactly one session's scope, and sharing one across
 * requests would mean sharing one user's scope with another — the precise
 * failure ADR-007 exists to make impossible.
 *
 * That is not a workaround; it is the mechanism working. Scope-per-connection
 * costs one `initialize` round trip per request on a private network, which is
 * the same order as the connection setup any pooled HTTP client would do, and
 * several tool calls share one client (see `withMcp`).
 *
 * -- What this module refuses to do ------------------------------------------
 * It does not accept a school id from anywhere but a verified session, and it
 * has no code path that opens a database. If a future feature needs school data,
 * it gets a new MCP tool, never a shortcut past this file (§15: "never 'optimize'
 * by adding a direct DB path around MCP").
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ERROR_CODES,
  MCP_CONTEXT_HEADER,
  PlatformError,
  signCallContext,
  type McpCallContext,
} from '@sap/shared';
import { config, mcpContextSecret } from '../config.js';
import type { SessionClaims } from '../auth/session.js';

/**
 * A scoped handle on the tool surface. Deliberately narrow: callers name a tool
 * and get parsed JSON, and cannot reach the transport, the header or the
 * context.
 */
export interface McpSession {
  call<T>(tool: string, args: Record<string, unknown>): Promise<T>;
}

/**
 * Run `fn` against the MCP server with this session's scope attached.
 *
 * The context is built from the SESSION, never from request input — the session
 * is itself built from the verified launch token (ADR-002/003), so the school
 * set the MCP server checks against traces back to the ERP's signature and
 * nothing else.
 *
 * `schoolIds` narrows within the session and is expected to have already passed
 * the orchestrator's own ⊆ check (middleware/scope.ts). Passing it here does not
 * re-authorise anything: the MCP server checks it again, independently, which is
 * the whole point of ADR-007.
 */
export async function withMcp<T>(
  session: SessionClaims,
  correlationId: string,
  schoolIds: readonly string[],
  fn: (mcp: McpSession) => Promise<T>,
): Promise<T> {
  const context: McpCallContext = {
    sub: session.sub,
    org_id: session.org_id,
    role: session.role,
    school_ids: [...schoolIds],
    perms: [...session.perms],
    permission_class: session.permission_class,
    correlation_id: correlationId,
  };

  const token = await signCallContext(context, mcpContextSecret);
  const client = new Client({ name: 'sap-orchestrator', version: '0.1.0' });

  try {
    await client.connect(
      /**
       * The cast is SDK interop, not a trust-boundary cast: `Transport` declares
       * optional members that the concrete transport types as
       * explicitly-undefined, which `exactOptionalPropertyTypes` rejects.
       */
      new StreamableHTTPClientTransport(new URL(config.MCP_URL), {
        requestInit: { headers: { [MCP_CONTEXT_HEADER]: token } },
      }) as unknown as Transport,
    );
  } catch (err) {
    /**
     * Fail loud, degrade soft (§10). The MCP server being unreachable is an
     * outage of the entire data plane, and it must not surface as an empty
     * dashboard — an empty dashboard reads as "your school has no students".
     */
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'Analytics cannot reach the data service right now.',
      diagnostics: { reason: err instanceof Error ? err.message : String(err) },
      correlationId,
      cause: err,
    });
  }

  try {
    return await fn({
      call: <T2>(tool: string, args: Record<string, unknown>): Promise<T2> =>
        callTool<T2>(client, tool, args, correlationId),
    });
  } finally {
    // Closing is not optional: a leaked client holds a socket and, more to the
    // point, a signed context.
    await client.close().catch((err: unknown) => {
      console.error('[orchestrator:mcp] failed to close client:', err);
    });
  }
}

interface ToolContent {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

async function callTool<T>(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
  correlationId: string,
): Promise<T> {
  const result = (await client.callTool({ name: tool, arguments: args })) as ToolContent;
  const text = (result.content ?? []).map((part) => part.text ?? '').join('');

  if (result.isError === true) {
    /**
     * The MCP server returns tool failures as structured wire errors so the AI
     * can re-plan (docs/05). The orchestrator is not the AI: it re-raises them
     * as PlatformErrors so its own error boundary produces one shape for the
     * SPA, and so a SCOPE_VIOLATION at the MCP layer does not quietly become a
     * 200 with an empty widget.
     */
    let wire: { code?: string; message?: string } = {};
    try {
      wire = JSON.parse(text) as { code?: string; message?: string };
    } catch {
      /* a non-JSON error body keeps the generic message below */
    }
    const code = isKnownErrorCode(wire.code) ? wire.code : ERROR_CODES.INTERNAL;
    throw new PlatformError({
      code,
      message: wire.message ?? 'The data service could not complete this request.',
      diagnostics: { tool, raw: text.slice(0, 500) },
      correlationId,
    });
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new PlatformError({
      code: ERROR_CODES.INTERNAL,
      message: 'The data service returned an unreadable response.',
      diagnostics: { tool, reason: err instanceof Error ? err.message : String(err) },
      correlationId,
      cause: err,
    });
  }
}

const KNOWN_CODES = new Set<string>(Object.values(ERROR_CODES));

function isKnownErrorCode(code: unknown): code is (typeof ERROR_CODES)[keyof typeof ERROR_CODES] {
  return typeof code === 'string' && KNOWN_CODES.has(code);
}

/** The shape `run_multi` returns. Parsed, never trusted as a domain type (§3). */
export interface RunMultiResult {
  rows: Record<string, unknown>[];
  columns: string[];
  truncated: boolean;
  masked_columns: string[];
  per_school: {
    school_id: string;
    status: 'ok' | 'failed';
    rows?: number;
    error?: { code: string; message: string };
  }[];
  schools_succeeded: number;
  schools_failed: number;
  as_of: string;
}
