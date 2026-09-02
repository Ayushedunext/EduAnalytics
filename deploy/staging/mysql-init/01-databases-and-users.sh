#!/bin/bash
# Create the two databases and the two users this platform expects.
#
# Runs ONCE, on the first boot of an empty data volume -- that is how the MySQL
# image's entrypoint works. It does not run again on restart, and it does not
# run against a volume that already has data. Changing it therefore has no
# effect on a live staging box; to re-apply, remove the volume (which discards
# the loaded school data too) or run the statements by hand.
#
# The official image's MYSQL_DATABASE / MYSQL_USER variables can create exactly
# one database and one user, and this platform needs two of each with
# deliberately different privileges. Hence a script.

set -euo pipefail

: "${PLATFORM_DB_NAME:?PLATFORM_DB_NAME is required}"
: "${PLATFORM_DB_USER:?PLATFORM_DB_USER is required}"
: "${PLATFORM_DB_PASSWORD:?PLATFORM_DB_PASSWORD is required}"
: "${SCHOOL_DB_NAME:?SCHOOL_DB_NAME is required}"
: "${SCHOOL_DB_USER:?SCHOOL_DB_USER is required}"
: "${SCHOOL_DB_PASSWORD:?SCHOOL_DB_PASSWORD is required}"

# Passwords reach MySQL through a here-document on stdin, never as an argv
# element: anything on the command line of a container process is readable from
# `docker inspect` and the host's process table.
mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
-- ── The platform's own database ─────────────────────────────────────────────
-- Registry, audit log, launch nonces, custom report definitions, BYOK
-- ciphertext. This one is READ AND WRITTEN by the orchestrator, so its user
-- holds full rights over it and over nothing else.
CREATE DATABASE IF NOT EXISTS \`${PLATFORM_DB_NAME}\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS '${PLATFORM_DB_USER}'@'%' IDENTIFIED BY '${PLATFORM_DB_PASSWORD}';
ALTER USER '${PLATFORM_DB_USER}'@'%' IDENTIFIED BY '${PLATFORM_DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${PLATFORM_DB_NAME}\`.* TO '${PLATFORM_DB_USER}'@'%';

-- ── The school data plane ───────────────────────────────────────────────────
-- The restored ERP extract. Loaded by deploy/staging/scripts/load-data.sh.
CREATE DATABASE IF NOT EXISTS \`${SCHOOL_DB_NAME}\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- [MANDATORY] Invariant 3, docs/08 §3, ADR-008: the data plane is SELECT-only,
-- through a read-only database user. The AST validator in the MCP server
-- refuses a non-SELECT statement before it is sent; this GRANT is the second,
-- independent line that holds even if that code is wrong, bypassed, or someone
-- opens a connection with these credentials by hand.
--
-- SELECT and nothing else. Not INSERT "for the sync", not CREATE TEMPORARY
-- TABLE "for a complex report" -- each of those has been the first step in
-- turning a read replica into something a bug can write to.
CREATE USER IF NOT EXISTS '${SCHOOL_DB_USER}'@'%' IDENTIFIED BY '${SCHOOL_DB_PASSWORD}';
ALTER USER '${SCHOOL_DB_USER}'@'%' IDENTIFIED BY '${SCHOOL_DB_PASSWORD}';
GRANT SELECT ON \`${SCHOOL_DB_NAME}\`.* TO '${SCHOOL_DB_USER}'@'%';

FLUSH PRIVILEGES;
SQL

echo "[mysql-init] created ${PLATFORM_DB_NAME} (read-write) and ${SCHOOL_DB_NAME} (SELECT-only)"
