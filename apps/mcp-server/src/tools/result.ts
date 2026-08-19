/**
 * How a tool answers.
 *
 * Two shapes only, so every tool fails the same way and the model can learn one
 * error contract (docs/05: the AI re-plans from the reason it is given).
 *
 * [MANDATORY] CODING_GUIDELINES §6: "Never leak SQL, stack traces, hostnames, or
 * another tenant's identifiers in error payloads." That is enforced by
 * construction rather than by remembering — the wire shape comes from
 * `PlatformError.toWireError()`, which drops `diagnostics`, and this module is
 * the only place a thrown error becomes a tool response. Diagnostics go to the
 * operational log, where operators need them and callers cannot see them.
 *
 * Note who the "caller" is here. A tool error is read by the AI model, so it is
 * untrusted output going to an untrusted reader: it must say enough to re-plan
 * ("that table is not in the catalog") and nothing about the tenant, the host or
 * the statement.
 */

import { toPlatformError } from '@sap/shared';

export interface ToolResponse {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export function ok(payload: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function fail(err: unknown, context: { tool: string; correlationId: string }): ToolResponse {
  const platformError = toPlatformError(err, context.correlationId);

  console.error(
    JSON.stringify({
      level: 'error',
      service: 'mcp',
      tool: context.tool,
      code: platformError.code,
      correlation_id: context.correlationId,
      message: platformError.message,
      diagnostics: platformError.diagnostics ?? null,
    }),
  );

  return {
    /**
     * `isError` rather than a thrown JSON-RPC error: a rejected query is a
     * result the model must see and react to, not a transport failure. A
     * protocol-level error would end the turn instead of letting the model fix
     * its SQL and try again.
     */
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(platformError.toWireError(), null, 2) }],
  };
}
