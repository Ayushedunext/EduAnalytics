/**
 * Runtime schema bootstrap for the Workflow Agents tables.
 *
 * Narrow, deliberate exception to the normal migration path (db/scripts/migrate.mjs
 * applying db/platform/migrations/*.sql, tracked in schema_migrations): this
 * covers ONLY the five tables 0009_agents.sql already defines, so an
 * environment whose platform DB predates that migration self-heals on the
 * orchestrator's own boot, without a separate command against the DB.
 *
 * Every statement is CREATE TABLE IF NOT EXISTS, byte-identical to
 * db/platform/migrations/0009_agents.sql, and run one at a time -- platformDb
 * is opened with multipleStatements: false (db/platform-db.ts), so a single
 * combined script would be rejected outright.
 */

import { platformDb } from './platform-db.js';

const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS agents (
    id              VARCHAR(64)  NOT NULL,
    org_id          VARCHAR(128) NOT NULL,
    school_ids      JSON         NOT NULL,
    name            VARCHAR(255) NOT NULL,
    status          ENUM('draft','active','paused') NOT NULL DEFAULT 'draft',
    current_version INT UNSIGNED NOT NULL DEFAULT 0,
    draft_graph_json    JSON NULL,
    draft_schedule_json JSON NULL,
    consecutive_failures INT UNSIGNED NOT NULL DEFAULT 0,
    created_by      VARCHAR(128) NOT NULL,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP    NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_agent_org FOREIGN KEY (org_id) REFERENCES org_registry (org_id)
      ON DELETE CASCADE,
    INDEX idx_agents_org (org_id, deleted_at),
    INDEX idx_agents_status (status, deleted_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    COMMENT='Workflow agents (ADR-022). graph_json lives on agent_versions, never here.'`,

  `CREATE TABLE IF NOT EXISTS agent_versions (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    agent_id      VARCHAR(64)     NOT NULL,
    version       INT UNSIGNED    NOT NULL,
    graph_json    JSON            NOT NULL,
    schedule_json JSON            NOT NULL,
    published_role  ENUM('DIRECTOR','PRINCIPAL','TEACHER','ACCOUNTANT','ADMIN') NOT NULL,
    published_perms JSON          NOT NULL,
    published_by    VARCHAR(128)  NOT NULL,
    published_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_agent_version (agent_id, version),
    CONSTRAINT fk_agent_version_agent FOREIGN KEY (agent_id) REFERENCES agents (id)
      ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    COMMENT='Append-only published versions of an agent graph (ADR-022).'`,

  `CREATE TABLE IF NOT EXISTS agent_runs (
    run_id           VARCHAR(64)     NOT NULL,
    agent_id         VARCHAR(64)     NOT NULL,
    agent_version_id BIGINT UNSIGNED NOT NULL,
    school_id        VARCHAR(128)    NOT NULL,
    record_ref       JSON            NOT NULL,
    dedup_key        VARCHAR(255)    NOT NULL,
    status           ENUM('running','waiting','completed','failed') NOT NULL DEFAULT 'running',
    current_node_id  VARCHAR(128)    NULL,
    started_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at      TIMESTAMP       NULL,
    PRIMARY KEY (run_id),
    UNIQUE KEY uq_agent_run_dedup (agent_id, dedup_key),
    CONSTRAINT fk_agent_run_agent FOREIGN KEY (agent_id) REFERENCES agents (id)
      ON DELETE CASCADE,
    CONSTRAINT fk_agent_run_version FOREIGN KEY (agent_version_id) REFERENCES agent_versions (id)
      ON DELETE RESTRICT,
    INDEX idx_agent_runs_agent (agent_id, started_at),
    INDEX idx_agent_runs_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    COMMENT='One row per matched record per trigger firing (ADR-022).'`,

  `CREATE TABLE IF NOT EXISTS run_steps (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    run_id      VARCHAR(64)     NOT NULL,
    node_id     VARCHAR(128)    NOT NULL,
    status      ENUM('pending','running','succeeded','failed','skipped') NOT NULL DEFAULT 'pending',
    payload_in  JSON            NULL,
    payload_out JSON            NULL,
    error       VARCHAR(255)    NULL,
    ts          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_run_step_run FOREIGN KEY (run_id) REFERENCES agent_runs (run_id)
      ON DELETE CASCADE,
    INDEX idx_run_steps_run (run_id, ts)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    COMMENT='Per-node execution trace for a run (ADR-022).'`,

  `CREATE TABLE IF NOT EXISTS message_log (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    run_id        VARCHAR(64)     NOT NULL,
    run_step_id   BIGINT UNSIGNED NOT NULL,
    school_id     VARCHAR(128)    NOT NULL,
    channel       ENUM('email','sms','whatsapp') NOT NULL,
    template_id   VARCHAR(128)    NULL,
    recipient     VARCHAR(255)    NOT NULL,
    status        ENUM('sent','failed','skipped_dedup','skipped_quiet_hours','skipped_cap','skipped_guardrail')
                  NOT NULL,
    provider_ref  VARCHAR(255)    NULL,
    error         VARCHAR(255)    NULL,
    sent_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_message_log_run FOREIGN KEY (run_id) REFERENCES agent_runs (run_id)
      ON DELETE CASCADE,
    CONSTRAINT fk_message_log_step FOREIGN KEY (run_step_id) REFERENCES run_steps (id)
      ON DELETE CASCADE,
    INDEX idx_message_log_school_day (school_id, sent_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    COMMENT='Per-message send record (ADR-022/025).'`,
];

/**
 * Idempotent (every statement is CREATE TABLE IF NOT EXISTS) -- safe to run on
 * every boot, on every replica, forever. Only creates tables; never seeds,
 * alters, or touches a row.
 */
export async function ensureAgentTables(): Promise<void> {
  for (const statement of STATEMENTS) {
    await platformDb.query(statement);
  }
}
