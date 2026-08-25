-- 0006_tenant_ai_config_provider.sql
--
-- Adds the AI provider choice to BYOK. Contract: ADR-031 (amends ADR-017).
--
-- ADR-017 fixed BYOK to Anthropic only; ADR-031 opens it to Google Gemini as a
-- second choice, so an org that already has a Google Cloud relationship (or
-- wants to evaluate Ask AI on Gemini's free tier before committing to a paid
-- Anthropic account) is not forced into one vendor. `provider` says which
-- SDK/model-catalog/error-mapping the stored key belongs to.
--
-- DEFAULT 'anthropic' rather than a bare NOT NULL: every row that exists
-- before this migration runs was created under the Anthropic-only rule, so
-- backfilling them as 'anthropic' states what was already true rather than
-- inventing a new fact. A brand-new row always supplies a real value at save
-- time (services/ai-config.ts's saveApiKey), so the default only ever matters
-- for rows this migration is reclassifying, never for a fresh save.
--
-- PRIMARY KEY (org_id) is unchanged: one active provider per org, matching
-- ADR-031's decision that an admin picks Anthropic OR Gemini rather than
-- holding both simultaneously. Switching providers overwrites this row
-- exactly like "Replace Key" already does today for a same-provider swap.

ALTER TABLE tenant_ai_config
  ADD COLUMN provider ENUM('anthropic','gemini') NOT NULL DEFAULT 'anthropic'
    COMMENT 'Which AI provider the stored key belongs to (ADR-031, amends ADR-017).'
    AFTER org_id;
