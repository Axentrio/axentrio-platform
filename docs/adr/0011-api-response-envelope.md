# API response envelope — one shape on the wire, helpers in code, codex-reviewed plan

Until this migration, the API mixed half a dozen response shapes:
`res.json({ success: true, data })`, `res.json({ error: 'string' })`,
`res.json({ success: false, data: {…} })`, raw entity returns
(`res.json(doc)`), and bare `res.status(500).json({ error: 'Internal server error' })`
from middleware that swallowed exceptions. Support tickets read "we got a
server error, no details" because requestIds, error codes, and machine-readable
status didn't survive the middleware chain. Portal toasts rendered `[object Object]`
the moment a server returned the nested envelope shape some routes already used.

v1 picks one envelope shape for every portal-facing endpoint and one path for
producing it:

```jsonc
// Success
{ "success": true, "data": <payload>, "meta": { "pagination": ... } }

// Error
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "...", "details": {…} },
  "meta": { "timestamp": "…", "requestId": "req_…", "path": "/api/v1/…" }
}
```

The contract is produced by two narrow surfaces only — `utils/response.ts`
(`sendSuccess` / `sendCreated` / `sendPaginated` / `sendNoContent`) and the
global `errorHandler` middleware (which receives typed errors from `error-handler.ts`'s
`ApiError` family + the `asyncHandler` ZodError adapter). Handlers `throw` or
call a helper; nothing writes the envelope directly.

**The critical framing:** an envelope IS NOT a wire shape that everyone has to
match — it's a contract between handlers and the canonical handler. Three
classes of endpoint deliberately stay outside the envelope:

- **OAuth callback redirects** (`channels/meta/oauth.routes.ts`) use `res.redirect`
  — they're browser flow, not JSON. Migration would break the redirect chain.
- **Provider-facing webhook receivers** (Stripe billing, Meta channels, n8n
  inbound) — the body shape n8n / Stripe / channel adapters parse is part
  of the integration contract. Changing it silently breaks downstream
  tooling on the partner side that we can't redeploy.
- **The /health probe** — Railway parses the HTTP status, not the body. The
  shape `{ status: "healthy", timestamp }` is the documented Railway probe
  contract.

The middleware that fronts these endpoints (`rateLimitByIp`, `timeoutMiddleware`)
needs the same body-shape carve-out — when one of these endpoints gets rate-limited
or times out, the 429/503 body keeps its legacy shape so partner clients keep
working. The carve-out is body-shape only — rate limiting still ENFORCES on
those paths; only the response wire shape differs. The matcher uses `req.originalUrl`
(NOT `req.path` — `apiRouter` mounts these middlewares where `req.path` is
mount-relative) against an explicit regex list pinned in
[`rate-limit.middleware.ts`](../chatbot-platform/api/src/middleware/rate-limit.middleware.ts)
and [`timeout.middleware.ts`](../chatbot-platform/api/src/middleware/timeout.middleware.ts).

**Decision notes that pushed back on intuition:**

- We picked `data.error.message` precedence over a plain string `data.error`
  in `extractApiErrorMessage` (portal) so legacy bodies like the old
  rate-limit response `{ error: "Too Many Requests", message: "Rate limit
  exceeded. Please try again later." }` yield the more useful copy from
  `message`, not the short string from `error`.
- We did NOT widen `UnauthorizedError`/`ForbiddenError`/`NotFoundError`
  constructors to take `details`. Use `ApiError(msg, status, code, details)`
  whenever a custom machine-readable code is needed (e.g.
  `TENANT_SUSPENDED`, `CLERK_UPSTREAM_FAILED`). Mixing a constructor-shorthand
  for some codes and `ApiError` for others is fine; the wire shape is
  identical.
- `sendSuccess(res, null)` is legal — explicitly for endpoints whose contract
  is "200 with null body to signal absent state" (e.g.
  `knowledge.controller.ts::getAiSettings` when AI is not yet configured).
  Audit callers before using; the contract is they tolerate `null` as the
  unwrapped value.
- `sendSuccess(res, undefined)` is NOT legal — the portal interceptor
  unwraps to `undefined`, which breaks every downstream destructuring.
  Handlers without a meaningful payload should pass `{ message: '...' }`
  instead.
- The portal's `axios-mock-adapter`-backed test pins the interceptor's
  auto-unwrap so a future change to that single piece of code can't
  silently regress every portal page at once.
- We added a deliberate wire-shape change to the webhook-test endpoint
  (`/tenants/me/webhooks/test` and `/me/webhook-test`): the old
  `{ success: false, data: {…} }` shape for "API call succeeded but the
  target webhook returned an error" was misleading — wire-level `success`
  conflated "the HTTP request succeeded" with "the target webhook returned
  2xx". v2 emits `{ success: true, data: { …, testFailed: true, error } }`
  so wire-level `success` reflects "the test ran" and the body's
  `testFailed:true` reports the target's failure. The portal `useTestWebhook`
  hook was updated in the same commit to surface the failure toast.

**What the migration did NOT change:**

- HTTP status codes — only response *shape* (the rate-limit body is the
  documented exception, see plan §6.2).
- Sentry / logger integration — `errorHandler` still captures 5xx and warns
  4xx as before; the headersSent guard moved the log BEFORE the delegate
  so post-timeout errors stay observable.
- Business logic, route paths, validation chains, audit logs.

**The plan and the loop that produced it.** The full file-by-file audit lives
at [`chatbot-platform/docs/api-response-standardization-plan.md`](../chatbot-platform/docs/api-response-standardization-plan.md).
The plan went through six rounds of codex review before any code changed —
each round caught a class of bug that would have shipped if implementation
had jumped first: an undercounted portal regression site (round 1), a typed-error
constructor signature trap (round 1), the cross-cutting middleware risk where
global `rateLimitByIp` fronts OOS provider endpoints (round 4), the
`extractApiErrorMessage` precedence subtlety that would have lost the
rate-limit body's `message` field (round 4), a Zod error adapter we'd missed
entirely (round 6). The plan document captures every resolved item against
its codex round so the rationale is recoverable.

**Guardrails (Phase 7):**
- `chatbot-platform/api/scripts/check-envelope-conventions.sh` — grep-based
  pre-commit / CI check. Bans `res.json({ error })`, `res.json({ success: true })`,
  and `res.status(N).json({ literal })` outside the allow-list. Provider-contract
  carve-outs add `// envelope-allow: <reason>` markers on the emit line. The
  script is bash because the project doesn't run ESLint — if ESLint is adopted
  later, the same patterns convert directly to `no-restricted-syntax` AST
  selectors.
- 19 test suites / 200+ tests pin every layer: helper precedence (10 portal
  unit), interceptor unwrap (12 portal integration via axios-mock-adapter),
  per-middleware wire envelope shape (45+ api supertest), OOS carve-out
  regression (rate-limit + timeout per path), and the inbound n8n webhook
  401 body shape (so a future cleanup can't silently break the contract).

Status-code-to-helper preservation rules live in plan §3.4a; the convention
section in [`chatbot-platform/api/README.md`](../chatbot-platform/api/README.md#response-envelope-convention)
is the contributor-facing quick reference.
