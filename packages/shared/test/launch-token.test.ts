import { describe, expect, it } from 'vitest';
import { parseLaunchTokenClaims, hasPerm } from '../src/launch-token.js';

const valid = {
  sub: 'user_1',
  name: 'R. Mehta',
  role: 'DIRECTOR',
  org_id: 'stmarks',
  school_ids: ['stmarksg', 'stmarksj'],
  default_school: 'stmarksg',
  perms: ['fees.read'],
  iat: 0,
  exp: 60,
  jti: 'n1',
};

describe('launch token claims', () => {
  it('accepts the docs/02 §3 contract', () => {
    const r = parseLaunchTokenClaims(valid);
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown role rather than coercing it', () => {
    const r = parseLaunchTokenClaims({ ...valid, role: 'SUPERUSER' });
    expect(r.ok).toBe(false);
  });

  it('rejects extra claims -- a token is not an extension point', () => {
    const r = parseLaunchTokenClaims({ ...valid, is_admin: true });
    expect(r.ok).toBe(false);
  });

  it('rejects empty school_ids: a session with no scope is not a session', () => {
    const r = parseLaunchTokenClaims({ ...valid, school_ids: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects a default_school outside school_ids', () => {
    const r = parseLaunchTokenClaims({ ...valid, default_school: 'sacskb' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/default_school/);
  });

  it('rejects duplicate school_ids', () => {
    const r = parseLaunchTokenClaims({ ...valid, school_ids: ['stmarksg', 'stmarksg'] });
    expect(r.ok).toBe(false);
  });

  it('tolerates an unknown perm from a newer ERP (docs/02 §8)', () => {
    // New domains must not fail verification -- they simply grant nothing yet.
    const r = parseLaunchTokenClaims({ ...valid, perms: ['fees.read', 'transport.read'] });
    expect(r.ok).toBe(true);
  });

  it('rejects a malformed perm', () => {
    const r = parseLaunchTokenClaims({ ...valid, perms: ['DROP TABLE students'] });
    expect(r.ok).toBe(false);
  });

  it('hasPerm reads the claim, never a local role table', () => {
    const r = parseLaunchTokenClaims(valid);
    if (!r.ok) throw new Error('fixture invalid');
    expect(hasPerm(r.claims, 'fees.read')).toBe(true);
    expect(hasPerm(r.claims, 'exams.read')).toBe(false);
  });
});
