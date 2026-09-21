/**
 * The ERP's `launchClaims` response shape -- NOT PRODUCT CODE.
 *
 * The rest of this stub plays the launch handshake the platform ASKED for
 * (ADR-003: sign an RS256 token, hand it over by form POST). This module plays
 * the one the ERP team actually built first: a REST endpoint returning UNSIGNED
 * claims JSON that the orchestrator fetches for itself (token introspection).
 *
 * Its job is to be faithful rather than convenient, including in the parts we
 * would not have chosen. It emits the ERP's own field shapes -- schools as
 * objects, `role` as a display string, `perms` as module names, `jti` empty, and
 * a 24-HOUR window rather than ADR-003's 60 seconds -- because the point of a
 * stub is to exercise `auth/erp-claims.ts` against something that behaves like
 * the real system. A stub that emitted a tidier payload would test the adapter
 * against our own wishes and pass regardless of whether the integration works.
 *
 * Source for every shape here: the sample response the ERP team supplied for
 * `GET /rest/analytics/erp/launchClaims`.
 */

import type { Identity } from './identities.js';

/**
 * Observed window: `exp - iat` was exactly 86400 in the ERP's sample.
 *
 * Deliberately NOT the 60 seconds of ADR-003 and of this stub's signed path.
 * The difference is the integration's most material security fact, so the stub
 * reproduces it rather than quietly normalising it away.
 */
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

/**
 * Every school in the local seeds lives in the one `ai_analysis` database and
 * is separated by `tenant_key`, not by schema (db/platform/seed/*.sql). The real
 * ERP returned a per-school `db`, so the field exists either way; what differs
 * is that here the honest value is the same for all of them.
 */
const LOCAL_DB = 'ai_analysis';
const LOCAL_DB_SERVER = '127.0.0.1';

/** Platform role -> the ERP's display string. */
const ERP_ROLE_BY_ROLE: Readonly<Record<string, string>> = Object.freeze({
  // The ERP's sample carried "Super Admin" for a user whose scope was a whole
  // society, which is what DIRECTOR means here.
  DIRECTOR: 'Super Admin',
  PRINCIPAL: 'Principal',
  TEACHER: 'Teacher',
  ACCOUNTANT: 'Accountant',
  ADMIN: 'Admin',
});

/**
 * Platform perm -> the ERP module names that imply it.
 *
 * The inverse of `PERM_BY_ERP_MODULE` in the orchestrator's adapter, and
 * deliberately emitting the `(N)`/`(O)` suffixed spellings: the suffix handling
 * is the fiddliest part of that mapping, so the stub should produce the form
 * that exercises it.
 */
const ERP_MODULES_BY_PERM: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'fees.read': ['Fee Management', 'Fee Invoice Management (N)'],
  'attendance.read': ['Student Attendance (O)', 'Student Attendance'],
  'staff.read': ['Employee Information (O)', 'Employee Attendance'],
  'exams.read': ['Examination Management'],
  'students.read': ['Student Information System (O)'],
});

/**
 * Modules the ERP hands to everyone and that grant nothing here.
 *
 * The real response carried 76 entries of which 64 mapped to no platform
 * permission. Including a representative slice keeps that ratio visible -- an
 * adapter tested only against modules it recognises would never show whether the
 * unmapped path works.
 */
const NOISE_MODULES: readonly string[] = Object.freeze([
  'School Information (N)',
  'E-learning',
  'Student Dashboard',
  'Teacher Dashboard',
  'Principal Dashboard',
  'Admission Management',
  'Transport Management (O)',
  'Library Management',
  'Hostel Management (N)',
  'Employee Payroll',
  'Financial Accounting',
  'Budget Management(N)',
  'Society Reports (Prime)',
  'Micro Scheduling',
  'Mess Management',
  'WAPI',
]);

interface ErpSchool {
  id: string;
  db: string;
  domain: string | null;
  name: string;
  db_server: string | null;
}

export interface ErpLaunchClaimsResponse {
  sub: string;
  name: string;
  role: string;
  org_id: string;
  org_db: string | null;
  school_ids: ErpSchool[];
  default_school: ErpSchool;
  /** The ERP sends this; the platform contract has no field for it. */
  current_school: ErpSchool;
  perms: string[];
  iat: number;
  exp: number;
  /** Empty in the ERP's own sample -- the adapter substitutes a nonce. */
  jti: string;
}

function school(id: string): ErpSchool {
  return { id, db: LOCAL_DB, domain: null, name: id, db_server: LOCAL_DB_SERVER };
}

/**
 * Render one identity in the ERP's response shape.
 *
 * `expired` backdates the window so the adapter's `exp` check can be exercised
 * — the equivalent of the signed path's `expired` fault, and worth having
 * because on this path nothing but the adapter checks expiry at all.
 */
export function toErpLaunchClaims(
  identity: Identity,
  options: { expired?: boolean } = {},
): ErpLaunchClaimsResponse {
  const now = Math.floor(Date.now() / 1000);
  const iat = options.expired === true ? now - TOKEN_TTL_SECONDS - 600 : now;

  const modules = new Set<string>();
  for (const perm of identity.claims.perms) {
    for (const module of ERP_MODULES_BY_PERM[perm] ?? []) modules.add(module);
  }
  for (const module of NOISE_MODULES) modules.add(module);

  const schools = identity.claims.school_ids.map(school);
  const preferred = schools.find((s) => s.id === identity.claims.default_school) ?? schools[0];
  // Every identity carries at least one school (the platform contract requires
  // it), so this is unreachable -- but the stub must not emit a response whose
  // shape it cannot honour, and a thrown error here is a far better signal than
  // a `default_school: undefined` that fails much later inside the adapter.
  if (preferred === undefined) throw new Error(`identity ${identity.key} has no schools`);

  return {
    sub: identity.claims.sub,
    name: identity.claims.name,
    role: ERP_ROLE_BY_ROLE[identity.claims.role] ?? identity.claims.role,
    org_id: identity.claims.org_id,
    org_db: null,
    school_ids: schools,
    default_school: preferred,
    current_school: preferred,
    perms: [...modules],
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
    jti: '',
  };
}
