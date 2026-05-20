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

## Effort estimate

- Server (2 new endpoints + tests): ~3 hours.
- Widget client (token plumbing + upload flow + UX): ~2 hours.
- E2E manual verification through a real widget embed: ~1 hour.
- Total: half a day, plus product sign-off on Choices 4 and 5.

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

## What I would NOT do

Mount `uploadRouter` "to make the widget work." It wouldn't — auth scheme mismatch — and it duplicates surface that `files.routes.ts` already provides cleanly. The right path is the new widget endpoint described above, not resurrecting the unfinished `upload.controller.ts` router. When the widget work lands, `upload.controller.ts` should be deleted in the same PR (it has migrated tests but is genuinely dead code).

## Related

- PR1 commit `2b5ff34` — the shared `performScan` module and the Clerk-authenticated `/files/:sessionId/upload-complete` endpoint.
- ADR `docs/adr/0011-api-response-envelope.md` — the response envelope convention any new endpoints must follow.
- `chatbot-platform/api/scripts/check-envelope-conventions.sh` — the lint guardrail that will catch ad-hoc shapes in new routes.
