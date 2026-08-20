/**
 * The identities the stub ERP can sign a token for.
 *
 * These stand in for real ERP users. The claims are built against
 * LaunchTokenClaims from @sap/shared -- the SAME type the orchestrator
 * validates on the other side. That is the whole reason the contract lives in a
 * shared package: if this file and the orchestrator each defined their own idea
 * of a token, they would drift and the drift would be an auth bug
 * (CODING_GUIDELINES §1).
 *
 * School ids and names come from ai_analysis.schools_data_set -- the ERP's own
 * org/school mapping. "Society" is the ERP's term for what docs/00 calls an org.
 */

import type { LaunchTokenClaims } from '@sap/shared';

/** Claims minus the timing fields, which are stamped at signing time. */
export type IdentityClaims = Omit<LaunchTokenClaims, 'iat' | 'exp' | 'jti'>;

export interface Identity {
  key: string;
  label: string;
  /** Shown on the picker so it is obvious what each session should be able to do. */
  note: string;
  claims: IdentityClaims;
}

export const IDENTITIES: Identity[] = [
  {
    key: 'director',
    label: 'R. Mehta — Director, St Marks Society',
    note: 'All 3 schools. Can combine them and compare.',
    claims: {
      sub: 'erp-user-1001',
      name: 'R. Mehta',
      role: 'DIRECTOR',
      org_id: 'stmarks',
      school_ids: ['stmarksg', 'stmarksj', 'stmarksmb'],
      default_school: 'stmarksmb',
      perms: ['fees.read', 'students.read', 'staff.read'],
    },
  },
  {
    key: 'principal-mb',
    label: 'S. Kapoor — Principal, Meera Bagh',
    note: 'One school only. Requesting Janakpuri must be rejected.',
    claims: {
      sub: 'erp-user-2001',
      name: 'S. Kapoor',
      role: 'PRINCIPAL',
      org_id: 'stmarks',
      school_ids: ['stmarksmb'],
      default_school: 'stmarksmb',
      perms: ['fees.read', 'students.read', 'staff.read'],
    },
  },
  {
    key: 'principal-j',
    label: 'A. Verma — Principal, Janakpuri',
    note: 'A different single school. Use with the one above to show isolation.',
    claims: {
      sub: 'erp-user-2002',
      name: 'A. Verma',
      role: 'PRINCIPAL',
      org_id: 'stmarks',
      school_ids: ['stmarksj'],
      default_school: 'stmarksj',
      perms: ['fees.read', 'students.read', 'staff.read'],
    },
  },
  {
    /**
     * The interesting one. No `students.read`, so this session must not reach
     * student-level data (docs/02 §3: "an accountant-only token lacks
     * exams.read"; docs/08 §4.5 role policies). It also produces a different
     * permission_class, so it can never be served the Principal's cached rows
     * (ADR-028).
     */
    key: 'accountant-mb',
    label: 'P. Nair — Accountant, Meera Bagh',
    note: 'Fees domain only — no students.read. Different cache class.',
    claims: {
      sub: 'erp-user-3001',
      name: 'P. Nair',
      role: 'ACCOUNTANT',
      org_id: 'stmarks',
      school_ids: ['stmarksmb'],
      default_school: 'stmarksmb',
      perms: ['fees.read'],
    },
  },
  {
    /**
     * The only identity that may configure the org's Anthropic key.
     *
     * docs/05 §5 makes BYOK setup admin-only and ADR-017 puts the key at ORG
     * level, so this is the one role that can spend the trust's money with a
     * provider. Every other identity above sees "contact your admin" on that
     * panel — which is worth being able to demonstrate, hence a real identity
     * rather than a flag on the Director.
     */
    key: 'admin',
    label: 'N. Iyer — IT Admin, St Marks Society',
    note: 'Org admin. The only role that can configure the AI key.',
    claims: {
      sub: 'erp-user-4001',
      name: 'N. Iyer',
      role: 'ADMIN',
      org_id: 'stmarks',
      school_ids: ['stmarksg', 'stmarksj', 'stmarksmb'],
      default_school: 'stmarksmb',
      perms: ['fees.read', 'students.read', 'staff.read'],
    },
  },
];

export function findIdentity(key: string): Identity | undefined {
  return IDENTITIES.find((i) => i.key === key);
}

/**
 * Failure modes the stub can produce on demand.
 *
 * docs/02 §6 enumerates the launch failures the platform must handle loudly
 * (expired, bad signature, replayed jti). Being able to trigger them from the
 * picker turns that table into something testable and demonstrable, rather than
 * a paragraph nobody exercises until it happens in production.
 */
export const FAULTS = {
  none: 'Sign normally',
  expired: 'Sign an already-expired token (exp in the past)',
  replay: 'Re-send the previous token (same jti)',
  badSignature: 'Corrupt the signature after signing',
} as const;

export type Fault = keyof typeof FAULTS;
