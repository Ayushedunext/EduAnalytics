-- Local development seed: the LPS society (`lpsho`), from the 2026-09-15 extract.
--
-- WHY A THIRD ORG EXISTS
--
-- The extract delivered on 2026-09-15 (ai_analysis_20260915-114354.sql) is the
-- first to carry the admission funnel -- students_admission_data_set and its
-- four stage tables -- and it carries them for 37 schools that are NOT the
-- three St Marks schools or the two training schools every other seed and
-- identity here is built around. Those five have no candidates at all, so the
-- Admissions Funnel report and the Dashboard's funnel card could be built
-- against the real schema but not SEEN against it (the same reasoning that
-- registered premium_test for attendance, premium-test.sql).
--
-- This registers the one society in that extract with the fullest funnel:
-- `lpsho`, ten schools, 8,516 candidates for 2026-27 of whom 3,219 were
-- admitted. It is a development seed and says so: nothing produced from it has
-- been validated against the ERP, and the society's OTHER tables are absent
-- from the extract -- no roll (students_data_set), no fee book, no attendance,
-- no staff -- so every card but the funnel and homework ones draws empty for
-- this scope. That is the true state of the extract, not a defect of the seed.
--
-- NAMES ARE CODES
--
-- schools_data_set arrived empty in this extract, so there is no ERP name for
-- any of these schools. The code IS the name here rather than an invented one:
-- a label somebody made up would read as a claim about a real school. The day
-- the mapping arrives, the names come from the registry sync (ADR-005).
--
-- Same consolidated-extract mapping as stmarks.sql: one database, tenant
-- isolation by the bound `school_db` filter, `tenant_key` stored explicitly.

INSERT INTO org_registry (org_id, org_name, school_count) VALUES
  ('lpsho', 'LPS Society (development, Sep-15 extract)', 10)
ON DUPLICATE KEY UPDATE org_name = VALUES(org_name), school_count = VALUES(school_count);

INSERT INTO tenant_registry
  (school_id, org_id, school_name, region, status, replica_host, db_name, secret_arn, schema_version, tenant_key)
VALUES
  ('lpsahr',   'lpsho', 'lpsahr',   'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'lpsahr'),
  ('lpsansal', 'lpsho', 'lpsansal', 'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'lpsansal'),
  ('lpseld',   'lpsho', 'lpseld',   'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'lpseld'),
  ('lpsjkp',   'lpsho', 'lpsjkp',   'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'lpsjkp'),
  ('lpspgr',   'lpsho', 'lpspgr',   'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'lpspgr'),
  ('lpsscity', 'lpsho', 'lpsscity', 'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'lpsscity'),
  ('lpssecb',  'lpsho', 'lpssecb',  'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'lpssecb'),
  ('lpssecc',  'lpsho', 'lpssecc',  'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'lpssecc'),
  ('lpssecd',  'lpsho', 'lpssecd',  'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'lpssecd'),
  ('lpsseci',  'lpsho', 'lpsseci',  'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'lpsseci')
ON DUPLICATE KEY UPDATE
  school_name = VALUES(school_name),
  status      = VALUES(status),
  db_name     = VALUES(db_name),
  tenant_key  = VALUES(tenant_key);

-- Channels: not connected, for the reason stmarks.sql gives.
INSERT INTO school_channels (school_id, channel, status)
SELECT t.school_id, c.channel, 'not_connected'
FROM tenant_registry t
JOIN (SELECT 'email' AS channel UNION ALL SELECT 'sms' UNION ALL SELECT 'whatsapp') c
WHERE t.org_id = 'lpsho'
ON DUPLICATE KEY UPDATE school_channels.status = school_channels.status;
