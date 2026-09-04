#!/usr/bin/env bash
# Health-gated deploy. Rollback: deploy.sh "$(cat /opt/axentrio/<env>-previous-sha)" <file> <service>
#
# One lock for the whole compose project. Staging and dev share Caddy, Postgres,
# and compose.nonprod.yml; CI must not run two deploys at once, and this flock
# also serializes a manual SSH deploy against Actions.
set -euo pipefail

usage() {
  echo "Usage: deploy.sh <TAG> <compose-file> [service]" >&2
  exit 1
}

ARG_TAG=${1:-}
FILE=${2:-}
SERVICE=${3:-}

[[ -n "$ARG_TAG" && -n "$FILE" ]] || usage

ROOT=/opt/axentrio
HOST_ENV="${ROOT}/.env"
SYS_ENV="${ROOT}/host.env"
cd "$ROOT"

if [[ ! -f "$FILE" ]]; then
  echo "compose file not found: $FILE" >&2
  exit 1
fi
if [[ ! -f "$HOST_ENV" ]]; then
  echo "missing project env file: $HOST_ENV" >&2
  exit 1
fi

exec 9>"${ROOT}/deploy.lock"
if ! flock -w 600 9; then
  echo "timed out waiting for ${ROOT}/deploy.lock" >&2
  exit 1
fi

if [[ -f "$SYS_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SYS_ENV"
  set +a
fi

# Nonprod Caddy is shared. Only staging-api reloads it (CI rsyncs Caddyfile
# from the staging job). A dev-api deploy must not recreate Caddy.
APPLY_CADDY=0
case "$SERVICE" in
  "" | api)
    SERVICE=api
    ENV_NAME=prod
    TAG=$ARG_TAG
    TAG_PREFIX=sha-
    DEPS=(redis)
    AFTER=(redis clamav n8n-db n8n)
    CADDYFILE=Caddyfile.prod
    APPLY_CADDY=1
    ;;
  staging-api)
    ENV_NAME=staging
    STAGING_TAG=$ARG_TAG
    TAG_PREFIX=sha-
    DEPS=(postgres staging-redis)
    AFTER=(postgres staging-redis)
    CADDYFILE=Caddyfile.nonprod
    APPLY_CADDY=1
    ;;
  dev-api)
    ENV_NAME=dev
    DEV_TAG=$ARG_TAG
    TAG_PREFIX=dev-
    DEPS=(postgres dev-redis)
    AFTER=(postgres dev-redis)
    CADDYFILE=
    ;;
  *)
    echo "unknown service: $SERVICE" >&2
    exit 1
    ;;
esac

upsert_env() {
  local file="$1" key="$2" value="$3"
  local tmp
  tmp=$(mktemp)
  touch "$file"
  grep -vE "^${key}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$file"
}

mkdir -p "$(dirname "$SYS_ENV")"
touch "$SYS_ENV"
[[ -n "${TAG:-}" ]] && upsert_env "$SYS_ENV" TAG "$TAG"
[[ -n "${STAGING_TAG:-}" ]] && upsert_env "$SYS_ENV" STAGING_TAG "$STAGING_TAG"
[[ -n "${DEV_TAG:-}" ]] && upsert_env "$SYS_ENV" DEV_TAG "$DEV_TAG"

export TAG="${TAG:-}"
export STAGING_TAG="${STAGING_TAG:-}"
export DEV_TAG="${DEV_TAG:-}"

COMPOSE=(docker compose --env-file "$HOST_ENV" -f "$FILE")

expected="${ARG_TAG#sha-}"
expected="${expected#dev-}"

pull_services=("$SERVICE" "${DEPS[@]}" "${AFTER[@]}")
if [[ "$APPLY_CADDY" == 1 ]]; then
  pull_services+=(caddy)
fi
"${COMPOSE[@]}" pull "${pull_services[@]}"
"${COMPOSE[@]}" up -d --wait "${DEPS[@]}"
"${COMPOSE[@]}" up -d --no-deps --wait "$SERVICE"

commit=""
deadline=$((SECONDS + 90))
while (( SECONDS < deadline )); do
  body=$("${COMPOSE[@]}" exec -T "$SERVICE" curl -sf http://localhost:3000/health || true)
  if [[ -n "$body" ]]; then
    commit=$(printf '%s' "$body" | jq -r '.commit // empty')
    if [[ "$commit" == "$expected" ]]; then
      break
    fi
  fi
  sleep 2
done

if [[ "$commit" != "$expected" ]]; then
  echo "health commit mismatch: got ${commit:-none} want ${expected}" >&2
  exit 1
fi

for s in "${AFTER[@]}"; do
  "${COMPOSE[@]}" up -d --no-deps "$s"
done

if [[ "$APPLY_CADDY" == 1 ]]; then
  # Reload only when the Caddyfile differs from the last APPLIED config.
  # Comparing host file vs in-container file is useless: the bind mount makes
  # them always equal even while the caddy process still runs an old config.
  applied_hash_path="${ROOT}/.${CADDYFILE}.applied.sha256"
  want_hash=$(sha256sum "${ROOT}/${CADDYFILE}" | awk '{print $1}')
  have_hash=$(cat "$applied_hash_path" 2>/dev/null || true)
  "${COMPOSE[@]}" up -d --no-deps caddy
  if [[ "$want_hash" == "$have_hash" ]]; then
    echo "caddy config unchanged; skip reload"
  else
    if ! "${COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
      echo "caddy reload failed; recreating container" >&2
      "${COMPOSE[@]}" up -d --no-deps --force-recreate caddy
    fi
    printf '%s\n' "$want_hash" > "$applied_hash_path"
  fi
fi

if ! systemctl is-enabled axentrio.service >/dev/null 2>&1; then
  sudo systemctl enable axentrio.service
fi

current_path="${ROOT}/${ENV_NAME}-current-sha"
previous_path="${ROOT}/${ENV_NAME}-previous-sha"
if [[ -f "$current_path" ]]; then
  mv -f "$current_path" "$previous_path"
fi
printf '%s\n' "$ARG_TAG" > "$current_path"

mapfile -t tags < <(docker images ghcr.io/axentrio/axentrio-api --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | awk -F'\t' '{print $2}')
keep=5
count=0
for t in "${tags[@]}"; do
  [[ -z "$t" || "$t" == "<none>" || "$t" == "latest" ]] && continue
  [[ "$t" == ${TAG_PREFIX}* ]] || continue
  count=$((count + 1))
  if (( count > keep )); then
    docker rmi "ghcr.io/axentrio/axentrio-api:${t}" || true
  fi
done
