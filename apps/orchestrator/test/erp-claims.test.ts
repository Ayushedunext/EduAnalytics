/**
 * Tests for the staging ERP claims adapter (auth/erp-claims.ts).
 *
 * The fixture is the ERP team's own `launchClaims` sample, trimmed in the perms
 * list only. What these tests hold:
 *
 *   1. Their real response produces valid `LaunchTokenClaims` — the five shape
 *      mismatches (object schools, object default_school, extra keys, empty
 *      jti, display-name perms) are all absorbed by the adapter.
 *   2. An unmapped role is REFUSED, not defaulted — the mapping decision that
 *      would otherwise fail silently as a data-visibility bug.
 *   3. Module `(N)`/`(O)`/`(Prime)` variants collapse to one permission.
 *   4. Unmapped modules grant nothing and are reported.
 *   5. `exp` is enforced here, because on this path nothing else enforces it.
 */

import { describe, expect, it } from 'vitest';
import { adaptErpLaunchClaims } from '../src/auth/erp-claims.js';

/** Their sample's own timestamps: iat + 24h, not ADR-003's 60 seconds. */
const IAT = 1789721436;
const EXP = 1789807836;
const DURING = new Date(IAT * 1000 + 60_000);

const school = {
  id: 'premium_test',
  db: 'premium_test',
  domain: null,
  name: 'premium_test',
  db_server: null,
};

const erpSample = {
  sub: 'praveen',
  name: 'praveen',
  role: 'Super Admin',
  org_id: 'premium_test',
  org_db: null,
  school_ids: [school],
  default_school: school,
  current_school: school,
  perms: [
    'Fee Invoice Management (N)',
    'Fee Management',
    'Student Attendance (O)',
    'Student Attendance',
    'Examination Management',
    'Employee Information (O)',
    'Employee Attendance',
    'Student Information System (O)',
    'Society Reports (Prime)',
    'Employee Recruitment(N)',
    'Hostel Management',
    'WAPI',
  ],
  iat: IAT,
  exp: EXP,
  jti: '',
};

const opts = { fallbackJti: 'generated-nonce', now: DURING };

describe('ERP launchClaims adapter', () => {
  it("accepts the ERP team's actual sample", () => {
    const r = adaptErpLaunchClaims(erpSample, opts);
    expect(r.ok).toBe(true);
  });

  it('maps Super Admin to DIRECTOR, the widest read scope (not ADMIN)', () => {
    const r = adaptErpLaunchClaims(erpSample, opts);
    if (!r.ok) throw new Error(r.issues.join('; '));
    expect(r.value.claims.role).toBe('DIRECTOR');
  });

  it('refuses an unmapped role rather than defaulting it', () => {
    // Defaulting here would present as a working session showing the wrong
    // data -- the failure mode the mapping table exists to prevent.
    const r = adaptErpLaunchClaims({ ...erpSample, role: 'Hostel Warden' }, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/role/);
  });

  it('translates ERP module names into domain.action perms', () => {
    const r = adaptErpLaunchClaims(erpSample, opts);
    if (!r.ok) throw new Error(r.issues.join('; '));
    expect(r.value.claims.perms).toEqual([
      'attendance.read',
      'exams.read',
      'fees.read',
      'staff.read',
      'students.read',
    ]);
  });

  it('collapses (N)/(O) duplicates of the same module to one perm', () => {
    const r = adaptErpLaunchClaims(
      { ...erpSample, perms: ['Student Attendance', 'Student Attendance (O)'] },
      opts,
    );
    if (!r.ok) throw new Error(r.issues.join('; '));
    expect(r.value.claims.perms).toEqual(['attendance.read']);
  });

  it('emits perms sorted, so permission_class is order-independent', () => {
    const forward = adaptErpLaunchClaims(erpSample, opts);
    const reversed = adaptErpLaunchClaims(
      { ...erpSample, perms: [...erpSample.perms].reverse() },
      opts,
    );
    if (!forward.ok || !reversed.ok) throw new Error('fixture invalid');
    expect(forward.value.claims.perms).toEqual(reversed.value.claims.perms);
  });

  it('grants nothing for unmapped modules but reports them', () => {
    const r = adaptErpLaunchClaims(erpSample, opts);
    if (!r.ok) throw new Error(r.issues.join('; '));
    expect(r.value.unmappedModules).toContain('Hostel Management');
    expect(r.value.unmappedModules).toContain('WAPI');
    expect(r.value.claims.perms).not.toContain('hostel.read');
  });

  it('flattens school objects to ids and keeps the topology separately', () => {
    const r = adaptErpLaunchClaims(erpSample, opts);
    if (!r.ok) throw new Error(r.issues.join('; '));
    expect(r.value.claims.school_ids).toEqual(['premium_test']);
    expect(r.value.claims.default_school).toBe('premium_test');
    expect(r.value.schools[0]).toEqual({
      id: 'premium_test',
      db: 'premium_test',
      name: 'premium_test',
      db_server: null,
      domain: null,
    });
  });

  it('drops current_school and org_db, which the strict contract would refuse', () => {
    const r = adaptErpLaunchClaims(erpSample, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.claims).not.toHaveProperty('current_school');
  });

  it('substitutes a nonce when the ERP sends an empty jti', () => {
    const r = adaptErpLaunchClaims(erpSample, opts);
    if (!r.ok) throw new Error(r.issues.join('; '));
    expect(r.value.claims.jti).toBe('generated-nonce');
  });

  it("prefers the ERP's own jti when it sends one", () => {
    const r = adaptErpLaunchClaims({ ...erpSample, jti: 'erp-nonce' }, opts);
    if (!r.ok) throw new Error(r.issues.join('; '));
    expect(r.value.claims.jti).toBe('erp-nonce');
  });

  it('rejects expired claims -- nothing else on this path checks exp', () => {
    const r = adaptErpLaunchClaims(erpSample, {
      ...opts,
      now: new Date(EXP * 1000 + 1000),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/exp/);
  });

  it('falls back to the first school when default_school is absent', () => {
    const { default_school: _omitted, ...withoutDefault } = erpSample;
    const r = adaptErpLaunchClaims(withoutDefault, opts);
    if (!r.ok) throw new Error(r.issues.join('; '));
    expect(r.value.claims.default_school).toBe('premium_test');
  });

  it('refuses a school id that is not identifier-safe', () => {
    // The second validation pass: school_id reaches a FROM clause, where it
    // cannot be parameterized, and no signature vouches for this response.
    const r = adaptErpLaunchClaims(
      { ...erpSample, school_ids: [{ ...school, id: 'prem`ium; DROP' }], default_school: null },
      opts,
    );
    expect(r.ok).toBe(false);
  });

  it('refuses a response that is not the expected shape at all', () => {
    expect(adaptErpLaunchClaims({ error: 'unauthorized' }, opts).ok).toBe(false);
    expect(adaptErpLaunchClaims(null, opts).ok).toBe(false);
  });
});
