/**
 * The provider registry — ADR-031.
 *
 * Every other module reaches a provider through this map, never by importing
 * `anthropic.ts`/`gemini.ts` directly — the same registry-of-adapters pattern
 * `apps/mcp-server/src/schema/index.ts` already uses for schema catalogs.
 */

import type { AiProviderId, ProviderMeta } from './types.js';
import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';

export const PROVIDERS: Readonly<Record<AiProviderId, ProviderMeta>> = {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
};

export function isAiProviderId(value: string): value is AiProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

export const DEFAULT_PROVIDER: AiProviderId = 'anthropic';

export type {
  AiProviderId,
  ModelClient,
  ProviderMeta,
  ProviderModel,
  ProviderStepResult,
  ProviderTool,
  ProviderToolCall,
  ProviderToolOutcome,
  ProviderUsage,
  ValidationResult,
} from './types.js';
