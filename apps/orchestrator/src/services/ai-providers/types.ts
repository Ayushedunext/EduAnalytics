/**
 * The provider abstraction — ADR-031 (amends ADR-017).
 *
 * Anthropic and Gemini need genuinely different message/tool-call shapes —
 * confirmed by hand, not assumed: both were built and driven end-to-end this
 * session before this interface existed. This file is the seam between them,
 * so `services/ai-chat.ts`'s loop, `ai-tools.ts`'s ADR-030 redaction, the
 * hydration step and the `ai.query` audit event are written once and never
 * touch an SDK directly.
 *
 * `TState` is provider-owned and opaque to the loop: Anthropic's is
 * `MessageParam[]`, Gemini's is `Content[]`. `ai-chat.ts` only ever passes a
 * `TState` back to the same `ModelClient` that produced it — it never reads
 * or constructs one itself.
 */

export type AiProviderId = 'anthropic' | 'gemini';

/** One tool definition, in the JSON-Schema shape both providers' SDKs accept. */
export interface ProviderTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
}

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}

/** What executing one tool call produced, fed back into the conversation. */
export interface ProviderToolOutcome {
  readonly callId: string;
  readonly name: string;
  readonly output?: unknown;
  readonly error?: string;
}

export interface ProviderStepResult<TState> {
  readonly state: TState;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly usage: ProviderUsage;
}

/** One conversation with one provider. */
export interface ModelClient<TState> {
  initialState(question: string): TState;
  /** One model turn: send the current state, get back tool calls (or none, if the model answered in plain text). */
  step(
    state: TState,
    systemPrompt: string,
    tools: readonly ProviderTool[],
  ): Promise<ProviderStepResult<TState>>;
  /** Append the results of executing this turn's tool calls, ready for the next step(). */
  withToolOutcomes(state: TState, outcomes: readonly ProviderToolOutcome[]): TState;
  /** Append a plain-text nudge (e.g. "you must call a tool"), ready for the next step(). */
  withNudge(state: TState, text: string): TState;
}

export interface ValidationResult {
  readonly ok: boolean;
  /** Plain-language, user-facing. Empty when `ok`. */
  readonly message: string;
  /** Whether retrying could succeed without the admin changing anything. */
  readonly transient: boolean;
}

export interface ProviderModel {
  readonly id: string;
  readonly label: string;
}

/** Everything Settings and the key vault need to know about one provider. */
export interface ProviderMeta {
  readonly id: AiProviderId;
  readonly label: string;
  readonly consoleUrl: string;
  readonly keyPlaceholder: string;
  /**
   * A reliable literal prefix real keys start with, or `null` when the
   * provider has none worth asserting on. Anthropic's `sk-ant-` is stable
   * enough to name; Gemini's is not — a real key seen firsthand this session
   * (`AQ.Ab8RN6...`) doesn't match the commonly assumed `AIza...` shape, so
   * `null` here is honest rather than a guess. Advisory only: it drives a
   * client-side "wrong provider selected?" hint (Settings.tsx), never
   * validation — `looksLikeValidKey`/`validateApiKey` remain the real gate.
   */
  readonly keyPrefix: string | null;
  readonly models: readonly ProviderModel[];
  readonly defaultModel: string;
  looksLikeValidKey(key: string): boolean;
  keyHint(key: string): string;
  isValidModelId(model: string): boolean;
  validateApiKey(args: { apiKey: string; model: string }): Promise<ValidationResult>;
  createClient(args: { apiKey: string; model: string }): ModelClient<unknown>;
}
