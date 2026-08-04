# Widget file upload — code complete, shipped OFF, needs a go/no-go

**Status as of 2026-08-05:** the path works end to end and is deployed, but the attach
button is hidden for every tenant until someone answers the questions at the bottom of this
page. Turning it on is a security posture decision, not a bug fix.

> This document previously described a ~2-day, four-PR rebuild, and it stayed wrong for two
> months. The server half had already shipped; only the widget client was still calling a
> route that does not exist. The old plan is in git history if anyone wants to see how far
> off it was — including a "fix this FIRST" blocker that had already been closed by the
> `UploadSession` entity and its migration.

## What was actually broken

One function. `uploadFile()` in `api/public/widget.js` POSTed to
`/api/v1/uploads/presigned-url` — a route exported by `file-handling/upload.controller.ts`
and **never mounted**, so every upload 404'd. It also authenticated with `X-API-Key` (which
identifies a tenant, not a chat session) and passed `tenantId` / `chatSessionId` as client
body fields, which is exactly the untrusted binding the real endpoint refuses.

The correct endpoints had existed since the booking file-upload work:

- `POST /api/v1/widget/files/upload` — `authenticateWidget`, plan-gated on `fileUpload`,
  tenant and chat session taken from the **server-trusted token**, returns
  `{ data: { upload: { sessionId, uploadUrl, expiresAt } } }` and deliberately **no**
  `publicUrl`.
- `POST /api/v1/widget/files/:sessionId/upload-complete` — rejects a session belonging to
  another tenant or another chat with the same 404 as a missing one (no existence oracle),
  terminal-idempotent, runs the scan.

The widget was simply never rewired to them. `upload.controller.ts` has now been deleted —
it was dead, and it is what made this look like a rebuild every time someone looked at it.

## What changed

- `widget.js` calls the real endpoints with the Bearer widget token, reads the correct
  envelope shape, and **calls `upload-complete`** — without which the row stays `pending`
  forever and `getReadySessionFileIds` never sees it. That call is the difference between
  "404s" and "appears to work but silently loses the file".
- Quarantined uploads show a generic rejection; scan details are never sent to the visitor.
- The message chip renders name and size only — a file must not be linkable before the scan
  clears it.
- The picker's MIME list mirrors the server allowlist, instead of wildcards that let svg,
  webm and legacy `.doc` through only to fail after the customer waited for the upload.
- The attach button is gated on the **server's** `features.fileUploadEnabled`, which
  defaults to `false`. The embed option alone defaulted to `true`, which is why every widget
  on every site showed a button whose uploads then failed.
- Server: `FileValidationError` → 400 and `QuotaExceededError` → 429 (both previously
  reached the visitor as a 500 "something went wrong on our end"), plus a 503 when storage
  is not configured.

## Before this is switched on

Each of these is a decision, not a task:

1. **Virus scanning is OFF in production.** `config.clamav.enabled` is `!!CLAMAV_HOST`, and
   `scanFile` short-circuits to `{ clean: true }` when disabled — so every visitor file
   would be stamped `ready` without being read. Provision ClamAV, accept the risk
   explicitly, or make the scan step fail closed when scanning is unavailable.
2. **No durable storage quota.** The cap is an in-memory map, per-replica, reset on every
   deploy. Anonymous visitors uploading 25 MB files is a real cost and abuse vector.
3. **`fileUploadEnabled` has no portal UI.** It exists on the entity and in the
   `/widget/config` response, and the server route enforces only the *plan* gate. Gating on
   it (as the widget now does) means the feature ships dark until a toggle is built — and
   the server should check it too, next to `requireFeature`.
4. **Free-tier UX.** Hide the attach button, or show it and surface the 402 as an upgrade
   prompt?
5. **Should a completed upload become a chat `Message`?** Today, outside a booking, a
   successful upload is visible to nobody but the visitor who uploaded it. Persisting it
   would also trigger an AI turn, with cost and prompt-behaviour implications.
6. **TOCTOU on the presigned PUT** — a client can re-upload different bytes to the same key
   after the scan passes, bounded only by the 300s URL TTL. A real fix pins the ETag at scan
   time and verifies it when preview/download URLs are minted. Accept as a documented
   limitation, or block on it?

## Verifying

Use the embed snippet from **EmbedWidgetCard**, which points at the API origin. The Widget
Test page builds its snippet from `window.location.origin` (the portal), which neither
serves nor proxies `/widget.js` — that snippet 404s for an unrelated reason and will send
you chasing the wrong bug.

`widget.js` is served from this repo (`api/public/widget.js` via `GET /widget.js`, with a
5-minute revalidating ETag), so an API deploy reaches every customer embed within minutes.
