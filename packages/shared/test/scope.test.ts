/**
 * Invariant tests for scope enforcement.
 *
 * CODING_GUIDELINES §14 marks these [MANDATORY] before GA: "scope escape
 * attempts rejected at both layers (ADR-007)". These cover the shared rule both
 * layers call; the per-layer wiring is tested in each service.
 */

import { describe, expect, it } from 'vitest';
import {
  isWithinScope,
  outOfScope,
  effectiveScope,
  permissionClass,
  scopeFromToken,
} from '../src/scope.js';
import type { LaunchTokenClaims } from '../src/launch-token.js';

const director: LaunchTokenClaims = {
  sub: 'user_1',
  name: 'R. Mehta',
  role: 'DIRECTOR',
  org_id: 'stmarks',
  school_ids: ['stmarksg', 'stmarksj', 'stmarksmb'],
  default_school: 'stmarksmb',
  perms: ['fees.read', 'attendance.read'],
  iat: 0,
  exp: 60,
  jti: 'n1',
};

describe('scope: the subset check', () => {
  it('allows a subset of token scope', () => {
    expect(isWithinScope(['stmarksj'], scopeFromToken(director))).toBe(true);
    expect(isWithinScope(['stmarksg', 'stmarksmb'], scopeFromToken(director))).toBe(true);
  });

  it('rejects any id outside scope -- the scope-escape case', () => {
    expect(isWithinScope(['sacskb'], scopeFromToken(director))).toBe(false);
    expect(isWithinScope(['stmarksj', 'sacskb'], scopeFromToken(director))).toBe(false);
  });

  it('rejects an empty request rather than widening to all of scope', () => {
    expect(isWithinScope([], scopeFromToken(director))).toBe(false);
  });

  it('reports which ids were out of scope, for the audit record', () => {
    expect(outOfScope(['stmarksj', 'sacskb', 'dcsd'], scopeFromToken(director))).toEqual([
      'sacskb',
      'dcsd',
    ]);
  });

  it('a Principal token cannot reach a sibling school', () => {
    const principal: LaunchTokenClaims = {
      ...director,
      role: 'PRINCIPAL',
      school_ids: ['stmarksj'],
      default_school: 'stmarksj',
    };
    expect(isWithinScope(['stmarksmb'], scopeFromToken(principal))).toBe(false);
    expect(isWithinScope(['stmarksj'], scopeFromToken(principal))).toBe(true);
  });
});

describe('effective scope (docs/02 §6)', () => {
  it('drops unservable schools and reports them, never silently', () => {
    const { effective, dropped } = effectiveScope(scopeFromToken(director), [
      'stmarksg',
      'stmarksmb',
    ]);
    expect(effective).toEqual(['stmarksg', 'stmarksmb']);
    expect(dropped).toEqual(['stmarksj']);
  });
});

describe('permissionClass (ADR-028)', () => {
  it('is deterministic regardless of perm order', () => {
    const a = permissionClass({ role: 'PRINCIPAL', perms: ['fees.read', 'attendance.read'] });
    const b = permissionClass({ role: 'PRINCIPAL', perms: ['attendance.read', 'fees.read'] });
    expect(a).toBe(b);
  });

  it('differs when visibility differs -- this prevents cross-role cache hits', () => {
    const principal = permissionClass({ role: 'PRINCIPAL', perms: ['fees.read'] });
    const teacher = permissionClass({ role: 'TEACHER', perms: ['fees.read'] });
    const narrower = permissionClass({ role: 'PRINCIPAL', perms: [] });
    expect(principal).not.toBe(teacher);
    expect(principal).not.toBe(narrower);
  });
});
