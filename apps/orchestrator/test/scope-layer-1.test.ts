/**
 * [MANDATORY] CODING_GUIDELINES §14 — invariant tests, layer 1.
 *
 * ADR-007 enforces scope at two layers, and §14 requires "scope escape attempts
 * rejected at BOTH layers". The MCP layer's wiring is tested in
 * apps/mcp-server/test/invariants.test.ts; this covers the orchestrator's, so
 * the pair is complete rather than half-asserted.
 *
 * The point of a per-layer test — as opposed to the shared-rule tests in
 * packages/shared — is the wiring: that this layer actually calls the rule, on
 * the right inputs, before doing anything else, and that a rejection produces
 * the audit event docs/08 §3 requires. A layer that computed the right answer
 * and forgot to act on it would pass every test in `@sap/shared`.
 *
 * The registry and the audit sink are mocked because neither is what is being
 * tested here, and mocking them keeps this test runnable without a database —
 * an invariant test that only runs when MySQL is up is an invariant test that
 * stops running.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { PlatformError, type AuditEvent } from '@sap/shared';
// Type-only, so this does not pull in the config module and its env validation.
import type { SessionClaims } from '../src/auth/session.js';

const written: AuditEvent[] = [];

vi.mock('../src/db/audit.js', () => ({
  auditSink: {
    write: (event: AuditEvent) => {
      written.push(event);
      return Promise.resolve();
    },
  },
}));

vi.mock('../src/db/registry.js', () => ({
  servableSchoolIds: () => Promise.resolve(['stmarksg', 'stmarksj', 'stmarksmb']),
}));

const { resolveRequestedSchools } = await import('../src/middleware/scope.js');

const SESSION: SessionClaims = {
  sub: 'erp-user-2001',
  name: 'S. Kapoor',
  role: 'PRINCIPAL',
  org_id: 'stmarks',
  school_ids: ['stmarksmb'],
  default_school: 'stmarksmb',
  perms: ['fees.read', 'students.read'],
  permission_class: 'test-class',
};

function request(query: Record<string, string> = {}, session: SessionClaims = SESSION): Request {
  return {
    session,
    query,
    correlationId: 'corr-1',
  } as unknown as Request;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof PlatformError ? err.code : 'NOT_A_PLATFORM_ERROR';
  }
  return 'NO_ERROR';
}

beforeEach(() => {
  written.length = 0;
});

describe('ADR-007 layer 1: the orchestrator rejects scope escapes', () => {
  it('allows the session to select within its own scope', async () => {
    await expect(resolveRequestedSchools(request({ school_ids: 'stmarksmb' }))).resolves.toEqual([
      'stmarksmb',
    ]);
  });

  it('defaults to the whole session scope when no selection is made', async () => {
    await expect(resolveRequestedSchools(request())).resolves.toEqual(['stmarksmb']);
  });

  it('refuses a school the token does not carry', async () => {
    // stmarksj is a real, active, same-org school. It is simply not this
    // Principal's, which is the case the double check exists for.
    expect(await codeOf(() => resolveRequestedSchools(request({ school_ids: 'stmarksj' })))).toBe(
      'SCOPE_VIOLATION',
    );
  });

  it('refuses a selection that mixes an in-scope and an out-of-scope school', async () => {
    const director: SessionClaims = {
      ...SESSION,
      role: 'DIRECTOR',
      school_ids: ['stmarksg', 'stmarksj'],
    };
    expect(
      await codeOf(() =>
        resolveRequestedSchools(request({ school_ids: 'stmarksg,sacskb' }, director)),
      ),
    ).toBe('SCOPE_VIOLATION');
  });

  it('refuses an empty selection rather than widening it to everything', async () => {
    // A bug that produces an empty list must not silently mean "all of scope".
    expect(await codeOf(() => resolveRequestedSchools(request({ school_ids: '' })))).toBe(
      'SCOPE_VIOLATION',
    );
  });

  it('writes a scope.violation audit event tagged to this layer', async () => {
    await codeOf(() => resolveRequestedSchools(request({ school_ids: 'stmarksj' })));

    const violations = written.filter((e) => e.kind === 'scope.violation');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      layer: 'orchestrator',
      actor_sub: SESSION.sub,
      org_id: SESSION.org_id,
      correlation_id: 'corr-1',
      requested: ['stmarksj'],
      scope: ['stmarksmb'],
    });
  });

  it('does not name the refused school in the client-visible error', async () => {
    try {
      await resolveRequestedSchools(request({ school_ids: 'stmarksj' }));
      throw new Error('should have thrown');
    } catch (err) {
      // §6: another tenant's identifier must not reach an error payload. The ids
      // belong in `diagnostics` and the audit row, both of which are checked
      // above.
      const wire = JSON.stringify((err as PlatformError).toWireError());
      expect(wire).not.toContain('stmarksj');
    }
  });

  it('refuses when a session has no valid session at all', async () => {
    const anonymous = { query: {}, correlationId: 'corr-1' } as unknown as Request;
    expect(await codeOf(() => resolveRequestedSchools(anonymous))).toBe('SESSION_INVALID');
  });
});
