# Data Processing Agreement — DRAFT for legal review

> **Status: DRAFT. Not legal advice, and not in force.** This exists so a lawyer
> has the engineering facts in one place instead of interviewing the team. Every
> factual claim below is traceable to code; the legal framing, the transfers
> mechanism and the liability clauses are for counsel to settle. Do not publish it
> as-is.

The analysis of Axentrio's GDPR position called the absence of a DPA the single
biggest blocker to the retention proposal. This is the first draft of one.

## 1. Roles

- **Customer** (the business using Axentrio) is the **controller** of end-user
  personal data.
- **Axentrio** is the **processor** for that data.
- Axentrio is the **controller** of its own customer records (staff accounts,
  billing, audit and compliance logs).

## 2. Subject matter, duration, nature and purpose

| | |
|---|---|
| Subject matter | Provision of the Axentrio chatbot platform |
| Duration | For as long as the Customer's account is active, plus the deletion window in §6 |
| Nature and purpose | Hosting and operating conversational AI over the Customer's connected channels; booking, lead capture, analytics and the in-portal assistant |
| Categories of data subjects | The Customer's end users (people who message the business); the Customer's staff |
| Categories of personal data | Message content; names, email addresses, phone numbers, addresses and other details end users volunteer; channel identifiers (e.g. a WhatsApp number); booking details; uploaded files |

## 3. Processor obligations

Axentrio shall:

1. process personal data only on the Customer's documented instructions (the
   configuration the Customer sets, including the retention period);
2. ensure persons authorised to process the data are under confidentiality
   obligations;
3. implement the technical and organisational measures in §5;
4. assist the Customer with data-subject requests. **Implemented:** a
   single-subject export (`exportSubject`) and erasure (`eraseLead`) that reach
   every store listed in §7;
5. notify the Customer without undue delay after becoming aware of a personal data
   breach. **To be agreed:** the notification channel and the deadline (24h/48h).
6. delete or return personal data at the end of the provision of services (§6).

## 4. Sub-processors

Current sub-processors, as disclosed in the privacy notice:

| Sub-processor | Purpose | Data |
|---|---|---|
| Railway | Application hosting, managed PostgreSQL and Redis | All platform data |
| Cloudflare | DNS, object storage (R2), database backups | Uploaded files; database dumps |
| OpenAI, Anthropic | Language-model inference | Message content and prompts sent for a turn |
| Clerk | Authentication, organisation management | Staff account identifiers |
| Stripe | Payments and billing | Customer billing details |
| Resend | Transactional email | Recipient email addresses |
| Sentry | Error monitoring | Error context, which may incidentally contain personal data |
| Google, Microsoft | Calendar, maps, file integrations | Only when the Customer connects them |
| Meta | WhatsApp / Instagram / Messenger delivery | Only for the channels the Customer connects |

**To be agreed:** the change-notification period (commonly 30 days) and whether the
Customer gets a right to object.

**Open item:** zero-retention and no-training terms with OpenAI and Anthropic are
not confirmed in writing. That confirmation belongs in this agreement, and it is a
factual question for whoever holds the vendor contracts.

## 5. Security measures

- Encryption at rest for message content where it is stored encrypted; transport
  encryption throughout.
- Per-tenant isolation on every query; a tenant-scoped key and JWT for the widget.
- Role-based access with an audited super-admin impersonation path
  (`X-Tenant-Context`), now written to the audit log.
- Audit logging of security-relevant actions, retained 90 days
  (`AUDIT_RETENTION_DAYS`).
- A documented erasure and restore procedure: `docs/gdpr-erasure-and-restore.md`.

## 6. Deletion and return at the end of the service

- A Customer can delete their workspace themselves from *Settings → Data &
  retention*. Answering stops immediately; content is purged after a **30-day**
  dormancy window (configurable via `DELETION_DORMANCY_DAYS`), measured from the
  request.
- On execution: conversations, messages, leads, bookings, documents, files and
  their stored objects are deleted; the workspace record is anonymised; the
  authentication organisation is removed; billing stops at the end of the paid
  period.
- **Retained:** invoices and accounting records (statutory retention), the
  compliance-event proof trail, and the 90-day audit log.
- **Backups:** deletion does not propagate into existing database dumps. A person
  deleted today remains in dumps taken before the deletion for up to **30 days**.
  Restored data is re-erased by replaying the recorded erasures — the procedure is
  in `docs/gdpr-erasure-and-restore.md`.

## 7. Where personal data lives

A complete list is maintained in the code and enforced by tests:

- **Lead erasure** covers the lead row, the transcript, the channel binding,
  judgments, bookings, handoffs, sent emails and guardrail logs
  (`lead-erasure.service.ts`, `lead-erasure-holders.test.ts`).
- **Tenant deletion** covers every tenant-scoped table, with an explicit
  classification that a test keeps honest
  (`tenant-deletion.service.ts`, `tenant-deletion-coverage.test.ts`).

## 8. To be agreed with counsel

- International transfer mechanism (SCCs / adequacy) per sub-processor.
- Liability, indemnity and insurance.
- Audit rights and their scope.
- Breach notification deadline and channel.
- The retention periods: the 30-day dormancy window, the 7-year compliance-event
  period, and whether the 90-day audit retention is long enough for disputes.
- Whether Axentrio's own retention for its defence makes it a controller for that
  copy, and on what Art 6 basis.
