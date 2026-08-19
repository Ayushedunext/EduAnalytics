-- 0002_audit_log.sql
--
-- The audit trail. Contract: docs/08 §7 (chokepoint table) ·
-- CODING_GUIDELINES §13 [MANDATORY].
--
-- Created in slice 1 rather than "later" on purpose: §13 states audit writes
-- are part of a feature's definition of done, not a follow-up. Schools answer
-- to parents and boards -- "who looked at this student's fee detail" has to be
-- answerable from the first query the platform ever runs, not from the day
-- someone remembers to add logging.
--
-- Two streams, never mixed (§13): this is the AUDIT stream. Operational logs
-- go to stdout and must never carry PII, SQL parameter values, tokens or keys.

CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  at             DATETIME(3)  NOT NULL COMMENT 'event time, millisecond precision',
  kind           VARCHAR(64)  NOT NULL COMMENT 'report.viewed | sql.executed | scope.violation | ...',
  actor_sub      VARCHAR(128) NOT NULL COMMENT 'token sub -- the acting user',
  org_id         VARCHAR(128) NOT NULL,
  correlation_id VARCHAR(64)  NOT NULL COMMENT 'propagated through MCP calls and logs (CODING §5)',

  -- Denormalised for the queries auditors actually ask ("everything touching
  -- this school"). JSON because an event may span a school set (fan-out).
  school_ids     JSON         NULL,

  -- The event body, shaped by the discriminated union in @sap/shared audit.ts.
  -- Keys and tokens are log-forbidden values and must never appear here.
  payload        JSON         NOT NULL,

  PRIMARY KEY (id),
  KEY idx_at (at),
  KEY idx_kind_at (kind, at),
  KEY idx_org_at (org_id, at),
  KEY idx_actor_at (actor_sub, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Append-only audit trail (docs/08 §7). Retention pending the compliance review (docs/11 §4.5).';
