#!/usr/bin/env bash
# Installs CI-staged files from /opt/axentrio/incoming/<env>/ under the deploy
# lock, then hands off to deploy.sh (which takes the same lock itself).
# Staging is the only env that installs shared files (Caddyfile, compose,
# deploy.sh). Dev installs only its portal.
set -euo pipefail

ENV_NAME=${1:-}
ARG_TAG=${2:-}

if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "dev" ]]; then
  echo "Usage: apply-nonprod.sh staging|dev <tag>" >&2
  exit 1
fi
[[ -n "$ARG_TAG" ]] || { echo "missing tag" >&2; exit 1; }

ROOT=/opt/axentrio
INCOMING="${ROOT}/incoming/${ENV_NAME}"
cd "$ROOT"

if [[ ! -d "$INCOMING" ]]; then
  echo "missing ${INCOMING}; CI rsync did not run" >&2
  exit 1
fi

exec 9>"${ROOT}/deploy.lock"
if ! flock -w 600 9; then
  echo "timed out waiting for ${ROOT}/deploy.lock" >&2
  exit 1
fi

if [[ "$ENV_NAME" == "staging" ]]; then
  # Shared-file allowlist. Staging is the authoritative writer.
  install -m 644 "${INCOMING}/Caddyfile.nonprod"   "${ROOT}/Caddyfile.nonprod"
  install -m 644 "${INCOMING}/compose.nonprod.yml" "${ROOT}/compose.nonprod.yml"
  install -m 644 "${INCOMING}/postgres-init.sql"   "${ROOT}/postgres-init.sql"
  install -m 755 "${INCOMING}/deploy.sh"           "${ROOT}/deploy.sh"
  install -m 755 "${INCOMING}/apply-nonprod.sh"    "${ROOT}/apply-nonprod.sh"
fi

mkdir -p "${ROOT}/portal-${ENV_NAME}"
rsync -a --delete "${INCOMING}/portal/" "${ROOT}/portal-${ENV_NAME}/"

# Release before deploy.sh, which flocks the same file itself. Files are
# fully installed, so the gap exposes only coherent state.
flock -u 9
exec 9>&-

exec "${ROOT}/deploy.sh" "$ARG_TAG" compose.nonprod.yml "${ENV_NAME}-api"
