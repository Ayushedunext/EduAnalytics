-- Local development seed: the St Marks society.
--
-- In production these rows arrive from the ERP sync (ADR-005). Locally we write
-- them by hand, which is exactly the point of "the registry IS the
-- configuration" -- the resolution code cannot tell the difference.
--
-- Sourced from ai_analysis.schools_data_set, which is the ERP's own org/school
-- mapping ("society" is the ERP's term for what docs/00 calls an org).
--
-- TENANT MAPPING -- option (a), confirmed 2026-08-19:
--   ai_analysis is a CONSOLIDATED extract: all three schools live in one
--   database, distinguished by a school_db column. The architecture assumes one
--   database per school (docs/03 §1), so here every school_id maps to the same
--   db_name and tenant isolation is a bound `WHERE school_db = ?` rather than
--   physical database separation.
--
--   This is the weaker of the two isolation models and is a known deviation
--   (AUDIT_REPORT, open question on ai_analysis). It is contained entirely
--   inside the MCP server's tenant resolution and the vetted SQL: if production
--   turns out to use per-school databases, db_name changes and the WHERE clause
--   drops away. Nothing above the MCP layer is aware of the difference.
--
--   Note that school_id and the school_db filter value coincide here. That is a
--   convenience of this dataset, not a rule -- do not collapse the two concepts.
--   The filter value is therefore stored explicitly in `tenant_key` (migration
--   0004, docs/02 §5) rather than derived from school_id, so the day an ERP
--   names them differently the configuration changes and the code does not.

INSERT INTO org_registry (org_id, org_name, school_count) VALUES
  ('stmarks', 'St Marks Society', 3)
ON DUPLICATE KEY UPDATE org_name = VALUES(org_name), school_count = VALUES(school_count);

INSERT INTO tenant_registry
  (school_id, org_id, school_name, region, status, replica_host, db_name, secret_arn, schema_version, tenant_key)
VALUES
  ('stmarksg',  'stmarks', 'World School', 'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'stmarksg'),
  ('stmarksj',  'stmarks', 'Janakpuri',    'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'stmarksj'),
  ('stmarksmb', 'stmarks', 'Meera Bagh',   'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'stmarksmb')
ON DUPLICATE KEY UPDATE
  school_name = VALUES(school_name),
  status      = VALUES(status),
  db_name     = VALUES(db_name),
  tenant_key  = VALUES(tenant_key);

-- -- Messaging channels (migration 0005) ---------------------------------------
--
-- Seeded as NOT CONNECTED, and that is a decision rather than laziness.
--
-- The UX prototype shows all three rows Connected with plausible detail
-- ("Provider: MSG91 · Sender ID: SUNRIS"). Seeding that here would put a claim
-- on a real screen -- "this school can send WhatsApp" -- that is false, and a
-- Principal who reads it and builds a fee-reminder agent on top finds out at
-- the moment the messages do not arrive. It is the same reasoning that kept
-- synthetic attendance data out of Phase 1 (docs/11 §1): a demo number that
-- cannot be traced to something real becomes a trust problem, not a shortcut.
--
-- Not-connected is also the TRUE state: no DLT entity, no WABA and no SMTP host
-- has been registered for these schools, and the screen showing exactly that is
-- what tells someone the provisioning programme in docs/07 §4 has not started.

INSERT INTO school_channels (school_id, channel, status) VALUES
  ('stmarksg',  'email',    'not_connected'),
  ('stmarksg',  'sms',      'not_connected'),
  ('stmarksg',  'whatsapp', 'not_connected'),
  ('stmarksj',  'email',    'not_connected'),
  ('stmarksj',  'sms',      'not_connected'),
  ('stmarksj',  'whatsapp', 'not_connected'),
  ('stmarksmb', 'email',    'not_connected'),
  ('stmarksmb', 'sms',      'not_connected'),
  ('stmarksmb', 'whatsapp', 'not_connected')
ON DUPLICATE KEY UPDATE status = status;
