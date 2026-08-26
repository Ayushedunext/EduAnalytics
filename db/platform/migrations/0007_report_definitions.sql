-- 0007_report_definitions.sql
--
-- Custom reports: clone-to-edit (ADR-018), logic transparency (ADR-019).
-- Contract: docs/06 §1 (the unified report-definition model) and §3
-- (clone-to-edit, versioning, visibility).
--
-- -- Why one table for predefined-clones AND AI-saved reports ----------------
-- ADR-018: "One persisted model for every report." `source_kind` says how a
-- row was created; `def_json.mode` (not a column -- see below) says how it is
-- EXECUTED. The two are independent: a predefined clone stays on the vetted
-- `run_predefined` path (mode 'template') until someone opens the SQL tab, at
-- which point it moves to mode 'raw_sql' like every AI-saved report already
-- is -- editing the statement is a one-way door, matching what "advanced
-- unlock" means in docs/06 §3.
--
-- -- Why school_scope is a column here but NEVER trusted alone --------------
-- AUDIT_REPORT A8, resolved this session: `school_scope` records the AUTHOR's
-- scope at save time, for display and as a default selection. At execution,
-- the effective scope is this column INTERSECTED with the viewer's own token
-- scope (services/custom-reports.ts) -- so a trust-shared report opened by a
-- single-school Principal runs, and shows, only that school. The column is
-- never read as an authorization grant by itself.
--
-- -- Why def_json carries the mode/params/queries rather than more columns --
-- Two shapes share one JSON column (discriminated by `def_json.mode`) rather
-- than being split into their own tables, because both funnel into the same
-- view/edit/version/rollback/PDF machinery (ADR-018's whole point) and a
-- schema migration should not be needed to add a third mode later.
--
-- -- Versioning: append-only, rollback is a new version -----------------------
-- `report_definitions` holds only the CURRENT version's content (fast reads,
-- matching a predefined report's read path); `report_definition_versions` is
-- the append-only history rollback reads from. A rollback copies an old
-- version's content forward as a NEW version rather than deleting anything
-- after it -- the same reasoning `report_definitions_versions` mirrors from
-- how a git revert works, and what "one-click rollback" in docs/06 §3
-- promises without promising to destroy the versions in between.

CREATE TABLE IF NOT EXISTS report_definitions (
  id                VARCHAR(64)  NOT NULL,
  org_id            VARCHAR(128) NOT NULL,
  owner_sub         VARCHAR(128) NOT NULL
    COMMENT 'Token sub of the user who cloned/saved this report.',
  name              VARCHAR(255) NOT NULL,

  -- NULL for an AI-saved report; a predefined catalog id for a clone. Not a
  -- foreign key -- predefined reports are code (mcp-server/src/reports/
  -- catalog.ts), not rows.
  base_report_id    VARCHAR(128) NULL,
  source_kind       ENUM('predefined_clone', 'ai_saved') NOT NULL,

  -- Author's scope at save time. See the header note: never trusted alone.
  school_scope      JSON NOT NULL,

  shared_flag       ENUM('private', 'school', 'trust') NOT NULL DEFAULT 'private',

  current_version   INT UNSIGNED NOT NULL DEFAULT 1,
  def_json          JSON NOT NULL
    COMMENT 'Discriminated on def_json.mode: template (run_predefined + params) or raw_sql (queries[] + a chart-spec draft).',
  sql_text          TEXT NOT NULL
    COMMENT 'Human-readable rendering of the current version''s SQL, for the Logic panel and audit -- always derivable from def_json, kept here so it never needs a query to display (Invariant 6).',

  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP NULL,

  PRIMARY KEY (id),
  CONSTRAINT fk_report_definition_org FOREIGN KEY (org_id) REFERENCES org_registry (org_id)
    ON DELETE CASCADE,
  -- My Reports lists by owner first; visibility promotion lists by org and
  -- shared_flag. Both are real query shapes, not speculative indexes.
  INDEX idx_report_definitions_owner (org_id, owner_sub, deleted_at),
  INDEX idx_report_definitions_shared (org_id, shared_flag, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Custom report definitions -- clone-to-edit and AI-saved reports (ADR-018).';

CREATE TABLE IF NOT EXISTS report_definition_versions (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id         VARCHAR(64)     NOT NULL,
  version           INT UNSIGNED    NOT NULL,
  def_json          JSON            NOT NULL,
  sql_text          TEXT            NOT NULL,
  edited_by         VARCHAR(128)    NOT NULL,
  edited_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_report_definition_version (report_id, version),
  CONSTRAINT fk_report_definition_version_report FOREIGN KEY (report_id)
    REFERENCES report_definitions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Append-only version history for report_definitions. Rollback copies a row forward as a new version (docs/06 §3).';
