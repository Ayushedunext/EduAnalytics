#!/usr/bin/env bash
#
# Generate the secrets deploy/staging/.env needs, and fill them in.
#
# Run once, on the staging host, after copying .env.staging.example to .env:
#
#     cp deploy/staging/.env.staging.example deploy/staging/.env
#     bash deploy/staging/scripts/make-secrets.sh
#
# Then edit .env by hand for the things a script cannot know: STAGING_HOSTNAME
# and ACME_EMAIL.
#
# WHY EACH SECRET IS SEPARATE
#
# Five values are generated, not one reused five times. .env.example in the
# repository root explains the reasoning for three of them and it is worth
# repeating: the session cookie is ours, the MCP call context is between two of
# our own services, and the BYOK master key guards someone else's billable
# Anthropic credential. They have different lifetimes and different audiences,
# and rotating one must never force rotating the others. A single shared secret
# would make every rotation a full outage and every compromise a total one.
#
# Only missing or placeholder values are filled. Re-running this does not
# rotate a working environment out from under itself.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${here}/../.env"

if [[ ! -f "${env_file}" ]]; then
  echo "error: ${env_file} does not exist." >&2
  echo "       cp deploy/staging/.env.staging.example deploy/staging/.env" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl is required." >&2
  exit 1
fi

# Passwords and signing secrets: url-safe base64, so nothing in them needs
# quoting in a .env file, a shell command or a MySQL connection string. A stray
# '$' or '#' in a generated password produces a failure that looks like a wrong
# password rather than like a quoting bug, and that is a long afternoon.
random_token() {
  openssl rand -base64 33 | tr '+/' '-_' | tr -d '=\n'
}

# ADR-017 is specific: base64 of exactly 32 bytes, because it is an AES-256 key
# rather than an opaque string. Generated differently on purpose.
random_aes_key() {
  openssl rand -base64 32
}

set_if_empty() {
  local key="$1" value="$2" current
  current="$(sed -n "s/^${key}=//p" "${env_file}" | head -1)"

  if [[ -n "${current}" && "${current}" != CHANGE_ME* ]]; then
    printf '  %-32s kept (already set)\n' "${key}"
    return
  fi

  if grep -q "^${key}=" "${env_file}"; then
    # A '|' delimiter because base64 contains '/', and an in-place edit through
    # a temp file because `sed -i` differs between GNU and BSD.
    sed "s|^${key}=.*|${key}=${value}|" "${env_file}" > "${env_file}.tmp"
    mv "${env_file}.tmp" "${env_file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${env_file}"
  fi
  printf '  %-32s generated\n' "${key}"
}

echo "Filling secrets in ${env_file}"

set_if_empty MYSQL_ROOT_PASSWORD   "$(random_token)"
set_if_empty PLATFORM_DB_PASSWORD  "$(random_token)"
set_if_empty SCHOOL_DB_PASSWORD    "$(random_token)"
set_if_empty SESSION_SECRET        "$(random_token)"
set_if_empty MCP_CONTEXT_SECRET    "$(random_token)"
set_if_empty AI_KEY_ENCRYPTION_KEY "$(random_aes_key)"

echo
echo "Demo account passwords:"
for account in DIRECTOR PRINCIPAL_MB PRINCIPAL_J PRINCIPAL_TRAINING ACCOUNTANT_MB ADMIN; do
  set_if_empty "ERP_STUB_PASSWORD_${account}" "$(random_token)"
done

# The file now contains every credential to the environment and a copy of the
# key that decrypts the org's Anthropic key. Owner-only is the least this
# deserves; the volume it sits on is a separate conversation.
chmod 600 "${env_file}"

cat <<'NOTE'

Done. Still to set by hand (this script cannot know them):

  STAGING_HOSTNAME   the DNS name pointing at this host, e.g. analytics-staging.example.com
  ACME_EMAIL         where Let's Encrypt sends certificate expiry warnings

Then, to read out the sign-in passwords to share with reviewers:

  grep ERP_STUB_PASSWORD deploy/staging/.env

Treat the rest of this file as production credentials. It is chmod 600 and
git-ignored; keep it that way, and do not paste it into a chat or a ticket.
NOTE
