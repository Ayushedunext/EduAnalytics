/**
 * [MANDATORY] CODING_GUIDELINES §14 — invariant tests, layer 2.
 *
 * "Invariant tests (highest value, [MANDATORY] before GA): scope escape attempts
 * rejected at both layers (ADR-007); non-SELECT/multi-statement SQL rejected
 * (ADR-008)."
 *
 * These run against a real MCP server over the real streamable-HTTP transport,
 * driven by the real MCP client — not against handler functions. That matters:
 * the thing under test is not "does `isWithinScope` return false", which
 * packages/shared already proves. It is that a tool call arriving over the wire,
 * shaped exactly as the AI agent service will shape it, cannot reach a school
 * outside the set that travelled out-of-band. A test that called the handler
 * directly would skip the transport, the context verification and the tool
 * registration — the three places the mechanism actually lives.
 *
 * No database is required, and that is by construction rather than by luck: the
 * scope check and the SQL guard both run before tenant resolution, so every
 * rejection path completes without a connection. If a future change made one of
 * these tests need a database, that would itself be the finding — it would mean
 * work is happening before the check that refuses it.
 */

import './env-defaults.js';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  MCP_CONTEXT_HEADER,
  permissionClass,
  signCallContext,
  type AuditEvent,
  type AuditSink,
  type McpCallContext,
} from '@sap/shared';
import { TEST_CONTEXT_SECRET } from './env-defaults.js';
import { createMcpHttpServer } from '../src/http.js';

const secret = new TextEncoder().encode(TEST_CONTEXT_SECRET);

/** Records instead of writing to MySQL, so the audit assertions need no DB. */
const written: AuditEvent[] = [];
const recordingSink: AuditSink = {
  write(event) {
    written.push(event);
    return Promise.resolve();
  },
};

let server: Server;
let baseUrl: URL;

/** A Principal of one school — the identity whose scope is easiest to escape. */
const PRINCIPAL: Omit<McpCallContext, 'permission_class' | 'correlation_id'> = {
  sub: 'erp-user-2001',
  org_id: 'stmarks',
  role: 'PRINCIPAL',
  school_ids: ['stmarksmb'],
  perms: ['fees.read', 'students.read', 'staff.read'],
};

function contextFor(
  identity = PRINCIPAL,
  correlationId = randomUUID(),
): McpCallContext {
  return {
    ...identity,
    permission_class: permissionClass({ role: identity.role, perms: identity.perms }),
    correlation_id: correlationId,
  };
}

/**
 * The cast is the same SDK interop noted in src/http.ts: `Transport` declares
 * optional members the concrete transport types as explicitly-undefined, which
 * `exactOptionalPropertyTypes` rejects. Kept in one place here too.
 */
function transportFor(token?: string): Transport {
  const options = token === undefined ? {} : { requestInit: { headers: { [MCP_CONTEXT_HEADER]: token } } };
  return new StreamableHTTPClientTransport(baseUrl, options) as unknown as Transport;
}

async function connect(context: McpCallContext): Promise<Client> {
  const token = await signCallContext(context, secret);
  const client = new Client({ name: 'invariant-test', version: '0.0.0' });
  await client.connect(transportFor(token));
  return client;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; code: string | undefined; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content.map((c) => c.text ?? '').join('');
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { code?: string }).code;
  } catch {
    code = undefined;
  }
  return { isError: result.isError === true, code, text };
}

beforeAll(async () => {
  server = createMcpHttpServer({ audit: recordingSink, contextSecret: secret });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = new URL(`http://127.0.0.1:${String(address.port)}/mcp`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe('ADR-007 layer 2: scope escapes are rejected at the MCP layer', () => {
  it('refuses a school the session does not hold, over the wire', async () => {
    written.length = 0;
    const client = await connect(contextFor());
    // stmarksj is real, active, and in the same org. The only thing wrong with
    // it is that this token does not carry it — which is the whole point.
    const result = await call(client, 'run_query', {
      school_id: 'stmarksj',
      sql: 'SELECT COUNT(*) AS n FROM students_data_set',
    });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.code).toBe('SCOPE_VIOLATION');
  });

  it('names no other tenant in the error it returns', async () => {
    const client = await connect(contextFor());
    const result = await call(client, 'run_query', {
      school_id: 'stmarksj',
      sql: 'SELECT COUNT(*) AS n FROM students_data_set',
    });
    await client.close();
    // CODING_GUIDELINES §6: another tenant's identifier must not appear in an
    // error payload — telling a caller which school it failed to reach is itself
    // a disclosure.
    expect(result.text).not.toContain('stmarksj');
  });

  it('writes a scope.violation audit event tagged with this layer', async () => {
    written.length = 0;
    const correlationId = randomUUID();
    const client = await connect(contextFor(PRINCIPAL, correlationId));
    await call(client, 'run_query', {
      school_id: 'stmarksj',
      sql: 'SELECT COUNT(*) AS n FROM students_data_set',
    });
    await client.close();

    const violations = written.filter((e) => e.kind === 'scope.violation');
    expect(violations).toHaveLength(1);
    const event = violations[0]!;
    // `layer` distinguishes a violation the orchestrator missed from one it
    // caught, and those are materially different incidents (docs/08 §7).
    expect(event).toMatchObject({
      layer: 'mcp',
      actor_sub: PRINCIPAL.sub,
      org_id: PRINCIPAL.org_id,
      correlation_id: correlationId,
      requested: ['stmarksj'],
      scope: ['stmarksmb'],
    });
  });

  it('refuses a fan-out where only one school is out of scope', async () => {
    written.length = 0;
    const director = {
      ...PRINCIPAL,
      sub: 'erp-user-1001',
      role: 'DIRECTOR' as const,
      school_ids: ['stmarksg', 'stmarksj'],
    };
    const client = await connect(contextFor(director));
    const result = await call(client, 'run_multi', {
      school_ids: ['stmarksg', 'stmarksj', 'sacskb'],
      sql: 'SELECT COUNT(*) AS n FROM students_data_set',
    });
    await client.close();

    expect(result.code).toBe('SCOPE_VIOLATION');
    // All or nothing: the in-scope schools must not be queried either, or a
    // caller could enumerate scope by watching which parts succeed.
    expect(written.filter((e) => e.kind === 'sql.executed')).toHaveLength(0);
  });

  it('refuses get_dimensions for a school outside scope', async () => {
    const client = await connect(contextFor());
    const result = await call(client, 'get_dimensions', { school_id: 'stmarksj' });
    await client.close();
    expect(result.code).toBe('SCOPE_VIOLATION');
  });

  it('rejects a call with no out-of-band context at all', async () => {
    const client = new Client({ name: 'invariant-test', version: '0.0.0' });
    await expect(client.connect(transportFor())).rejects.toThrow();
  });

  it('rejects a context signed with the wrong key', async () => {
    const forged = await signCallContext(
      contextFor({ ...PRINCIPAL, school_ids: ['stmarksg', 'stmarksj', 'stmarksmb'] }),
      new TextEncoder().encode('a-different-secret-entirely-not-ours'),
    );
    const client = new Client({ name: 'invariant-test', version: '0.0.0' });
    await expect(client.connect(transportFor(forged))).rejects.toThrow();
  });

  it('rejects an expired context', async () => {
    // Signed with a real key but stale: the context authorises one call in
    // flight, so a captured header must not be a durable capability.
    const { SignJWT } = await import('jose');
    const stale = await new SignJWT({ ...contextFor() })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(secret);

    const client = new Client({ name: 'invariant-test', version: '0.0.0' });
    await expect(client.connect(transportFor(stale))).rejects.toThrow();
  });
});

describe('ADR-008: non-SELECT and multi-statement SQL is rejected over the wire', () => {
  it.each([
    ['a write', "DELETE FROM students_data_set WHERE studentid = 1"],
    ['a stacked statement', 'SELECT 1 FROM students_data_set; DROP TABLE students_data_set'],
    ['a DDL statement', 'DROP TABLE students_data_set'],
    ['a table outside the catalog', 'SELECT * FROM mysql.user'],
    ['a locking read', 'SELECT studentid FROM students_data_set FOR UPDATE'],
  ])('refuses %s', async (_label, sql) => {
    written.length = 0;
    const client = await connect(contextFor());
    const result = await call(client, 'run_query', { school_id: 'stmarksmb', sql });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.code).toBe('SQL_REJECTED');
    // Nothing reached a database, so nothing was executed to audit.
    expect(written.filter((e) => e.kind === 'sql.executed')).toHaveLength(0);
  });

  it('does not echo the rejected statement back to the caller', async () => {
    const client = await connect(contextFor());
    const result = await call(client, 'run_query', {
      school_id: 'stmarksmb',
      sql: 'DROP TABLE students_data_set',
    });
    await client.close();
    // CODING_GUIDELINES §6: no SQL in error payloads. The reason is enough for
    // the model to re-plan; the statement belongs in the operational log.
    expect(result.text).not.toContain('DROP TABLE');
  });
});

describe('the tool surface is the contract (ADR-006)', () => {
  it('exposes exactly the tools this slice implements, under their contract names', async () => {
    const client = await connect(contextFor());
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    // run_rollup is absent deliberately, not forgotten — it arrives with the
    // Rollup Store, whose engine is still an open decision (see mcp.ts).
    expect(listed).toEqual([
      'get_dimensions',
      'get_schema',
      'run_multi',
      'run_predefined',
      'run_query',
    ]);
  });

  it('does not accept a school set as a tool argument', async () => {
    const client = await connect(contextFor());
    const tools = (await client.listTools()).tools;
    await client.close();
    // The allowed set arrives out-of-band and must never be expressible in the
    // model-facing schema (ADR-007, CODING_GUIDELINES §7).
    for (const tool of tools) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(properties).not.toContain('scope');
      expect(properties).not.toContain('allowed_school_ids');
      expect(properties).not.toContain('org_id');
      expect(properties).not.toContain('perms');
      // Nor may any tool accept SQL it did not author, beyond the two whose
      // contract is a statement (docs/04 §2). run_predefined takes a report id.
      if (tool.name === 'run_predefined') expect(properties).not.toContain('sql');
    }
  });
});
