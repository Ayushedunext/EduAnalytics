/**
 * Per-tenant rate limiting — docs/04 §3 rail 4.
 *
 * Contract source: docs/04 §3 rail 4 · docs/03 §6 (isolation & fairness) ·
 * docs/08 §8 ("one misbehaving tenant, agent, or prompt cannot degrade the
 * fleet") · CODING_GUIDELINES §7 ("implemented here, not in callers").
 *
 * A fixed-window counter per school. Deliberately simple: the goal is a
 * blast-radius bound, not fair queueing, and the boundary burst a fixed window
 * allows (up to 2× the limit across two adjacent windows) is well inside what
 * the row and time caps already permit a single tenant to consume.
 *
 * Per process, like the circuit breaker. With N instances the effective fleet
 * limit is N× the configured value, which is the correct behaviour for a
 * horizontally scaled stateless service: a shared counter in Redis would put a
 * network round trip in front of every query to enforce a number that is a
 * safety bound rather than a quota. If a hard org-wide quota is ever needed
 * (ADR-017 has one for AI spend), it belongs where the money is counted, not
 * here.
 */

import { ERROR_CODES, PlatformError } from '@sap/shared';
import { config } from './config.js';

interface Window {
  startedAt: number;
  count: number;
}

const windows = new Map<string, Window>();

const WINDOW_MS = 60_000;

/**
 * Count one query against a school's budget. Throws when the budget is spent.
 *
 * Called before execution rather than after, so a tenant that is already over
 * budget stops consuming connections immediately.
 */
export function consumeQueryBudget(schoolId: string, now: number = Date.now()): void {
  const window = windows.get(schoolId);
  if (window === undefined || now - window.startedAt >= WINDOW_MS) {
    windows.set(schoolId, { startedAt: now, count: 1 });
    return;
  }

  window.count += 1;
  if (window.count > config.RATE_LIMIT_QUERIES_PER_MINUTE) {
    const retryAfter = Math.ceil((window.startedAt + WINDOW_MS - now) / 1000);
    throw new PlatformError({
      code: ERROR_CODES.RATE_LIMITED,
      message: 'This school has made too many queries in the last minute. Try again shortly.',
      details: { retry_after_seconds: retryAfter },
      diagnostics: { school_id: schoolId, count: window.count },
    });
  }
}

export function resetRateLimits(): void {
  windows.clear();
}
