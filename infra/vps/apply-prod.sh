#!/usr/bin/env bash
# Installs CI-staged prod files from /opt/axentrio/incoming/prod/ under the
# deploy lock, then hands off to deploy.sh (which takes the same lock itself).
set -euo pipefail

ARG_TAG=${1:-}
[[ -n "$ARG_TAG" ]] || { echo "Usage: apply-prod.sh <tag>" >&2; exit 1; }

ROOT=/opt/axentrio
INCOMING="${ROOT}/incoming/prod"
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

install -m 644 "${INCOMING}/Caddyfile.prod"   "${ROOT}/Caddyfile.prod"
install -m 644 "${INCOMING}/compose.prod.yml" "${ROOT}/compose.prod.yml"
install -m 755 "${INCOMING}/deploy.sh"        "${ROOT}/deploy.sh"
install -m 755 "${INCOMING}/apply-prod.sh"    "${ROOT}/apply-prod.sh"

mkdir -p "${ROOT}/portal-prod"
rsync -a --delete "${INCOMING}/portal/" "${ROOT}/portal-prod/"

# Release before deploy.sh, which flocks the same file itself. Files are
# fully installed, so the gap exposes only coherent state.
flock -u 9
exec 9>&-

exec "${ROOT}/deploy.sh" "$ARG_TAG" compose.prod.yml api
