#!/usr/bin/env bash
# Run the API against the local Docker Postgres/Redis + the dev Clerk instance.
# Local overrides + secrets live in api/.env.local (gitignored) and are exported
# here so they win over the prod-pointed .env (dotenv won't override set vars).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env.local ]; then
  echo "Missing api/.env.local — create it from the README/Option-B notes." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env.local
set +a
exec npm run dev
