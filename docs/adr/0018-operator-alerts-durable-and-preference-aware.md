# Operator handoff alerts become at-least-once via a transactional outbox

B-PR6a already makes a handoff notify operators by platform notification and PII-minimal email,
per their stored preferences: an `EmailDelivery` model and `emailDeliveryService.sendDurable`
(find-or-create by `idempotency_key` under a row lock, idempotent on resend), a shared
`notification-preferences` contract, and per-recipient dedupe keyed `handoff:{handoffId}:{userId}`.
This ADR does **not** revisit any of that.

What B-PR6a deferred, and what this ADR decides, is **guaranteed delivery**. Today every handoff
path notifies *after* the transaction commits, fire-and-forget (a notify failure must never fail the
handoff). A crash in the window between the commit and the dispatch therefore loses the alert with
no trace — and an unaccepted handoff is a customer waiting for a human, the one alert where silence
is most expensive.

**Decision.** A handoff writes **one outbox row inside its own transaction**. A sweep worker — the
same shape as the shipped `sla-sweep` and `timed-control-expiry.service` (`setInterval` +
`FOR UPDATE SKIP LOCKED` + an in-flight guard) — claims rows and dispatches through the seams that
already exist: `emailDeliveryService.sendDurable` for email and the Bull `notifications` queue for
push. The immediate best-effort notify stays for latency; the outbox is the backstop that guarantees
the intent survives.

**Why an outbox when Bull already retries.** Bull gives retry, backoff and a dead-letter queue — but
only *once a job is enqueued*, and today the enqueue happens **after** the commit. The outbox row is
written in the same transaction as the handoff, so the intent to alert cannot survive-fail the commit
that created the handoff. Bull still owns push *delivery* retry; the outbox owns the guarantee that
the intent *reaches* the dispatch seams at all.

**Why the worker sends, not the transaction.** Sending inside the handoff transaction would hold a
pool connection across a Resend round-trip — the failure `internal.provider` warns about, where one
third-party latency spike becomes a connection-pool outage. The commit stays local; the network
happens in the worker.

**Idempotency makes at-least-once safe.** `sendDurable` already dedupes on its key; adding the Resend
`Idempotency-Key` header (its documented follow-on) closes the last gap — a retry after a crash
between provider-accept and DB-commit cannot double-send.

**SLA overdue re-alerts route through the same path.** `sla-sweep` already decides *when* to
re-alert; pointing it at the durable seam lets an unaccepted handoff escalate by email — the case
email matters most, because the initial notify is the one most likely to have been missed.

## Considered and rejected

- **Bull alone.** Cheapest, reuses everything, and leaves the commit→enqueue gap this ADR exists to
  close. The gap is invisible in testing and shows up only as a lost alert during a crash.
- **A separate durable email queue beside push.** Two mechanisms, no added guarantee over one outbox
  that fans out to both.
- **Sending synchronously inside the handoff transaction.** Removes the worker but reintroduces the
  connection-held-across-a-network-call outage.

## Consequences

One additive migration (the outbox table). B-PR6a's post-commit fire-and-forget notify becomes
at-least-once; the happy path is unchanged beyond the initial email/push now arriving after a sweep
poll (seconds) rather than inline.
