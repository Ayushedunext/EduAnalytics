-- 0005_ai_config_and_channels.sql
--
-- The BYOK key vault (docs/05 §4.1, ADR-017) and the school messaging-channel
-- register (docs/07 §4, ADR-024).
--
-- -- Why the key lives in the PLATFORM database ------------------------------
-- It is platform configuration, not school data: one key per ORG covers every
-- school the org owns, which is how trusts buy (ADR-017). It is also written,
-- and the school data plane is SELECT-only by construction (ADR-008), so it
-- could not live there even if the ownership argument went the other way.
--
-- -- Why the ciphertext is a column and not a reference ----------------------
-- ADR-017 requires AES-256 at rest with the master key held outside the
-- database. That is what `encrypted_api_key` is: ciphertext produced with a key
-- this database never sees, so a dump of this table is not a disclosure. In
-- production the master key comes from KMS; locally it comes from the
-- environment (services/key-vault.ts).
--
-- `key_hint` exists so the UI can show `sk-ant-…1G4a` without a decrypt. Rail:
-- the plaintext key is decrypted only in memory at call time and is never
-- returned to a client, so the hint is the ONLY key-derived value that ever
-- crosses the API boundary.

CREATE TABLE IF NOT EXISTS tenant_ai_config (
  org_id            VARCHAR(128) NOT NULL,

  -- AES-256-GCM: iv(12) || auth tag(16) || ciphertext. NULL until a key is
  -- saved, and set back to NULL when an admin disables AI -- a disabled org
  -- should not still be holding a usable secret.
  encrypted_api_key VARBINARY(1024) NULL
    COMMENT 'AES-256-GCM ciphertext. Master key from KMS/env, never in this database.',

  -- Display only: last four characters, so a reader can tell WHICH key is
  -- installed without the platform being able to show them the key.
  key_hint          VARCHAR(32)  NULL,

  model             VARCHAR(64)  NOT NULL DEFAULT 'claude-haiku-4-5'
    COMMENT 'Model id the org chose: economical (Haiku) or best quality (Sonnet).',

  -- docs/05 §4: 'platform' is the hybrid mode where the platform's own key
  -- backs a small school on bundled pricing. Same gate, different vault entry.
  billing_mode      ENUM('byok','platform') NOT NULL DEFAULT 'byok',

  monthly_query_cap INT UNSIGNED NOT NULL DEFAULT 1500,

  -- The gating state machine (docs/05 §4.2). Every /api/ai/* request re-checks
  -- this; UI locks are cosmetic on top of it (Invariant 5).
  ai_status         ENUM('not_configured','pending_validation','active','error')
                    NOT NULL DEFAULT 'not_configured',

  last_validated_at TIMESTAMP NULL,

  -- The provider's own failure, translated to plain language for the fix-it
  -- banner (ADR-017: "the platform must translate someone else's billing
  -- errors"). Never contains the key or a raw provider payload.
  last_error        VARCHAR(255) NULL,

  -- Who last changed it, for the config-change audit trail (docs/08 §7).
  updated_by        VARCHAR(128) NULL,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (org_id),
  CONSTRAINT fk_ai_config_org FOREIGN KEY (org_id) REFERENCES org_registry (org_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='BYOK key vault and AI gating state, one row per org (ADR-017, docs/05 §4).';

-- -- Messaging channels -------------------------------------------------------
--
-- Per SCHOOL, not per org: docs/07 §4 puts sender reputation, DLT attribution
-- and WABA quality ratings with the school that owns them, and ADR-024 makes
-- that binding. A row exists for every (school, channel) pair the product knows
-- about, connected or not, because the UI has to show a channel that is NOT
-- connected -- that is the state the school acts on.
--
-- Provider CREDENTIALS are deliberately absent. This table records the
-- connection STATE and the human-readable detail the settings screen shows;
-- capturing SMTP passwords, DLT sender registrations and BSP tokens is a
-- separate piece of work with its own vault, and stubbing columns for it now
-- would invite someone to write a secret into a table that has no encryption.

CREATE TABLE IF NOT EXISTS school_channels (
  school_id  VARCHAR(128) NOT NULL,
  channel    ENUM('email','sms','whatsapp') NOT NULL,
  status     ENUM('connected','not_connected') NOT NULL DEFAULT 'not_connected',

  -- e.g. 'Gupshup' / 'MSG91' / an SMTP host. Display text, never a credential.
  provider   VARCHAR(128) NULL,
  detail     VARCHAR(255) NULL
    COMMENT 'Human-readable configuration summary shown in Settings. Never a secret.',

  updated_by VARCHAR(128) NULL,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (school_id, channel),
  CONSTRAINT fk_channel_school FOREIGN KEY (school_id) REFERENCES tenant_registry (school_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Per-school messaging channel state (docs/07 §4, ADR-024). No credentials here.';
