/**
 * Password authentication for the stub ERP -- STAGING ONLY.
 *
 * WHY THIS IS HERE AND NOT IN THE PRODUCT
 *
 * CODING_GUIDELINES §11 is [MANDATORY] and absolute: "Never add platform-local
 * login, password storage, or user tables mirroring the ERP." docs/10 §2 says
 * the same from the UX side -- there is no login screen in this product, and
 * App.tsx refuses to grow one on purpose.
 *
 * Staging still needs a front door, because there is no ERP to launch from. So
 * the front door goes where the ERP's front door goes: HERE, in the component
 * that stands in for the ERP. This file authenticates a user and then performs
 * the ordinary, unmodified launch handshake of docs/02 §2 -- RS256 token, 60s
 * expiry, one-time jti, POST handoff. Everything downstream of the handoff is
 * production code that cannot tell staging from the real ERP, which is the
 * whole reason the stub was described as "the staging harness" in docs/11 §2.
 *
 * When the real ERP ships, this directory is deleted and ERP_JWKS_URL changes.
 * Nothing in apps/ has to be unwound, because nothing in apps/ knows about it.
 *
 * WHERE THE PASSWORDS COME FROM
 *
 * The environment, one variable per identity, and nowhere else --
 * CODING_GUIDELINES §12 forbids credentials in the repository including in
 * scripts and test fixtures. An identity with no password configured cannot be
 * signed in as and is not offered on the form: absent configuration fails
 * closed rather than opening an account with a default password, which is the
 * failure mode that makes staging boxes interesting to strangers.
 */

import { timingSafeEqual } from 'node:crypto';
import { IDENTITIES, type Identity } from './identities.js';

/**
 * The environment variable holding one identity's password.
 *
 * `principal-mb` -> `ERP_STUB_PASSWORD_PRINCIPAL_MB`.
 */
export function passwordVar(key: string): string {
  return 'ERP_STUB_PASSWORD_' + key.toUpperCase().replace(/-/g, '_');
}

/** Identities with a password configured. The others do not exist as accounts. */
export function enabledLogins(): Identity[] {
  return IDENTITIES.filter((i) => {
    const secret = process.env[passwordVar(i.key)];
    return typeof secret === 'string' && secret.length > 0;
  });
}

/**
 * Compare without leaking length or prefix through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would reintroduce the
 * very side channel it exists to remove, so both sides are hashed to a fixed
 * width first. This is a staging harness and the threat is modest, but a
 * password comparison written the careless way is the kind of thing that gets
 * copied into somewhere it matters.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  if (left.length !== right.length) {
    // Still do the work, so a wrong length is not measurably faster.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Resolve a username + password to an identity, or undefined.
 *
 * The username IS the identity key (`director`, `accountant-mb`). One name for
 * one thing: a separate username field would be a second identifier to keep in
 * step with the first, and the only value it could add -- looking like a real
 * ERP login -- is not worth a mapping that can drift.
 */
export function authenticate(username: string, password: string): Identity | undefined {
  const identity = enabledLogins().find((i) => i.key === username.trim().toLowerCase());
  if (identity === undefined) {
    // Spend the same work on an unknown user as on a known one, so the form
    // cannot be used to enumerate which accounts are configured.
    constantTimeEquals(password, 'no-such-account');
    return undefined;
  }
  const expected = process.env[passwordVar(identity.key)] ?? '';
  return constantTimeEquals(password, expected) ? identity : undefined;
}

/**
 * Per-address attempt throttle.
 *
 * A staging box with a login form on the public internet gets credential
 * stuffing within days of DNS propagating -- not because anyone wants this
 * data, but because everything with a password field does. A fixed window is
 * crude and entirely sufficient: it turns an unlimited online guessing budget
 * into a few attempts a minute, which is the difference that matters.
 *
 * In memory, so a restart clears it. Acceptable: the process restarting is not
 * something an attacker can cause from the login form.
 */
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;

interface Window {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, Window>();

export function throttleCheck(address: string, now: number): { allowed: boolean; retryInSeconds: number } {
  const existing = attempts.get(address);
  if (existing === undefined || now >= existing.resetAt) {
    attempts.set(address, { count: 0, resetAt: now + WINDOW_MS });
    return { allowed: true, retryInSeconds: 0 };
  }
  if (existing.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryInSeconds: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { allowed: true, retryInSeconds: 0 };
}

/** Count a failure. Successes deliberately do not count against the window. */
export function throttleRecordFailure(address: string, now: number): void {
  const existing = attempts.get(address);
  if (existing === undefined || now >= existing.resetAt) {
    attempts.set(address, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  existing.count += 1;
}

export function throttleClear(address: string): void {
  attempts.delete(address);
}
