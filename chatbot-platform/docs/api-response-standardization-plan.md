# API response standardization — audit & plan

Status: research / proposal (codex rounds 1-5 fully incorporated; round 6 — the 5 real-bug items applied, 9 precision items deferred to PR review per explicit decision). Nothing has been changed yet. Owner: TBD.

## 1. Goal

Eliminate ad-hoc `res.json({ error: '...' })` and `res.json({ success: true, ... })` calls across **first-party / portal-facing JSON APIs and the middleware that fronts them**. Those endpoints should go through the existing helpers and emit the same envelope, so:

- The user-facing `{"error":"Internal server error"}` blob disappears.
- Every error response on a portal-facing route carries `code`, `message`, `requestId`, `path`, `timestamp` (for support + log correlation).
- The portal's auto-unwrap interceptor receives consistent shapes.
- New portal-facing routes follow one obvious pattern.

**This goal explicitly does NOT cover** integration-contract endpoints listed in §5 (Stripe / Meta / n8n webhook receivers, OAuth redirects, `/health`, file/CSV streams, n8n booking + RAG endpoints). Those have non-JSON or third-party-fixed shapes that must remain unchanged. The §7 regression tests pin those shapes (codex round 3 #1).

## 2. The canonical convention

Already implemented — we are aligning with it, not inventing it.

### 2.1 Error envelope

Source: `chatbot-platform/api/src/middleware/error-handler.ts`

```jsonc
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",            // machine-readable
    "message": "Tenant not found",  // human-readable, redacted in prod for non-operational errors
    "details": { /* optional */ }
  },
  "meta": {
    "timestamp": "2026-05-20T12:34:56.000Z",
    "requestId": "req_xxx",
    "path": "/api/v1/tenants/me"
  }
}
```

Produced by the global `errorHandler` middleware. To opt in, a handler either:
- `throw new <TypedError>(...)`, **or**
- `next(err)` from a middleware.

`asyncHandler(fn)` is required for async route handlers so rejected promises reach the global handler.

### 2.2 Typed-error constructor reference

**Important — codex round 1 flagged that the constructors do NOT all share the same signature.** Check this table before throwing:

| Class | Constructor | Use it for |
| --- | --- | --- |
| `ApiError(message, statusCode, code, details?, isOperational?)` | Full control. | Anything that needs a custom `code` (e.g. `TENANT_SUSPENDED`, `CLERK_UPSTREAM_FAILED`, `RATE_LIMIT_FALLBACK`) or a non-stock status. |
| `BadRequestError(message, details?)` | 400 / `BAD_REQUEST` | Bad input the caller can fix. |
| `UnauthorizedError(message)` | 401 / `UNAUTHORIZED` | **No `details` parameter.** |
| `ForbiddenError(message)` | 403 / `FORBIDDEN` | **No `details` parameter.** |
| `NotFoundError(message)` | 404 / `NOT_FOUND` | **No `details` parameter.** |
| `ConflictError(message, details?)` | 409 / `CONFLICT` | |
| `ValidationError(message, details?)` | 422 / `VALIDATION_ERROR` | |
| `RateLimitError(message, details?)` | 429 / `RATE_LIMIT_EXCEEDED` | `details: { retryAfter }` becomes `error.details.retryAfter`. |

If you want a custom `code` on a 401/403/404, use `new ApiError(msg, 401, 'YOUR_CODE')` — do not pass a 2nd arg to `UnauthorizedError`/`ForbiddenError`/`NotFoundError`. Migration #fix-typed-error-constructors in Phase 0 either tightens these signatures or sticks with `ApiError` at the throw site (default: stick with `ApiError`).

### 2.3 Success envelope

Source: `chatbot-platform/api/src/utils/response.ts`

```jsonc
{ "success": true, "data": <payload>, "meta": { /* optional */ } }
```

Helpers:
- `sendSuccess(res, data, meta?)` — 200.
- `sendCreated(res, data)` — 201.
- `sendPaginated(res, data, pagination)` — 200 with `meta.pagination`.
- `sendNoContent(res)` — 204, no body.

**Convention for handlers without a meaningful payload** (today: `res.json({ success: true, message: '...' })`): use `sendSuccess(res, { message: '...' })`. After portal interceptor unwrap, the frontend reads `result.message` — preserves existing portal call sites.

**`sendSuccess(res, undefined)` is forbidden** — the interceptor unwraps to `undefined` and breaks destructuring downstream.

**`sendSuccess(res, null)` is allowed only for endpoints whose contract today is "200 with null body to signal absent state"**, like `knowledge.controller.ts::getAiSettings` (codex round 3 #11). In that case the call site already handles `null` (e.g. `if (result === null) showEmptyState()`) and migrating to `sendSuccess(res, null)` keeps the post-unwrap shape identical. **Audit before using**: confirm each call site tolerates `null`. If any do not, wrap the payload (`sendSuccess(res, { settings: null })`) and update callers in the same PR.

### 2.4 Portal contract (don't break this)

`chatbot-platform/portal/src/services/apiClient.ts:91-108` auto-unwraps:
- `{ success, data }` → `data` (handler sees the payload directly).
- `{ success, data, meta }` → `{ data, meta }` (keeps pagination).
- Anything else passes through untouched.

Implication for **success** responses: switching `res.json({ success: true, data: X })` → `sendSuccess(res, X)` is a no-op on the wire. Switching `res.json(X)` (raw, no envelope) → `sendSuccess(res, X)` adds a wrapper that the interceptor unwraps. Both are safe for portal consumers.

Implication for **error** responses: **the portal does NOT auto-unwrap errors.** Error bodies reach call sites as-is. See §2.5.

### 2.5 Portal error-shape risk (codex round 1 #6 — must fix before server migration)

`chatbot-platform/portal/src/services/apiClient.ts:129-142::handleApiError` currently does:

```ts
return data?.message || data?.error || `Error ${status}: ...`;
```

That works when `data.error` is a string. After migration, `data.error` becomes `{ code, message, details? }`. Rendering an object as toast text yields `[object Object]`.

**Audit of direct call sites** (`response?.data?.error` + the `response?.data?.message` variants):

| File:line | Current code | Needs |
| --- | --- | --- |
| `services/apiClient.ts:135` (`handleApiError`) | `data?.message \|\| data?.error` | Replace inline chain with `extractApiErrorMessage(error)`. |
| `queries/useChannelQueries.ts:49,85,101,124` | `error?.response?.data?.error \|\| 'Failed to ...'` | Call `extractApiErrorMessage(error) ?? 'Failed to ...'`. |
| `queries/useSkillsQueries.ts:36,52,67` | same shape | same fix |
| `queries/useAutomationsQueries.ts:30,44` | same shape | same fix |
| `queries/useIntegrationQueries.ts:48,58` | same shape | same fix |
| `components/settings/CalcomSettings.tsx:73` | same shape | same fix |
| `pages/Team.tsx:486-487` | `error?.response?.data?.error?.message \|\| error?.response?.data?.error` | **Mandatory fix (codex round 3 #5)** — when the server emits `{error:{code:'X'}}` with no `.message`, the second branch still passes the object. Migrate to `extractApiErrorMessage(error)`. |
| `pages/admin/AdminTenants.tsx:384-385` | same nested-with-fallback-to-object | Mandatory fix, same reason. |
| `pages/WidgetTest.tsx:587` (codex round 3 #6) | `err?.response?.data?.message \|\| err?.message \|\| 'Failed to initialise.'` | After migration the server-side message lives at `data.error.message`, not `data.message`. Replace with `extractApiErrorMessage(err) ?? 'Failed to initialise.'` (the helper now folds in the `err.message` fallback per §2.5 helper code). |
| `queries/queryConfig.ts:5` (`extractErrorMessage`) (codex round 4 #3) | Already nested-aware: `data?.error?.message \|\| (typeof data?.error === 'string' ? data.error : ...)` | Centralize: replace the inline chain with `extractApiErrorMessage(error) ?? '<fallback>'` so the precedence (incl. `data.message`) is uniform. |
| `queries/useBillingQueries.ts:60` (`describeBillingError`) (codex round 4 #3) | Reads `error?.response?.data?.error?.message` then has billing-specific fallbacks. | Use `extractApiErrorMessage(err) ?? <billing-fallback>` while preserving the billing-specific code → human copy map (do NOT remove that map; it's the human-readable layer on top of `error.code`). |

**Total: 15 portal sites need the helper + 1 helper definition.** No site is optional.

**Inline ternaries like `data?.error?.message ?? data?.error` are forbidden** in call sites: when an object is missing `.message`, the second branch still passes the object to a toast and renders `[object Object]`. **All call sites must use `extractApiErrorMessage(error)`** which guarantees a string return (or `undefined` for the fallback to take over).

```ts
// portal/src/services/apiClient.ts — new export
// Strictly extracts the server-side error string from an Axios response body. Returns
// undefined for:
//   - non-Axios errors (callers chain their own `err.message` / hardcoded fallback)
//   - Axios errors without `response` (network/timeout — caller falls back to err.message,
//     which axios sets to "Network Error" / "timeout of Xms exceeded")
//   - Axios responses with no extractable string in the body (caller falls back)
// Precedence inside the response body (codex rounds 4 #4/#5 + 5 #1 + 6 #4/#5):
//   1. data.error.message (new envelope) — most specific server message.
//   2. data.message (legacy bodies that emit both `error: 'short'` and `message: 'detail'`,
//      e.g. today's rate-limit body. Picking message before string-error gives the more
//      useful copy "Rate limit exceeded. Please try again later." instead of "Too Many Requests".)
//   3. data.error as string (legacy string-only error bodies).
export function extractApiErrorMessage(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  if (!error.response) return undefined; // network/timeout — caller falls back to err.message
  const data = error.response.data as
    | { error?: string | { message?: string; code?: string }; message?: string }
    | undefined;
  if (data?.error && typeof data.error === 'object' && typeof data.error.message === 'string') {
    return data.error.message;
  }
  if (typeof data?.message === 'string') return data.message;
  if (typeof data?.error === 'string') return data.error;
  return undefined;
}
```

**Per-call-site replacement patterns:** there are two flavors in the codebase. **Pattern A** has no `err.message` fallback (e.g. `useChannelQueries.ts`): `error?.response?.data?.error || 'Failed to connect Telegram bot'`. **Pattern B** does (e.g. `useSkillsQueries.ts`): `err?.response?.data?.error || err?.message || 'Failed to create skill'`.

```ts
// Pattern A → keep behavior identical:
const msg = extractApiErrorMessage(error) ?? 'Failed to connect Telegram bot';

// Pattern B → preserve the err.message fallback explicitly:
const msg =
  extractApiErrorMessage(error) ??
  (error instanceof Error ? error.message : undefined) ??
  'Failed to create skill';
```

When migrating each of the 13 portal call sites, check whether the legacy line was Pattern A or B and replace with the matching template. **Do not** uniformly substitute one template — that's how codex round 6 #4 caught the regression for axios-without-response.

**`handleApiError` preserves its existing fallback ladder** (codex rounds 5 #2 + 6 #5):

```ts
export const handleApiError = (error: unknown): string => {
  const serverMessage = extractApiErrorMessage(error);
  if (serverMessage) return serverMessage;
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return `Error ${error.response.status}: ${error.response.statusText}`;
    }
    if (error.request) {
      return 'Network error. Please check your connection.';
    }
  }
  return 'An unexpected error occurred.';
};
```

Behavior verification:
- Axios + response + extractable string → server message.
- Axios + response + no extractable string → `'Error N: statusText'` (preserved).
- Axios + no response + has `request` → `'Network error. Please check your connection.'` (preserved).
- Axios + no response + no request → `'An unexpected error occurred.'` (preserved).
- `new Error('boom')` → `'An unexpected error occurred.'` (NOT `'boom'` — preserved). Earlier draft of the helper returned `error.message` for non-Axios `Error` instances, which made `handleApiError('boom')` return `'boom'` and break the legacy contract. The helper is now strictly axios-response-only, so this regression is gone.

This MUST land before (or in the same PR as) any server-side error migration that touches the routes those queries hit (`useChannelQueries` → channels, `useSkillsQueries` → skills.routes.ts, `useAutomationsQueries` → automations, `useIntegrationQueries` + `CalcomSettings` → integrations.controller).

## 3. File-by-file audit

Statuses:
- ✅ Compliant — uses `asyncHandler` + typed errors + send-helpers throughout.
- 🟡 Partial — mostly compliant, a few ad-hoc sites remain.
- 🔴 Non-compliant — handler-shaped controller, no helpers, raw `res.json`.
- ⚪️ Out of scope — webhook receivers / multer error chain / non-JSON responses (see §5).

### 3.1 Middleware (writes responses directly — biggest source of the bare 500 leak)

| File | Status | Lines that need to change |
| --- | --- | --- |
| `middleware/auth.middleware.ts` | 🔴 | `authenticateAgent` L136/145/155/171/175/**179**; `authenticateWidget` L195/204/227/231/**235**; `requireRole` L295/301. Switch all to `next(new UnauthorizedError(...))` / `next(new ForbiddenError(...))` / `next(err)`. **Bug fix during migration (codex round 2 #12):** today the `catch` order checks `JsonWebTokenError` (L170-173) **before** `TokenExpiredError` (L174-177). Since `TokenExpiredError extends JsonWebTokenError`, the expired-token branch is currently **unreachable** — every expired token surfaces as "Invalid token". Reorder so `TokenExpiredError` is checked first in both `authenticateAgent` and `authenticateWidget`. Same reorder needed in `authenticateSocket` (L278-283). Socket auth paths still use `next(new Error(...))` (Socket.IO middleware contract). |
| `middleware/clerk.middleware.ts` | 🔴 | `requireClerkAuth` L73/L77; `autoProvision` L95/**193**/219/**303**/**355**/**376**. The four bolded ones are `res.status(500).json({ error: ... })` — the most-visible leak in production. Replace with `next(new UnauthorizedError(...))` / `next(new ApiError('Failed to provision tenant', 500, 'PROVISIONING_FAILED'))` etc. L219 is shaped `{error:'Organization suspended', code:'TENANT_SUSPENDED'}` — use `next(new ApiError('Organization suspended', 403, 'TENANT_SUSPENDED'))` (NOT `ForbiddenError`, which has no details/code parameter). |
| `middleware/tenant.middleware.ts` | 🔴 | `validateTenant` L61/68/78/84/**93** → `next(new BadRequestError/NotFoundError/ForbiddenError/...)`. `validateSocketTenant` (L139–170) keeps `Error` (Socket.IO). |
| `middleware/super-admin.middleware.ts` | 🔴 | L11/36/41/**55** → `next(new ForbiddenError/NotFoundError/...)`. |
| `middleware/index.ts:51-66` | 🔴 | `requireAdmin` emits raw `res.status(403).json({ error: 'Forbidden: Admin access required' })`. Used by `routes/tenants.ts` and the legacy alias. Switch to `next(new ForbiddenError('Admin access required'))`. (Codex round 1 #2.) |
| `middleware/timeout.middleware.ts` | 🟡 | L13: `res.status(503).json({ error: 'Request timeout' })`. Headers may already be sent; this branch is the *direct write* path. Convert via shared `buildErrorResponse` helper (see §6.1). |
| `middleware/rate-limit.middleware.ts` | 🟡 | L121/130/165/174/206/215/259/268. See §6.2 for the explicit wire-format change. |
| `middleware/rate-limit.ts` | 🟡 | L65, L214. Same as above. |
| `security/csp.middleware.ts` | 🟡 (unmounted — codex round 6 #10) | L431 emits `res.status(400).json({error:'Invalid CSP report'})`. **Critical context:** `handleCSPReport` is exported (L427) and re-exported from the module default (L563), but a repo-wide `grep -rn 'handleCSPReport'` finds NO `app.use(...handleCSPReport)` or `router.post(...handleCSPReport)` site. **Like `uploadRouter` (see file-handling row), this is dead/unmounted code today.** Treatment options:<br>(a) **Cleanup-only migration** — update the function shape (`handleCSPReport(req, res, next)`, swap `res.status(400).json(...)` for `next(new BadRequestError('Invalid CSP report'))`) so it's ready when someone wires it up. PR notes the unmounted status.<br>(b) **Strip from this plan** — add an open-question entry asking whether CSP reporting is wanted, defer the function fix until the mount decision is made.<br>**Default: (a)** — same rationale as `uploadRouter` (the work is small and pre-empts a regression when mounted later).<br>L453 (`reportOnlyCspMiddleware` violation endpoint) emits 204 with no body — correct. |

### 3.2 `src/routes/*.ts`

| File | Status | Notes |
| --- | --- | --- |
| `routes/agents.routes.ts` | ✅ | Fully compliant. |
| `routes/analytics.routes.ts` | 🟡 | One stub: L219 `res.status(501).json({ error: 'Analytics export not yet implemented' })` → `throw new ApiError('Analytics export not yet implemented', 501, 'NOT_IMPLEMENTED')`. |
| `routes/auth.routes.ts` | ✅ | Fully compliant. |
| `routes/canned-responses.routes.ts` | ✅ | Fully compliant. |
| `routes/clerk-webhook.routes.ts` | ✅ | Fully compliant. |
| `routes/chat.routes.ts` | ✅ | Fully compliant. |
| `routes/handsoff.routes.ts` | ✅ | Fully compliant. |
| `routes/notifications.routes.ts` | ✅ | Fully compliant. |
| `routes/users.routes.ts` | ✅ | Fully compliant. |
| `routes/admin.routes.ts` | 🟡 | Mostly compliant. Three ad-hoc 502s where we call out to Clerk: L115 (resend invite), L333 (create-tenant), L705 (invite member). Already use the envelope shape `{success:false, error:{message}}`. Convert each to `throw new ApiError('...', 502, 'CLERK_UPSTREAM_FAILED')`. L1118 is a CSV export response (`res.send(header + rows)`) — out of scope (§5). |
| `routes/billing.routes.ts` | 🟡 | One ad-hoc 403 at L68 (`requireBillingAdmin`) — already envelope-shaped, convert to `next(new ForbiddenError('Admin access required'))`. The `BILLING_ERROR_STATUS` table + `billingErrorToApiError` (L97–116) is the model we want everywhere else. |
| `routes/automations.routes.ts` | 🟡 | Three `res.json({ success: true, data: { ... } })` (L69/L114/L143) → `sendSuccess(res, { ... })`. |
| `routes/files.routes.ts` | 🟡 | Three `res.status(503).json({ error: 'File service is not configured' })` (L32, L84, L115) → `throw new ApiError('File service is not configured', 503, 'FILE_SERVICE_UNAVAILABLE')`. |
| `routes/session-management.routes.ts` | 🟡 | L39, L79, L96 → `sendSuccess`. |
| `routes/skills.routes.ts` | 🟡 | L79/L152 → `sendSuccess(res, { skills })` / `sendSuccess(res, { skill: updated })`. L118 → `sendCreated(res, { skill })`. **L174** today `res.json({ success: true })` (no data) → `sendSuccess(res, { message: 'Skill deleted' })`. |
| `routes/webhook-admin.routes.ts` | 🟡 | **Specific call-out (codex rounds 4 #7 + 5 #6).** The "test webhook" endpoint at L113/L132 today emits BOTH shapes on success: `sendSuccess(res, { status, durationMs })` for HTTP-success-AND-test-passed, but `res.json({ success: false, data: { status, durationMs, error } })` at L132 for "test completed but the target webhook returned an error" (the API call itself succeeded). **The wire-level `success: false` is misleading** — it conflates HTTP success with target-webhook success.<br>Migration decision: **change L132 to `sendSuccess(res, { status, durationMs, error, testFailed: true })`** — wire `success: true` now reflects "the test ran and we have a result"; the body's `testFailed: true` reports the *target's* failure. This is an **explicit contract change**. Action items:<br>• **Update `portal/src/queries/useWebhookQueries.ts:42-47` (codex round 5 #6).** `useTestWebhook` currently toasts `'Test webhook sent'` on `onSuccess` unconditionally — after migration, every test (including failed ones) will show this misleading success toast. Replace with:<br>`onSuccess: (result) => { if (result?.testFailed) { toast.error(\`Test failed: ${result.error ?? 'unknown error'}\`); } else { toast.success('Test webhook sent'); } }`.<br>• Add an integration test asserting both the new server shape AND a portal vitest asserting `useTestWebhook` surfaces a failure toast when `testFailed: true`.<br>• Document in the ADR. |
| `routes/widget.ts` | 🟡 | L46 raw `res.status(429).json({ error: 'Too many requests...' })` → see §6.2 for rate-limit contract. Rest is compliant. |
| `routes/tenants.ts` | 🔴 | The biggest single offender. ~30 sites mix raw `res.json({success:true,...})` with raw `res.status(400/404).json({error})`.<br>**Successes WITH data → `sendSuccess` / `sendCreated`:** L72, L199, L238, L292, L334, L391, L435, L446, L479, L484, L493, L529, L637, L799, L980, L1000.<br>**Successes WITHOUT data (today `{success:true, message:'...'}`) → `sendSuccess(res, { message })`:** L594, L717, L760, L887, L901, L930. (Codex round 1 #7.)<br>**Errors → typed throws:** L129/136/143 (BadRequest "use other endpoint"), L571 (502 Clerk invite → `ApiError(..., 502, 'CLERK_UPSTREAM_FAILED')`), L655/663/668/678 (deactivate user — split between BadRequest and NotFound), L737/742 (reactivate), L820/827 (resend invite), L892 (502 Clerk), L922 (cancel invite). |

### 3.3 Other route modules

| File | Status | Notes |
| --- | --- | --- |
| `channels/channel-management.routes.ts` | ✅ | Fully compliant. |
| `widget/widget-appearance.routes.ts` | ✅ | Router wires `asyncHandler(getWidgetAppearance)` / `asyncHandler(updateWidgetAppearance)`. The **controller** is non-compliant — see below. (Codex round 1 #1.) |
| `widget/widget-appearance.controller.ts` | 🔴 | `getWidgetAppearance` L32 `res.json(toResponse(tenant))` → `sendSuccess(res, toResponse(tenant))`. `updateWidgetAppearance` L69 same → `sendSuccess(res, toResponse(tenant))`. **Coordinate with `widget.js:1402-1413`** — appearance fetch tolerates either `body.data || body`, so the migration is wire-compatible. Verify with the appearance-load path in the embed script before shipping. |
| `channels/meta/oauth.routes.ts` | mixed | **NOT a full migration** (codex rounds 2 #7/#8 + 3 #3/#4). Two distinct contracts:<br>**OAuth callback redirects (L51, 55, 66, 71) use `res.redirect(...)` with `?error=denied` query string — NOT JSON.** Browser flow back from Meta. **Leave entirely as-is.**<br>**JSON endpoints** are `GET /url` (L27), `GET /pages` (L80 — note: on the `metaOAuthCallbackRouter`, not the main router; codex round 3 #3 corrected the name from the earlier draft's `/session`), and `POST /connect` (L98). Migrate these to `asyncHandler` + typed throws at L30/L34/L38/L83/L88/L90/L101/L107/L111/L128/L154.<br>**`/connect` catch-all at L158** currently maps every caught error to 400 regardless of original status. **Default behavior (codex round 3 #4):** the migrated adapter is:<br>```ts<br>// inside POST /connect after migration<br>try { /* ...body... */ }<br>catch (err) {<br>  if (err instanceof ApiError) return next(err);  // ApiError keeps its own status<br>  // unknown errors keep the legacy 400 envelope shape<br>  return next(new BadRequestError(err instanceof Error ? err.message : 'Connect failed'));<br>}<br>```<br>This preserves the current 400 for unknown failures while letting typed `ApiError`s (e.g. plan-limit 402, upstream 502) propagate with their real status. The portal Cmd+K integration is the only known caller; smoke-test that flow before shipping. |
| `channels/meta/webhook.routes.ts` | ⚪️ | Meta's webhook verification endpoint — must return Meta's required shapes (`200 challenge`, `403 'Forbidden'` text, `200 {ok:true}`). Out of scope. |
| `channels/channel-webhook.routes.ts` | ⚪️ | Provider-facing webhooks. Keep current shapes. |
| `knowledge/ai-settings.routes.ts` | 🔴 | Routes wire `asyncHandler(ctrl.*)`; controller functions write raw responses. |
| `knowledge/integrations.routes.ts` | 🔴 | Same — controller functions need migration. |
| `knowledge/knowledge.routes.ts` | 🔴 | Same. **Plus (codex round 6 #8):** `POST /documents/upload` at L31 uses `upload.single('file')` from multer, which throws `MulterError` (size limits, unexpected fields) **before** the controller runs. The plan's §6.4 multer adapter is on the unmounted `upload.controller.ts`; this router needs its own. Add at the end of `knowledge.routes.ts`:<br>`router.use((err: Error, _req, _res, next) => { if (err instanceof multer.MulterError) return next(new ApiError(err.message, 400, err.code)); return next(err); });`<br>Without this, a too-large upload returns a multer-default 500 instead of a clean 400 with `error.code === 'LIMIT_FILE_SIZE'` etc. |
| `knowledge/knowledge.controller.ts` | 🔴 | 19 sites. Successes return raw entity (`res.json(kb)`, `res.json(doc)`, etc. — L34, 59, 66, 95, 114, 138, 165, 171, 181, 224, 249, 285) → wrap with `sendSuccess` / `sendCreated`. **L183 special-case (codex round 3 #11):** `getAiSettings` returns `res.json(null)` when `tenant.settings.ai` is absent. Migrate to `sendSuccess(res, null)` — per §2.3 carve-out — only after confirming the portal AI-settings page tolerates `null` as the unwrapped value. (Grep `useAiSettings` / `getAiSettings` in `portal/src` and verify the destructuring path.) If callers don't tolerate it, wrap: `sendSuccess(res, { settings: null })` and update callers in the same PR. **L85 is actually a 201 success** (create-document) → `sendCreated(res, doc)`, NOT `sendSuccess`. **L120 is a 204** → `sendNoContent(res)`. Errors: L92, L145, L150, L235, L239, L259, L262, L292 → typed throws. |
| `knowledge/integrations.controller.ts` | 🔴 | 10 sites. L24, L71, L158, L194 are successes → `sendSuccess`. L79, L103, L107, L111, L116, L168, L197, L200 are 4xx/5xx → typed throws (`BadRequestError`, `RateLimitError`, `ApiError(*, 502, 'UPSTREAM_FAILED')`). |
| `file-handling/upload.controller.ts` | 🔴 (unmounted — see note) | **Codex round 3 #10 — `uploadRouter` is exported at L614 but NOT mounted anywhere in `server.ts`.** A repo-wide grep finds no `app.use(...uploadRouter)`. The router is currently **dead/unmounted code**; migrating it does NOT affect live API behavior today. Decisions:<br>(a) **Treat as cleanup-only.** Migrate the shapes anyway so the file is ready if it gets mounted later, but skip the deploy/smoke-test budget that would normally accompany migrating a live route. Document in PR description.<br>(b) **Out of scope.** Strip from Phase 5 and add an explicit follow-up ticket: "Determine whether `uploadRouter` should be mounted or deleted."<br>**Default: (a)** — the work is already scoped, and shipping it pre-emptively prevents a future regression when someone wires it up.<br>If still in scope, the migration steps are:<br>• Self-contained Router with its own validation handler (L72-82) and inline multer-style error router (L576-607) that emits the bare `{"error":"Internal server error"}` at L603. Plus two `express-rate-limit` middlewares at L46-58 (`uploadRateLimiter`) and L61-66 (`statusCheckLimiter`).<br>• Successes (L163, 224, 289, 332, 366, 442, 475, 514) → `sendSuccess`/`sendCreated` (preserve existing 200/201 statuses — codex round 2 #11).<br>• Errors (L75, 318, 326, 402, 467, 502, 580, 588) → typed throws.<br>• **Delete the inline error router L576-607**; replace with an adapter (§6.4) so the global `errorHandler` handles them.<br>• Both express-rate-limit middlewares: add a `handler` option calling `next(new ApiError('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED', { retryAfter }))`. |
| `n8n/booking.routes.ts` | ⚪️ | **Reclassified to OUT-OF-SCOPE (codex round 2 #10).** Earlier draft proposed "guards only" but that's contradictory: the endpoint success/error bodies pass through `handleBookingError(error, res)` at L66-73 which emits `{ error: string, code: string }` — the same shape n8n parses. Migrating L30/L44/L59 (auth + validation guards) **without** L67 (the `BookingError` mapper) and L71 (the generic 500) leaves an inconsistent contract n8n cannot parse uniformly. **Default: leave the entire file untouched.** Coordinate any future contract change with `chatbot-platform/docs/n8n-workflows/`. |
| `n8n/rag-search.routes.ts` | ⚪️ | **Reclassified to OUT-OF-SCOPE.** Same reasoning as booking: endpoint body `res.json(result)` is what n8n RAG-search parses, and the validation/error paths share that wire format. Leave entirely as-is. |
| `n8n/webhook.routes.ts` | mixed | **Disambiguate (codex rounds 1 #4 + 2 #9):** L36 (rate-limit) and L47 (validation) live **inside the inbound guard for the public `/inbound` endpoint** — part of n8n contract, leave alone. L127 (admin 503), L134 (admin 401) — admin/internal, migrate. **L177-184 (`/events` GET)** is per its file comment a legacy/testing endpoint that may have external consumers — **leave as-is until a deprecation audit confirms no external use.** |
| `n8n/webhook.controller.ts` | mixed | The **inbound webhook handler** (L47-162) is provider-facing; n8n acts on `result.success`. Leave as-is. **Genuinely admin endpoints** (`resetCircuitBreaker` L210-227, `getQueueStatus` L233-248, `retryMessage` L254-281, `getCircuitStatus` L191-203) — migrate. **`healthCheck` L168-185** is documented as the n8n integration probe endpoint — its body shape (`{ status, timestamp, circuitBreaker, services }`) may be parsed by n8n monitoring. **Leave as-is.**<br>**Async-error-propagation note (codex round 3 #9):** these methods are registered as `controller.healthCheck` / `controller.resetCircuitBreaker` etc. — they are **not wrapped in `asyncHandler`**. A typed `throw` inside an async method will NOT propagate to the global error handler; Express treats it as an unhandled rejection. Two options when migrating the admin methods:<br>(a) Wrap at the route layer: change `router.post('/circuit-reset', requireInternalAuth, controller.resetCircuitBreaker)` to `router.post('/circuit-reset', requireInternalAuth, asyncHandler(controller.resetCircuitBreaker))`. **Preferred.**<br>(b) Keep the existing `try/catch` in each method and call `next(typedErr)` instead of `res.status(500).json(...)`.<br>Pick (a) — single-line route-layer change per admin endpoint, no duplication. |
| `webhooks/billing-webhook.routes.ts` | ⚪️ | Stripe webhook receiver. Shapes `{ignored:true}`, `{received:true}`, `{alreadyProcessed:true}`, `{error:'...'}` are part of the Stripe contract. **Leave entirely as-is** — including the 500 path. (Codex round 1 #12: earlier draft suggested funneling the 500 through `next(err)`. That conflicts with the §7 regression test for exact-shape preservation. Withdrawn.) |
| `server.ts:84-90` `/health` | ⚪️ | Railway health check probe. Returns `{ status: 'healthy', timestamp }`. Probe parses HTTP status, not body shape. **Leave as-is.** (Codex round 1 #3.) |

### 3.4a Status-code preservation rules (codex round 2 #11)

When migrating, always map current status → the helper that emits the same status:

| Current code | Helper |
| --- | --- |
| `res.status(200).json({success:true, data})` or `res.json({success:true,data})` | `sendSuccess(res, data, meta?)` (200) |
| `res.status(201).json(...)` | `sendCreated(res, data)` (201) |
| `res.status(204).send()` | `sendNoContent(res)` (204) |
| `res.status(N).json({error})` for any 4xx/5xx | typed `throw` matching `N` (`BadRequestError` 400, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404, `ConflictError` 409, `ValidationError` 422, `RateLimitError` 429) **or** `throw new ApiError(msg, N, code)` for non-stock combinations (e.g. 402, 501, 502, 503). |

Specifically check during migration:
- Every `res.status(201).json(...)` site (e.g. `routes/admin.routes.ts:413`, `routes/canned-responses.routes.ts:132`, `routes/skills.routes.ts:118`, `routes/tenants.ts:292`, `file-handling/upload.controller.ts` if present) → **must** become `sendCreated`, not `sendSuccess`, to preserve 201.
- `knowledge.controller.ts:120` already emits 204; the migration should use `sendNoContent(res)` (NOT `sendSuccess(res, undefined)` which is 200).
- `upload.controller.ts` `presigned-url` and the other handlers emit 200 explicitly via `res.status(200).json(...)`; mapping to `sendSuccess` keeps 200.

### 3.4 Summary count (updated)

| Category | Files | Approx. handler/site changes |
| --- | --- | --- |
| Middleware (🔴 / 🟡) | 9 | ~45 sites |
| `src/routes` partial (🟡) | 11 | ~50 sites |
| `src/routes` heavy (🔴) | 1 (`tenants.ts`) | ~30 sites |
| Channels/knowledge/widget-appearance/file-handling (🔴) | 8 | ~65 sites |
| n8n partial (guards/admin only) | 4 | ~10 sites |
| **Portal-side error adapter (new — codex #6)** | 8 portal files | ~12 sites |
| Out of scope (⚪️) | 5 | — |

Grand total: ~210 sites across ~36 files (incl. portal).

## 4. Phased rollout

Each phase is independently shippable. The portal interceptor tolerates both old and new server shapes for **successes**. **Errors require the portal adapter to land first.**

### Phase 0 — pre-work (no behavior change)
- [ ] Add a shared error-code constants file at `chatbot-platform/api/src/middleware/error-codes.ts` exporting at minimum: `CLERK_UPSTREAM_FAILED`, `PROVISIONING_FAILED`, `FILE_SERVICE_UNAVAILABLE`, `UPSTREAM_FAILED`, `NOT_IMPLEMENTED`, `TENANT_SUSPENDED`, `REQUEST_TIMEOUT`, `RATE_LIMIT_FALLBACK`. Existing billing codes (extracted from `routes/billing.routes.ts:97`) move here too.
- [ ] Export `buildErrorResponse(err, req)` from `error-handler.ts` so the **timeout middleware** — the only middleware that cannot call `next(err)` because the original handler is still running — reuses the same envelope construction. Refactor `errorHandler` to call this internally. (Codex round 5 #9: rate-limit fallback CAN call `next(err)` per §6.2 and does not need `buildErrorResponse`. Only timeout is inline.)
- [ ] **Decide typed-error constructor policy (codex round 1 #8):** Default = leave `UnauthorizedError`/`ForbiddenError`/`NotFoundError` constructors as-is (message only); throw `ApiError(msg, status, code)` whenever a custom code is needed. (Alternative: widen those constructors. Out of scope unless we discover ≥5 sites that would benefit.)
- [ ] **Add a ZodError → ValidationError adapter in `asyncHandler` (codex round 6 #9).** Three controllers use `schema.parse(req.body|req.query)`: `widget/widget-appearance.controller.ts:37`, `knowledge/integrations.controller.ts:29`, `knowledge/knowledge.controller.ts:39/64/71/100/189/229`. On bad input, these throw `ZodError`, which today reaches `errorHandler` as a non-operational error and becomes 500/`INTERNAL_ERROR` — wrong status (should be 422) and wrong code (`VALIDATION_ERROR`). Update `asyncHandler`:<br>```ts<br>import { ZodError } from 'zod';<br>export const asyncHandler = (fn) => (req, res, next) =><br>  Promise.resolve(fn(req, res, next)).catch((err) => {<br>    if (err instanceof ZodError) {<br>      return next(new ValidationError('Validation failed', err.flatten() as unknown as Record<string, unknown>));<br>    }<br>    next(err);<br>  });<br>```<br>This is a global behavior change: every existing `parse()` call site automatically gets 422 envelopes. Add an integration test (`POST /tenants/me/widget-appearance` with invalid body → 422 with `error.code === 'VALIDATION_ERROR'` and `error.details` carrying the field-level Zod errors).

### Phase 1 — portal error adapter (codex rounds 1 #6 + 2 #1/#2 + 3 #5/#6 + 4 #3/#4/#5 — blocks Phases 2+) [~16 sites, 11 files]
**This must land before any server-side error migration**, otherwise the 15 portal call sites listed in §2.5 will start rendering `[object Object]` toasts or losing the server message entirely.
- [ ] Add `extractApiErrorMessage(error)` helper in `portal/src/services/apiClient.ts` (snippet + precedence rules in §2.5).
- [ ] Update `apiClient.ts:135::handleApiError` to use it.
- [ ] Update **all 15 portal call sites** listed in §2.5 — including `Team.tsx:486`, `AdminTenants.tsx:384`, `WidgetTest.tsx:587`, `queryConfig.ts:5::extractErrorMessage`, `useBillingQueries.ts:60::describeBillingError` (preserve the billing code→copy map on top of the helper). No site is optional. No inline `data?.error?.message ?? data?.error` fallbacks (they pass objects through).
- [ ] Vitest in `portal/src/services/__tests__/apiClient.test.ts`: asserts:
  - string-shaped `{error:'msg'}` → returns `'msg'`.
  - object-shaped `{error:{message:'msg'}}` → returns `'msg'`.
  - object-without-message `{error:{code:'X'}}` → returns `undefined` (callers fall back).
  - bare-`message` `{message:'msg'}` → returns `'msg'`.
  - **legacy rate-limit body `{error:'Too Many Requests', message:'Rate limit exceeded...'}` → returns `'Rate limit exceeded...'`** (codex round 4 #5 — `data.message` outranks string `data.error` so today's rate-limit body yields the more useful copy).
  - non-Axios `new Error('boom')` → returns `'boom'` (codex round 4 #4 — preserves the legacy `err.message` fallback that callers relied on).
  - Result is never an object.

### Phase 2 — stop the bleed: middleware (highest visibility) [~45 sites, 9 files]
Fixes the literal `{"error":"Internal server error"}` the user saw.
- [ ] `auth.middleware.ts`
- [ ] `clerk.middleware.ts`
- [ ] `tenant.middleware.ts`
- [ ] `super-admin.middleware.ts`
- [ ] `middleware/index.ts::requireAdmin` (codex #2)
- [ ] `timeout.middleware.ts` (special-case: §6.1)
- [ ] `rate-limit.middleware.ts` (wire change: §6.2)
- [ ] `rate-limit.ts`
- [ ] `security/csp.middleware.ts`

Acceptance: any auth/tenant/rate-limit failure now returns the standard envelope with `requestId`.

### Phase 3 — `src/routes/*.ts` partial files [~50 sites, 11 files]
Mostly mechanical:
- [ ] `analytics.routes.ts`
- [ ] `automations.routes.ts`
- [ ] `billing.routes.ts`
- [ ] `files.routes.ts`
- [ ] `session-management.routes.ts`
- [ ] `skills.routes.ts`
- [ ] `webhook-admin.routes.ts`
- [ ] `widget.ts`
- [ ] `admin.routes.ts` (3 sites)

### Phase 4 — `routes/tenants.ts` [~30 sites]
Single biggest churn file. Its own PR. Apply the success-with-message convention from §2.3 for L594/717/760/887/901/930.

### Phase 5 — knowledge controllers, widget-appearance controller, file-handling [~50 sites]
- [ ] `knowledge/knowledge.controller.ts`
- [ ] `knowledge/integrations.controller.ts`
- [ ] `widget/widget-appearance.controller.ts` (codex #1) — verify `widget.js:1402-1413` appearance-fetch still works (it already tolerates both shapes).
- [ ] `file-handling/upload.controller.ts` (incl. deleting the inline error router at L576-607; add multer adapter §6.4)

### Phase 6 — channels & n8n (scope-limited per §3.3)
- [ ] `channels/meta/oauth.routes.ts` — JSON endpoints only (codex round 4 #9 — explicit success mapping):
  - `GET /url` (L38: `res.json({ url })`) → `sendSuccess(res, { url })` (200, preserves status).
  - `GET /pages` (L88: `res.json({ pages })`) → `sendSuccess(res, { pages })` (200, preserves status).
  - `POST /connect` (L154: `res.status(201).json({ connections })`) → `sendCreated(res, { connections })` (preserves 201).
  - Error sites (L30, 34, 83, 90, 101, 107, 111, 128) → typed throws.
  - `/connect` catch-all adapter at L158 spelled out in §3.3 (`if (err instanceof ApiError) next(err); else next(new BadRequestError(...))`).
  - **OAuth callback redirects L51/55/66/71 preserved** (`res.redirect`, not JSON).
- [ ] `n8n/webhook.routes.ts` — **admin endpoints only**: L127 (admin not-configured), L134 (admin 401). Inbound L36/L47 preserved. `/events` legacy endpoint L177-184 deferred (open question §10).
- [ ] `n8n/webhook.controller.ts` — **genuine admin endpoints only**: `resetCircuitBreaker`, `getQueueStatus`, `retryMessage`, `getCircuitStatus`. **Wrap each at the route layer with `asyncHandler` (codex round 3 #9)** so typed throws propagate. Inbound handler preserved. `healthCheck` preserved.
- [ ] `n8n/booking.routes.ts`, `n8n/rag-search.routes.ts` — **NOT migrated** (codex round 2 #10). Leave entirely as-is; contract change requires a workflow audit.

### Phase 7 — guardrails (prevent regression)
- [ ] **ESLint rule (codex rounds 1 #10 + 3 #12).** Ban any of these patterns:
  - `res.json({ error: ... })` — old error shape.
  - `res.json({ success: true, ... })` — old success shape.
  - `res.json(<literal-object>)` — raw payload without helpers.
  - `res.status(N).json(<literal-object>)` — same.
  - **Allow-list works at line / function granularity, NOT file granularity** — files like `n8n/webhook.routes.ts` and `n8n/webhook.controller.ts` contain BOTH allowed (inbound/health) and forbidden (admin) handlers. Use `// eslint-disable-next-line <rule>` markers at the specific call sites for the contract-preserved handlers, with a comment pointing to the §5 OOS classification. The lint rule plus the markers together encode the policy.
  - **Wholly file-level allow** (every emit site in the file is OOS): `middleware/error-handler.ts`, `utils/response.ts`, `webhooks/billing-webhook.routes.ts`, `channels/meta/webhook.routes.ts`, `channels/channel-webhook.routes.ts`, `n8n/booking.routes.ts`, `n8n/rag-search.routes.ts`, `server.ts:/health` (use a line marker since the file otherwise has none of these patterns).
  - **Exclude `src/__tests__/**`** from the rule entirely — test fixtures and helpers shouldn't be lint-scoped against this policy.
  - `widget.js` is not in the TypeScript lint scope.
- [ ] Tests — see §7.
- [ ] Update `chatbot-platform/api/README.md` with the convention + helper imports + §2.2 typed-error table.
- [ ] Add an ADR at **`docs/adr/0011-api-response-envelope.md`** (codex round 3 #13 — existing ADRs go 0001-0010 in `docs/adr/`; next free number is 0011, root path not `chatbot-platform/docs/`).

## 5. Explicit out-of-scope (don't touch)

These look like our API but are **integration contracts** with external systems. Changing them silently can break integrations at the receiver.

- `channels/meta/webhook.routes.ts` — Meta's WhatsApp/Messenger webhook (codex round 5 #8 — corrected). **GET verification path** returns plain text (`200 <challenge>` or `403 Forbidden`). **POST ingress path** returns JSON: `401 {error:'Unauthorized'}`, `401 {error:'Invalid signature'}`, `400 {error:'Invalid JSON'}`, `200 {ok:true}`. Regression tests in §7.3 must pin **both** the text shapes (GET) and the JSON shapes (POST). Note the JSON error shape here is the same legacy `{error:'string'}` the rest of the migration is moving away from — but Meta's webhook consumer doesn't read the body, only the status; the shape is preserved to keep things uniform with the GET-verification pair and to avoid any chance of a regression for whatever tooling currently consumes Meta webhook delivery logs.
- `channels/channel-webhook.routes.ts` — same family for any other channel adapter.
- `webhooks/billing-webhook.routes.ts` — Stripe & co. They check status code; body is for our own logs/audit. **Including the 500 path** (codex #12).
- `n8n/webhook.controller.ts:handleInboundWebhook` (L47-162) — n8n receives the response body and acts on `result.success`. Coordinate any change with the n8n workflow templates in `chatbot-platform/docs/n8n-workflows/`.
- `n8n/webhook.routes.ts` L36 (inbound rate-limit), L47 (inbound validation) — same contract.
- `n8n/booking.routes.ts` and `n8n/rag-search.routes.ts` — entire files preserved (codex round 2 #10 + round 3 #2 — earlier draft said "guards only" which contradicted §3.3).
- `routes/admin.routes.ts:1067-1121` (CSV export) — `text/csv`, not JSON. Leave alone.
- `server.ts:84-90` `/health` — Railway probe. Returns `{ status: 'healthy', timestamp }`. Leave alone.
- Multer/file streaming endpoints that return the file bytes directly.

## 6. Special cases

### 6.1 Async-timeout middleware (`timeout.middleware.ts`)

When the timeout fires, the original handler is still running and may write later. We can't `next(err)` because Express has likely moved past this middleware. **Solution (decided): export `buildErrorResponse(err, req)` from `error-handler.ts` and call it inline.**

```ts
const timeoutErr = new ApiError('Request timeout', 503, 'REQUEST_TIMEOUT');
res.status(503).json(buildErrorResponse(timeoutErr, req));
```

`buildErrorResponse` becomes the single source of envelope construction for both the global handler and these inline cases.

**`errorHandler` must guard against double-write but still log (codex rounds 4 #2 + 5 #7).** Naïvely placing `if (res.headersSent) return next(err)` at the very top means post-timeout errors get no logging or Sentry capture. Instead: log + Sentry-capture **first**, then delegate to Express's default finalizer if headers are already sent:

```ts
export const errorHandler = (err, req, res, next) => {
  // Always log + Sentry the new error, even if we can't write a body.
  const statusCode = err instanceof ApiError ? err.statusCode : 500;
  if (statusCode >= 500) {
    logger.error('Server error (response already sent)', { /* ...full context... */ });
    Sentry.captureException(err);
  } else if (statusCode >= 400) {
    logger.warn('Client error (response already sent)', { /* ...full context... */ });
  }

  // If timeout (or another inline writer) already responded, do NOT write again.
  // Delegate to Express's default error handler which will close the connection cleanly.
  if (res.headersSent) {
    return next(err);
  }

  // ...existing envelope construction via buildErrorResponse + res.status(...).json(...)
};
```

The integration test for `timeoutMiddleware` should explicitly assert: handler throws after timeout fires → response body is the timeout envelope (single write), no double-send crash, **and** the post-timeout error is still captured in the logger output / Sentry mock.

### 6.2 Rate-limit wire format (codex round 1 #9 + round 2 #3, #4 — explicit contract change)

**Today** (`rate-limit.middleware.ts:121-135` style):
```json
{ "error": "Too Many Requests", "retryAfter": 42, "message": "Rate limit exceeded. Please try again later." }
```

**After migration:**
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded. Please try again later.",
    "details": { "retryAfter": 42 }
  },
  "meta": { "timestamp": "...", "requestId": "...", "path": "..." }
}
```

The `Retry-After` HTTP header is unchanged and remains the canonical place for clients to look.

**Two code variants:**
- **Normal path** (rate-limiter returned a `RateLimiterRes`): `next(new RateLimitError('Rate limit exceeded. Please try again later.', { retryAfter }))` → `error.code === 'RATE_LIMIT_EXCEEDED'`.
- **Fallback path** (Redis errored, in-memory fallback exhausted): use `next(new ApiError('Rate limit exceeded (fallback).', 429, 'RATE_LIMIT_FALLBACK', { retryAfter }))` (codex round 2 #3 — `RateLimitError` constructor pins code to `'RATE_LIMIT_EXCEEDED'`; if we need a different machine-readable code, we MUST use `ApiError`).

**Functions to migrate (codex round 2 #4 — complete list):**

In `middleware/rate-limit.middleware.ts`:
- `rateLimitByIp` (L102-136) — 2 emit sites: L121 fallback, L130 normal.
- `rateLimitByTenant` (L141-180) — 2 sites: L165 fallback, L174 normal.
- `rateLimitWidget` (L185-221) — 2 sites: L206 fallback, L215 normal.
- combined `rateLimit` (L227-275) — 2 sites: L259 fallback, L268 normal.

In `middleware/rate-limit.ts` (codex round 4 #6 — these use **different field names** than `rate-limiter-flexible`'s `RateLimiterRes`, so the generic "compute msBeforeNext" step does not apply):
- `createRedisRateLimiter` (L34-100, emit at **L65-72**) — uses `const ttl = await redis.ttl(key)` (L53) for the retry estimate. Migration:
  1. Compute `ttl` as today (L53).
  2. `res.setHeader('Retry-After', String(ttl))` (already done at L54).
  3. Replace L65-72 with `return next(new RateLimitError('Rate limit exceeded. Please try again later.', { retryAfter: ttl }))`.
- `slidingWindowLimiter` (L188-220, emit at **L214-219**) — uses `const resetTime = parseInt(oldest[1], 10) + windowMs` (L207). Migration:
  1. Compute `retryAfter = Math.ceil((resetTime - now) / 1000)` as already done at L209.
  2. Header already set.
  3. Replace L214-219 with `return next(new RateLimitError('Rate limit exceeded. Please try again later.', { retryAfter }))`.

In application code:
- `routes/widget.ts:46` — `res.status(429).json({ error: 'Too many requests, please try again later' })`. Per-session creation gate. Migrate same way.

In `file-handling/upload.controller.ts`:
- `uploadRateLimiter` (L46-58) and `statusCheckLimiter` (L61-66) — `express-rate-limit` instances. Add a `handler` option to each: `handler: (req, _res, next) => next(new ApiError('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED', { retryAfter: req.rateLimit?.resetTime ? Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000) : undefined }))`. **Do NOT** keep the `message: {...}` option — `handler` takes precedence; leaving both is confusing.

**Steps per emit site:**

**Normal path (limiter rejected with a `RateLimiterRes`):**
1. Compute `retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000)` as today.
2. `res.setHeader('Retry-After', String(retryAfter))`.
3. `return next(new RateLimitError('Rate limit exceeded. Please try again later.', { retryAfter }))`.

**Fallback path (Redis errored, in-memory `fallbackConsume` rejected — codex round 3 #7):**
`fallbackConsume(key, max, windowMs)` returns only a `boolean`; it does NOT expose a `msBeforeNext`. There is no `retryAfter` to set. Steps:
1. **Do NOT** set `Retry-After` header (no estimate available — would mislead clients).
2. `return next(new ApiError('Rate limit exceeded (fallback). Please try again later.', 429, 'RATE_LIMIT_FALLBACK'))` — no `details` arg.

Document this asymmetry in the ADR: clients that depend on `Retry-After` should treat its absence as "retry with backoff" (HTTP RFC 7231 §7.1.3 allows this). The body's `code` field distinguishes `RATE_LIMIT_EXCEEDED` (header present) from `RATE_LIMIT_FALLBACK` (header absent).

Callers consuming the body's top-level `retryAfter` must move to `error.details.retryAfter`. **Audit:** no portal call site reads `retryAfter` from the body (grep is empty); `widget.js` does not read it either. The change is internally safe but is documented as a contract bump in the ADR.

### 6.3 Socket.IO middleware

Socket.IO's `(socket, next: (err?: Error) => void)` contract differs from Express. Socket auth/tenant middlewares (`auth.middleware.ts:242-287`, `tenant.middleware.ts:129-172`) keep `next(new Error('...'))` — Socket.IO emits `connect_error` events to the client. Don't try to use `ApiError` here.

### 6.4 Inline error sub-routers (multer in `upload.controller.ts`)

Removing `upload.controller.ts:576-607` lets errors bubble to the global handler. But the routed errors include framework errors (multer `LIMIT_FILE_SIZE`, etc.) that aren't `ApiError`s. Add the adapter at the point of failure or right before the global handler.

**Codex round 2 #6 correction:** `BadRequestError(msg, details)` and `RateLimitError(msg, details)` put the `code` field of `details` into `error.details.code` — `error.code` itself stays `'BAD_REQUEST'` / `'RATE_LIMIT_EXCEEDED'`. To get a real custom machine code, use `ApiError` directly:

```ts
// upload.controller.ts — replacement for the deleted inline router:
import multer from 'multer';
router.use((err: Error, _req: Request, _res: Response, next: NextFunction) => {
  if (err instanceof FileValidationError) {
    return next(new ApiError(err.message, 400, 'FILE_VALIDATION_FAILED'));
  }
  if (err instanceof QuotaExceededError) {
    return next(new ApiError(err.message, 429, 'QUOTA_EXCEEDED'));
  }
  if (err instanceof multer.MulterError) {
    return next(new ApiError(err.message, 400, err.code)); // multer codes like LIMIT_FILE_SIZE
  }
  return next(err);
});
```

This is a thin *adapter*, not the old envelope-emitter. Global handler still produces the response.

### 6.5 `/health` and webhook receivers

See §5. **Do not** add `next(err)` or `sendSuccess` to these. The §7 regression tests pin their exact shapes.

## 7. Test strategy

Two distinct test layers (codex #11 split this out):

### 7.1 API integration tests — assert the wire envelope
Per migrated file, one supertest hitting failure → assert raw response body:
```ts
expect(body).toEqual({
  success: false,
  error: expect.objectContaining({ code: 'NOT_FOUND', message: expect.any(String) }),
  meta: expect.objectContaining({ requestId: expect.any(String), path: '/api/...', timestamp: expect.any(String) }),
});
```
And one hitting success → assert `{ success: true, data: <shape> }`. These tests do **not** go through the axios interceptor.

### 7.2 Portal vitest — assert interceptor unwrap
- `apiClient` enveloped success → caller sees unwrapped `data`.
- `apiClient` enveloped success with `meta` → caller sees `{ data, meta }`.
- `apiClient` error with object `error` → `extractApiErrorMessage` returns the string.
- `apiClient` error with legacy string `error` → `extractApiErrorMessage` still returns the string.

### 7.3 Webhook regression tests
One supertest per OOS endpoint in §5 asserting the exact body shape and status code Stripe/Meta/n8n expects (regression guard if someone "fixes" them later).

## 8. Risk register

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Portal toasts render `[object Object]` after a server error migration | **High** if Phase 1 skipped | Phase 1 (portal adapter) is now a hard prerequisite for Phases 2+. |
| Webhook receiver shape accidentally migrated | Medium | §5 list + §7.3 regression tests + ESLint allow-list (§4 Phase 7). |
| `Retry-After` semantics drift during rate-limit migration | Low | §6.2 explicit contract + integration test asserting both header and `error.details.retryAfter`. |
| Widget embed script breaks on enveloped widget-appearance response | Low | `widget.js:1402-1413` already does `body.data || body`. Verify in a smoke test before shipping Phase 5. |
| Inline error router deletion in `upload.controller.ts` causes multer errors to become 500s | Low | §6.4 adapter shipped in the same PR. |
| n8n workflow misparses the new envelope after a careless full migration | Medium | Phase 6 is scope-limited (codex round 4 #8 — earlier draft said "guards only" which contradicts the admin-endpoint migration in §3.3 / Phase 6). Actual scope: admin endpoints in `n8n/webhook.routes.ts` (L127/L134) and admin methods on `n8n/webhook.controller.ts` migrate; inbound handler, `healthCheck`, `/events`, `n8n/booking.routes.ts`, and `n8n/rag-search.routes.ts` preserved. ESLint allow-list (Phase 7) pins the preservation. |
| `ApiError(msg, 401, 'CUSTOM_CODE')` accidentally written as `new UnauthorizedError(msg, { code })` (would TS-error) | Low | §2.2 table; TS strict-mode catches it at compile time. |

## 9. What this plan does NOT do

- Doesn't change HTTP status codes — only response *shape* (rate-limit body shape is the one explicit exception, documented in §6.2).
- Doesn't introduce new error codes beyond the small list in Phase 0.
- Doesn't touch the Sentry / logger integration — `errorHandler` already does it.
- Doesn't change auth flows, business logic, or external contracts.
- Doesn't widen typed-error constructors — `ApiError` is the escape hatch for custom codes.

## 10. Open questions

- ✅ **`channels/meta/oauth.routes.ts:158` 400-mapping behavior** (codex round 2 #8): **RESOLVED in Phase 6** (commit cdad261). Adapter ships at the catch-all keeping current 400-for-unknown behavior; `ApiError`s propagate with their real status. Wire test in `phase6-channels-n8n-wire.test.ts` pins both branches (ApiError 402 propagates; plain Error → 400 fallback).
- **`n8n/webhook.routes.ts:177-184` `/events` endpoint**: legacy/testing per file comment. Are there external consumers (older n8n flows, monitoring scripts)? Audit before migrating. **Still open** — the endpoint stays as-is per plan §5 until the audit happens.
- **`file-handling/upload.controller.ts` mount status** (codex round 3 #10): `uploadRouter` is exported but no `server.ts` use mounts it. **Phase 5C migrated the file as cleanup-only** (commit 7b89cdc) so it's wire-ready if someone mounts it. Decision **still open**: mount it at `/api/v1/uploads` or delete the file. Follow-up issue worth filing.
- **Global middleware that fronts OOS routes** (codex rounds 3 #8 + 4 #1 — **expanded after re-grep**): the `server.ts` middleware order is:
  - L94/97/103: clerk/meta-inbound/billing webhook receivers — mounted **before** `rateLimitByIp` (L196), so unaffected.
  - L196: `app.use(rateLimitByIp)`.
  - L237: `app.use('/api/v1', apiRouter)`. Anything under `apiRouter` is fronted by `rateLimitByIp`.
  - L215: `apiRouter.use(timeoutMiddleware(30000))` — fronts everything registered on `apiRouter` after this line.
  - L347: `apiRouter.use('/webhooks', webhookModule.router)` — **n8n inbound webhook is here, fronted by BOTH `rateLimitByIp` and `timeoutMiddleware`** (codex round 4 #1).
  - L382: `apiRouter.use('/internal/rag', ragSearchRoutes)` — fronted.
  - L385: `apiRouter.use('/internal/booking', bookingRoutes)` — fronted.
  - L393: `apiRouter.use(channelWebhookRoutes)` (mounts `/channels/:channel/webhook`) — fronted.
  - L395: `apiRouter.use('/channels/meta/oauth', metaOAuthRoutes)` — fronted.

  **Impact:** if Phase 2 changes `rateLimitByIp` and `timeoutMiddleware` to emit the new envelope, the §5 OOS endpoints (n8n inbound, channel webhooks, RAG, booking) will receive the new envelope **on rate-limit or timeout events**. That's a contract change for these endpoints' edge cases.

  **Decision options (must pick before Phase 2):**
  - **(a) Path-filter the migrated middlewares.** Add a body-shape carve-out inside the migrated `rateLimitByIp` and `timeoutMiddleware`. **Use `req.originalUrl` (NOT `req.path`)** — codex round 5 #3 — because `timeoutMiddleware` runs inside `apiRouter` where `req.path` is mount-relative (`/inbound`, not `/api/v1/webhooks/inbound`). Skip list (codex round 5 #4 — corrected from earlier draft):
    - `/api/v1/webhooks/inbound` (n8n inbound — the actual mount; earlier draft said `/api/v1/webhooks/n8n/inbound` which is wrong).
    - `/api/v1/webhooks/health` (n8n health probe).
    - `/api/v1/webhooks/events` (n8n legacy events endpoint).
    - `/api/v1/internal/rag`, `/api/v1/internal/booking`.
    - `/api/v1/channels/*/webhook` (channel webhook receivers).
    - `/api/v1/channels/meta/oauth/callback` and any other OAuth redirect path that should keep its redirect contract on rate-limit (browser-facing, not JSON).
  - **Critical clarification (codex round 5 #5):** the path filter changes ONLY the response body shape when a limit is exceeded / timeout fires. It must NOT bypass rate limiting or timeout enforcement for these paths — providers can still hammer us, and we still want timeouts to abort runaway requests. The carve-out is purely about the envelope wire shape.
  - **(b) Accept the contract change for rate-limit/timeout edge cases.** n8n and channel webhooks already retry on any non-2xx, and the new envelope is still a 429/503. Risk: monitoring or log-parsers downstream of the providers may key off the old body shape. Lower-effort but requires explicit sign-off.
  - **(c) Re-mount OOS routes BEFORE `rateLimitByIp` / `timeoutMiddleware`.** Move L347/L382/L385/L393 out of `apiRouter` into an earlier `app.use('/api/v1/...', ...)` mount. Highest churn; reorders middleware in a non-obvious way.

  **Default: (a).** Body-shape carve-out inside both middlewares keyed on `req.originalUrl` against a `LEGACY_ENVELOPE_PATHS` regex, regression-test that the OOS routes still emit the legacy 429/503 shape, and move on. The skip list lives next to the migration code so it's discoverable.
- **`knowledge.controller.ts:183` null-payload contract** (codex round 3 #11 — partially resolved in §3.3 + §2.3): caller-tolerance audit is part of Phase 5 implementation, not pre-decided here. PR must include grep evidence of the portal call site reading the response.

(Codex rounds 1, 2, and 3 items all resolved or surfaced as open questions above. If round 4 raises new ones, append here.)

---

**Next step:** review this revision, then I can start with Phase 1 (portal adapter) as a single PR. That unblocks Phase 2 (middleware) which kills the user-reported `{"error":"Internal server error"}`. Each subsequent phase is its own PR.
