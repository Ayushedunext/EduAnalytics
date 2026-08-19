-- 0001_tenant_registry.sql
--
-- The Tenant Registry: the platform's own copy of the ERP's school topology.
-- Contract: docs/02 §5 (columns) · docs/03 §2 (resolution) · ADR-005 · ADR-013.
--
-- "The registry IS the configuration" (docs/04 §4): onboarding a school is an
-- INSERT, not a deployment. In production these rows arrive from the 15-minute
-- ERP sync; locally they are seeded (db/platform/seed/).
--
-- Engine: MySQL 8 (PROJECT_CONTEXT.md §7, decided 2026-08-19).

CREATE TABLE IF NOT EXISTS tenant_registry (
  school_id      VARCHAR(128) NOT NULL COMMENT 'ERP school id; same id space end-to-end (docs/02 §3)',
  org_id         VARCHAR(128) NOT NULL COMMENT 'ERP org/society id',
  school_name    VARCHAR(255) NOT NULL,
  region         VARCHAR(64)  NOT NULL COMMENT 'AWS region; routes multi-region deployments (docs/03 §6)',
  status         ENUM('active','suspended','migrating') NOT NULL DEFAULT 'active'
                 COMMENT 'non-active schools are dropped from scope with a notice (docs/02 §6)',

  -- [MANDATORY] ADR-009: the REPLICA host, and only ever the replica host.
  -- There is deliberately NO primary_host column and one must not be added --
  -- "primaries are unaddressable from platform code" is the mechanism that
  -- turns zero-ERP-load from a policy into a guarantee.
  replica_host   VARCHAR(255) NOT NULL,

  -- Interpolated into SQL as an identifier (USE `db` / FROM `db`.table) where a
  -- bound parameter is not legal syntax, so it is allowlisted in application
  -- code before it ever reaches the driver (@sap/shared identifiers.ts,
  -- CODING_GUIDELINES §9). 64 chars = the MySQL identifier limit.
  db_name        VARCHAR(64)  NOT NULL,

  -- Pointer only. Credentials live in AWS Secrets Manager (ADR-013): the
  -- registry is a frequently-read topology table and the wrong store for
  -- secrets. Locally this holds an env:// URI resolved by the same interface.
  secret_arn     VARCHAR(512) NOT NULL,

  schema_version VARCHAR(64)  NOT NULL COMMENT 'e.g. erp-v4.2; schema + prompt caches key on this (ADR-014)',

  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (school_id),
  KEY idx_org_status (org_id, status),
  KEY idx_schema_version (schema_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='School topology synced from ERP master config (ADR-005). Never stores credentials.';

CREATE TABLE IF NOT EXISTS org_registry (
  org_id       VARCHAR(128) NOT NULL,
  org_name     VARCHAR(255) NOT NULL,
  school_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Org/trust registry. Unit of BYOK ownership and AI gating (ADR-017).';
