/**
 * The staging sign-in gate.
 *
 * This is `tools/`, not product code, and most of what lives here does not earn
 * a test. This does: in the staging environment it is the only thing between the
 * open internet and a database holding real student and guardian records, and
 * its two most important behaviours are both ones that fail SILENTLY when wrong.
 *
 *   * An account with no password configured must not exist. If that ever
 *     degrades into "no password means any password", or into an account with a
 *     built-in default, nothing looks broken -- sign-in works, which is exactly
 *     the symptom of it working for everybody.
 *   * The attempt throttle must actually count. A throttle that never trips
 *     looks identical to one that does until somebody is enumerating passwords
 *     against it.
 *
 * Neither is visible from the outside, so they are asserted here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticate,
  enabledLogins,
  passwordVar,
  throttleCheck,
  throttleClear,
  throttleRecordFailure,
} from '../src/logins.js';

/**
 * The module reads process.env on every call rather than caching at import, so
 * each test can define its own account set. Anything set here is removed again
 * afterwards; a leaked ERP_STUB_PASSWORD_* would silently change what a later
 * test believes is configured.
 */
const touched: string[] = [];

function setPassword(identity: string, password: string): void {
  const key = passwordVar(identity);
  touched.push(key);
  process.env[key] = password;
}

beforeEach(() => {
  // Start from a known-empty account set, whatever the ambient environment has.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ERP_STUB_PASSWORD_')) {
      touched.push(key);
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const key of touched) delete process.env[key];
  touched.length = 0;
});

describe('passwordVar', () => {
  it('maps an identity key to its environment variable', () => {
    expect(passwordVar('director')).toBe('ERP_STUB_PASSWORD_DIRECTOR');
  });

  it('turns hyphens into underscores, because a hyphen is not legal in a shell name', () => {
    expect(passwordVar('principal-mb')).toBe('ERP_STUB_PASSWORD_PRINCIPAL_MB');
    expect(passwordVar('principal-training')).toBe('ERP_STUB_PASSWORD_PRINCIPAL_TRAINING');
  });
});

describe('enabledLogins', () => {
  it('is empty when nothing is configured', () => {
    expect(enabledLogins()).toEqual([]);
  });

  it('offers only the identities that have a password', () => {
    setPassword('director', 'a-password');
    expect(enabledLogins().map((i) => i.key)).toEqual(['director']);
  });

  it('treats an EMPTY password as no password, not as an empty one', () => {
    // The difference matters: `ERP_STUB_PASSWORD_ADMIN=` in a .env file is what
    // a half-finished configuration looks like, and it must disable the account
    // rather than create one that opens to an empty string.
    setPassword('admin', '');
    expect(enabledLogins()).toEqual([]);
  });
});

describe('authenticate', () => {
  beforeEach(() => {
    setPassword('director', 'correct-horse-battery');
  });

  it('accepts the configured password and returns that identity', () => {
    const identity = authenticate('director', 'correct-horse-battery');
    expect(identity?.key).toBe('director');
    expect(identity?.claims.role).toBe('DIRECTOR');
  });

  it('rejects a wrong password', () => {
    expect(authenticate('director', 'nearly-right')).toBeUndefined();
  });

  it('rejects a password that is a prefix of the correct one', () => {
    expect(authenticate('director', 'correct-horse')).toBeUndefined();
  });

  it('rejects an unknown username', () => {
    expect(authenticate('nobody', 'correct-horse-battery')).toBeUndefined();
  });

  it('rejects a real identity that has no password configured', () => {
    // `admin` exists in identities.ts but is not configured in this test. It
    // must be unreachable rather than reachable with an empty password -- this
    // is the fail-closed behaviour the whole gate rests on.
    expect(authenticate('admin', '')).toBeUndefined();
    expect(authenticate('admin', 'anything')).toBeUndefined();
  });

  it('does not accept an empty password against a configured account', () => {
    expect(authenticate('director', '')).toBeUndefined();
  });

  it('tolerates the whitespace and capitals a browser autofill introduces', () => {
    expect(authenticate('  Director  ', 'correct-horse-battery')?.key).toBe('director');
  });

  it('does not extend that tolerance to the password', () => {
    // Usernames are identifiers and normalising them is a kindness. Passwords
    // are secrets: trimming one would silently shrink the space of passwords
    // that can be set.
    expect(authenticate('director', ' correct-horse-battery ')).toBeUndefined();
  });
});

describe('throttle', () => {
  const now = 1_000_000;

  it('allows attempts up to the limit, then blocks', () => {
    const address = '198.51.100.1';
    for (let i = 0; i < 10; i += 1) {
      expect(throttleCheck(address, now).allowed).toBe(true);
      throttleRecordFailure(address, now);
    }
    const blocked = throttleCheck(address, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryInSeconds).toBeGreaterThan(0);
  });

  it('throttles each address separately', () => {
    const noisy = '198.51.100.2';
    for (let i = 0; i < 12; i += 1) throttleRecordFailure(noisy, now);
    expect(throttleCheck(noisy, now).allowed).toBe(false);

    // Behind the staging proxy every request shares a socket address, so if
    // this ever collapsed to one global counter the first person to fumble a
    // password would lock out everyone else.
    expect(throttleCheck('198.51.100.3', now).allowed).toBe(true);
  });

  it('lets the window expire', () => {
    const address = '198.51.100.4';
    for (let i = 0; i < 12; i += 1) throttleRecordFailure(address, now);
    expect(throttleCheck(address, now).allowed).toBe(false);

    const afterWindow = now + 5 * 60 * 1000 + 1;
    expect(throttleCheck(address, afterWindow).allowed).toBe(true);
  });

  it('forgives a successful sign-in', () => {
    const address = '198.51.100.5';
    for (let i = 0; i < 9; i += 1) throttleRecordFailure(address, now);
    throttleClear(address);
    for (let i = 0; i < 9; i += 1) {
      expect(throttleCheck(address, now).allowed).toBe(true);
      throttleRecordFailure(address, now);
    }
  });
});
