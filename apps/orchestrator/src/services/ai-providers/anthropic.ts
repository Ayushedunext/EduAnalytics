/**
 * The Anthropic provider adapter — ADR-031.
 *
 * Absorbs what was `services/anthropic.ts` (model catalog, live key
 * validation, SDK-error translation — docs/05 §4.1) plus a `createClient`
 * wrapping the tool-planning loop mechanics that were previously inline in
 * `services/ai-chat.ts`. Nothing about the validation/translation behavior
 * changed in the move — it's the same code, now behind `ProviderMeta`.
 *
 * -- Why a live call and not a format check ------------------------------------
 * A well-formed key that is revoked, unfunded or rate-limited looks exactly
 * like a working one. Activating on shape alone would move the failure to the
 * first question a Principal asks. One real call at save time costs a
 * fraction of a rupee and makes `ai_status = active` mean something.
 *
 * [MANDATORY] CODING_GUIDELINES §13: the key is never logged.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import type {
  ModelClient,
  ProviderMeta,
  ProviderStepResult,
  ProviderTool,
  ProviderToolOutcome,
  ValidationResult,
} from './types.js';

/** docs/05 §5: "Economical–Haiku / Best–Sonnet". A closed set, resolved server-side. */
const MODELS = [
  { id: 'claude-haiku-4-5', label: 'Economical — Haiku' },
  { id: 'claude-sonnet-5', label: 'Best quality — Sonnet' },
] as const;

const MODEL_IDS = new Set<string>(MODELS.map((m) => m.id));

const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{16,200}$/;

function looksLikeValidKey(value: string): boolean {
  return KEY_SHAPE.test(value.trim());
}

function keyHint(apiKey: string): string {
  return `sk-ant-…${apiKey.trim().slice(-4)}`;
}

async function validateApiKey(args: { apiKey: string; model: string }): Promise<ValidationResult> {
  const client = new Anthropic({
    apiKey: args.apiKey,
    timeout: config.AI_VALIDATION_TIMEOUT_MS,
    // No retries: this is a reachability probe, not a request worth 30s of backoff.
    maxRetries: 0,
  });

  try {
    await client.messages.create({
      model: args.model,
      // One token, exactly as docs/05 §4.1 specifies — the answer is discarded.
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true, message: '', transient: false };
  } catch (err) {
    return translate(err);
  }
}

/**
 * Provider failure → something a school admin can act on. Typed SDK classes,
 * not string matching on messages. Also the error path `createClient`'s
 * `step()` reuses mid-conversation, so a rejected key reads the same whether
 * it failed at Settings' "Test & Save" or three tool calls into a question.
 */
function translate(err: unknown): ValidationResult {
  if (err instanceof Anthropic.AuthenticationError) {
    return {
      ok: false,
      transient: false,
      message:
        'Anthropic rejected this key. Check that you pasted the whole key, and that it has not been revoked in the Console.',
    };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return {
      ok: false,
      transient: false,
      message:
        'This key does not have permission to use the Messages API. Create a key with default permissions in the Anthropic Console.',
    };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return {
      ok: false,
      transient: false,
      message:
        'This account cannot access the selected model. Try the economical model, or check model access in the Anthropic Console.',
    };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      ok: false,
      transient: true,
      message: 'Anthropic is rate-limiting this account right now. Wait a minute and try again.',
    };
  }
  if (err instanceof Anthropic.BadRequestError) {
    const text = err.message.toLowerCase();
    if (text.includes('credit') || text.includes('billing')) {
      return {
        ok: false,
        transient: false,
        message:
          'The key works, but the Anthropic account has no credit. Add a card or prepaid credits in the Console, then test again.',
      };
    }
    return {
      ok: false,
      transient: false,
      message: 'Anthropic rejected the test request. Check the key and the selected model.',
    };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return {
      ok: false,
      transient: true,
      message: 'Analytics could not reach Anthropic. This is usually a temporary network problem — try again in a moment.',
    };
  }
  if (err instanceof Anthropic.APIError) {
    return {
      ok: false,
      transient: err.status !== undefined && err.status >= 500,
      message: 'Anthropic returned an error while testing this key. Try again in a few minutes.',
    };
  }
  return { ok: false, transient: true, message: 'The key could not be tested right now. Try again in a moment.' };
}

function createClient(args: { apiKey: string; model: string }): ModelClient<Anthropic.MessageParam[]> {
  const client = new Anthropic({ apiKey: args.apiKey, timeout: config.AI_CHAT_TIMEOUT_MS, maxRetries: 0 });
  const model = args.model;

  return {
    initialState(question) {
      return [{ role: 'user', content: question }];
    },

    async step(
      state: Anthropic.MessageParam[],
      systemPrompt: string,
      tools: readonly ProviderTool[],
    ): Promise<ProviderStepResult<Anthropic.MessageParam[]>> {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model,
          max_tokens: 4096,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
          messages: state,
        });
      } catch (err) {
        throw new Error(translate(err).message);
      }

      const nextState: Anthropic.MessageParam[] = [
        ...state,
        { role: 'assistant', content: response.content },
      ];

      const toolCalls = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }));

      return {
        state: nextState,
        toolCalls,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        },
      };
    },

    withToolOutcomes(state: Anthropic.MessageParam[], outcomes: readonly ProviderToolOutcome[]) {
      const content: Anthropic.ToolResultBlockParam[] = outcomes.map((o) =>
        o.error !== undefined
          ? { type: 'tool_result', tool_use_id: o.callId, is_error: true, content: o.error }
          : { type: 'tool_result', tool_use_id: o.callId, content: JSON.stringify(o.output) },
      );
      return [...state, { role: 'user', content }];
    },

    withNudge(state: Anthropic.MessageParam[], text: string) {
      return [...state, { role: 'user', content: text }];
    },
  };
}

export const anthropicProvider: ProviderMeta = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  consoleUrl: 'https://console.anthropic.com',
  keyPlaceholder: 'sk-ant-…',
  keyPrefix: 'sk-ant-',
  models: MODELS,
  defaultModel: 'claude-haiku-4-5',
  looksLikeValidKey,
  keyHint,
  isValidModelId: (model) => MODEL_IDS.has(model),
  validateApiKey,
  createClient,
};
