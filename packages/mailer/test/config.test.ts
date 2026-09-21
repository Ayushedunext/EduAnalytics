/**
 * The transport's configuration contract (ADR-035).
 *
 * [MANDATORY] CODING_GUIDELINES §14 tests what must not silently break, and
 * both rules here fail silently by nature:
 *
 *  - a half-configured credential pair (`SMTP_USER` with no `SMTP_PASSWORD`)
 *    parses fine and then fails on the first scheduled delivery at 07:30, where
 *    nobody is watching. The boot-time check is the whole defence;
 *  - `SMTP_SECURE` arrives from the environment as the STRING "false", which is
 *    truthy. A coercion bug here means implicit TLS against a plain-SMTP port
 *    and every send failing with a handshake error nobody would connect to a
 *    boolean.
 *
 * Pure: no network, no server, no environment.
 */

import { describe, expect, it } from 'vitest';
import { smtpConfigSchema, smtpCredentialIssue } from '../src/config.js';

function parse(env: Record<string, string>) {
  const result = smtpConfigSchema.safeParse(env);
  if (!result.success) throw new Error(result.error.issues.map((i) => i.message).join('; '));
  return result.data;
}

describe('smtpConfigSchema', () => {
  it('defaults to the local Mailpit transport, unauthenticated', () => {
    const config = parse({});
    expect(config.SMTP_HOST).toBe('127.0.0.1');
    expect(config.SMTP_PORT).toBe(1026);
    expect(config.SMTP_SECURE).toBe(false);
    expect(config.SMTP_USER).toBeUndefined();
    expect(config.SMTP_PASSWORD).toBeUndefined();
  });

  it('coerces the port from its string form', () => {
    expect(parse({ SMTP_PORT: '587' }).SMTP_PORT).toBe(587);
  });

  it('reads SMTP_SECURE as a boolean, not as a truthy string', () => {
    expect(parse({ SMTP_SECURE: 'false' }).SMTP_SECURE).toBe(false);
    expect(parse({ SMTP_SECURE: 'true' }).SMTP_SECURE).toBe(true);
  });

  it('refuses a from-address that is not one', () => {
    expect(() => parse({ SMTP_FROM: 'not-an-address' })).toThrow(/SMTP_FROM/);
  });
});

describe('smtpCredentialIssue', () => {
  it('accepts an unauthenticated relay', () => {
    expect(smtpCredentialIssue(parse({}))).toBeNull();
  });

  it('accepts a fully configured pair', () => {
    expect(smtpCredentialIssue(parse({ SMTP_USER: 'u', SMTP_PASSWORD: 'p' }))).toBeNull();
  });

  it('refuses a user with no password', () => {
    expect(smtpCredentialIssue(parse({ SMTP_USER: 'u' }))).toContain('SMTP_PASSWORD');
  });

  it('refuses a password with no user', () => {
    expect(smtpCredentialIssue(parse({ SMTP_PASSWORD: 'p' }))).toContain('SMTP_USER');
  });

  it('treats an empty string as unset, because an env file writes it that way', () => {
    expect(smtpCredentialIssue(parse({ SMTP_USER: '', SMTP_PASSWORD: '' }))).toBeNull();
  });

  it('never repeats the password back in the message it produces', () => {
    /**
     * [MANDATORY] §12/§13: `SMTP_PASSWORD` is a log-forbidden value, and this
     * string is printed to stdout at boot. The rule is easy to break by making
     * the message more "helpful".
     */
    const issue = smtpCredentialIssue(parse({ SMTP_PASSWORD: 'hunter2' }));
    expect(issue).not.toBeNull();
    expect(issue).not.toContain('hunter2');
  });
});
