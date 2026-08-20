/**
 * The provider boundary: validating an org's own Anthropic key.
 *
 * Contract source: docs/05 §4.1 ("Validation on save: a 1-token live test call
 * to the Messages API; only success activates") · ADR-017 (the gating state
 * machine, and "the platform must translate someone else's billing errors into
 * plain language").
 *
 * -- Why a live call and not a format check -----------------------------------
 * A well-formed key that is revoked, unfunded or rate-limited looks exactly like
 * a working one. Activating on shape alone would move the failure to the first
 * question a Principal asks — at which point the error is the platform's fault
 * in the user's mind. One real call at save time costs a fraction of a rupee and
 * makes `ai_status = active` mean something.
 *
 * -- Why the answers are rewritten --------------------------------------------
 * "Your credit balance is too low to access the Anthropic API" is Anthropic
 * talking to a developer. The person reading this screen is a school admin who
 * has just followed a three-step wizard. Every branch below ends in a sentence
 * that says what happened and what to do about it, and none of them echo a raw
 * provider payload — which could contain request detail we should not be
 * surfacing anyway.
 *
 * [MANDATORY] CODING_GUIDELINES §13: the key is never logged. It exists here as
 * a function argument and reaches the SDK; it is not written to any log line,
 * error message or diagnostic in this module.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/**
 * The two choices the setup wizard offers (docs/05 §5: "Economical–Haiku /
 * Best–Sonnet").
 *
 * A closed set, resolved server-side from an id, for the same reason report SQL
 * is: a model name arriving from a client is a caller choosing what the org pays
 * for. The labels are the product's; the ids are the provider's.
 */
export const AI_MODELS = {
  'claude-haiku-4-5': { id: 'claude-haiku-4-5', label: 'Economical — Haiku' },
  'claude-sonnet-5': { id: 'claude-sonnet-5', label: 'Best quality — Sonnet' },
} as const;

export type AiModelId = keyof typeof AI_MODELS;

export function isAiModelId(value: string): value is AiModelId {
  return Object.prototype.hasOwnProperty.call(AI_MODELS, value);
}

export const DEFAULT_MODEL: AiModelId = 'claude-haiku-4-5';

export interface ValidationResult {
  readonly ok: boolean;
  /** Plain-language, user-facing. Empty when `ok`. */
  readonly message: string;
  /**
   * Whether retrying could plausibly succeed without the admin changing
   * anything — a timeout or a 5xx, as opposed to a revoked key. It decides
   * whether the org lands in `error` (their problem to fix) or stays where it
   * was (ours).
   */
  readonly transient: boolean;
}

export async function validateApiKey(args: {
  apiKey: string;
  model: AiModelId;
}): Promise<ValidationResult> {
  const client = new Anthropic({
    apiKey: args.apiKey,
    timeout: config.AI_VALIDATION_TIMEOUT_MS,
    /**
     * No retries. The SDK would retry a 429 or a 5xx behind our back, turning a
     * ten-second budget into thirty while an admin watches a spinner. This is a
     * reachability probe, and one attempt answers it.
     */
    maxRetries: 0,
  });

  try {
    await client.messages.create({
      model: args.model,
      /**
       * One token, exactly as docs/05 §4.1 specifies. This is the deliberate
       * exception to "never lowball max_tokens": the answer is discarded, and
       * the only question being asked is whether the credential works. It bills
       * the org a fraction of a rupee, which is the honest cost of finding out.
       */
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true, message: '', transient: false };
  } catch (err) {
    return translate(err);
  }
}

/**
 * Provider failure → something a school admin can act on.
 *
 * Typed SDK classes, not string matching on messages (which change without
 * notice and are not part of any contract).
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
    /**
     * The model id is ours, not the caller's, so this means the org's account
     * cannot reach the model we asked for — which is an account question, not a
     * key question, and saying so saves an admin from re-pasting a good key.
     */
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
    /**
     * The 400 an unfunded account returns. It is the single most likely failure
     * for a brand-new Console account — the key is real, the billing is not set
     * up — and the wizard's step 1 already warns about it, so the message points
     * back there rather than at the key.
     */
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
      message:
        'Analytics could not reach Anthropic. This is usually a temporary network problem — try again in a moment.',
    };
  }

  if (err instanceof Anthropic.APIError) {
    return {
      ok: false,
      transient: err.status !== undefined && err.status >= 500,
      message: 'Anthropic returned an error while testing this key. Try again in a few minutes.',
    };
  }

  return {
    ok: false,
    transient: true,
    message: 'The key could not be tested right now. Try again in a moment.',
  };
}
