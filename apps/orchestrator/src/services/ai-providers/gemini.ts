/**
 * The Gemini provider adapter — ADR-031.
 *
 * Built from the throwaway harness proven end-to-end this session
 * (`local-test/gemini-swap`'s `ai-chat-gemini.ts`) — the tool-planning
 * mechanics are unchanged, now behind `ProviderMeta`/`ModelClient` instead of
 * a bypassed BYOK gate.
 *
 * -- Model ids are "latest" aliases, deliberately -------------------------------
 * `gemini-2.0-flash` was retired mid-session, live in this codebase's own
 * testing — Google's error pointed at a replacement model id in the same
 * response. Pinning a dated id is exactly the drift docs/05's assumption #2
 * already warns about for Anthropic; aliases are the mitigation available
 * here.
 *
 * -- Key shape is a loose check, not a prefix regex -----------------------------
 * A real Gemini key observed firsthand this session (`AQ.Ab8RN6...`) does not
 * match the commonly-assumed `AIza...` pattern. Guessing a strict regex would
 * be actively wrong rather than merely permissive, so this only rejects the
 * obviously-not-a-key cases (empty, whitespace, too short).
 */

import { GoogleGenAI, type Content, type Part } from '@google/genai';
import { config } from '../../config.js';
import type {
  ModelClient,
  ProviderMeta,
  ProviderStepResult,
  ProviderTool,
  ProviderToolOutcome,
  ValidationResult,
} from './types.js';

const MODELS = [
  { id: 'gemini-flash-lite-latest', label: 'Economical — Flash-Lite' },
  { id: 'gemini-flash-latest', label: 'Best quality — Flash' },
] as const;

const MODEL_IDS = new Set<string>(MODELS.map((m) => m.id));

function looksLikeValidKey(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 20 && !/\s/.test(trimmed);
}

function keyHint(apiKey: string): string {
  return `…${apiKey.trim().slice(-4)}`;
}

interface GeminiErrorBody {
  readonly error?: { readonly code?: number; readonly message?: string; readonly status?: string };
}

function parseGeminiError(err: unknown): NonNullable<GeminiErrorBody['error']> | null {
  const message = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(message) as GeminiErrorBody;
    return parsed.error ?? null;
  } catch {
    return null;
  }
}

/**
 * Provider failure → something a school admin can act on. Gemini's SDK
 * throws with the raw JSON error body as the message text rather than typed
 * error classes, so this parses that body instead of matching SDK classes —
 * the two 429/404 shapes below are ones this codebase has actually seen.
 */
function translate(err: unknown): ValidationResult {
  const parsed = parseGeminiError(err);
  if (parsed === null) {
    return { ok: false, transient: true, message: 'The key could not be tested right now. Try again in a moment.' };
  }

  const status = parsed.status ?? '';
  const code = parsed.code ?? 0;

  if (status === 'UNAUTHENTICATED' || code === 401 || code === 403) {
    return {
      ok: false,
      transient: false,
      message: 'Google rejected this key. Check that you pasted the whole key, and that it is still enabled.',
    };
  }
  if (status === 'NOT_FOUND' || code === 404) {
    return {
      ok: false,
      transient: false,
      message: 'This account cannot access the selected model. Try the economical model.',
    };
  }
  if (status === 'RESOURCE_EXHAUSTED' || code === 429) {
    return {
      ok: false,
      transient: true,
      message: 'Google is rate-limiting this key right now (a free-tier limit, most likely). Wait a minute and try again.',
    };
  }
  if (code >= 500) {
    return { ok: false, transient: true, message: 'Google returned an error while testing this key. Try again in a few minutes.' };
  }
  return {
    ok: false,
    transient: false,
    message: parsed.message ?? 'Google rejected the test request. Check the key and the selected model.',
  };
}

async function validateApiKey(args: { apiKey: string; model: string }): Promise<ValidationResult> {
  const ai = new GoogleGenAI({ apiKey: args.apiKey });
  try {
    await ai.models.generateContent({
      model: args.model,
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      config: { maxOutputTokens: 1 },
    });
    return { ok: true, message: '', transient: false };
  } catch (err) {
    return translate(err);
  }
}

function createClient(args: { apiKey: string; model: string }): ModelClient<Content[]> {
  const ai = new GoogleGenAI({ apiKey: args.apiKey });
  const model = args.model;

  return {
    initialState(question) {
      return [{ role: 'user', parts: [{ text: question }] }];
    },

    async step(state: Content[], systemPrompt: string, tools: readonly ProviderTool[]): Promise<ProviderStepResult<Content[]>> {
      const functionDeclarations = tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.inputSchema,
      }));

      let response;
      try {
        response = await ai.models.generateContent({
          model,
          contents: state,
          config: { systemInstruction: systemPrompt, tools: [{ functionDeclarations }] },
        });
      } catch (err) {
        throw new Error(translate(err).message);
      }

      const modelContent = response.candidates?.[0]?.content;
      const nextState: Content[] = modelContent === undefined ? state : [...state, modelContent];

      const toolCalls = (response.functionCalls ?? []).map((call, index) => ({
        id: call.id ?? `${call.name ?? 'call'}-${String(index)}`,
        name: call.name ?? '',
        args: (call.args ?? {}) as Record<string, unknown>,
      }));

      return {
        state: nextState,
        toolCalls,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
          cacheReadTokens: response.usageMetadata?.cachedContentTokenCount ?? 0,
        },
      };
    },

    withToolOutcomes(state: Content[], outcomes: readonly ProviderToolOutcome[]) {
      const parts: Part[] = outcomes.map((o) => ({
        functionResponse: {
          name: o.name,
          response: o.error !== undefined ? { error: o.error } : { output: o.output },
        },
      }));
      return [...state, { role: 'user', parts }];
    },

    withNudge(state: Content[], text: string) {
      return [...state, { role: 'user', parts: [{ text }] }];
    },
  };
}

export const geminiProvider: ProviderMeta = {
  id: 'gemini',
  label: 'Google (Gemini)',
  consoleUrl: 'https://aistudio.google.com/apikey',
  keyPlaceholder: 'Paste your Gemini API key',
  keyPrefix: null,
  models: MODELS,
  defaultModel: 'gemini-flash-lite-latest',
  looksLikeValidKey,
  keyHint,
  isValidModelId: (model) => MODEL_IDS.has(model),
  validateApiKey,
  createClient,
};
