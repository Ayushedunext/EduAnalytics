/**
 * Who may configure the org's Anthropic key — asserted, not assumed.
 *
 * docs/05 §5 makes BYOK setup admin-only and ADR-017 puts the key at ORG level:
 * one credential, billed to the trust, unlocking AI for every school and user.
 * The UI shows non-admins "contact your admin", but a UI message is a courtesy;
 * the rule is that the SERVICE refuses, so a hand-written request from a
 * Director's session gets the same answer as the screen gives them.
 *
 * This is the same relationship Invariant 5 describes for the AI lock itself:
 * the padlock is cosmetic on top of a real refusal. A test that only checked the
 * screen would be testing the cosmetic half.
 *
 * The provider call and the database are mocked because neither is the subject:
 * the question is whether a non-admin ever REACHES them. That a refused caller
 * never touches the vault is asserted directly below.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import './env-defaults.js';
import type { Role } from '@sap/shared';

/** Every query the service would run, so "did it touch the vault?" is answerable. */
const queries: string[] = [];

vi.mock('../src/db/platform-db.js', () => ({
  platformDb: {
    query: (sql: string) => {
      queries.push(sql);
      return Promise.resolve([[], []]);
    },
  },
}));

const audits: { subject: string; action: string; summary: string }[] = [];
vi.mock('../src/db/audit.js', () => ({
  auditSink: {
    write: (event: { subject: string; action: string; summary: string }) => {
      audits.push(event);
      return Promise.resolve();
    },
  },
}));

/** Counts calls so a refusal that still hit Anthropic would fail the test. */
let validateCalls = 0;
vi.mock('../src/services/anthropic.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/anthropic.js')>(
    '../src/services/anthropic.js',
  );
  return {
    ...actual,
    validateApiKey: () => {
      validateCalls += 1;
      return Promise.resolve({ ok: true, message: '', transient: false });
    },
  };
});

const { saveApiKey, disableAi, canConfigureAi, CONTACT_ADMIN } = await import(
  '../src/services/ai-config.js'
);

const KEY = 'sk-ant-api03-Zx9QvT2mKp7LrN4wBhs6YdEuJc1AoFgHiK3lMnPqRsTuVwXyZ1G4a';

function save(role: Role) {
  return saveApiKey({
    orgId: 'stmarks',
    actorSub: 'erp-user-1',
    role,
    apiKey: KEY,
    model: 'claude-haiku-4-5',
    monthlyQueryCap: 1500,
    correlationId: 'corr-1',
  });
}

beforeEach(() => {
  queries.length = 0;
  audits.length = 0;
  validateCalls = 0;
});

describe('only an ADMIN may configure the key', () => {
  it.each<Role>(['DIRECTOR', 'PRINCIPAL', 'TEACHER', 'ACCOUNTANT'])(
    'refuses a %s with the message the screen shows',
    async (role) => {
      await expect(save(role)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
        message: CONTACT_ADMIN,
      });
    },
  );

  it('refuses before touching the vault or the provider', async () => {
    await expect(save('DIRECTOR')).rejects.toThrow();
    // A refusal that still called Anthropic would bill the org for a request it
    // was not allowed to make; one that still wrote would be worse.
    expect(validateCalls).toBe(0);
    expect(queries).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('refuses a non-admin trying to DISABLE ai, not only to set it', async () => {
    // Disabling is the destructive half: one call relocks AI for every school in
    // the trust, so it needs the same gate as saving rather than a weaker one.
    await expect(
      disableAi({ orgId: 'stmarks', actorSub: 'erp-user-1', role: 'PRINCIPAL', correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(queries).toEqual([]);
  });

  it('lets an ADMIN through', async () => {
    await save('ADMIN');
    expect(validateCalls).toBe(1);
    expect(queries.some((q) => q.includes('tenant_ai_config'))).toBe(true);
  });

  it('agrees with the answer the API reports to the SPA', () => {
    // `can_configure` on GET /api/settings and the refusal in saveApiKey must
    // come from the same rule, or the screen offers a form the server rejects.
    expect(canConfigureAi('ADMIN')).toBe(true);
    for (const role of ['DIRECTOR', 'PRINCIPAL', 'TEACHER', 'ACCOUNTANT'] as Role[]) {
      expect(canConfigureAi(role)).toBe(false);
    }
  });
});

describe('what reaches the audit trail', () => {
  it('records the change without recording the key', async () => {
    await save('ADMIN');
    expect(audits).toHaveLength(1);
    const event = audits[0];
    expect(event?.subject).toBe('ai_key');
    // [MANDATORY] §13: keys are log-forbidden. The summary says what happened.
    expect(JSON.stringify(event)).not.toContain(KEY);
    expect(JSON.stringify(event)).not.toContain(KEY.slice(-8));
  });
});

describe('a malformed key never reaches the provider', () => {
  it('is refused on shape, by an admin too', async () => {
    await expect(
      saveApiKey({
        orgId: 'stmarks',
        actorSub: 'erp-user-1',
        role: 'ADMIN',
        apiKey: 'not-a-key',
        model: 'claude-haiku-4-5',
        monthlyQueryCap: 1500,
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(validateCalls).toBe(0);
  });
});
