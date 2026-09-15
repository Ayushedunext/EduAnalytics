-- 0009_agents.sql
--
-- Workflow Agents: JSON graph + persisted state-machine runs (ADR-022),
-- read-only against school data with messages as the only side effect
-- (ADR-023), platform-enforced idempotency and guardrails (ADR-025).
-- Contract: docs/07 (all sections).
--
-- -- Why these five tables and not fewer ---------------------------------------
-- docs/07 §3 names the storage shape explicitly: "agents(...) · agent_runs(...)
-- · run_steps(...) · message_log(...)" -- one row per concept, not one wide
-- table, because each grows and is queried on a different axis (an agent is
-- edited rarely; a run is created per matched record per tick; a step is
-- written per node per run; a message is written per send attempt). This file
-- adds a fifth, agent_versions, splitting "the agent" from "one published
-- version of its graph" for the reason ADR-022 states directly: "publishing an
-- agent never mutates in-flight runs" requires a run to pin an immutable
-- version row, not a mutable current-graph column.
--
-- -- Why school_ids lives on the agent, not inferred from the org ------------
-- "Multi-school orgs can deploy one agent to any/all of their schools" (docs/07
-- §1) makes the deploy scope a per-agent choice, not the whole org by default.
-- Mirrors ADR-032's discipline for report_definitions.school_scope: this column
-- is the scope the agent was DEPLOYED with; every trigger evaluation still
-- intersects it against the org's currently servable schools (docs/02 §6)
-- rather than trusting it to stay valid forever.
--
-- -- Why agent_runs carries a dedup_key column instead of computing it ad hoc --
-- ADR-025's guardrails are "platform-level, not per-agent options" -- making
-- the auto-derived key (agent+node+record+date, docs/07 §3) a UNIQUE column
-- turns "never double-message for the same event" from application discipline
-- into a constraint the database itself refuses to violate twice, which is the
-- same "mechanism over discipline" reasoning ADR-028 and ADR-025 both give
-- elsewhere.
--
-- -- PII note on message_log ---------------------------------------------------
-- `recipient` is a parent/staff phone number or email address -- row-level PII
-- in the platform database, same posture docs/07 §3 already anticipates by
-- naming message_log among the platform-DB tables. This is the audit trail FOR
-- messages (docs/08 §7: "prove we informed the parent at 10:31"), not an
-- operational log, so it is exempt from the log-forbidden-values rule (§13)
-- the same way audit_log already is -- but it must never be written to
-- stdout/operational logging, only to this table.

CREATE TABLE IF NOT EXISTS agents (
  id              VARCHAR(64)  NOT NULL,
  org_id          VARCHAR(128) NOT NULL,

  -- Deploy scope -- see header note. A subset of the org's schools, chosen at
  -- create/edit time by whoever built the agent.
  school_ids      JSON         NOT NULL,

  name            VARCHAR(255) NOT NULL,

  -- 'draft' = never published (current_version = 0, nothing runs); 'active' =
  -- publishable version exists and the scheduler ticks it; 'paused' = a
  -- published agent an admin or the auto-pause guardrail (ADR-025) has
  -- stopped. Distinct from a run's own status.
  status          ENUM('draft','active','paused') NOT NULL DEFAULT 'draft',

  -- 0 until the first publish. Runs pin agent_versions.version, never this
  -- column directly, so editing a draft ahead of the next publish cannot
  -- affect an in-flight run (ADR-022).
  current_version INT UNSIGNED NOT NULL DEFAULT 0,

  -- The builder's in-progress, UNPUBLISHED graph -- separate from
  -- agent_versions on purpose. The builder autosaves here on every edit;
  -- Publish is the one action that validates this and copies it forward as a
  -- new, immutable agent_versions row. Before the first publish this is the
  -- only graph that exists for the agent.
  draft_graph_json    JSON NULL,
  draft_schedule_json JSON NULL,

  -- Consecutive-failure counter backing the auto-pause guardrail (ADR-025).
  -- Reset to 0 on any successful run.
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
  COMMENT='Workflow agents (ADR-022). graph_json lives on agent_versions, never here.';

CREATE TABLE IF NOT EXISTS agent_versions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id      VARCHAR(64)     NOT NULL,
  version       INT UNSIGNED    NOT NULL,

  -- The published graph: nodes + edges, validated against packages/agent-graph
  -- before this row is written (flow linting, docs/07 §6). Immutable once
  -- written -- an edit is always a NEW row, never an UPDATE.
  graph_json    JSON            NOT NULL,
  schedule_json JSON            NOT NULL
    COMMENT 'Trigger schedule at publish time, e.g. {"kind":"cron","cron":"30 10 * * 1-6","tz":"Asia/Kolkata"}.',

  -- Snapshot of the publisher's own token role at publish time -- the same
  -- non-widening discipline ADR-032 applies to a viewer's effective scope,
  -- applied here to a background run's effective permissions: an agent must
  -- never read with more authority than its publisher held (docs/04 §3 rail
  -- 6 masking, docs/08 §4.5 domain policies).
  published_role  ENUM('DIRECTOR','PRINCIPAL','TEACHER','ACCOUNTANT','ADMIN') NOT NULL,
  published_perms JSON          NOT NULL
    COMMENT 'Publisher''s token perms[] at publish time (docs/08 §4.5) -- the MCP call context an unattended run signs with never exceeds what the publisher themselves could see.',
  published_by    VARCHAR(128)  NOT NULL,
  published_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_version (agent_id, version),
  CONSTRAINT fk_agent_version_agent FOREIGN KEY (agent_id) REFERENCES agents (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Append-only published versions of an agent''s graph (ADR-022). Runs pin one row here, never the mutable agents.current_version.';

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id           VARCHAR(64)     NOT NULL,
  agent_id         VARCHAR(64)     NOT NULL,
  agent_version_id BIGINT UNSIGNED NOT NULL,
  school_id        VARCHAR(128)    NOT NULL,

  -- Which record this run is FOR, e.g. {"student_id":"...","consecutive_days":3}
  -- -- docs/07 §3: "one RUN per record". Never a school-DB foreign key; this is
  -- an opaque snapshot taken at trigger-evaluation time, not a live reference.
  record_ref       JSON            NOT NULL,

  -- Auto-derived agent+node+record+date key (docs/07 §3, ADR-025). The UNIQUE
  -- constraint below is the dedup guardrail as a database mechanism, not just
  -- application discipline -- see header note.
  dedup_key        VARCHAR(255)    NOT NULL,

  status           ENUM('running','waiting','completed','failed') NOT NULL DEFAULT 'running',
  current_node_id  VARCHAR(128)    NULL COMMENT 'Where a waiting/failed run paused; NULL once completed.',

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
  COMMENT='One row per matched record per trigger firing (ADR-022). The persisted state machine''s top-level record.';

CREATE TABLE IF NOT EXISTS run_steps (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id      VARCHAR(64)     NOT NULL,
  node_id     VARCHAR(128)    NOT NULL,
  status      ENUM('pending','running','succeeded','failed','skipped') NOT NULL DEFAULT 'pending',

  -- Per-node input/output (docs/07 §3: "per-node input/output/status"), so a
  -- run can be replayed on the flowchart after the fact (docs/07 §6).
  payload_in  JSON            NULL,
  payload_out JSON            NULL,

  -- Structured guardrail/provider outcome, not a thrown error (CODING_GUIDELINES
  -- §11: "guardrail violations are structured, logged outcomes -- not throws
  -- that kill the run loop"). NULL on success.
  error       VARCHAR(255)    NULL,

  ts          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  CONSTRAINT fk_run_step_run FOREIGN KEY (run_id) REFERENCES agent_runs (run_id)
    ON DELETE CASCADE,
  INDEX idx_run_steps_run (run_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Per-node execution trace for a run (ADR-022). What "replay this run" reads.';

CREATE TABLE IF NOT EXISTS message_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id        VARCHAR(64)     NOT NULL,
  run_step_id   BIGINT UNSIGNED NOT NULL,
  school_id     VARCHAR(128)    NOT NULL,

  channel       ENUM('email','sms','whatsapp') NOT NULL,
  template_id   VARCHAR(128)    NULL COMMENT 'Approved template referenced (ADR-024); NULL only for non-templated channels, if any are ever added.',

  -- Contact PII -- see header note. Never written to operational logs.
  recipient     VARCHAR(255)    NOT NULL,

  status        ENUM('sent','failed','skipped_dedup','skipped_quiet_hours','skipped_cap','skipped_guardrail')
                NOT NULL,
  provider_ref  VARCHAR(255)    NULL COMMENT 'BSP/SMTP message id, for delivery-status follow-up.',
  error         VARCHAR(255)    NULL COMMENT 'Provider error, translated to plain language (mirrors ADR-017''s billing-error rule).',

  sent_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  CONSTRAINT fk_message_log_run FOREIGN KEY (run_id) REFERENCES agent_runs (run_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_message_log_step FOREIGN KEY (run_step_id) REFERENCES run_steps (id)
    ON DELETE CASCADE,
  -- Daily-cap guardrail (ADR-025) counts per school per day; CSV export
  -- (docs/07 §6) lists per school in time order.
  INDEX idx_message_log_school_day (school_id, sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Per-message send record (ADR-022/025). Contact PII -- see header note.';
