/**
 * The BYOK key vault — encryption of the org's own Anthropic API key.
 *
 * Contract source: ADR-017 ("AES-256 at rest, KMS master key, decrypted in
 * memory at call time, never logged, masked in UI") · docs/05 §4.1 · docs/08 §6
 * ("Platform operators cannot read tenant keys in plaintext").
 *
 * -- Why GCM and not CBC -------------------------------------------------------
 * Authenticated encryption. Without the tag, a row edited in the database — by
 * an operator, a restore from a tampered backup, a bug — decrypts to *something*
 * and that something gets sent to Anthropic as a key. With GCM the decrypt fails
 * loudly instead, which is the behaviour we want at every layer of this system:
 * refuse rather than proceed on data you cannot account for.
 *
 * -- What is stored ------------------------------------------------------------
 *   iv (12 bytes) || auth tag (16 bytes) || ciphertext
 * A fresh random IV per encryption, prefixed rather than stored in its own
 * column, so a row can never be half-updated into an undecryptable state.
 *
 * -- The master key ------------------------------------------------------------
 * ADR-017 says KMS. This module takes 32 bytes from configuration, which is what
 * KMS/Secrets Manager delivers in production and what the environment delivers
 * locally. The important property is not where it comes from but that it is NOT
 * in the database holding the ciphertext: a dump of `tenant_ai_config` is then
 * not a disclosure.
 *
 * -- What must never happen here ----------------------------------------------
 * [MANDATORY] CODING_GUIDELINES §13: keys are log-forbidden. Nothing in this
 * module logs, and the errors it throws carry no key material — not the
 * plaintext, not the ciphertext, not a length. A stack trace from here is safe
 * to paste into a ticket.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM's standard nonce length
const TAG_BYTES = 16;

/**
 * Anthropic keys are `sk-ant-…`. Checked before the network call so an obvious
 * paste error ("sk_ant", a whole curl command, a Slack quote) is a form error in
 * milliseconds rather than a 401 the user has to interpret as their own fault.
 *
 * Deliberately loose about the tail: the platform does not get to decide what a
 * valid provider key looks like beyond its documented prefix, and a stricter
 * pattern would reject a legitimate key the day Anthropic changes its format.
 */
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{16,200}$/;

export function looksLikeAnthropicKey(value: string): boolean {
  return KEY_SHAPE.test(value.trim());
}

/**
 * The only key-derived value that ever crosses the API boundary.
 *
 * docs/05 §4.1 shows `sk-ant-…****1G4a`: enough for an admin to tell which of
 * their keys is installed, not enough to be one. The last four characters are a
 * recognition aid, not a secret — the Anthropic Console shows the same tail.
 */
export function keyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  return `sk-ant-…${trimmed.slice(-4)}`;
}

function masterKey(): Buffer {
  const key = Buffer.from(config.AI_KEY_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    /**
     * A boot-time misconfiguration, surfaced at first use rather than guessed
     * around. Deriving a 32-byte key from whatever was supplied (hashing it,
     * padding it) would make a weak configuration silently work, and the
     * operator would never learn that their "encryption key" is four characters.
     */
    throw new PlatformError({
      code: ERROR_CODES.INTERNAL,
      message: 'AI key storage is not configured on this server.',
      diagnostics: { reason: 'AI_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes' },
    });
  }
  return key;
}

export function encryptApiKey(apiKey: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey.trim(), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * In-memory only, at call time. Callers must not persist, log or return the
 * result — the whole point of the vault is that the plaintext exists for the
 * duration of one provider request.
 */
export function decryptApiKey(stored: Buffer): string {
  if (stored.length <= IV_BYTES + TAG_BYTES) {
    throw new PlatformError({
      code: ERROR_CODES.INTERNAL,
      message: 'The stored AI key could not be read.',
      diagnostics: { reason: 'ciphertext is too short to contain an IV and a tag' },
    });
  }
  const iv = stored.subarray(0, IV_BYTES);
  const tag = stored.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = stored.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, masterKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
  } catch {
    /**
     * The tag did not verify: the row was altered, or it was encrypted under a
     * different master key. Both are configuration incidents and neither is
     * something to recover from by guessing — the org is asked to re-enter its
     * key, which is the only way back to a state the platform can vouch for.
     */
    throw new PlatformError({
      code: ERROR_CODES.INTERNAL,
      message: 'The stored AI key could not be read. Please save the key again.',
      diagnostics: { reason: 'authentication tag mismatch' },
    });
  }
}

/**
 * Constant-time comparison, exported for tests and for any future equality
 * check on secret material. Length is not secret; content is.
 */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
