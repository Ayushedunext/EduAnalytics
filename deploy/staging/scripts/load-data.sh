#!/usr/bin/env bash
#
# Load the school-data extract into the staging MySQL container.
#
#     bash deploy/staging/scripts/load-data.sh ~/ai_analysis-staging.sql.gz
#
# Run on the staging host, after `docker compose up -d mysql` has brought the
# database up healthy at least once (that first boot is what creates the
# databases and the two users -- see mysql-init/).
#
# Safe to re-run: mysqldump output begins with DROP TABLE IF EXISTS for each
# table, so a second load replaces the data rather than duplicating it. It is
# not incremental, and it is not fast -- expect several minutes for ~1 GB.

set -euo pipefail

dump="${1:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_file="${here}/../docker-compose.yml"
env_file="${here}/../.env"

if [[ -z "${dump}" ]]; then
  echo "usage: $0 <path-to-ai_analysis-staging.sql.gz>" >&2
  exit 1
fi

if [[ ! -f "${dump}" ]]; then
  echo "error: ${dump} not found" >&2
  exit 1
fi

if [[ ! -f "${env_file}" ]]; then
  echo "error: ${env_file} not found -- see deploy/staging/README.md" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "${env_file}"
set +a

: "${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD is not set in deploy/staging/.env}"
school_db="${SCHOOL_DB_NAME:-ai_analysis}"

compose() { docker compose -f "${compose_file}" "$@"; }

# A container that is merely running is not a container that can answer a
# query: MySQL accepts connections some time before it finishes crash recovery
# and buffer-pool warmup. Loading into it during that window fails partway and
# leaves half a database, which then looks like a bad dump file.
echo "Waiting for MySQL to report healthy..."
for _ in $(seq 1 60); do
  status="$(compose ps --format '{{.Health}}' mysql 2>/dev/null || true)"
  [[ "${status}" == "healthy" ]] && break
  sleep 5
done
if [[ "${status:-}" != "healthy" ]]; then
  echo "error: mysql is not healthy. Check: docker compose -f ${compose_file} logs mysql" >&2
  exit 1
fi

echo "Loading ${dump} into ${school_db}..."
echo "(~1 GB; several minutes. Do not interrupt -- a partial load looks like a complete one.)"

# The dump is decompressed on THIS side of the pipe and streamed in over stdin,
# so the file never has to be copied into the container and no temporary copy of
# real school data is left inside it.
#
# Root, not the analytics_ro user: loading creates and writes tables, and
# analytics_ro holds SELECT and only SELECT. That asymmetry is the point of
# Invariant 3 -- the credential the application uses cannot perform this
# operation, and this operation is not something the application ever does.
#
# `--protocol=socket` inside the container avoids the localhost/TCP ambiguity;
# MYSQL_PWD keeps the password out of the process table, as in export-data.sh.
gzip -dc "${dump}" \
  | compose exec -T \
      -e MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" \
      mysql \
      mysql --protocol=socket -uroot --default-character-set=utf8mb4

echo
echo "Verifying..."
compose exec -T -e MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" mysql \
  mysql --protocol=socket -uroot -N -e "
    SELECT CONCAT(RPAD(table_name, 34, ' '), LPAD(FORMAT(table_rows, 0), 12, ' '), ' rows')
    FROM information_schema.tables
    WHERE table_schema = '${school_db}'
    ORDER BY (data_length + index_length) DESC;"

# The privilege grant is re-asserted rather than assumed. mysql-init/ runs only
# on the first boot of an empty volume, and a dump restored later can introduce
# tables that did not exist when the grant was made. A database-level GRANT
# covers new tables automatically -- this line exists to make that visible and
# to fail loudly if someone has since changed it.
compose exec -T -e MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" mysql \
  mysql --protocol=socket -uroot -e "
    GRANT SELECT ON \`${school_db}\`.* TO '${SCHOOL_DB_USER:-analytics_ro}'@'%';
    FLUSH PRIVILEGES;"

cat <<NOTE

Loaded. Bring the rest of the stack up:

  docker compose -f ${compose_file} up -d

Then delete the dump from this host -- it is real student and guardian data,
and there is no reason for a second copy of it to sit in a home directory:

  shred -u ${dump}    # or: rm ${dump}
NOTE
