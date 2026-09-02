#!/usr/bin/env bash
#
# Export the school-data extract, ON THE MACHINE THAT HAS IT.
#
# Run this where `ai_analysis` currently lives -- the development machine whose
# MySQL holds the restored ERP dumps -- and copy the result to the staging host.
#
#     bash deploy/staging/scripts/export-data.sh
#     scp dumps/ai_analysis-staging.sql.gz  staging-host:~/
#
# It reads the source credentials from the repository-root .env, the same file
# the local services use, so there is nothing to type twice and no second place
# for a password to live.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHAT IS IN THIS FILE
#
# Real school data: roughly 242,000 students with names and guardian contact
# details, 1.7 million fee-collection rows, and staff records. Not a synthetic
# fixture. Everything that is true of the production extract is true of this
# file, and it is about to be copied over the network onto a machine reachable
# from the internet.
#
# That was a deliberate decision for this environment, taken with the
# alternative (an anonymised copy) on the table. It carries three obligations
# that are cheap now and expensive later:
#
#   * the staging host's disk is as sensitive as the source machine's;
#   * the transfer goes over scp/rsync, never a file-sharing link or email;
#   * this file is deleted from both the source and the staging host once
#     loaded -- see the end of load-data.sh.
#
# If that ever stops being acceptable, the change is to anonymise names, phone
# numbers, emails and addresses after the dump and before the copy. Fee amounts,
# dates and counts must be left exactly as they are, or the dashboards stop
# demonstrating anything real.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
env_file="${repo_root}/.env"

if [[ ! -f "${env_file}" ]]; then
  echo "error: ${env_file} not found. This script runs on the machine that has the data." >&2
  exit 1
fi

# `set -a` exports everything the file defines, so mysqldump's own MYSQL_PWD
# lookup and the variables below both see it. Scoped tightly and turned off
# again immediately.
set -a
# shellcheck disable=SC1090
. "${env_file}"
set +a

: "${SCHOOL_DB_USER:?SCHOOL_DB_USER is not set in .env}"
: "${SCHOOL_DB_PASSWORD:?SCHOOL_DB_PASSWORD is not set in .env}"

source_host="${PLATFORM_DB_HOST:-127.0.0.1}"
source_port="${PLATFORM_DB_PORT:-3306}"
school_db="${SCHOOL_DB_NAME:-ai_analysis}"
out_dir="${repo_root}/dumps"
out_file="${out_dir}/ai_analysis-staging.sql.gz"

mkdir -p "${out_dir}"

echo "Exporting ${school_db} from ${source_host}:${source_port}"
echo "This is ~1 GB uncompressed and takes a few minutes."

# MYSQL_PWD rather than -p"$PASSWORD": a password in argv is visible in the
# process table to every user on the machine for the whole duration of the dump.
#
# --single-transaction  a consistent snapshot without locking the tables, so
#                       this can run against a database somebody else is using.
# --quick               stream rows instead of buffering a 1.7M-row table in RAM.
# --no-tablespaces      the dumping user has SELECT and nothing else; without
#                       this, mysqldump asks for PROCESS privilege and fails.
# --set-gtid-purged=OFF the dump is restored into an unrelated server, and GTID
#                       state from the source makes that restore fail.
MYSQL_PWD="${SCHOOL_DB_PASSWORD}" mysqldump \
  --host="${source_host}" \
  --port="${source_port}" \
  --user="${SCHOOL_DB_USER}" \
  --single-transaction \
  --quick \
  --no-tablespaces \
  --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  --databases "${school_db}" \
  | gzip -6 > "${out_file}"

# `set -o pipefail` is on, so a mysqldump failure has already aborted the script
# rather than leaving a truncated file that gzip happily compressed.

size="$(du -h "${out_file}" | cut -f1)"

cat <<NOTE

Wrote ${out_file}  (${size})

Copy it to the staging host and load it:

  scp ${out_file} YOUR-HOST:~/
  ssh YOUR-HOST
  cd /path/to/EduAnalytics
  bash deploy/staging/scripts/load-data.sh ~/ai_analysis-staging.sql.gz

Then delete this local copy -- it is real student and guardian data:

  rm ${out_file}
NOTE
