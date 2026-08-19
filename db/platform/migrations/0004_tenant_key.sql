-- 0004_tenant_key.sql
--
-- Adds the row-level tenant discriminator to the registry. Contract: docs/02 §5.
--
-- The architecture assumes one database per school (docs/03 §1), and under that
-- model `db_name` IS the tenant boundary and this column stays NULL. The first
-- real ERP dataset does not work that way: `ai_analysis` consolidates an org's
-- schools into one database separated by a `school_db` column (option (a),
-- db/platform/seed/stmarks.sql). There, the isolation the database is not
-- providing has to be provided by the MCP server, and it needs to know what
-- value to bind.
--
-- Why a column rather than reusing `school_id`: in this dataset the two happen
-- to be equal, and that is a property of one extract, not a rule. Code that
-- assumed the equality would keep working right up until an ERP names them
-- differently, and would then query the wrong school and return a confident,
-- well-formatted, wrong answer -- the failure mode CODING_GUIDELINES §10 calls
-- the worst bug class in this system. Storing it explicitly makes the wrong
-- configuration visible instead of silent: a school whose schema version needs a
-- tenant_key and has none is refused by the MCP server, not guessed at.
--
-- NULL is the correct default: it means "this schema version isolates tenants by
-- database", which is what every school is expected to look like in production.

ALTER TABLE tenant_registry
  ADD COLUMN tenant_key VARCHAR(128) NULL
    COMMENT 'Row-level tenant discriminator, bound as a query parameter. NULL when db_name separates tenants (docs/02 §5).'
    AFTER schema_version;
