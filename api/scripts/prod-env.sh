#!/usr/bin/env bash
# Replacement for `railway run`: run a command with the prod VPS environment.
#
# Usage:
#   PROD_SSH_HOST=deploy@<prod-ip> api/scripts/prod-env.sh npx tsx scripts/smoke-booking-day-part.ts
set -euo pipefail

: "${PROD_SSH_HOST:?set PROD_SSH_HOST=deploy@<prod-ip>}"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
ssh "$PROD_SSH_HOST" 'cat /opt/axentrio/.env' > "$tmp"

set -a
# shellcheck disable=SC1090
. "$tmp"
set +a

# `redis` and `clamav` resolve only on the box's compose network. Point Redis at
# a local instance and disable scanning so a local run degrades instead of
# hanging on an unresolvable host.
export REDIS_URL="${LOCAL_REDIS_URL:-redis://127.0.0.1:6379}"
export CLAMAV_HOST=""

exec "$@"
