/**
 * Launch-token claim contract.
 *
 * Contract source: docs/02 §3 (token reference) · ADR-003 (token architecture).
 * This module owns the *shape* of the claims only. Signature verification,
 * `exp` checking and `jti` replay protection live in the orchestrator's launch
 * handler (docs/02 §2) — they are not contracts shared with other services.
 *
 * [MANDATORY] CODING_GUIDELINES §3: token claims arrive from outside the trust
 * boundary, so they are `unknown` until parsed by `parseLaunchTokenClaims`.
 * Never cast a decoded JWT payload into `LaunchTokenClaims`.
 */

import { z } from 'zod';

/**
 * Roles as enumerated in docs/02 §3.
 *
 * OPEN QUESTION (AUDIT_REPORT A3, TL question 15): `role` is a single scalar,
 * so a Principal who is also the org admin cannot hold both values, and no
 * `perms[]` value carries admin capability. Do not invent one here — the RBAC
 * matrix is an open decision. Admin-gated behaviour must not be built against
 * this enum until that decision lands.
 */
export const ROLES = ['DIRECTOR', 'PRINCIPAL', 'TEACHER', 'ACCOUNTANT', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Domain permissions observed in docs/02 §3. This list is *not* closed:
 * docs/02 §8 states new domains (e.g. `transport.read`) require "only new
 * claim values honored by the reporting layer". An unknown permission from a
 * newer ERP must therefore NOT fail token parsing — it is carried through and
 * simply grants nothing until the reporting layer honours it.
 *
 * Hence: validated as a `domain.action` shaped string, with the known set
 * exported separately for capability checks.
 */
export const KNOWN_PERMS = [
  'fees.read',
  'attendance.read',
  'exams.read',
  'staff.read',
  'students.read',
] as const;
export type KnownPerm = (typeof KNOWN_PERMS)[number];

/** A permission claim: `domain.action`, lowercase, dot-separated. */
export const permSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'perm must look like "domain.action"');

/** Identifiers are the ERP's own ids (docs/02 §3: "the same IDs the ERP uses"). */
const idSchema = z.string().min(1).max(128);

export const launchTokenClaimsSchema = z
  .object({
    sub: z.string().min(1),
    name: z.string().min(1),
    role: z.enum(ROLES),
    org_id: idSchema,
    /**
     * Exhaustive for the session (docs/02 §3): a Principal's token carries one
     * id, a Director's carries every school of the org. Never widened later —
     * scope is immutable within a session (docs/00 glossary).
     */
    school_ids: z.array(idSchema).min(1),
    default_school: idSchema,
    perms: z.array(permSchema),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    /** One-time nonce; the replay cache is the orchestrator's concern. */
    jti: z.string().min(1),
  })
  .strict()
  .refine((c) => c.school_ids.includes(c.default_school), {
    message: 'default_school must be one of school_ids',
    path: ['default_school'],
  })
  .refine((c) => new Set(c.school_ids).size === c.school_ids.length, {
    message: 'school_ids must not contain duplicates',
    path: ['school_ids'],
  });

export type LaunchTokenClaims = z.infer<typeof launchTokenClaimsSchema>;

/**
 * Parse untrusted claims. Returns a discriminated result rather than throwing,
 * so the caller decides the failure mode — a bad launch must fail loudly with
 * the "reopen from the ERP" page (docs/02 §6), not surface as a 500.
 */
export function parseLaunchTokenClaims(
  input: unknown,
): { ok: true; claims: LaunchTokenClaims } | { ok: false; issues: string[] } {
  const result = launchTokenClaimsSchema.safeParse(input);
  if (result.success) return { ok: true, claims: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
  };
}

/** Whether the session holds a given domain permission. */
export function hasPerm(claims: LaunchTokenClaims, perm: string): boolean {
  return claims.perms.includes(perm);
}
