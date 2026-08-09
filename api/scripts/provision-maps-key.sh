#!/usr/bin/env bash
#
# Provision the Google Cloud project and API key that travel-time scheduling needs (#69).
#
# From an empty project to a restricted, working key, so a fresh environment is repeatable
# rather than remembered. The setup has several steps that are easy to get subtly wrong, and
# getting them wrong does not fail loudly: it produces exactly the silent degradation #68 exists
# to catch. A revoked key, an un-enabled API and a lapsed trial all look the same from inside the
# product - bookings keep flowing, quietly less protected than the owner believes.
#
# WHICH APIS, AND HOW THAT WAS SETTLED. Not from a document, which can drift, but from the
# endpoints the code actually calls:
#
#   routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix  -> Routes API
#   maps.googleapis.com/maps/api/geocode/json                   -> Geocoding API
#
# ADR-0014 names the same two. Nothing else uses this key: Calendar is OAuth and holds no Maps
# quota, so it must not be enabled here.
#
#   Usage:
#     scripts/provision-maps-key.sh --project my-project --allowed-ip 1.2.3.4 [--allowed-ip 5.6.7.8]
#     scripts/provision-maps-key.sh --project my-project --allowed-ip 1.2.3.4 --dry-run
#
# Running it twice is safe: every step checks the current state first, and an existing key of the
# same name has its restrictions UPDATED rather than a second key created beside it.
set -euo pipefail

# The two APIs this feature uses, and no others (AC-1).
readonly REQUIRED_APIS=(
  "routes.googleapis.com"
  "geocoding-backend.googleapis.com"
)

# Maps-family APIs that are NOT ours. Enabled ones are reported, never disabled: this script
# provisions, and a project may legitimately serve something else. Silence about them would be
# the problem, not their presence.
readonly FOREIGN_MAPS_APIS=(
  "places-backend.googleapis.com"
  "directions-backend.googleapis.com"
  "distance-matrix-backend.googleapis.com"
  "maps-backend.googleapis.com"
  "roads.googleapis.com"
  "elevation-backend.googleapis.com"
  "timezone-backend.googleapis.com"
  "static-maps-backend.googleapis.com"
)

PROJECT=""
KEY_NAME="axentrio-travel-time"
ALLOWED_IPS=()
DRY_RUN=false
BILLING_CONFIRMED=false

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
run() {
  if $DRY_RUN; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --allowed-ip) ALLOWED_IPS+=("${2:-}"); shift 2 ;;
    --key-name) KEY_NAME="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --billing-is-upgraded) BILLING_CONFIRMED=true; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# ARGUMENTS FIRST, then the environment: a mistyped invocation should not have to wait for a
# tool check to hear about itself. It also means ALLOWED_IPS is provably non-empty before any
# `${ALLOWED_IPS[*]}` below, which bash 3.2 under `set -u` treats as an unbound variable.
[[ -n "$PROJECT" ]] || die "--project is required"

# AC-2: a key with no restriction is worse than no key. Anyone who finds it can spend the
# platform's Maps budget, and the first sign would be a bill or a quota alarm. Refusing here is
# the only way this script cannot produce one.
if [[ ${#ALLOWED_IPS[@]} -eq 0 ]]; then
  cat >&2 <<'MSG'

ERROR: --allowed-ip is required, at least once.

An unrestricted key is the one outcome this script must never produce, so it refuses rather
than defaulting. Routes v2 publishes no OAuth scope, so an IP-restricted server key is the
only restriction available to it.

Pass every egress address the API can call Google from. On Railway that is the service's
static outbound IP - see the service's Settings > Networking. If the platform gives you no
stable egress address, do not work around it here: an unrestricted key is not the answer, a
proxy with one is.
MSG
  exit 1
fi

command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed. https://cloud.google.com/sdk/docs/install"

step "Project and account"
gcloud projects describe "$PROJECT" --format='value(projectId)' >/dev/null 2>&1 \
  || die "project '$PROJECT' does not exist, or this account cannot see it. Run: gcloud auth login"
say "  project:  $PROJECT"
say "  account:  $(gcloud config get-value account 2>/dev/null)"
say "  key name: $KEY_NAME"
say "  allowed:  ${ALLOWED_IPS[*]}"

step "Billing (AC-3)"
BILLING_JSON="$(gcloud beta billing projects describe "$PROJECT" --format=json 2>/dev/null || echo '{}')"
BILLING_ENABLED="$(printf '%s' "$BILLING_JSON" | grep -o '"billingEnabled": *[a-z]*' | awk '{print $2}' || true)"
BILLING_ACCOUNT="$(printf '%s' "$BILLING_JSON" | grep -o '"billingAccountName": *"[^"]*"' | cut -d'"' -f4 || true)"

[[ "$BILLING_ENABLED" == "true" ]] \
  || die "billing is not enabled on '$PROJECT'. The Routes API will reject every request."
say "  billing account: ${BILLING_ACCOUNT:-unknown}"

# A CLOSED account is detectable and fatal. It is also what a LAPSED trial becomes, which is the
# exact failure ADR-0014 calls out: not a clean error, but ADR-0015's Routes-unreachable branch
# firing permanently and silently for every tenant at once.
if [[ -n "$BILLING_ACCOUNT" ]]; then
  ACCOUNT_OPEN="$(gcloud beta billing accounts describe "${BILLING_ACCOUNT#billingAccounts/}" \
    --format='value(open)' 2>/dev/null || echo "")"
  [[ "$ACCOUNT_OPEN" != "False" && "$ACCOUNT_OPEN" != "false" ]] \
    || die "billing account ${BILLING_ACCOUNT} is CLOSED. A lapsed free trial looks exactly like this."
fi

# AN ACTIVE TRIAL IS NOT DETECTABLE FROM THE API, and pretending otherwise would be worse than
# asking. The Cloud Billing API reports `open` and nothing about trial status or credits, so this
# script cannot answer the question by itself. It refuses until somebody who can look has looked,
# because an unnoticed trial is precisely the silent, platform-wide outage in waiting that
# ADR-0014 records as an unmet operational precondition.
if ! $BILLING_CONFIRMED; then
  cat >&2 <<MSG

ERROR: confirm the billing account is UPGRADED, not a free trial, then re-run with --billing-is-upgraded.

Check: https://console.cloud.google.com/billing/${BILLING_ACCOUNT#billingAccounts/}
A trial shows a credit balance and an expiry date. An upgraded account shows neither.

Why this is a hard stop rather than a warning: a trial that expires does not fail cleanly. It
becomes ADR-0015's Routes-unreachable branch, firing permanently and for every tenant at once,
while bookings carry on being taken against straight-line distance bounds.

The Cloud Billing API does not expose trial status, so this script genuinely cannot check it.
It asks instead of guessing.
MSG
  exit 1
fi
say "  upgraded: confirmed by the operator (--billing-is-upgraded)"

step "APIs (AC-1: exactly these two)"
ENABLED="$(gcloud services list --enabled --project "$PROJECT" --format='value(config.name)' 2>/dev/null || true)"
for api in "${REQUIRED_APIS[@]}"; do
  if grep -qx "$api" <<<"$ENABLED"; then
    say "  already enabled: $api"
  else
    say "  enabling:        $api"
    run gcloud services enable "$api" --project "$PROJECT"
  fi
done

# Reported, never disabled. Turning something off that another workload depends on is not this
# script's call to make, and doing it silently would be worse than the drift.
for api in "${FOREIGN_MAPS_APIS[@]}"; do
  if grep -qx "$api" <<<"$ENABLED"; then
    say "  NOTE: $api is enabled and is NOT used by travel time. Left alone. Disable it by hand if nothing else needs it."
  fi
done

step "API key (AC-2: restricted, AC-4: idempotent)"
EXISTING="$(gcloud services api-keys list --project "$PROJECT" \
  --filter="displayName=$KEY_NAME" --format='value(name)' 2>/dev/null | head -1 || true)"

API_TARGETS=()
for api in "${REQUIRED_APIS[@]}"; do API_TARGETS+=("--api-target=service=$api"); done
IP_LIST="$(IFS=,; echo "${ALLOWED_IPS[*]}")"

if [[ -n "$EXISTING" ]]; then
  # Updated in place. Creating a second key of the same name is the failure mode that makes
  # "run it twice" unsafe: two live keys, one of them forgotten and unrotatable.
  say "  found existing key, updating its restrictions rather than creating another"
  say "  $EXISTING"
  run gcloud services api-keys update "$EXISTING" \
    --clear-restrictions --project "$PROJECT" --quiet
  run gcloud services api-keys update "$EXISTING" \
    "${API_TARGETS[@]}" --allowed-ips="$IP_LIST" --project "$PROJECT" --quiet
  KEY_RESOURCE="$EXISTING"
else
  say "  creating a new restricted key"
  run gcloud services api-keys create \
    --display-name="$KEY_NAME" \
    "${API_TARGETS[@]}" \
    --allowed-ips="$IP_LIST" \
    --project "$PROJECT" --quiet
  KEY_RESOURCE="$(gcloud services api-keys list --project "$PROJECT" \
    --filter="displayName=$KEY_NAME" --format='value(name)' 2>/dev/null | head -1 || true)"
fi

step "What was done (AC-5)"
if $DRY_RUN; then
  say "  dry run: nothing was changed. Re-run without --dry-run to apply."
  exit 0
fi

say "  key resource: ${KEY_RESOURCE:-unknown}"
say ""
say "  Restrictions now on the key:"
gcloud services api-keys describe "$KEY_RESOURCE" --project "$PROJECT" \
  --format='yaml(restrictions)' 2>/dev/null | sed 's/^/    /' || say "    (could not read them back)"

say ""
say "  Verify by hand:"
say "    gcloud services list --enabled --project $PROJECT | grep -E 'routes|geocoding'"
say "    gcloud services api-keys describe $KEY_RESOURCE --project $PROJECT"
say ""
say "  Read the secret (it is NOT printed above on purpose):"
say "    gcloud services api-keys get-key-string $KEY_RESOURCE --project $PROJECT"
say ""
say "  Then set it as GOOGLE_MAPS_API_KEY on the api service."
say ""
say "  The watchdog will tell you whether it works: within about 90 seconds of a deploy,"
say "  travel-health probes Routes once and alerts PLATFORM_ALERT_EMAIL if it cannot answer."
say "  A refused key and an outage read differently in that alert, which is the point of it."
