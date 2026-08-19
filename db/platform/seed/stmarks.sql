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

INSERT INTO org_registry (org_id, org_name, school_count) VALUES
  ('stmarks', 'St Marks Society', 3)
ON DUPLICATE KEY UPDATE org_name = VALUES(org_name), school_count = VALUES(school_count);

INSERT INTO tenant_registry
  (school_id, org_id, school_name, region, status, replica_host, db_name, secret_arn, schema_version)
VALUES
  ('stmarksg',  'stmarks', 'World School', 'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1'),
  ('stmarksj',  'stmarks', 'Janakpuri',    'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1'),
  ('stmarksmb', 'stmarks', 'Meera Bagh',   'local', 'active', '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1')
ON DUPLICATE KEY UPDATE
  school_name = VALUES(school_name),
  status      = VALUES(status),
  db_name     = VALUES(db_name);
