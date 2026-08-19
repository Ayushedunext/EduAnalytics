/**
 * Per-school circuit breaker.
 *
 * Contract source: docs/04 §3 rail 5 ("fail fast for 60 s on a down/slow
 * school") · docs/03 §6 · docs/08 §8 (blast-radius limits) ·
 * CODING_GUIDELINES §7 ("implemented here, not in callers").
 *
 * The failure it prevents is not one school being unavailable — that is already
 * handled, and ADR-011 says a fan-out annotates the unreachable school and
 * returns the rest. It is one school's stuck connections draining a pool that
 * schools sharing the RDS instance also depend on. Without a breaker, every
 * request to a dead school waits the full 10 s timeout, and enough of them
 * exhaust the instance's workers. The breaker turns a slow failure into an
 * immediate one, which is what keeps a neighbour's outage off this school's
 * latency budget.
 *
 * State is per process and deliberately not shared. A breaker is a local
 * observation about connections THIS instance holds; coordinating it through
 * Redis would make one instance's bad luck everyone's outage, and the services
 * are stateless precisely so instances can disagree harmlessly (docs/01 §5).
 */

import { ERROR_CODES, PlatformError } from '@sap/shared';
import { config } from '../config.js';

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

const states = new Map<string, BreakerState>();

function stateFor(schoolId: string): BreakerState {
  let state = states.get(schoolId);
  if (state === undefined) {
    state = { consecutiveFailures: 0, openedAt: null };
    states.set(schoolId, state);
  }
  return state;
}

/** Throws when the breaker is open. Call before acquiring a connection. */
export function assertClosed(schoolId: string, now: number = Date.now()): void {
  const state = stateFor(schoolId);
  if (state.openedAt === null) return;
  const elapsedSeconds = (now - state.openedAt) / 1000;
  if (elapsedSeconds < config.BREAKER_OPEN_SECONDS) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'This school is temporarily unreachable. Try again shortly.',
      details: { retry_after_seconds: Math.ceil(config.BREAKER_OPEN_SECONDS - elapsedSeconds) },
      diagnostics: { school_id: schoolId, breaker: 'open' },
    });
  }
  // Half-open: let the next call through. It either succeeds and resets the
  // breaker, or fails and re-opens it for another window.
  state.openedAt = null;
  state.consecutiveFailures = config.BREAKER_FAILURE_THRESHOLD - 1;
}

export function recordSuccess(schoolId: string): void {
  const state = stateFor(schoolId);
  state.consecutiveFailures = 0;
  state.openedAt = null;
}

/**
 * Only INFRASTRUCTURE failures count. A rejected statement or a scope violation
 * is the guard working, and a school whose users write bad SQL is not a school
 * that should be taken offline — counting those would let one careless report
 * break a healthy tenant.
 */
export function recordFailure(schoolId: string, now: number = Date.now()): void {
  const state = stateFor(schoolId);
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= config.BREAKER_FAILURE_THRESHOLD) {
    state.openedAt = now;
    console.error(
      `[mcp:breaker] opened for school_id=${schoolId} after ` +
        `${String(state.consecutiveFailures)} consecutive failures`,
    );
  }
}

export function resetBreakers(): void {
  states.clear();
}
