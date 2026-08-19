/**
 * Launch-token replay protection.
 *
 * Contract: docs/02 §2 step ② · ADR-003 ("one-time nonce (jti); jti cached until
 * expiry") · docs/02 §6 (a replayed jti fails the launch).
 *
 * Consuming a nonce is an INSERT against a UNIQUE key, so a duplicate-key error
 * IS the replay detection. That atomicity is the whole point: two simultaneous
 * presentations of one token must not both succeed, and a read-then-write check
 * would race exactly when it matters most.
 *
 * See db/platform/migrations/0003_launch_nonce.sql for why this is a table and
 * not an in-process Map.
 */

import { platformDb } from '../db/platform-db.js';

/** MySQL duplicate-entry error. */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

/**
 * Consume a nonce exactly once.
 *
 * @returns true if this jti had not been seen (launch may proceed);
 *          false if it is a replay (launch must be rejected).
 */
export async function consumeNonce(jti: string, expiresAt: Date): Promise<boolean> {
  try {
    await platformDb.execute(
      'INSERT INTO launch_nonce (jti, expires_at) VALUES (?, ?)',
      [jti, expiresAt],
    );
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === ER_DUP_ENTRY) {
      return false;
    }
    // Any other failure must NOT be read as "not a replay". If we cannot
    // establish single use, we have not established it -- fail the launch loudly
    // rather than degrade to accepting the token (CODING_GUIDELINES §10).
    throw err;
  }
}

/**
 * Prune consumed nonces past their expiry.
 *
 * Rows are only needed while the token could still be presented, and tokens live
 * 60 seconds (ADR-003). Retention beyond expiry buys nothing and the audit trail
 * already records launches.
 */
export async function pruneExpiredNonces(): Promise<number> {
  const [result] = await platformDb.execute(
    'DELETE FROM launch_nonce WHERE expires_at < UTC_TIMESTAMP(3)',
  );
  return (result as { affectedRows: number }).affectedRows;
}
