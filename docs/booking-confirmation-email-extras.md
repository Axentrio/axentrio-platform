# Booking confirmation email extras

Per-Agent settings on `chatbot_booking_settings` that every **customer** booking-confirmation email carries, on top of the booking itself.

## What the owner configures

| Field | Storage | Scope |
|---|---|---|
| Information text | `confirmation_extra_info` (`text`, max 2000) | One multiline block, escaped with `<br/>` in HTML |
| Attachments | `confirmation_attachments` (`jsonb` array) | Metadata only; bytes under `booking-confirmation/{tenantId}/{botId}/…` |

Both live on the same row as venue, travel, and service area — **per Agent**, not per service.

Portal: **Settings → Appointment Booking → Booking confirmation email** (`SchedulerSettings`).

## Which emails carry the extras

`loadConfirmationExtras(botId)` runs inside `sendBookingEmail` only when:

- `method === 'REQUEST'` (create, owner-accepted request, reschedule, invite re-issue)
- a customer email address exists

Cancellations and reminders never load extras. Owner notifications never receive them — the owner wrote these for the customer.

## Attachment policy

- Mime allowlist (detected bytes): PDF, JPEG, PNG, WebP, DOC, DOCX
- Per-file cap: `BOOKING_CONFIRMATION_ATTACHMENT_MAX_MB` (default **10**)
- Total email budget: **15 MB** (`TOTAL_MAX_BYTES` in `booking-attachments.ts`, shared with owner file attachments)
- Upload route and `loadConfirmationExtras` use the same per-file cap so an accepted file is never silently dropped at send time
- Storage is durable S3 under `booking-confirmation/`, **not** chat `UploadSession` (GDPR cleanup would delete a PDF after 30 days)

## Behaviour guarantees

- Best effort: one unreadable attachment is skipped; the text and ICS still send
- The information text is owner-authored: escaped HTML only, **never translated**, never rewritten by a model
- The heading (`customer.extra_info_heading`) is localized via `getBookingCopy(customerLanguage)`

## API

- `PUT /scheduler/config` — `{ confirmationEmail: { extraInfo: string | null } }` (whole object every save)
- `POST /scheduler/config/confirmation-attachments` — multipart `file`
- `DELETE /scheduler/config/confirmation-attachments/:attachmentId`

## Smoke

```bash
cd api && npm run smoke:confirmation-extras
```
