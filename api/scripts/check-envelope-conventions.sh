#!/usr/bin/env bash
# Envelope-convention guardrail.
#
# Bans the four ad-hoc response shapes the migration eliminated:
#
#   1.  res.json({ error: '...' })                — old error shape
#   2.  res.json({ success: true, ... })          — old success shape
#   3.  res.json({ ...literal-object... })        — raw payload without helpers
#   4.  res.status(N).json({ ...literal... })     — same, with explicit status
#
# Files in ALLOW_LIST below are exempt — either because they BUILD the envelope
# (utils/response.ts, error-handler.ts) or because they preserve an external
# integration contract (Stripe/Meta/n8n webhook receivers, OAuth callback
# redirects already use res.redirect not res.json). See plan §5 + §4 Phase 7.
#
# Usage:
#     scripts/check-envelope-conventions.sh           # CI mode — exit 1 on violation
#     scripts/check-envelope-conventions.sh --verbose # show all matches incl. allow-listed
#
# Wire into CI (e.g. GitHub Actions) by adding:
#     - run: bash chatbot-platform/api/scripts/check-envelope-conventions.sh
#
# Why bash + grep instead of a custom ESLint rule: this repo doesn't run ESLint
# (no .eslintrc, no lint script in package.json) — adding an ESLint plugin for
# one rule has worse cost/benefit than a focused 50-line script. If ESLint is
# adopted later, the same patterns convert directly to `no-restricted-syntax`
# selectors (see plan §4 Phase 7 for the AST shapes).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_DIR="${API_DIR}/src"

# Files whose entire content is exempt — they either BUILD the envelope or
# are preserved provider contracts where the legacy body shape is the contract.
ALLOW_LIST=(
  "src/middleware/error-handler.ts"
  "src/utils/response.ts"
  "src/webhooks/billing-webhook.routes.ts"
  "src/channels/meta/webhook.routes.ts"
  "src/channels/channel-webhook.routes.ts"
  "src/n8n/booking.routes.ts"
  "src/n8n/rag-search.routes.ts"
  "src/n8n/webhook.controller.ts"   # handleInboundWebhook is the n8n contract
  "src/n8n/webhook.routes.ts"       # inbound rate-limit + /events legacy endpoint
  "src/server.ts"                   # /health probe
)

# Build grep --exclude args from the allow-list.
EXCLUDE_ARGS=()
for f in "${ALLOW_LIST[@]}"; do
  EXCLUDE_ARGS+=("--exclude=$(basename "${f}")")
done

# Always exclude tests — those legitimately mock raw responses.
EXCLUDE_ARGS+=("--exclude-dir=__tests__")

# Patterns to ban.
#
# We deliberately accept some false negatives (e.g. `res.json(variable)` is
# allowed — most pass-throughs are intentional in DB-streaming endpoints).
# The high-signal regressions all match the literal-object shapes below.
PATTERNS=(
  'res\.json\(\s*\{[^}]*error\s*:'
  'res\.json\(\s*\{[^}]*success\s*:\s*true'
  'res\.status\(\s*[0-9]+\s*\)\.json\(\s*\{'
)

violations=0
verbose=0
if [[ "${1:-}" == "--verbose" ]]; then verbose=1; fi

echo "Scanning ${SRC_DIR} for ad-hoc envelope shapes..."
echo

for pattern in "${PATTERNS[@]}"; do
  # grep -E for ERE, -rn for recursive line-numbered, -P would be PCRE but BSD
  # grep on macOS doesn't support -P — stick with -E.
  if matches="$(grep -rEn "${pattern}" "${SRC_DIR}" --include='*.ts' "${EXCLUDE_ARGS[@]}" 2>/dev/null || true)"; then
    if [[ -n "${matches}" ]]; then
      # Strip line-marker exemptions: `// envelope-allow: <reason>`
      filtered="$(echo "${matches}" | awk '!/\/\/ envelope-allow:/{print}')"
      if [[ -n "${filtered}" ]]; then
        echo "VIOLATION — pattern: ${pattern}"
        echo "${filtered}"
        echo
        violations=$((violations + $(echo "${filtered}" | wc -l)))
      elif [[ "${verbose}" == "1" ]]; then
        echo "ALLOWED (envelope-allow markers) — pattern: ${pattern}"
        echo "${matches}"
        echo
      fi
    fi
  fi
done

if [[ "${violations}" -gt 0 ]]; then
  cat <<'EOF'
Found one or more ad-hoc envelope shapes outside the allow-list.

Fix:
  - Replace `res.json({ success: true, data })` → `sendSuccess(res, data)`.
  - Replace `res.status(N).json({ error })` → `throw new <TypedError>(...)`
    or, for a custom code: `throw new ApiError(msg, status, code)`.
  - For provider contracts that MUST keep the legacy body shape, add an
    inline comment marker at the call site:
        res.json({ error: '...' }); // envelope-allow: <reason>

See chatbot-platform/docs/api-response-standardization-plan.md §2 and the
ADR at docs/adr/0011-api-response-envelope.md for the convention.
EOF
  exit 1
fi

echo "OK — no ad-hoc envelope shapes outside the allow-list."
