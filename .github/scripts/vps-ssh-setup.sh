#!/usr/bin/env bash
# Pin the VPS host key for GitHub Actions. Do not use StrictHostKeyChecking=accept-new:
# a first-use MITM would receive GITHUB_TOKEN on docker login stdin.
set -euo pipefail

: "${HOST:?HOST is required}"
: "${SSH_KEY:?SSH_KEY is required}"
: "${KNOWN_HOSTS:?KNOWN_HOSTS is required}"

if [[ -z "${KNOWN_HOSTS//[[:space:]]/}" ]]; then
  echo "KNOWN_HOSTS is empty" >&2
  exit 1
fi

install -m 600 /dev/null /tmp/deploy_key
install -m 600 /dev/null /tmp/known_hosts
printf '%s\n' "$SSH_KEY" > /tmp/deploy_key
printf '%s\n' "$KNOWN_HOSTS" > /tmp/known_hosts

if ! grep -qF "$HOST" /tmp/known_hosts; then
  echo "KNOWN_HOSTS does not contain ${HOST}" >&2
  exit 1
fi

# GlobalKnownHostsFile=/dev/null: runner image keys must not satisfy a new host.
export AXENTRIO_SSH="ssh -i /tmp/deploy_key -o UserKnownHostsFile=/tmp/known_hosts -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o HashKnownHosts=no"
