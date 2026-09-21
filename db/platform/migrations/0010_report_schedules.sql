-- 0010_report_schedules.sql
--
-- Scheduled report delivery (ADR-037), on the transport ADR-035 configured.
-- Contract: docs/06 §7, docs/10 §2 ("Schedule"), docs/08 §7 (every delivery is
-- an audited chokepoint event).
--
-- -- Why a schedule stores an AUTHORITY and not just a rule -------------------
-- Invariant 2 constrains every query to the `school_ids` in a verified launch
-- token, and a 07:30 delivery has no token. There are only three places the
-- scope of an unattended read can come from: the ERP at send time (forbidden --
-- Invariant 1, ADR-005), the client (forbidden -- CODING_GUIDELINES §8), or a
-- set captured from a verified token when a human was present. This table
-- captures it, exactly as `agents.school_ids` and
-- `report_definitions.school_scope` do, and the delivery re-intersects it
-- against the org's currently servable schools on every firing. A schedule is
-- therefore a REQUEST with a pinned authority that is re-checked every time it
-- is honoured -- never a standing permission.
--
-- `created_role`/`created_perms` pin the same thing for masking and drill-leaf
-- policy, mirroring `agent_versions.published_role`/`published_perms`: an
-- unattended run must never read with more authority than the person who asked
-- for it held (docs/04 rail 6, docs/08 §4.5).
--
-- -- Why schedule_deliveries is its own table ---------------------------------
-- `message_log` is the obvious candidate and is the wrong one: it foreign-keys
-- to `agent_runs`, and a scheduled report is not an agent run. Reusing it would
-- force every delivery to fabricate a run row to satisfy that key, corrupting
-- the one table that answers "which agent messaged this parent". Two tables,
-- one audit posture.
--
-- -- PII note ------------------------------------------------------------------
-- `recipient` on both tables is an email address -- row-level PII in the
-- platform database, the same posture `message_log.recipient` carries
-- (0009_agents.sql). These are the audit trail FOR deliveries, so they are
-- exempt from CODING_GUIDELINES §13's log-forbidden-values rule in the same way
-- `audit_log` is -- and for the same reason must never be written to
-- stdout/operational logging, only to these tables.

CREATE TABLE IF NOT EXISTS report_schedules (
  id              VARCHAR(64)  NOT NULL,
  org_id          VARCHAR(128) NOT NULL,

  -- WHICH report re-runs. `report_kind` decides which catalog resolves the id:
  -- a served predefined dashboard, or the owner's own report_definitions row.
  -- A reader schedules what they read, and half of what they read is their own
  -- (docs/06 §3) -- offering only predefined dashboards would mean the report
  -- someone built for exactly this purpose is the one report they cannot have
  -- delivered.
  report_id       VARCHAR(128) NOT NULL,
  report_kind     ENUM('predefined','custom') NOT NULL DEFAULT 'predefined',

  -- The title as it read when the schedule was made. A LABEL, never the source
  -- of truth: the delivery re-reads the real title from the catalog, so a
  -- renamed report does not send under its old name. Kept so a paused or
  -- broken schedule can still say what it was for.
  report_title    VARCHAR(255) NOT NULL,

  -- The captured scope -- see header. Intersected against the creator's token
  -- at save time, re-intersected against the servable set at send time.
  school_ids      JSON         NOT NULL,

  -- WHEN. Weekday numbers as `Date#getDay` numbers them (0 = Sunday), so the
  -- SPA, this row and the cron expression the queue is given all count days the
  -- same way. `time_of_day` is 24-hour HH:MM.
  days            JSON         NOT NULL,
  time_of_day     CHAR(5)      NOT NULL,

  -- The SCHOOL's clock, not the reader's browser's. A trust director in another
  -- timezone who asks for 07:30 means the school's 07:30, because that is when
  -- the school day the report describes actually starts (docs/10 §2, and the
  -- note the Schedule form prints under every time field).
  tz              VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata',

  -- WHERE. Only 'email' can be delivered today (ADR-035 gave email a transport;
  -- items 4/8 still gate the rest), but the column carries 'whatsapp' because
  -- the screen shows the option and refuses it in the open rather than hiding
  -- it (docs/10 §3, locked is not hidden). SMS is absent on purpose and not as
  -- an oversight: a report is a PDF, and there is no SMS in which a PDF arrives.
  channel         ENUM('email','whatsapp') NOT NULL DEFAULT 'email',
  recipient       VARCHAR(255) NOT NULL COMMENT 'Contact PII -- see header note.',

  -- A pause is not a delete: a paused schedule stays on the list, stated, and
  -- its repeatable queue job is removed until it is resumed.
  status          ENUM('active','paused') NOT NULL DEFAULT 'active',

  -- The pinned authority -- see header. Snapshotted from the creator's verified
  -- token, re-pinned whenever the schedule is edited.
  created_role    ENUM('DIRECTOR','PRINCIPAL','TEACHER','ACCOUNTANT','ADMIN') NOT NULL,
  created_perms   JSON         NOT NULL
    COMMENT 'Creator''s token perms[] at save time (docs/08 §4.5) -- an unattended delivery never reads beyond what the creator themselves could see.',
  created_by      VARCHAR(128) NOT NULL,

  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP    NULL,

  PRIMARY KEY (id),
  CONSTRAINT fk_schedule_org FOREIGN KEY (org_id) REFERENCES org_registry (org_id)
    ON DELETE CASCADE,
  INDEX idx_schedules_org (org_id, deleted_at),
  -- "Whose schedules are these" is the list query every time the screen opens.
  INDEX idx_schedules_owner (org_id, created_by, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Scheduled report deliveries (ADR-037). Stores a request and a pinned authority, never a rendered report.';

CREATE TABLE IF NOT EXISTS schedule_deliveries (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  schedule_id   VARCHAR(64)     NOT NULL,
  org_id        VARCHAR(128)    NOT NULL,

  -- The scope actually USED, after re-validation -- not the scope stored on the
  -- schedule. The two differ precisely when a school left the org or lost its
  -- entitlement between saving and sending, which is the case this column
  -- exists to make visible rather than silent.
  school_ids    JSON            NOT NULL,

  channel       ENUM('email','whatsapp') NOT NULL,
  recipient     VARCHAR(255)    NOT NULL COMMENT 'Contact PII -- see header note.',

  -- Whether the clock or a person started this. "Send now" runs the identical
  -- path (ADR-037), so the only honest difference between the two is recorded
  -- here rather than expressed as a separate, divergent code path.
  trigger_kind  ENUM('schedule','manual') NOT NULL DEFAULT 'schedule',

  -- Every skip names its own reason, because "not sent" with no reason is the
  -- state a school admin cannot act on (CODING_GUIDELINES §10, fail loud).
  status        ENUM('sent','failed','skipped_scope_empty','skipped_channel_not_connected','skipped_paused')
                NOT NULL,
  provider_ref  VARCHAR(255)    NULL COMMENT 'The transport''s message id (ADR-035). Never a sandbox- prefix: this path really delivers.',
  error         VARCHAR(255)    NULL COMMENT 'Provider or render failure in plain language (mirrors message_log.error).',

  -- How long the whole delivery took -- render dominates it. Recorded because
  -- ADR-037's accepted trade-off is that scheduled renders compete with
  -- interactive exports for one browser, and that is a claim worth being able
  -- to check against data rather than re-arguing.
  duration_ms   INT UNSIGNED    NULL,
  sent_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  CONSTRAINT fk_delivery_schedule FOREIGN KEY (schedule_id) REFERENCES report_schedules (id)
    ON DELETE CASCADE,
  -- "What happened the last few times" is what a row on the Schedule screen
  -- shows, and the only query this table serves interactively.
  INDEX idx_deliveries_schedule (schedule_id, sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='One row per delivery attempt (ADR-037). The audit trail for scheduled reports -- the counterpart of message_log for agents.';
