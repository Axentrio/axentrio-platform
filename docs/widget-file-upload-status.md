# Widget file-upload — broken in production, needs proper rebuild

The chat widget exposes a file-attach button (`api/public/widget.js:2110/2121`) that calls `uploadFile()` at `widget.js:2167-2225`. **Every call to that handler currently returns 404 and shows the user `"Failed to upload file. Please try again."`** This has been true since at least the initial commit; nothing in the repo's history suggests it ever worked.

This document describes what's broken, why, and what a real fix requires. It is a discovery + follow-up plan, not a decision — product/security needs to weigh in on UX, plan-gating, and infrastructure.

## What's broken

Three independent failures stack:

### 1. The endpoint is unmounted

`widget.js:2177` hits `POST /api/v1/uploads/presigned-url`. That route lives in `chatbot-platform/api/src/file-handling/upload.controller.ts` and is exported as `uploadRouter` at the bottom of the file. **Nothing in `server.ts` mounts it.** A grep across the entire api source confirms no `app.use(...uploadRouter)` or `apiRouter.use(...uploadRouter)` site exists.

The mounted file path is `/api/v1/files/*` (`routes/files.routes.ts`) — three endpoints (upload presigned URL, preview signed URL, download signed URL). The widget doesn't call those.

### 2. Auth scheme mismatch

Even if `uploadRouter` were mounted, the widget's existing call wouldn't authenticate:

- Widget sends `'X-API-Key': this.config.apiKey` (widget.js:2181).
- `uploadRouter` uses `authenticateAgent` (alias `authenticateJWT`) which expects `Authorization: Bearer <agent-JWT>` and rejects token types other than `'agent'`. Widget sessions use `type: 'widget'` per `auth.middleware.ts::generateWidgetToken`.

The widget would get a 401 even with the route mounted.

### 3. Widget doesn't store its JWT

The server's `/widget/init` returns a session JWT (`token`) in the response body — see `widget.routes.ts:173,277`. **The widget JS never captures it.** Look at `widget.js::_initSession` (around L1485-1530): it stores `data.session.id`, `data.session.tenantId`, `data.visitorId` to localStorage but doesn't touch `data.token`.

The widget uses Socket.IO for messages (which has its own auth handshake) and `X-API-Key` for the one HTTP call that actually works (`/widget/init`). The upload flow is the only HTTP endpoint that was *supposed* to use the JWT but the plumbing was never finished.

## What a real fix looks like

Two design choices intersect. Pick from each:

### Choice 1 — where the new endpoints live

A. **`/api/v1/widget/files/*`** — add to `routes/widget.ts`, use `authenticateWidget` (already proven on `/widget/messages` etc.). Tenant-scoped via the widget session.

B. **Add widget-auth support to `routes/files.routes.ts`** — make the existing Clerk-only `/files/*` accept widget JWTs too via a multi-auth middleware. More surface change; mixing auth schemes on one router is a code smell.

**Recommendation: A.** Self-contained, follows the established widget endpoint pattern, no auth-scheme mixing.

### Choice 2 — server endpoints

Three handlers needed:

1. **`POST /api/v1/widget/files/upload-init`** — body: `{ fileName, fileSize, mimeType }` (chatSessionId comes from `req.widget.sessionId`, tenantId from `req.widget.tenantId`). Calls `uploadService.generateUploadUrl(...)`. Returns `{ sessionId, uploadUrl, publicUrl, expiresAt }`.

2. **`POST /api/v1/widget/files/:sessionId/upload-complete`** — the scan trigger. Same shape as the existing `/files/:sessionId/upload-complete` from PR1 (commit `2b5ff34`) but on widget-auth. Calls the existing `performScan` from `file-handling/virus-scan-trigger.ts` (the shared module is already ready for this).

3. (Optional) **`POST /api/v1/widget/files/:sessionId/cancel`** — clean up session if the user aborts mid-upload. Nice-to-have.

### Choice 3 — widget client changes

`widget.js` updates:

- Capture `data.token` in `_initSession` and persist alongside `sessionId` / `tenantId` (localStorage + the in-memory `this.token`).
- `_initSession` restoration path: read `token` back from storage.
- `uploadFile`: send `Authorization: Bearer ${this.token}` (drop `X-API-Key`), hit `/api/v1/widget/files/upload-init`.
- After the S3 PUT succeeds, call `POST /api/v1/widget/files/:sessionId/upload-complete`. Block the message-send until scan returns `ready`. On `quarantined`, show a clear UX: "This file was rejected because it failed our security scan."
- Cache-bust the widget asset — bump `WIDGET_VERSION` so customer-embedded copies refetch.

### Choice 4 — plan-gating

The server's `files.routes.ts:47` plan-gates uploads via `requireFeature(tenantId, 'fileUpload', 'plan_limit_file_upload')`. The new widget endpoint should do the same. Decision: does free tier get widget uploads, or do we want a clear "upgrade" message when a free-tier visitor tries to attach?

### Choice 5 — UX for quarantined files

The scan returns `{ status: 'quarantined', scanResult: { threats: [...] } }` on infection. The widget should:
- NOT add the file to the conversation message.
- Show a localized error toast ("This file was rejected because it failed a security scan").
- Optionally log to Sentry so we can detect malicious-user patterns per tenant.

Decision point: do we want to surface the threat name to the user, or just the generic message? (Recommendation: generic — threat names can be confusing or exploitable.)

## Effort estimate (revised after codex design review)

The original "half a day" estimate assumed the upload-session storage and the chat-message-persistence pieces were already sound. Codex review of the draft design (see "Codex findings on the draft design" below) surfaced two foundational issues that must land before any widget upload work is safe to ship:

| Item | Effort |
| --- | --- |
| Persist `UploadSession` to DB or Redis (codex #5) — also closes a latent bug in the PR1 portal endpoint | ~half day |
| Wire upload completion into chat-message persistence + agent-emit + n8n-forward (codex #3) | ~half day |
| Original server endpoint + widget client + tests + smaller fixes (codex #1, #2, #6, #7, #8, #9) | ~half day |
| E2E manual verification through a real widget embed | ~1 hour |
| **Realistic total** | **~1.5–2 days**, plus product sign-off on Choices 4 and 5 |

## Codex findings on the draft design (must address before implementation)

A draft design (extracted to `.scratch/widget-upload-design.md` during the planning session) went through codex review and returned `VERDICT: CHANGES_REQUESTED` with 9 findings. They split into three tiers:

### 🔴 Foundational — fix BEFORE widget upload work starts

**#5 In-memory upload-session Map.** `upload.service.ts:540` stores `private sessions = new Map(...)`. Two consequences:
- On Railway with horizontal scaling, `/upload-init` and `/upload-complete` can land on different replicas → `getSession` returns undefined → 404 on every upload.
- Any deploy/restart between init and complete loses all sessions.

**Important**: this issue also affects the **already-shipped** PR1 portal endpoint (`POST /api/v1/files/:sessionId/upload-complete` from commit `2b5ff34`) — it just hasn't been bitten because nothing in production exercises it. The widget rebuild would expose it.

Fix options:
- **(A) Persist `UploadSession` to DB.** New TypeORM entity, update `upload.service.generateUploadUrl` to insert, `getSession` to load, `updateSessionStatus` to update. ~100 lines. Right long-term solution.
- **(B) Stateless sessionId via signed JWT.** `/upload-init` returns a JWT carrying `{chatSessionId, tenantId, fileKey, expiresAt}`; `/upload-complete` decodes instead of looking up. ~60 lines but changes the upload.service contract and complicates idempotency tracking.

**Recommendation: A.** B's contract changes ripple into anything else that calls `getSession` (currently nothing live, but the unmounted `upload.controller.ts` has 5 usages). A keeps the existing in-memory API as a fallback / dev mode if needed.

**#3 Clean-file path doesn't persist as a chat message.** The draft `addMessage` call is local UI only. Real chat persistence flows through Socket.IO + the Message entity; agents on the other side never see the attachment, history doesn't include it, n8n isn't forwarded. Need to mirror how widget message-send currently works — study `widget.routes.ts` POST `/messages` and the socket emit pattern, replicate for file messages.

### 🟠 Important — fold into the widget PR

**#1 Stale cached widget sessions have no `token`.** Existing widget installs have localStorage entries from before this change. After deploy, the restoration path would set `this.token = undefined` and `uploadFile` would always show the generic "still connecting" error. Fix: in `_initSession`'s restore path, if no `token` was persisted, force re-init.

**#2 Audit log silently fails for widget uploads.** `req.widget.visitorId` is `"widget-${random}"` (widget.js:1493) — not a UUID. `audit_logs.actor_id` is `uuid NOT NULL`. Same class of bug as the round-1 #2 in the audit-logging work. Fix options: (a) skip audit on widget uploads (lose traceability), (b) add an `actor_visitor_id` column to `audit_logs` typed as `text`, (c) store `visitorId` in `metadata` and use a synthetic system UUID for `actor_id`. Recommend (c) for v1.

**#6 Closed/stale chat session not checked.** Widget JWT lives 7 days; the chat session could be closed (agent ended it, timeout). Upload-init would succeed against a dead conversation. Fix: load `ChatSession` and reject if `status === 'closed'` — matches the existing pattern in widget message-send (`widget.routes.ts:373`).

**#7 `threats[]` returned in the quarantined response.** Leaks threat names to browser devtools, violates the confirmed Q2=A (generic-message-only) UX. Fix: replace the response's `scanResult` field with a minimal `{ status, message }` shape — server still emits the full audit row internally, but the client gets only the user-facing message.

**#8 `FileValidationError` / `QuotaExceededError` reach the global handler as 500s.** Those are custom error classes from `upload.service`; nothing in `routes/widget.ts` or `routes/files.routes.ts` adapts them to 4xx envelopes. (PR1's portal endpoint has the same gap.) Fix: small adapter middleware on both endpoints converting them to `BadRequestError` / `RateLimitError` respectively. The unmounted `upload.controller.ts:566` already does this — port the pattern.

**#9 Missing `isS3Configured()` guard on the widget endpoint.** Portal route has it → returns clean 503. New widget route must too.

### ⚪ Documented limitation, deferred

**#4 TOCTOU on presigned URL re-upload.** Same as PR1 — a malicious client can re-upload to the same key after scan completes. Real fix needs ETag/version pinning at scan time + ETag verification when preview/download URLs are minted. Separate security ticket. v1 mitigation: short presigned-URL TTL (existing default).

## What's ready today

PR1 (commit `2b5ff34`) already shipped the shared `performScan` module at `file-handling/virus-scan-trigger.ts`. It handles:
- Session status updates (`scanning` → `ready` / `quarantined` / `failed`).
- Audit emission (`FILE_SCAN_COMPLETED` / `FILE_QUARANTINED`).
- File deletion on infection.
- Thumbnail generation on clean scans (if applicable).
- Per-sessionId concurrent-call dedup (codex round PR1 #2).
- 25s timeout to fit under the apiRouter global 30s timeout.

The new widget endpoint just needs to call `performScan(sessionId, fileKey)` after verifying `uploadService.fileExists(fileKey)` — exactly like `files.routes.ts::POST /:sessionId/upload-complete` already does.

## What was just cleaned up

The `chore` commit paired with this document removes:

- `portal/src/services/fileService.ts` — methods `uploadFile`, `downloadFile`, `getPreview`, `validateFile`, `getFileIcon`. None had any portal callers. `formatFileSize` stays (used by `FilePreview.tsx`).
- `portal/src/hooks/useFilePreview.ts` — entire file. Re-exported from `hooks/index.ts` but no `.tsx` consumer.
- `portal/src/types/index.ts::FilePreview` interface — only consumer was the deleted hook.
- `portal/src/config/api.config.ts::ENDPOINTS.files` block — only consumer was the deleted `fileService` methods.

The server-side `/api/v1/files/*` routes stay mounted and tested (PR1 hooked the `/upload-complete` endpoint into the same router). When portal-side or widget file-upload work resumes, the server contract is already established.

## Recommended sequence

1. **PR-Persistence first.** `UploadSession` to DB (codex #5). Standalone PR. Also unblocks the existing PR1 `/files/:sessionId/upload-complete` endpoint for real production use. ~half day.
2. **PR-Chat-message-persistence.** Wire the upload completion result into a proper Message entity + socket emit + n8n forward (codex #3). Could happen in the same PR as widget, but isolating it makes review easier. ~half day.
3. **PR-Widget upload.** New `routes/widget.ts` endpoints (`/files/upload-init`, `/files/:sessionId/upload-complete`) using `authenticateWidget`, with all the smaller fixes (#1, #2, #6, #7, #8, #9) folded in. Plus widget.js JWT plumbing and `uploadFile` rewrite. ~half day.
4. **Manual E2E verification.** Pro-tier tenant: clean upload + EICAR file. Free-tier tenant: plan-limit toast. ~1 hour.

Each PR is independently mergeable. Stop after step 1 if appetite ends — the persistence work alone closes the hidden bug in PR1 and is valuable on its own.

## What I would NOT do

Mount `uploadRouter` "to make the widget work." It wouldn't — auth scheme mismatch — and it duplicates surface that `files.routes.ts` already provides cleanly. The right path is the new widget endpoint described above, not resurrecting the unfinished `upload.controller.ts` router. When the widget work lands, `upload.controller.ts` should be deleted in the same PR (it has migrated tests but is genuinely dead code).

## Related

- PR1 commit `2b5ff34` — the shared `performScan` module and the Clerk-authenticated `/files/:sessionId/upload-complete` endpoint. **Note: depends on the in-memory upload-session Map (codex #5); production use of this endpoint is blocked until session persistence ships.**
- ADR `docs/adr/0011-api-response-envelope.md` — the response envelope convention any new endpoints must follow.
- `chatbot-platform/api/scripts/check-envelope-conventions.sh` — the lint guardrail that will catch ad-hoc shapes in new routes.
