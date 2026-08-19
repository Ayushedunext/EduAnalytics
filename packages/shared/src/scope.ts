/**
 * Scope: the set of school_ids a session may query.
 *
 * Contract source: docs/00 glossary ("Scope") · docs/08 §3 · ADR-007.
 *
 * [MANDATORY] Invariant 2 — "Scope is law". Scope comes only from the verified
 * launch token and is immutable within a session. It is enforced TWICE:
 *   ① orchestrator: requested ⊆ token.school_ids, else 403
 *   ② MCP layer:    the allowed set travels OUT-OF-BAND with every tool call
 *
 * Both layers call `isWithinScope` from this module. That is the point of
 * putting it here: two *independent* checks of the same rule (ADR-007) only
 * work if it is literally the same rule. Two hand-rolled copies would be two
 * different checks, which is worse than one — you would trust it more than it
 * deserves.
 *
 * The AI model never supplies tenant identifiers; nothing in this module is
 * ever populated from model output.
 */

import { createHash } from 'node:crypto';
import type { LaunchTokenClaims, Role } from './launch-token.js';

/** An immutable set of school ids. Order is never significant. */
export type Scope = readonly string[];

/** Scope as carried by the token — the only legitimate origin. */
export function scopeFromToken(claims: LaunchTokenClaims): Scope {
  return Object.freeze([...claims.school_ids]);
}

/**
 * The ⊆ check. `requested` must be non-empty and every id must be in scope.
 *
 * An empty request is rejected rather than treated as "all of scope": callers
 * must be explicit about which schools they are asking for, so that a bug
 * producing an empty selection cannot silently widen to the whole trust.
 */
export function isWithinScope(requested: readonly string[], scope: Scope): boolean {
  if (requested.length === 0) return false;
  const allowed = new Set(scope);
  return requested.every((id) => allowed.has(id));
}

/** The ids in `requested` that fall outside scope — for the audit record. */
export function outOfScope(requested: readonly string[], scope: Scope): string[] {
  const allowed = new Set(scope);
  return requested.filter((id) => !allowed.has(id));
}

/**
 * Effective scope = token scope ∩ schools the registry can currently serve.
 *
 * docs/02 §6: a school whose registry row is missing, or whose status is
 * suspended/migrating, is dropped from scope *with a visible notice* — the
 * session proceeds for the remainder. Returning the dropped ids (rather than
 * silently filtering) is what lets the caller render that notice; silent
 * filtering would be exactly the "success-shaped failure" CODING_GUIDELINES
 * §10 calls the worst bug class in this system.
 */
export function effectiveScope(
  scope: Scope,
  servableSchoolIds: readonly string[],
): { effective: Scope; dropped: string[] } {
  const servable = new Set(servableSchoolIds);
  const effective: string[] = [];
  const dropped: string[] = [];
  for (const id of scope) (servable.has(id) ? effective : dropped).push(id);
  return { effective: Object.freeze(effective), dropped };
}

/**
 * `permission_class` — a deterministic digest of the caller's effective data
 * visibility, required in every result-cache key.
 *
 * Contract source: ADR-028 · docs/03 §4 · docs/08 §5.1 · CODING_GUIDELINES §8.
 *
 * Why this exists: PII masking is applied per session role (docs/04 §3 rail 6)
 * and drill leaves are gated on student-data rights (docs/08 §4.5). A cache key
 * without a permission component lets two users of the same school with
 * different `perms[]` collide — a Principal warming the cache would serve
 * unmasked rows to a class teacher on an identical key. A masking rule enforced
 * at query time and discarded at cache time is not enforced.
 *
 * [MANDATORY] Determinism: perms are sorted and the input is canonicalised, so
 * the same visibility always yields the same digest. A non-deterministic digest
 * fragments the cache silently — the failure mode is a quiet loss of hit rate,
 * not an error, which is why this lives in one tested function rather than at
 * each call site.
 */
export function permissionClass(claims: Pick<LaunchTokenClaims, 'role' | 'perms'>): string {
  const canonical = JSON.stringify({
    role: claims.role satisfies Role,
    perms: [...claims.perms].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
