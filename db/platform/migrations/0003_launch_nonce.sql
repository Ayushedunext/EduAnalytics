-- 0003_launch_nonce.sql
--
-- Replay protection for launch tokens (docs/02 §2 step ②, ADR-003:
-- "one-time nonce (jti); jti cached until expiry").
--
-- Why a table and not an in-process Map:
--   * CODING_GUIDELINES §5 -- services are stateless; no in-process state a
--     restart would lose. A nonce cache in memory forgets every used token on
--     deploy, reopening the replay window.
--   * A replay must be caught across instances. The orchestrator scales
--     horizontally (docs/01 §5), so an in-memory cache would let an attacker
--     replay a token against a different instance than the one that consumed
--     it.
--
-- The UNIQUE key does the work: consuming a nonce is an INSERT, and a duplicate
-- key error IS the replay detection. That makes it atomic rather than a
-- read-then-write race, which matters because the whole point is that two
-- simultaneous presentations of one token must not both succeed.
--
-- Volume is negligible: one row per launch, expiring in 60 seconds. Redis would
-- serve equally well once it is in the stack; the DB avoids adding infrastructure
-- to slice 1 for a security control we need immediately.

CREATE TABLE IF NOT EXISTS launch_nonce (
  jti        VARCHAR(128) NOT NULL COMMENT 'the token jti; consumed exactly once',
  expires_at DATETIME(3)  NOT NULL COMMENT 'token exp; rows are prunable after this',
  consumed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (jti),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='One-time launch-token nonces. A duplicate insert is a replay attempt (ADR-003).';
