/**
 * Invariant tests for the BYOK key vault.
 *
 * ADR-017 makes four promises about an org's API key: AES-256 at rest, a master
 * key held outside the database, never logged, and masked in the UI. Three of
 * those are properties of this module and are asserted here. The fourth — never
 * logged — is a property of every call site, and is covered by the settings
 * tests asserting the key never appears in a response body.
 *
 * The point of the tamper test in particular: under GCM a modified row fails to
 * decrypt instead of yielding plausible bytes. Without it, an edited ciphertext
 * would decrypt to *something* and that something would be sent to Anthropic as
 * a credential.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@sap/shared';
import './env-defaults.js';

const { encryptApiKey, decryptApiKey, keyHint, looksLikeAnthropicKey, secretEquals } =
  await import('../src/services/key-vault.js');

const KEY = 'sk-ant-api03-Zx9QvT2mKp7LrN4wBhs6YdEuJc1AoFgHiK3lMnPqRsTuVwXyZ1G4a';

describe('a stored key round-trips and nothing else does', () => {
  it('decrypts to exactly what was encrypted', () => {
    expect(decryptApiKey(encryptApiKey(KEY))).toBe(KEY);
  });

  it('never stores the key in a recoverable form', () => {
    const stored = encryptApiKey(KEY);
    // The obvious failure: someone "encrypts" by encoding. The plaintext must
    // not appear in the ciphertext under any common encoding.
    expect(stored.toString('utf8')).not.toContain(KEY);
    expect(stored.toString('base64')).not.toContain(Buffer.from(KEY).toString('base64'));
    expect(stored.toString('hex')).not.toContain(Buffer.from(KEY).toString('hex'));
  });

  it('produces a different ciphertext every time, from the same key', () => {
    // A fresh IV per encryption. Deterministic ciphertext would let anyone with
    // read access to the table tell that two orgs use the same key.
    expect(encryptApiKey(KEY).equals(encryptApiKey(KEY))).toBe(false);
  });

  it('refuses a tampered row rather than decrypting it to something', () => {
    const stored = encryptApiKey(KEY);
    // Flip one bit of ciphertext — the shape a bad restore or a manual UPDATE
    // would take.
    stored[stored.length - 1] = (stored.at(-1) ?? 0) ^ 0x01;
    expect(() => decryptApiKey(stored)).toThrow(PlatformError);
  });

  it('refuses a row encrypted under a different master key', async () => {
    const stored = encryptApiKey(KEY);
    vi.resetModules();
    process.env['AI_KEY_ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    const other = await import('../src/services/key-vault.js');
    /**
     * Matched on the message, not the class: `vi.resetModules()` re-imports
     * @sap/shared as well, so the freshly loaded module throws a PlatformError
     * from a different module instance and `instanceof` is false for reasons
     * that have nothing to do with the behaviour under test.
     */
    expect(() => other.decryptApiKey(stored)).toThrowError(/could not be read/);
  });

  it('refuses a truncated row', () => {
    expect(() => decryptApiKey(Buffer.alloc(8))).toThrow(PlatformError);
  });
});

describe('the hint is a recognition aid, not a key', () => {
  it('shows only the last four characters', () => {
    const hint = keyHint(KEY);
    expect(hint).toBe('sk-ant-…1G4a');
    // Everything between the prefix and the tail must be gone: a "masked" value
    // that still carries most of the secret is not masked.
    expect(hint.length).toBeLessThan(20);
    expect(KEY).toContain(hint.slice(-4));
    expect(hint).not.toContain(KEY.slice(8, 20));
  });
});

describe('an obvious paste error is caught before the network call', () => {
  it.each([
    ['a real-looking key', KEY, true],
    ['whitespace around it', `  ${KEY}\n`, true],
    ['the wrong separator', KEY.replace('sk-ant-', 'sk_ant_'), false],
    ['a whole curl command', `curl -H "x-api-key: ${KEY}"`, false],
    ['empty', '', false],
    ['just the prefix', 'sk-ant-', false],
  ])('%s → %s', (_label, value, expected) => {
    expect(looksLikeAnthropicKey(value)).toBe(expected);
  });
});

describe('secret comparison', () => {
  it('is true only for identical values', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abd')).toBe(false);
    expect(secretEquals('abc', 'abcd')).toBe(false);
  });
});

beforeAll(() => {
  // A sanity check on the fixture itself: if this ever stops looking like a key,
  // every assertion above is testing the wrong thing.
  expect(KEY.startsWith('sk-ant-')).toBe(true);
});
