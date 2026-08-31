#!/usr/bin/env bash
# Render cloud-init user data for one role. Do not paste cloud-init.yml raw.
set -euo pipefail

role=${1:-}
root=$(cd "$(dirname "$0")" && pwd)
src="${root}/cloud-init.yml"

case "$role" in
  prod)
    compose=compose.prod.yml
    host=axentrio-prod
    ;;
  nonprod)
    compose=compose.nonprod.yml
    host=axentrio-nonprod
    ;;
  *)
    echo "Usage: render-user-data.sh prod|nonprod" >&2
    exit 1
    ;;
esac

if ! grep -q '__AXENTRIO_COMPOSE_FILE__' "$src"; then
  echo "cloud-init.yml missing __AXENTRIO_COMPOSE_FILE__ sentinel" >&2
  exit 1
fi

sed \
  -e "s/__AXENTRIO_COMPOSE_FILE__/${compose}/g" \
  -e "s/__AXENTRIO_HOSTNAME__/${host}/g" \
  "$src"
