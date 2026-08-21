-- Local development seed: the Premium Test society.
--
-- WHY A SECOND ORG EXISTS AT ALL
--
-- The attendance extract delivered on 2026-08-21 carries rows for exactly one
-- school -- `training_edubac`, under the society `premium_test` -- and none at
-- all for the three St Marks schools every other seed and identity here is
-- built around. Attendance Analytics could therefore be built against the real
-- schema but not SEEN against it, and a dashboard nobody has looked at is not a
-- dashboard anyone should demo.
--
-- So this registers the org the attendance data actually belongs to. It is a
-- development seed and it is honest about what it is: `premium_test` is a
-- training/QA society of the ERP, its attendance is 49 student rows across 5
-- students and 32 dates, and no number produced from it has been validated
-- against anything. It exists to exercise the serving path end to end, not to
-- support a claim about a school.
--
-- TWO SCHOOLS, DELIBERATELY
--
--   training_edubac -- 3,014 students, 273 employees, and the only attendance
--                      rows in the extract.
--   training        -- 13,924 students, 600 employees, and NO attendance.
--
-- The second one is not padding. A school where nobody has marked the register
-- is the common case in a rollout, and it is the case a dashboard is most
-- likely to get wrong by rendering 0% attendance as though every child were
-- absent. Having one of each in the same scope means that path is exercised
-- every time someone opens the screen, instead of being a branch nobody sees
-- until a real school hits it.
--
-- NEITHER APPEARS IN `schools_data_set`
--
-- That table holds only the three St Marks rows, so the school names below are
-- written here rather than sourced from the ERP's own mapping the way
-- stmarks.sql could. They are labels for a development picker and are marked as
-- such; the day this org is real, the names come from the registry sync
-- (ADR-005) like everyone else's.

INSERT INTO org_registry (org_id, org_name, school_count) VALUES
  ('premium_test', 'Premium Test Society (development)', 2)
ON DUPLICATE KEY UPDATE org_name = VALUES(org_name), school_count = VALUES(school_count);

INSERT INTO tenant_registry
  (school_id, org_id, school_name, region, status, replica_host, db_name, secret_arn, schema_version, tenant_key)
VALUES
  ('training_edubac', 'premium_test', 'Edubac Training School', 'local', 'active',
   '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'training_edubac'),
  ('training', 'premium_test', 'Training School', 'local', 'active',
   '127.0.0.1', 'ai_analysis', 'env://SCHOOL_DB_CREDENTIALS', 'erp-v1', 'training')
ON DUPLICATE KEY UPDATE
  school_name = VALUES(school_name),
  status      = VALUES(status),
  db_name     = VALUES(db_name),
  tenant_key  = VALUES(tenant_key);

-- Not connected, for the same reason stmarks.sql gives: a channel row is a claim
-- that a school can send messages, and none of these can.

INSERT INTO school_channels (school_id, channel, status) VALUES
  ('training_edubac', 'email',    'not_connected'),
  ('training_edubac', 'sms',      'not_connected'),
  ('training_edubac', 'whatsapp', 'not_connected'),
  ('training',        'email',    'not_connected'),
  ('training',        'sms',      'not_connected'),
  ('training',        'whatsapp', 'not_connected')
ON DUPLICATE KEY UPDATE status = status;
