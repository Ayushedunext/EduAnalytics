/**
 * The MCP endpoint over streamable HTTP.
 *
 * Contract source: ADR-006 · docs/04 §1 (stateless, read-only, private network
 * only, never internet-exposed) · docs/04 §7 assumption 1 (streamable HTTP
 * between orchestrator and MCP) · CODING_GUIDELINES §7.
 *
 * -- Stateless, deliberately -------------------------------------------------
 * A new `McpServer` and a new transport per request, with no session id. docs/04
 * §6 runs 2–4 instances behind an internal ALB, and docs/01 §5 forbids
 * in-process state a restart would lose — a stateful MCP session would pin a
 * conversation to one instance and break on the first deploy. The per-request
 * lifetime is also what lets the verified call context be closed over rather
 * than looked up (mcp.ts).
 *
 * -- The context is verified before a tool exists ----------------------------
 * [MANDATORY] CODING_GUIDELINES §7: the allowed school set arrives out-of-band,
 * "never inside model-generated content". It arrives as a signed header
 * (@sap/shared mcp-context.ts) and is verified here, before the MCP server for
 * this request is constructed. A request without a valid context never reaches a
 * tool, so there is no ordering in which a handler could run un-scoped.
 *
 * The server is built as a factory rather than started at import time so tests
 * can run it on an ephemeral port — which is what makes the §14 invariant tests
 * exercise the real transport instead of calling handlers directly.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  MCP_CONTEXT_HEADER,
  verifyCallContext,
  type AuditSink,
  type McpCallContext,
} from '@sap/shared';
import { buildMcpServer } from './mcp.js';
import type { ToolContext } from './scope.js';

export const MCP_PATH = '/mcp';

export interface McpHttpOptions {
  /** Injected so tests can record audit events instead of writing to MySQL. */
  readonly audit: AuditSink;
  /** Shared with the orchestrator, which signs the call context. */
  readonly contextSecret: Uint8Array;
}

export function createMcpHttpServer(options: McpHttpOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, options).catch((err: unknown) => {
      console.error('[mcp:http] unhandled request failure:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: McpHttpOptions,
): Promise<void> {
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path !== MCP_PATH) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  /**
   * Stateless mode has no server-initiated stream and no session to delete, so
   * only POST is meaningful. Answering GET and DELETE with 405 rather than
   * letting the transport negotiate them keeps the surface honest about what
   * this deployment supports.
   */
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const context = await verifiedContext(req, options);
  if (context === null) {
    /**
     * 401 with no detail. The caller is a platform service, not a user, and the
     * reason a context failed verification is an operational fact (already
     * logged) rather than something to describe over the wire.
     */
    sendJson(res, 401, { error: 'invalid_call_context' });
    return;
  }

  const toolContext: ToolContext = { call: context, audit: options.audit };
  const server = buildMcpServer(toolContext);
  // Stateless: omitting `sessionIdGenerator` is how the SDK is told not to
  // generate, negotiate or validate a session id.
  const transport = new StreamableHTTPServerTransport({});

  /**
   * Both are per-request resources. Closing on response end rather than after
   * `handleRequest` returns matters for the streaming case, where the response
   * outlives the call.
   */
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  /**
   * The cast is library interop, not a trust-boundary cast (CODING_GUIDELINES
   * §3 forbids the latter): the SDK's `Transport` declares `onclose?: () => void`
   * while its own transport class declares `(() => void) | undefined`, and under
   * `exactOptionalPropertyTypes` those are not assignable. Nothing about the
   * value is being reinterpreted.
   */
  await server.connect(transport as unknown as Transport);
  await transport.handleRequest(req, res);
}

async function verifiedContext(
  req: IncomingMessage,
  options: McpHttpOptions,
): Promise<McpCallContext | null> {
  const header = req.headers[MCP_CONTEXT_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;

  if (raw === undefined || raw === '') {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'mcp',
        event: 'call_context.missing',
        reason: `no ${MCP_CONTEXT_HEADER} header`,
      }),
    );
    return null;
  }

  const verified = await verifyCallContext(raw, options.contextSecret);
  if (!verified.ok) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'mcp',
        event: 'call_context.rejected',
        // The reason, never the token: it carries the session's scope, and
        // CODING_GUIDELINES §13 keeps credentials out of both log streams.
        reason: verified.reason,
      }),
    );
    return null;
  }
  return verified.context;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
