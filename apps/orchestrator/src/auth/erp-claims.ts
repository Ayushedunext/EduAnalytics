/**
 * ERP `launchClaims` response → `LaunchTokenClaims`.
 *
 * STAGING ONLY. The production launch path is ADR-003/ADR-029: the ERP signs an
 * RS256 token and form-POSTs it, and `auth/jwks.ts` verifies that signature
 * before any of this would run. This module exists because the ERP team built
 * the other shape first — a REST endpoint returning unsigned claims JSON that
 * the orchestrator fetches (token introspection).
 *
 * Everything vendor-specific about that arrangement is deliberately confined to
 * this one file: one response schema and two mapping tables. When the ERP can
 * sign a token, deleting this file and its config flag removes the entire path
 * — which is the property that makes taking the shortcut reversible.
 *
 * [MANDATORY] CODING_GUIDELINES §3: this is an external response and is
 * `unknown` until parsed. It carries NO signature, so unlike the JWT path there
 * is no proof of origin — only TLS to the ERP host. Every field is therefore
 * validated here, and the mapped result is validated a SECOND time against the
 * real contract through `parseLaunchTokenClaims`. Authenticity and content are
 * different questions (the reasoning `auth/jwks.ts` gives for its own two-step
 * check); this path has no answer to the first, so the second must be strict.
 */

import { z } from 'zod';
import {
  KNOWN_PERMS,
  ROLES,
  parseLaunchTokenClaims,
  type KnownPerm,
  type LaunchTokenClaims,
  type Role,
} from '@sap/shared';

/**
 * A school as the ERP describes it.
 *
 * Their `school_ids` carries objects, not ids — `{id, db, domain, name,
 * db_server}`. That is more than a token needs and exactly what the Tenant
 * Registry needs (docs/02 §5), so the adapter returns it separately rather than
 * discarding it: in staging it is the only available source of the school→db
 * mapping the registry sync would normally supply.
 */
export interface ErpSchool {
  readonly id: string;
  readonly db: string | null;
  readonly name: string | null;
  readonly db_server: string | null;
  readonly domain: string | null;
}

/**
 * Tolerant on purpose, and the opposite posture from `launchTokenClaimsSchema`.
 *
 * That schema is `.strict()` because it is OUR contract — an unexpected claim
 * there means someone is extending a contract without amending it. This one
 * describes a THIRD PARTY's response, which will grow fields on their schedule,
 * and breaking every launch because the ERP added a key would be a bad trade.
 *
 * Plain `z.object()` (not `.passthrough()`) is the deliberate middle: unknown
 * keys are accepted and then STRIPPED, so `current_school` and `org_db` cost
 * nothing, and no attacker-influenced key survives into an object we build on.
 */
const erpSchoolSchema = z.object({
  id: z.string().min(1),
  db: z.string().min(1).nullish(),
  domain: z.string().nullish(),
  name: z.string().nullish(),
  db_server: z.string().nullish(),
});

export const erpLaunchClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  org_id: z.string().min(1),
  school_ids: z.array(erpSchoolSchema).min(1),
  default_school: erpSchoolSchema.nullish(),
  perms: z.array(z.string()),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  /** Observed empty (`""`) in the ERP's own sample, hence no `.min(1)`. */
  jti: z.string().nullish(),
});

export type ErpLaunchClaims = z.infer<typeof erpLaunchClaimsSchema>;

/**
 * ERP role → platform role.
 *
 * An unrecognised role is REFUSED, never defaulted. `role` drives PII masking
 * (docs/04 §3 rail 6) and is half of `permission_class` (ADR-028), so guessing
 * it wrong is a data-visibility bug that presents as a working session — the
 * success-shaped failure CODING_GUIDELINES §10 calls the worst class of bug
 * here. Refusing an unknown role costs a support ticket; defaulting one to
 * DIRECTOR could show a class teacher the whole trust.
 *
 * "Super Admin" maps to DIRECTOR because DIRECTOR is the widest READ scope in
 * the enum. It is deliberately not ADMIN: the RBAC matrix is an open decision
 * (AUDIT_REPORT A3, the note on `ROLES`), and no admin-gated behaviour may be
 * built against this enum until that lands.
 */
const ROLE_BY_ERP_ROLE: Readonly<Record<string, Role>> = Object.freeze({
  'super admin': 'DIRECTOR',
  director: 'DIRECTOR',
  principal: 'PRINCIPAL',
  teacher: 'TEACHER',
  accountant: 'ACCOUNTANT',
  admin: 'ADMIN',
});

/**
 * ERP module name → platform permission.
 *
 * Deliberately conservative: only modules whose mapping is unambiguous appear
 * here. The ERP sends ~75 module names per user, many of them adjacent to a
 * domain without implying read rights over it (Financial Accounting, Budget
 * Management and Employee Payroll all touch money or staff without being the
 * fee ledger or the staff register). An unmapped module grants nothing and is
 * reported in `unmappedModules` for review — under-granting shows up as a
 * missing dashboard, over-granting shows up as a data leak.
 */
const PERM_BY_ERP_MODULE: Readonly<Record<string, KnownPerm>> = Object.freeze({
  'fee management': 'fees.read',
  'fee invoice management': 'fees.read',
  'student attendance': 'attendance.read',
  'employee attendance': 'staff.read',
  'employee information': 'staff.read',
  'examination management': 'exams.read',
  'student information system': 'students.read',
});

/**
 * Strip the ERP's version suffixes and case.
 *
 * Their catalogue ships the same module twice under `(N)`/`(O)` (and once as
 * `(Prime)`), sometimes without the leading space — "Employee Recruitment(N)".
 * Which generation of a module a school runs says nothing about whether the
 * user may read its data, so the suffix is removed before lookup and the
 * duplicates collapse.
 */
function normaliseModule(raw: string): string {
  return raw
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export interface AdaptedLaunch {
  readonly claims: LaunchTokenClaims;
  /** Topology for the Tenant Registry — see `ErpSchool`. */
  readonly schools: readonly ErpSchool[];
  /** ERP modules with no platform permission, for diagnostics. */
  readonly unmappedModules: readonly string[];
}

export interface AdaptOptions {
  /**
   * Used when the ERP sends no `jti`, which its sample does. The caller
   * supplies it so this function stays pure and testable; the orchestrator
   * passes a random value, preserving the one-time-nonce behaviour of the
   * signed path even though the ERP is not providing one.
   */
  readonly fallbackJti: string;
  readonly now?: Date;
}

/**
 * Adapt an unverified ERP response into validated launch claims.
 *
 * Returns a discriminated result rather than throwing, matching
 * `parseLaunchTokenClaims`: a bad launch must fail loudly with the "reopen from
 * the ERP" page (docs/02 §6), not surface as a 500.
 */
export function adaptErpLaunchClaims(
  input: unknown,
  options: AdaptOptions,
): { ok: true; value: AdaptedLaunch } | { ok: false; issues: string[] } {
  const parsed = erpLaunchClaimsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }
  const erp = parsed.data;
  const issues: string[] = [];

  /**
   * Nothing else checks this.
   *
   * On the signed path jose rejects an expired token before the handler sees
   * it. Here there is no jose and no signature, so if this function does not
   * check `exp` then nothing does — and a day-old claims document would mint a
   * fresh 8-hour session. Note the ERP's sample spans 24 hours, not the 60
   * seconds ADR-003 specifies, so this is a live concern rather than a
   * theoretical one.
   */
  const now = options.now ?? new Date();
  if (erp.exp * 1000 <= now.getTime()) {
    issues.push('exp: these claims have expired');
  }

  const role = ROLE_BY_ERP_ROLE[erp.role.trim().toLowerCase()];
  if (role === undefined) {
    // The value is echoed because it comes from the ERP's own role table, not
    // from a user, and knowing which role went unmapped is the whole diagnostic.
    issues.push(`role: unmapped ERP role ${JSON.stringify(erp.role)}`);
  }

  const perms = new Set<KnownPerm>();
  const unmappedModules: string[] = [];
  for (const module of erp.perms) {
    const mapped = PERM_BY_ERP_MODULE[normaliseModule(module)];
    if (mapped === undefined) unmappedModules.push(module);
    else perms.add(mapped);
  }

  const schools: ErpSchool[] = erp.school_ids.map((s) => ({
    id: s.id,
    db: s.db ?? null,
    name: s.name ?? null,
    db_server: s.db_server ?? null,
    domain: s.domain ?? null,
  }));

  /**
   * The ERP may omit `default_school`; the contract may not. Falling back to
   * the first school is safe in a way that inventing an id would not be — it is
   * always a school the user already holds, so the fallback cannot widen scope.
   */
  const defaultSchool = erp.default_school?.id ?? schools[0]?.id;
  if (defaultSchool === undefined) issues.push('default_school: no school available');

  if (issues.length > 0) return { ok: false, issues };

  /**
   * Second validation, against the real contract. This is what enforces
   * identifier safety on `school_ids` (they reach a FROM clause — see
   * identifiers.ts), the `domain.action` perm shape, `default_school ∈
   * school_ids`, and duplicate ids. The mapping above is ours and could be
   * wrong; the contract is the thing that must hold regardless.
   */
  const claims = parseLaunchTokenClaims({
    sub: erp.sub,
    name: erp.name,
    role,
    org_id: erp.org_id,
    school_ids: schools.map((s) => s.id),
    default_school: defaultSchool,
    // Sorted so the same visibility always produces the same `permission_class`
    // digest (ADR-028) regardless of the order the ERP listed its modules in.
    perms: [...perms].sort(),
    iat: erp.iat,
    exp: erp.exp,
    jti: erp.jti !== undefined && erp.jti !== null && erp.jti !== '' ? erp.jti : options.fallbackJti,
  });

  if (!claims.ok) return { ok: false, issues: claims.issues };

  return { ok: true, value: { claims: claims.claims, schools, unmappedModules } };
}

/** Exported for tests and for the operator-facing mapping table in the docs. */
export const ERP_CLAIM_MAPPINGS = Object.freeze({
  roles: ROLE_BY_ERP_ROLE,
  perms: PERM_BY_ERP_MODULE,
  knownPerms: KNOWN_PERMS,
  platformRoles: ROLES,
});
