/**
 * agent-runtime's MCP client — the only way this service reaches school data
 * (ADR-006/023). Mirrors apps/orchestrator/src/mcp/client.ts's `withMcp`
 * exactly; the one difference is WHO the call context names.
 *
 * -- Why `sub` is `agent:<id>`, not a live user ------------------------------
 * A trigger evaluation runs on a schedule, unattended — there is no session to
 * read `sub`/`role`/`perms` from. Those claims still have to mean something
 * for the audit trail (docs/08 §7) and for rail 6 masking (docs/04 §3), so
 * they are SNAPSHOTTED at publish time onto `agent_versions.published_role`/
 * `published_perms` (the publisher's own token claims, the moment they clicked
 * Publish) and carried forward into every run that version produces. This is
 * the same non-widening discipline ADR-032 applies to a viewer's effective
 * report scope, applied here to a background run's effective permissions: an
 * agent can never read with more authority than whoever published it held,
 * and re-publishing (by someone else, with different claims) is the only way
 * that authority changes.
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
  type Role,
} from '@sap/shared';
import { config, mcpContextSecret } from '../config.js';

export interface McpSession {
  call<T>(tool: string, args: Record<string, unknown>): Promise<T>;
}

export interface AgentMcpIdentity {
  readonly agentId: string;
  readonly orgId: string;
  readonly role: Role;
  readonly perms: readonly string[];
  readonly schoolIds: readonly string[];
  readonly correlationId: string;
}

export async function withAgentMcp<T>(
  identity: AgentMcpIdentity,
  fn: (mcp: McpSession) => Promise<T>,
): Promise<T> {
  const context: McpCallContext = {
    sub: `agent:${identity.agentId}`,
    org_id: identity.orgId,
    role: identity.role,
    school_ids: [...identity.schoolIds],
    perms: [...identity.perms],
    /** No cache reads happen from this path (a trigger evaluation is a fresh
     * replica read every tick, never served from the result cache), so this
     * is a fixed, inert value rather than a real permission_class digest. */
    permission_class: 'agent-runtime',
    correlation_id: identity.correlationId,
  };

  const token = await signCallContext(context, mcpContextSecret);
  const client = new Client({ name: 'sap-agent-runtime', version: '0.1.0' });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.MCP_URL), {
        requestInit: { headers: { [MCP_CONTEXT_HEADER]: token } },
      }) as unknown as Transport,
    );
  } catch (err) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'Agent runtime cannot reach the data service right now.',
      diagnostics: { reason: err instanceof Error ? err.message : String(err) },
      correlationId: identity.correlationId,
      cause: err,
    });
  }

  try {
    return await fn({
      call: <T2>(tool: string, args: Record<string, unknown>): Promise<T2> =>
        callTool<T2>(client, tool, args, identity.correlationId),
    });
  } finally {
    await client.close().catch((err: unknown) => {
      console.error('[agent-runtime:mcp] failed to close client:', err);
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
    let wire: { code?: string; message?: string } = {};
    try {
      wire = JSON.parse(text) as { code?: string; message?: string };
    } catch {
      /* non-JSON error body keeps the generic message below */
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
