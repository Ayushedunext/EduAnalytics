-- 0008_org_channels.sql
--
-- Trust-level channel defaults, overridable per school (ADR-034, amending
-- ADR-024's school-level-v1 clause). Contract: docs/07 §4.
--
-- -- Why a second table instead of widening school_channels -------------------
-- `school_channels` (0005) is keyed (school_id, channel) and means "this
-- school's own configuration" -- that meaning must not change, because
-- ADR-034's whole point is a school's own override always wins over the trust
-- default. Folding both into one table would need a sentinel school_id for
-- "the org default", which is the kind of implicit convention
-- CODING_GUIDELINES §9 style avoids: a NULL-able foreign key standing in for a
-- different entity type is a bug waiting for a WHERE clause that forgets it.
--
-- -- Resolution lives in code, not SQL -----------------------------------------
-- The effective channel for a school is computed by one function
-- (services/channels.ts `effectiveChannel`, ADR-034) that reads school_channels
-- first and falls back to org_channels -- deliberately not a SQL COALESCE/JOIN
-- view, so the same resolution logic that guards publish-time and send-time
-- checks is the only place this decision is made (ADR-028's "one function,
-- unit-tested" discipline applied here to channel resolution instead of a
-- cache key).

CREATE TABLE IF NOT EXISTS org_channels (
  org_id     VARCHAR(128) NOT NULL,
  channel    ENUM('email','sms','whatsapp') NOT NULL,
  status     ENUM('connected','not_connected') NOT NULL DEFAULT 'not_connected',

  -- e.g. 'Gupshup' / 'MSG91' / an SMTP host. Display text, never a credential --
  -- same posture as school_channels (0005): this table records connection
  -- STATE, not secrets.
  provider   VARCHAR(128) NULL,
  detail     VARCHAR(255) NULL
    COMMENT 'Human-readable configuration summary shown in Settings. Never a secret.',

  updated_by VARCHAR(128) NULL,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (org_id, channel),
  CONSTRAINT fk_org_channel_org FOREIGN KEY (org_id) REFERENCES org_registry (org_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Trust-level messaging channel defaults (ADR-034). No credentials here.';
