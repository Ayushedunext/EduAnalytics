/**
 * Key-shape/hint/model-id checks — ADR-031 moved these onto each provider's
 * own `ProviderMeta` (out of key-vault.ts, which is pure crypto again). What
 * used to be key-vault.test.ts's "the hint is a recognition aid" and "an
 * obvious paste error is caught before the network call" describe blocks now
 * live here, once per provider, plus the new Gemini-specific case.
 */

import { describe, expect, it } from 'vitest';
import './env-defaults.js';

const { PROVIDERS } = await import('../src/services/ai-providers/index.js');

const ANTHROPIC_KEY = 'sk-ant-api03-Zx9QvT2mKp7LrN4wBhs6YdEuJc1AoFgHiK3lMnPqRsTuVwXyZ1G4a';
// A real key observed firsthand this session — deliberately NOT the commonly
// assumed `AIza...` shape, which is exactly why Gemini's check stays loose.
const GEMINI_KEY = 'AQ.Ab8RN6IESTQ5ZYllRqkx4eJsSu3xpkBcHLDAnrLH9vO9TJfqzQ';

describe('anthropic provider — key shape and hint', () => {
  it('shows only the last four characters, prefixed', () => {
    const hint = PROVIDERS.anthropic.keyHint(ANTHROPIC_KEY);
    expect(hint).toBe('sk-ant-…1G4a');
    expect(hint.length).toBeLessThan(20);
    expect(hint).not.toContain(ANTHROPIC_KEY.slice(8, 20));
  });

  it.each([
    ['a real-looking key', ANTHROPIC_KEY, true],
    ['whitespace around it', `  ${ANTHROPIC_KEY}\n`, true],
    ['the wrong separator', ANTHROPIC_KEY.replace('sk-ant-', 'sk_ant_'), false],
    ['a whole curl command', `curl -H "x-api-key: ${ANTHROPIC_KEY}"`, false],
    ['empty', '', false],
    ['just the prefix', 'sk-ant-', false],
    ['a real Gemini key', GEMINI_KEY, false],
  ])('%s → %s', (_label, value, expected) => {
    expect(PROVIDERS.anthropic.looksLikeValidKey(value)).toBe(expected);
  });

  it('only accepts its own catalog of model ids', () => {
    expect(PROVIDERS.anthropic.isValidModelId('claude-haiku-4-5')).toBe(true);
    expect(PROVIDERS.anthropic.isValidModelId('gemini-flash-lite-latest')).toBe(false);
    expect(PROVIDERS.anthropic.isValidModelId('not-a-model')).toBe(false);
  });
});

describe('gemini provider — key shape and hint', () => {
  it('shows only the last four characters, unprefixed', () => {
    const hint = PROVIDERS.gemini.keyHint(GEMINI_KEY);
    expect(hint).toBe(`…${GEMINI_KEY.slice(-4)}`);
    expect(hint.length).toBe(5);
    expect(hint).not.toContain(GEMINI_KEY.slice(0, -4));
  });

  it.each([
    ['a real Gemini key', GEMINI_KEY, true],
    ['a real Anthropic key (still passes the loose check)', ANTHROPIC_KEY, true],
    ['empty', '', false],
    ['too short to be any real key', 'abc123', false],
    ['contains whitespace', 'not a real key at all here', false],
  ])('%s → %s', (_label, value, expected) => {
    expect(PROVIDERS.gemini.looksLikeValidKey(value)).toBe(expected);
  });

  it('only accepts its own catalog of model ids', () => {
    expect(PROVIDERS.gemini.isValidModelId('gemini-flash-lite-latest')).toBe(true);
    expect(PROVIDERS.gemini.isValidModelId('claude-haiku-4-5')).toBe(false);
  });
});

describe('the registry', () => {
  it('every provider carries at least one model, and a defaultModel that is one of them', async () => {
    for (const provider of Object.values(PROVIDERS)) {
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.models.some((m) => m.id === provider.defaultModel)).toBe(true);
    }
  });

  it('isAiProviderId agrees with the registry keys', async () => {
    const { isAiProviderId } = await import('../src/services/ai-providers/index.js');
    expect(isAiProviderId('anthropic')).toBe(true);
    expect(isAiProviderId('gemini')).toBe(true);
    expect(isAiProviderId('openai')).toBe(false);
    expect(isAiProviderId('')).toBe(false);
  });
});
