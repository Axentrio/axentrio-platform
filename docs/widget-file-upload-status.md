# Widget file upload — live for plans that include `fileUpload`

**Status as of 2026-08-31:** the path works end to end and is deployed. The attach button is
visible whenever the tenant's plan includes the `fileUpload` entitlement, and hidden for every
plan that does not. There is no per-bot switch. Virus scanning is **on** as of 2026-08-31,
backed by a ClamAV service on Railway, and verified with a real EICAR upload.

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
- The attach button is gated on the **plan** `fileUpload` entitlement, which `/widget/config`
  answers. It starts `false` in the browser, so the button stays hidden until the server says
  otherwise. The embed option alone defaulted to `true`, which is why every widget on every
  site showed a button whose uploads then failed.
- Free tenants never receive that entitlement, so they never see the attach button and the
  402 upgrade path is unreachable from the widget UI.
- Server: `FileValidationError` → 400 and `QuotaExceededError` → 429 (both previously
  reached the visitor as a 500 "something went wrong on our end"), plus a 503 when storage
  is not configured.

## Open risks, live right now

Upload is on, so these are no longer pre-launch decisions. Each is a risk being carried:

1. **Virus scanning is ON, and it fails closed.** Provisioned on 2026-08-31 with
   `scripts/provision-clamav.sh`. `CLAMAV_HOST=clamav.railway.internal`, `CLAMAV_PORT=3310`,
   backed by the `clamav` service (image `clamav/clamav:1.4`) and a volume at
   `/var/lib/clamav`. Verified end to end through `POST /widget/files/:id/upload-complete`:

   | Upload | Result |
   | --- | --- |
   | 1x1 PNG | `status: ready`, `clean: true`, `scanDurationMs: 542` |
   | EICAR signature | `status: quarantined`, `threats: ["Eicar-Test-Signature"]`, 496 ms |

   A non-zero `scanDurationMs` is the tell. The disabled path returned `0`, because
   `scanFile` short-circuited to `{ clean: true, scanDurationMs: 0 }` and stamped every file
   `ready` without reading it. Re-check with
   `railway variables --service chatbot-api | grep CLAMAV_HOST`.

   **Fails closed now.** Any scan error throws `VirusScanError`, and the trigger marks the
   session `failed` rather than promoting it to `ready`. So an unreachable clamd, or one
   still loading its database after a restart, blocks every upload. That is why the volume
   matters, and why the wizard proves reachability before it sets `CLAMAV_HOST`.
   Rollback is one command: `railway variables --service chatbot-api --set 'CLAMAV_HOST='`.

   Turning it on was nearly a one-line env change that would have broken every upload.
   `virus-scan.service.ts` built a **bare** `S3Client`, which ignores `S3_ENDPOINT` and
   `forcePathStyle` and resolves `<bucket>.s3.auto.amazonaws.com` on the prod object store
   (Cloudflare R2, region `auto`). Because a scan error fails closed, the first `GET` would
   have turned every upload into a 500. It now uses `createS3Client()`, the same builder
   `upload.service.ts` uses, and reads the validated `config.s3.bucket`.

   Sizing: 3 GiB minimum, 4 GiB preferred. clamd holds about 1.2 GiB of signatures and about
   2.4 GiB briefly during the daily reload. Size the API replica too, because `scanStream`
   does a `Buffer.concat` of the whole object, so a 25 MB upload sits in the replica's heap.
   Do not set `CLAMD_CONF_TCPAddr`: the image already binds `0.0.0.0:3310` and `[::]:3310`,
   and forcing `::` breaks its own healthcheck, which pings 3310 over IPv4 localhost.
2. **No durable storage quota.** The cap is an in-memory map, per-replica, reset on every
   deploy. Anonymous visitors uploading 25 MB files is a real cost and abuse vector.
3. **Should a completed upload become a chat `Message`?** Today, outside a booking, a
   successful upload is visible to nobody but the visitor who uploaded it. Persisting it
   would also trigger an AI turn, with cost and prompt-behaviour implications.
4. **TOCTOU on the presigned PUT** — a client can re-upload different bytes to the same key
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
