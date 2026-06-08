# P6: Rich records + Outlook (Microsoft Graph) calendar provider

Two independent but related slices. **Part A (rich records)** makes the owner's calendar
event and the booking row carry self-explanatory content (service, intake answers, contact,
notes/AI summary, manage link) instead of today's bare title + notes. **Part B (Outlook)**
adds Microsoft Graph as a second calendar provider alongside Google, so a solo owner on
Microsoft 365 / Outlook.com can connect their calendar with the same connect → free/busy →
event CRUD lifecycle and the same cross-bot double-booking protection.

Part A is provider-agnostic and lands first (smaller, no OAuth). Part B reuses the rich-event
body Part A produces.

## Current state (verified)

### Rich records gap
- `InternalProvider.createBooking` mirrors to Google via `syncGoogleCreate(ctx, bookingId,
  service.name, start, end, timezone, notes)` → `createCalendarEvent` with
  `summary = service.name`, `description = notes` only. **No** service description, intake
  answers, customer phone/address, AI summary, or manage link reaches the event body.
- `CalendarEventInput` is `{ startISO, endISO, timezone, summary, description? }`. The event
  body is a single optional `description` string.
- `Booking` (entity) **already has** the columns to carry rich content — `customerPhone`,
  `customerAddress`, `intakeAnswers` (jsonb), `aiSummary`, `notes`, `sourceChannel` — added in
  the keystone. They are persisted on `request_created` rows (via `createRequest`) but the
  **auto-confirm `createBooking` INSERT only writes** `attendee_*`, `notes`. So even the DB
  record is thinner than it could be on the confirmed path, and `customer_phone` /
  `customer_address` are **never written by any current code path** (no tool captures them
  yet — that's P5/intake territory).
- `create_booking` tool params today: `startTime, attendeeName, attendeeEmail, notes?,
  serviceId?`. No phone/address/intake params. **P3 (intake) and P5 (extended fields) own
  introducing those capture params** — P6 must NOT add intake/phone/address capture tools or
  agent params; it only *renders* whatever already lands on the Booking row.
- `sendBookingEmail` builds the customer ICS + HTML from `summary, description?, location?,
  manageUrl?`. The manage link already exists for the customer email
  (`buildManageUrl(bookingId)`), but is **not** put in the calendar event the owner sees.
- The sync reconciler (`sync-reconciler.ts`) rebuilds the event from `loadEventMeta` →
  `{ summary: serviceType.name, timezone }` only. Any rich body must be reconstructable here
  too, or a reconciled (retried) event would lose the rich content the inline create had.

### Google wiring (the Outlook template)
- `CalendarCredential` (`chatbot_calendar_credentials`): one **active** row per
  `(botId, provider)` — partial-unique index `where status='active'`. `provider` is a
  `varchar(16)` defaulting to `'google'`; the TS type is `CalendarProviderType = 'google'`.
  Stores `accountEmail`, encrypted `accessTokenEnc` / `refreshTokenEnc`, `tokenExpiry`,
  `calendarId` (write target + busy source, default `'primary'`).
- OAuth: `buildConnectUrl` (signed-JWT `state` binding tenant+bot, 30m expiry) →
  `exchangeAndStore` (code → tokens, verified account email from id_token, persist, rekey).
  `getValidAccessToken` refreshes via the refresh token when `tokenExpiry` is within 60s,
  else throws `CALENDAR_REAUTH_REQUIRED`.
- Routes: public `googleCalendarCallbackRouter` (`GET .../google/callback`, no auth) mounted
  at `/api/v1/integrations/google`; authed router (`connect-url`, `status`, `disconnect`,
  `calendars`, `calendar`) mounted at `apiRouter /integrations/google`. Callback re-checks
  `requireFeature(... 'calendarIntegrations')` + `getOwnedBot` before storing.
- Free/busy: `getGoogleBusyForBot(botId, startISO, endISO)` → `events.list` on `calendarId`,
  returns busy intervals or `null` (no connection). `InternalProvider.loadAllBusy` merges it
  with internal busy and **fails closed** (`BOOKING_TEMPORARILY_UNAVAILABLE` 503) if the
  provider throws — never offers a slot that might collide.
- Event CRUD: `createCalendarEvent` (deterministic id = booking uuid sans hyphens →
  idempotent 409→fetch; adds a Meet conference), `updateCalendarEvent` (404/410→`not_found`,
  403→`no_access`), `deleteCalendarEvent` (swallows 404/410, 403→`no_access`). Each returns
  `'no_connection'` when no active cred.
- `BookingReference` (`chatbot_booking_references`): unique `(bookingId, providerType)`,
  stores `externalEventId`, `externalCalendarId`, `meetingUrl`. The provider always targets
  the event's **real home** (`ref.externalCalendarId`), not the current cred calendar.
- Identity / double-booking: `resolveCalendarIdentity(botId)` → non-`primary` `calendarId`,
  else verified `accountEmail`, else `null`. `conflictKeyFor(botId, identity)` → `gcal:<id>`
  or `bot:<botId>`. Every booking's `calendar_key` is this; the
  `EXCLUDE USING gist (calendar_key WITH =, blocked_range WITH &&)` constraint +
  per-`calendar_key` `pg_advisory_xact_lock` block overlaps **across bots sharing one real
  calendar**. `rekeyBotBookings` re-stamps active future bookings on connect / reconnect /
  picker / disconnect.
- Portal: `SchedulerSettings.tsx` shows a "Google Calendar" block (connect / status /
  disconnect) driven by `useGoogleCalendarQueries`; the OAuth redirect returns to
  `/settings?google=connected|error` and a `useEffect` toasts + invalidates.
- Config: `config.google.{clientId, clientSecret, redirectUri, stateJwtSecret}` from env
  (`stateJwtSecret` currently aliases `META_OAUTH_JWT_SECRET`).

---

## Part A — Rich calendar-event + record content

### Goal
The owner's calendar entry (and the stored Booking row) is self-explanatory at a glance:
which service, who, how to reach them, what they said, and a link to manage it — without the
owner opening the chat transcript.

### Locked decisions (Part A)

- **A single rich-body builder** `buildBookingEventContent(booking, service, manageUrl)` →
  `{ summary, description }`, in a new pure module
  `api/src/n8n/booking-providers/booking-content.ts`. Provider-agnostic plain text (NOT
  HTML — Google and Outlook event descriptions are plain text / Outlook accepts HTML but we
  keep ONE plain-text body for parity and because Google's is text). It is the **single
  source** of the event body for: the inline `syncGoogleCreate`, the inline Outlook create
  (Part B), AND the reconciler. The reconciler must call the same builder (it currently only
  has `summary`), so a retried event is identical to an inline one.
- **`summary`** = `service.name` (unchanged — keeps ICS/email titles stable). Rich content
  goes in `description` only, so existing title-based behavior is untouched.
- **`description` body**, in this fixed order, each line omitted when its source is empty:
  1. `Service: <service.name>` + (if `service.description`) a following `<service.description>`
     line.
  2. `Customer: <name> <<email>>` (exact format; see the Customer rule below for empties).
  3. (if `booking.customerPhone`) `Phone: <customerPhone>`.
  4. (if `booking.customerAddress`) `Address: <customerAddress>`.
  5. (if `booking.aiSummary`) `Summary: <aiSummary>`.
  6. (if `booking.notes`) `Notes: <notes>`.
  7. (if `booking.intakeAnswers`) an `Intake:` block — one `  <label>: <value>` line per
     entry. P3 owns the intake *schema/labels*; absent P3, raw keys are acceptable (documented
     known-rough rendering). **The LABEL is normalized + capped exactly like a value** (trim,
     collapse newlines/strip control chars, 500-cap) so a malicious/odd key can't inject fake
     lines or blow the cap. **Sort is on the RAW keys** (`Object.keys(intakeAnswers).sort()`)
     for a stable deterministic order independent of label normalization; the label is normalized
     only for rendering. **Per-value rendering (locked, test-pinned):** for each key (in raw-key
     sort order) the value renders as:
     `string` → the trimmed string; `number`/`boolean` → `String(v)`; `null`/`undefined` →
     the entire entry is **omitted**; empty string after trim → omitted; `[]` / `{}` (empty) →
     omitted; non-empty array/object → `JSON.stringify(v)` (any `\n` INSIDE a JSON string is a
     literal escaped `\n` two-char sequence in the stringified output — text, not a real line
     break — so it does not create a fake body line; the normalization step below only collapses
     *actual* newline characters). The rendered value then goes through the same per-field
     normalization + 500-char cap below. These exact cases are unit-tested because
     `intake_answers` is arbitrary jsonb.
  8. `Manage: <manageUrl>` (= `buildManageUrl(bookingId)`).
- **Field value normalization (applied to EVERY user-supplied value before it's placed in the
  body, then snapshot-locked):** (a) `.trim()`; (b) collapse any run of whitespace **that
  includes a newline** to a single space and strip other control chars (so a multi-line note
  can't inject fake `Label:` lines or blow up the body — each rendered field becomes a single
  logical line); (c) cap to **500 characters** (`Array.from(s).length`, i.e. code-point count,
  not bytes) appending a single `…` when cut. The `Customer:` line is exactly
  `Customer: <name> <<email>>` — name and email each normalized as above. Empties (all four
  cases pinned): both present → `Customer: <name> <<email>>`; name empty, email present →
  `Customer: <<email>>`; **name present, email empty → `Customer: <name>`** (no angle brackets);
  both empty → line omitted. These rules make the body byte-stable for snapshots.
- **No separate `Join:`/meet line and NO post-create PATCH.** The Meet/Teams join URL is
  emitted by the provider's *create* call into the event's native conference fields (Google
  `conferenceData` → `hangoutLink`; Outlook `isOnlineMeeting` → `onlineMeeting.joinUrl`), so
  the owner's calendar already shows the join button — we do NOT also write it into the
  text body (which would require a fragile second PATCH that can partially fail). The join
  URL still flows to the BookingReference (`meetingUrl`) and the customer email as today.
  (The P6c demo line therefore checks the Teams join URL on the event's conference field, not
  in the description body — corrected below.)
  - **Outlook no-Teams fallback ⇒ `meetUrl = null`, which the existing email path already
    handles cleanly.** Today `sendBookingEmail` is called with `location: meetUrl ??
    (in_person ? 'In person' : undefined)` and `description: meetUrl ? 'Join with…' :
    undefined` — i.e. a null meet URL simply yields no join line and falls back to the
    in-person/location text. So a personal-Outlook booking with no Teams link produces a clean
    customer email (no stale/blank "Join" line) — the null-meetUrl handling itself needs no
    change. The ONE customer-email change in P6 is generalizing the hard-coded "Google Meet"
    wording to provider-neutral "Join the meeting: <url>" so a Teams link isn't labelled "Google
    Meet". Tests pin BOTH Google (Meet URL → "Join the meeting") and Outlook (Teams URL → "Join
    the meeting"; no URL → no join line).
- **Deterministic, idempotent body.** Field order is the fixed list above; the `Intake:` block
  iterates `Object.keys(intakeAnswers).sort()` (lexicographic) so the body is byte-stable
  regardless of insertion order — required for reconciler parity and snapshot tests.
- **Exact caps (locked):** per-field 500 code-points (above). The whole assembled `description`
  is hard-capped at **4000 code-points**. **Protected line set (never dropped):** the body is
  partitioned into HEAD = `Service` (+ its description line), `Customer`, `Phone`, `Address`;
  MIDDLE = `Summary`, `Notes`, `Intake:` block; TAIL = `Manage`. Truncation drops complete
  `\n`-delimited lines ONLY from the end of MIDDLE (last MIDDLE line first), inserting a single
  `… (truncated)` marker line, then always re-appends TAIL (`Manage`). HEAD and TAIL always
  survive. **If HEAD + `Manage` alone already exceed 4000** (pathological — very long service
  description/address), HEAD's own per-field 500-cap already bounds each line, so HEAD+Manage is
  at most ~5 lines × ≤500 ≈ 2.5K, comfortably under 4000; the design relies on the per-field cap
  to make this case unreachable, and if it somehow isn't, MIDDLE is simply fully dropped and the
  body is HEAD + `Manage` (still under 4000 by the arithmetic above). Never cut mid-line/mid-JSON.
  Caps in code-points (`Array.from(...).length`); tests assert character counts, not bytes (the
  `…` ellipsis is intentional and code-point-counted).
- **Body-equality is asserted on OUR builder output (pre-send), not on the provider's stored
  copy.** Graph/Google may normalize whitespace/line-endings on read-back; reconciler-parity
  tests compare `buildBookingEventContent(...)` output across the inline and reconciler call
  sites (same inputs ⇒ same string), NOT a round-tripped fetch.
- **The confirmed-path INSERT persists `source_channel` (only).** Today's `createBooking`
  INSERT omits `source_channel`; we add it because the value already exists with **zero new
  plumbing** — `ctx.session.channel` (the request path already writes exactly this). We do
  **NOT** add `ai_summary`, `customer_phone`, `customer_address`, or `intake_answers` to the
  confirmed INSERT, because **no value flows into `createBooking` for them**: the auto-confirm
  `create_booking` tool has no such params, and inventing capture is P3/P5's job, not P6's.
  So on the confirmed path those columns stay NULL today and the builder simply omits the
  corresponding lines — graceful, no invented plumbing. (Once P3/P5 add capture params and
  write those columns, the builder *already* renders them with no further P6 change — that is
  the whole point of reading off the Booking row.) `ai_summary` on the auto path therefore is
  out of scope here; it renders only when an upstream slice populates it.
- **Threading:** `syncGoogleCreate` (and the Part B Outlook create) take the **full `Booking`
  row** (or the fields above) instead of just `(summary, notes)`, plus the `service` and
  `manageUrl`, and call `buildBookingEventContent`. The reconciler's `loadEventMeta` is
  extended to load the full booking row + service so it can call the same builder. This is
  the only signature change rippling out of Part A.
- **Reschedule never touches the body; recreate-on-missing DOES rebuild it (accepted).**
  `updateCalendarEvent` patches only times — so a normal reschedule preserves any owner edit
  to the description. The reconciler / reschedule-recreate path (event deleted in the calendar
  → recreate with the deterministic id) necessarily writes a fresh body from the builder; this
  CAN overwrite an owner edit, but only in the case where the owner had **deleted** the event
  (there's nothing to preserve) or it never synced. **Locked:** P6 is allowed to clobber the
  description ONLY on a (re)create, never on an update — i.e. we never PATCH the body of an
  existing event. That is the precise, testable boundary for owner-edit preservation.
- **Out of scope for A:** putting the rich owner-body into the *customer* email/ICS (it stays
  summary+location+manage as today — the rich body is for the **owner's** calendar entry, which
  may contain PII the customer shouldn't be re-sent). The ONLY customer-email change anywhere in
  P6 is the provider-neutral "Join the meeting" wording (above). Also out: capturing new fields,
  two-way sync of owner edits.

---

## Part B — Outlook / Microsoft Graph calendar provider

### Goal
A solo owner on Microsoft can connect their Outlook/Microsoft 365 calendar and get the exact
same behavior Google gives: bookings mirror to their calendar (rich body from Part A), the bot
respects their existing events (free/busy), and cross-bot double-booking is still blocked.

### Locked decisions (Part B)

- **Provider abstraction: a thin `CalendarProvider` port, parallel services behind it.** We
  do NOT rewrite the Google service. We introduce an interface
  `api/src/integrations/calendar/calendar-provider.ts`:
  ```
  getBusy(botId, startISO, endISO): Promise<BusyInterval[] | null>
  createEvent(botId, input, opts): Promise<CalendarEventResult | null>
  updateEvent(botId, eventId, times, calendarId?): Promise<'ok'|'not_found'|'no_access'|'no_connection'>
  deleteEvent(botId, eventId, calendarId?): Promise<'ok'|'no_access'|'no_connection'>
  resolveIdentity(botId): Promise<string | null>
  getActiveCredential(botId): Promise<CalendarCredential | null>
  ```
  `deleteEvent` deliberately has NO `'not_found'` — a 404/410 on delete means "already gone",
  which is success, so both providers map 404/410 → `'ok'` (Google already does). The existing
  Google functions match these signatures exactly — Google's adapter is a one-line re-export
  wrapper. A new `outlook-calendar.service.ts` implements the same port
  against Microsoft Graph. A `resolveCalendarProvider(botId)` picks the active provider (see
  selection rule). `InternalProvider` stops importing Google directly and depends only on the
  resolved port. This is a refactor-in-place: the **lifecycle semantics** for Google-only bots
  are preserved (same create/update/delete/free-busy outcomes, same `gcal:` key string). It is
  NOT literally byte-identical — Part A enriches the Google event **body**, the reconciler's
  inputs grow, and `conflictKeyFor` gains a provider arg — but no Google booking's identity, key
  string, or external event is disturbed, and no Google rekey/migration occurs. The
  reconciler's existing Google ref handling is unchanged; it gains a parallel branch for
  `providerType='microsoft'` refs (same create/update/delete-on-status logic via the port).
- **Provider selection — at most ONE active calendar per bot, enforced in the DB.** A bot has
  **zero or one** active `CalendarCredential` regardless of provider. The connect flow for
  either provider **revokes any existing active cred (of either provider)** before inserting
  the new one. To make this race-proof (two tabs / two callbacks completing concurrently) we
  **replace the partial-unique index `(botId, provider) where status='active'` with
  `(botId) where status='active'`** — a single migration. **The migration first
  deterministically deduplicates any pre-existing multiple-active rows** (there should be none
  today, but manual data could have them): keep the most-recently-`updated_at` active row per
  bot, set the rest to `status='revoked'`, log the count — THEN create the unique index (which
  would otherwise fail). **Ordering (critical): the new connection is fully validated BEFORE the
  old one is revoked.** `exchangeAndStore` first does all fallible network work OUTSIDE the txn —
  exchange the code for tokens, call `/me` for `account_id` + email — and ONLY if all of that
  succeeds opens the DB txn to revoke-old + insert-new. If exchange or `/me` fails, the txn never
  opens and the existing working calendar stays connected (failed connect = no-op). We never
  revoke a working calendar on the hope a replacement connects.
  The revoke-then-insert DB step in `exchangeAndStore` runs in one transaction
  **serialized by a per-bot advisory lock** (`pg_advisory_xact_lock(hashtext('calcred:'||botId))`
  — the same primitive the booking path uses), taken at the top of the txn. Within the lock the
  handler runs `UPDATE ... SET status='revoked' WHERE bot_id=$1 AND status='active'` then
  `INSERT` the new active cred. The **advisory lock (not the unique index alone)** is what
  serializes two concurrent connects: relying on the index alone is wrong, because the second
  txn's `UPDATE` would revoke the first's just-inserted row and then its INSERT would succeed
  (silent last-writer-wins, not the unique-violation I previously claimed). With the lock the
  second connect blocks until the first commits, then runs its own clean revoke+insert →
  deterministic last-completer-wins, exactly one active row. The intuitive outcome holds: the
  bot ends on whichever provider the owner finished connecting last. So "owner has both active"
  is a DB impossibility. Connecting Outlook while Google is connected
  **switches** the bot to Outlook (rekey, since identity changes). Rationale: a solo owner has
  one working calendar; dual-mirror is complexity with no product win and breaks the
  single-`calendar_key` model. Dual-provider is out of scope.
  - **`resolveCalendarProvider(botId)`** selects the provider of the bot's single active cred
    (`SELECT ... WHERE bot_id=$1 AND status='active'` — `status` filter is explicit so revoked
    rows never count). With the new unique index this returns at most one row, so the >1 branch
    is unreachable in normal operation; it exists ONLY to fail safely against manual data
    corruption. **If it ever observes >1 active cred, it FAILS CLOSED:** log a loud
    `CALENDAR_PROVIDER_AMBIGUOUS` error and throw → free/busy raises 503, new bookings refuse,
    until an operator resolves the data. We do NOT "pick the most recent and proceed", because
    the OTHER active provider's calendar would then go unread and the bot could offer a colliding
    slot. Ambiguous active state is treated as unsafe-to-book, not best-effort. (This is the only
    place the at-most-one guarantee could be violated, and it's caught conservatively.)
  - **Reconciliation + reschedule/cancel route by the REF's `providerType`, NOT the bot's
    currently-active provider.** `BookingReference.providerType` is the authoritative provider
    for a given external event. The reconciler and `syncReschedule`/`syncCancel` look up the
    ref, then call **that provider's** adapter (a `providerByType(ref.providerType)` map), so a
    switched bot updating/deleting an OLD Google event still goes through the Google adapter (it
    just returns `no_connection` because the Google cred was revoked — see below). Only NEW
    bookings (no ref yet) use `resolveCalendarProvider` to pick the active provider. This rule
    is explicit so switched bots never try to PATCH a Google event id through Graph.
    **A booking keeps its ORIGINAL provider ref for life — we never create a SECOND provider
    ref for an existing booking.** Reschedule/cancel/reconcile of a booking that already has a
    `BookingReference` always act on that ref's provider; they never mirror the booking into the
    newly-active provider (no Outlook ref is ever created for a booking made under Google, even
    after a switch). So `(bookingId, providerType)` stays effectively one row per booking; the
    recreate-on-not-found path reuses the SAME provider+ref, never a new provider. Only a
    brand-new booking (no ref) creates a ref, under the active provider.
    **Each provider adapter's credential lookup is provider-scoped** (`getActiveCredential`
    already filters `WHERE provider=$1 AND status='active'`), so routing a Google-ref operation
    through the Google adapter reads/locks the GOOGLE cred (and finds none after a switch →
    `no_connection`), never the now-active Outlook cred. The token-refresh `FOR UPDATE` lock is
    therefore on the looked-up cred ROW (provider-scoped), not a bare bot-wide lock — a
    Google-ref op can never lock/refresh the Outlook cred or vice-versa.
  - **Backend enforces the switch, not the UI.** The revoke-the-other-provider logic lives in
    `exchangeAndStore` (shared) — direct API callers get the same single-active guarantee.
    The portal copy is cosmetic; correctness is server + DB side. (Addresses "relies on UI
    intent".)
  - **Neither connected:** `resolveCalendarProvider` returns `null`; the port's `getBusy`
    returns `null` (internal-only availability — the keystone established the calendar is NOT
    the availability source), `createEvent`/`update`/`delete` return `'no_connection'`. Exactly
    today's Google-absent behavior. Bookings still auto-confirm. **This `null` "no provider"
    case is the ONLY thing that yields `null`/`no_connection`; a present-but-broken provider
    (expired/revoked/misconfigured/`reauth_required`) THROWS — see free/busy failure modes — so
    `loadAllBusy` fails closed instead of treating broken-as-absent. Critically,
    `resolveCalendarProvider` STILL returns the provider of a broken/`reauth_required` active
    cred (selection is by active row, not by health); the port's `getBusy` then THROWS on token
    use → 503 fail-closed. A broken active provider must never be mistaken for "no provider"
    and allow internal-only booking over the owner's real (unreadable) calendar.**
  - **`resolveCalendarProvider` is purely credential-driven and IGNORES `BookingReference`
    rows.** New-booking provider selection looks ONLY at the active `CalendarCredential`; a
    leftover historical ref (e.g. a Google ref after switching to Outlook) NEVER makes the bot
    "have a Google provider" for new work. **Product assumption (locked):** after a switch, ONLY
    the active provider's calendar is authoritative for availability — events stranded on the
    abandoned old calendar are NOT consulted for free/busy. A solo owner who switched calendars
    is expected to live in the new calendar; this is the accepted consequence of a deliberate
    switch.
  - **The switch on a bot with existing future bookings** rekeys via
    `rekeyBotBookings(botId, conflictKeyFor(botId, newIdentity, 'microsoft'))`. Existing
    `BookingReference` rows still point at the OLD provider's event (`providerType='google'`).
    We do NOT migrate old Google events into Outlook. **Because the switch revokes the Google
    cred, reschedule/cancel of an OLD (Google-ref) booking will get `no_connection` from the
    Google adapter (no active Google cred) — this is accepted and is NOT a contradiction: the
    old events are deliberately orphaned on the abandoned calendar for the owner to clean up.**
    The provider handles it gracefully: cancel/reschedule logs, marks `sync_pending`, the
    reconciler (routing by `ref.providerType`) finds no active cred for that provider and goes
    **terminal** (`sync_last_error='no active <provider> credential for stored ref'`) — no
    crash, no re-claim loop. New bookings made after the switch mirror to Outlook.
    **Explicit accepted state for already-existing future bookings at switch time (#5):** they
    are rekeyed to `mscal:<account_id>` (so they DO occupy the owner's new-calendar conflict
    space and block new Outlook bookings from overlapping them — the bot won't double-book over
    them), but their actual external EVENT still lives only on the old Google calendar and is NOT
    recreated on Outlook (we never create a second-provider ref). So those bookings are protected
    in OUR scheduler but **invisible on the owner's new Outlook calendar** until they next touch
    one (reschedule/cancel, which then goes terminal with `sync_last_error`). **Admin signal at
    switch:** the switch path logs a single `CALENDAR_PROVIDER_SWITCHED` summary with the count
    of rekeyed future bookings whose events remain on the old provider, so the owner/ops know
    those N appointments won't appear on the new calendar. We do NOT auto-recreate them (no
    bulk cross-provider migration — out of scope); this is the documented, signalled cost of a
    deliberate switch.
  - **No silent "calendar synced" success.** The booking op (reschedule/cancel) still succeeds
    for the customer (DB is authoritative), but because the mirror went `no_connection` the row
    is flagged `sync_pending`; the reconciler retries, finds no active cred for the ref's
    provider, and moves it to **terminal** by setting `sync_last_error` and clearing
    `sync_pending` (exactly the existing reconciler `terminal()` behavior — stops re-claiming so
    it can't loop). **The admin-visible signal is `sync_last_error` being non-null (surfaced in
    the existing admin/ops view), which persists after `sync_pending` clears** — so "stranded
    stale event" is visible and actionable, not invisible. `sync_pending` is the transient
    "retry me" flag; `sync_last_error` is the durable "this needs attention" record. We never
    report "synced to your calendar" when the mirror didn't happen. **Surface (#5):** the
    booking API/tool result is unchanged — it reports the BOOKING succeeded (DB-authoritative)
    and never asserts calendar-sync status (today's contract; the customer-facing path makes no
    sync claim). The mirror health lives ONLY on the booking row (`sync_pending`/`sync_last_error`,
    already exposed in the existing admin bookings view) — P6 adds no new "synced?" field to the
    booking result and makes no new UX promise. This stale-event outcome is the documented,
    accepted cost of a deliberate provider switch.
  - **Disconnect only affects the active credential + future keying — never historical refs.**
    Disconnecting the active provider sets that cred `status='revoked'` and rekeys active
    future bookings to `bot:<botId>` (no identity). Old `BookingReference` rows are untouched;
    a later reschedule/cancel of one routes by `ref.providerType`, finds no active cred, and
    goes terminal exactly as the switch case. Disconnect never tries to delete historical
    external events (we don't bulk-clean the calendar). Same for disconnecting Outlook while
    old Google refs exist.
- **CalendarCredential changes:**
  - `CalendarProviderType` becomes `'google' | 'microsoft'`. `provider` column already
    `varchar(16)` — no DDL for the column itself.
  - **One migration (Part B)** does three things: (1) dedup any multiple-active rows per bot
    (keep the row with the greatest `(updated_at, id)` — `id` (uuid) is the deterministic
    tie-breaker for equal/null `updated_at`, so the kept row is identical across all databases —
    revoke the rest) then swap the partial-unique index to
    `(botId) where status='active'`; (2) add nullable `account_id varchar(128)`; (3) add
    `reauth_required boolean NOT NULL DEFAULT false` (NOT nullable — so status logic treats it
    as a plain boolean with no null-normalization; existing rows are backfilled to `false` by
    the default). For existing Google rows `account_id` stays null (Google keeps using email).
    **Dedup auditability (#15):** the dedup step UPDATEs losers to `status='revoked'` (it does
    NOT delete them), so the revoked rows remain queryable post-migration for audit; the
    migration also writes the kept/revoked counts via the migration framework's own
    output/`queryRunner` (the established logging path in this repo's migrations) rather than a
    floating app log. In practice no bot has >1 active row today, so this is a guard, not an
    expected operation.
  - `calendarId` for Outlook is **`'primary'` and only `'primary'` in P6** (picker deferred).
    The column can hold an opaque Graph id later, but P6 never writes a non-`'primary'` value
    for Microsoft, all Microsoft CRUD + free/busy use the default-calendar paths (`/me/events`,
    `/me/calendarView`), and the identity is always `mscal:<account_id>` (never per-calendar).
    **If a Microsoft cred is ever observed with `calendarId != 'primary'` (impossible in P6,
    guard against future/manual data), that provider FAILS CLOSED** (free/busy throws → 503)
    rather than mixing a per-calendar read with a default-calendar write — preserving the
    "key = the real calendar we write to" invariant until the picker lands.
  - **Stable account identity (Microsoft):** Microsoft aliases/UPNs are NOT stable, so the
    Outlook conflict identity is the **immutable Graph user object id** (`id` from `GET /me`, a
    GUID), stored in the new `account_id` column. `accountEmail` for Outlook holds
    `me.mail ?? me.userPrincipalName` for **display only** and is never the conflict identity.
    This guarantees two bots on the same Microsoft account ALWAYS resolve the same identity.
    **`me.id` is always present on a successful `/me` call** — so on the Outlook path a stored
    cred MUST have `account_id`; if `account_id` is null on an active Microsoft cred we treat
    the credential as **broken** (set `reauth_required`, free/busy fails closed, prompt
    reconnect) rather than silently degrading to the alias-prone `accountEmail`. We do NOT fall
    back to email for Microsoft cross-bot identity — that would reintroduce the instability this
    column exists to remove. (Google's ladder is unchanged: email ⇒ null ⇒ `bot:<botId>`.)
  - No new token columns — Graph access + refresh tokens fit `accessTokenEnc` /
    `refreshTokenEnc` / `tokenExpiry`. Refresh-token rotation persists into the same columns
    (see token refresh).
- **Microsoft Graph OAuth:**
  - Authorization-code + PKCE-less confidential-client flow against
    `https://login.microsoftonline.com/common/oauth2/v2.0/{authorize,token}` (the `common`
    endpoint so both org M365 and personal Outlook.com accounts can connect). **This requires
    the Azure app registration to be configured "Accounts in any org directory AND personal
    Microsoft accounts" (multitenant + personal)** with the matching `MICROSOFT_REDIRECT_URI` —
    a single-tenant or org-only registration will fail despite this design's Outlook.com claim.
    This is a deployment prerequisite, called out so the app-registration is set up correctly.
  - **Scopes (locked):** `offline_access openid profile email User.Read Calendars.ReadWrite`.
    `Calendars.ReadWrite` covers calendarView (free/busy) + event CRUD; `User.Read` lets us
    call `GET /me` to read the stable user `id` + `userPrincipalName` + `mail` (the id_token
    `email` claim is unreliable on personal accounts, so `/me` is the **authoritative**
    source, not a "fallback"). Identity resolution after exchange:
    `account_id = me.id` (always present, stable); `accountEmail = me.mail ?? me.userPrincipalName ?? null` (display).
    `offline_access` is REQUIRED for a refresh token (Graph analog of `access_type=offline`).
  - `state` = the signed-JWT pattern, **with an explicit `provider` claim**, validated
    per-callback. **Newly minted states are provider-specific immediately:** the Microsoft
    connect URL mints `provider:'microsoft'`, and as part of P6 the Google connect URL is
    updated to mint `provider:'google'`. Each callback asserts its OWN provider value (Microsoft
    callback requires `provider==='microsoft'`; Google callback requires `provider==='google'`
    OR — only briefly — absence, for any in-flight pre-deploy Google state). **The cutoff is
    AUTOMATIC and time-bound, requiring no follow-up:** the Google callback accepts a
    provider-less state only when its `iat` is before a hardcoded `LEGACY_STATE_CUTOFF` constant
    (= deploy time + 30m, baked into the build). Since state JWTs already expire in 30m, every
    provider-less state is naturally gone within 30m of deploy AND explicitly rejected by the
    `iat < CUTOFF` check — so the leniency self-expires with zero operational action; there is no
    "remember to disable it later". Newly minted Google states always carry `provider:'google'`.
    A Microsoft state always carries `provider:'microsoft'` and is rejected by the Google
    callback regardless, so no Microsoft state can ever be replayed against the Google callback
    even during the window. Reuse `config.*.stateJwtSecret`.
  - **Token access rejects broken creds BEFORE checking expiry.** `getValidAccessToken*` first
    checks: if `reauth_required === true` OR `refreshTokenEnc` is null → **throw
    `CALENDAR_REAUTH_REQUIRED` immediately**, even if the cached access token hasn't expired yet.
    Otherwise it returns the cached token when >60s from expiry, else refreshes. This guarantees
    the broken-cred ⇒ throw ⇒ fail-closed invariant holds the moment a cred is flagged — a
    revoked grant with a still-unexpired access token must NOT serve one more read. (This applies
    to both providers; it's a small addition to the existing Google function too.)
  - **Token refresh/expiry + rotation + concurrency (Microsoft):** Graph access tokens ~60–90m;
    refresh tokens **rotate** — a refresh response may return a NEW refresh token we MUST persist.
    `getValidAccessTokenMicrosoft`: refresh when within 60s of `tokenExpiry`. **Concurrency:**
    two in-flight requests could clobber a freshly-rotated refresh token with a stale one.
    Guard the refresh in a transaction that re-reads the cred row `FOR UPDATE` and only
    refreshes if still expired (double-checked under the lock); the second waiter sees the
    just-persisted token and skips the refresh. Persist new access token + expiry + rotated
    refresh token together in that same txn. **The same `FOR UPDATE` double-checked pattern is
    applied to Google's `getValidAccessToken` too** — Google's refresh token is stable (no
    rotation) so the clobber risk is lower, but the locked refresh pattern is extended to both
    for uniformity and to avoid redundant concurrent refreshes; this is a small, in-place change
    to the existing Google function.
  - **Refresh-failure taxonomy (locked), three buckets:**
    (a) **Owner-actionable reauth → set `reauth_required=true`:** `invalid_grant` (consent
        revoked / refresh token expired/used), missing refresh token, AND
        owner/account-policy denials (AAD conditional-access / tenant-policy / consent
        required) — because these are fixed by the OWNER reconnecting or their admin granting
        consent, NOT by us. The portal "Reconnect needed" + a help note "your IT policy may
        require admin approval" is the owner's action path (so these don't become a permanent
        503 with no recourse).
    (b) **OUR misconfiguration → DO NOT touch credential state, fail closed + ops-alert:**
        `invalid_client` (bad/rotated client secret), `unauthorized_client`, app
        disabled/secret-expired — an OUR-side problem; flipping `reauth_required` would wrongly
        tell every owner to reconnect. Surfaced as 503 + ops alert, owner state untouched.
    (c) **Transient (5xx / network / throttle) → fail closed, leave state, retry next time.**
    All three throw `CALENDAR_REAUTH_REQUIRED`/`BOOKING_TEMPORARILY_UNAVAILABLE` upstream so
    free/busy fails closed; only (a) flips the cred flag.
  - **Status reflects token health AND clears correctly.** `/status` (both providers) reports
    `needsReauth:true` when the active cred has `reauth_required=true` OR no refresh token. The
    nullable `reauth_required boolean` is flipped on ONLY by case (a), and **cleared ONLY on a
    successful (re)connect.** It is NOT auto-cleared by a later refresh: once case (a) is true
    (revoked/expired/missing refresh token, or policy denial), a refresh CANNOT succeed without
    a valid refresh token, so "clear on refresh" would be dead/contradictory. (A transient blip
    is bucket (c) and never sets the flag in the first place, so there's nothing to "un-stick".)
    Reconnect is the only exit.
    - **Legacy Google creds with no refresh token (#6):** a pre-`offline_access` Google cred
      can lack `refreshTokenEnc`. After this migration such a cred reports `needsReauth:true`
      immediately (no refresh token ⇒ can't refresh ⇒ will fail closed on next expiry anyway).
      This is **intentional and correct** — it surfaces a cred that was already going to break,
      prompting reconnect before a booking silently fails closed. Tested as an expected status
      change for those legacy rows.
    The portal shows "Reconnect needed" instead of a misleading "Connected".
  - New config block `config.microsoft.{clientId, clientSecret, redirectUri, stateJwtSecret}`
    from `MICROSOFT_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` (env, all optional). **`stateJwtSecret`
    source (locked):** like Google's (`config.google.stateJwtSecret` aliases `META_OAUTH_JWT_SECRET`,
    line ~76), `config.microsoft.stateJwtSecret` **reuses the SAME `META_OAUTH_JWT_SECRET`** — one
    shared state-signing secret across all OAuth callbacks; there is no separate
    `MICROSOFT_STATE_JWT_SECRET` env var. The per-callback `provider` claim (round-1/round-2: Google
    callback requires `provider==='google'`, Microsoft requires `provider==='microsoft'`) is what keeps
    states provider-isolated, so sharing one signing secret is safe. A separate
    redirect URI / callback path (`/integrations/microsoft/callback`) so the Azure app
    redirect matches. **Public-callback authorization parity (locked):** the Microsoft callback
    (public, no session, like Google's) MUST perform the SAME pre-store checks the Google callback
    does before inserting the credential — re-verify `requireFeature(... 'calendarIntegrations')` and
    `getOwnedBot` (tenant+bot resolved from the validated signed-JWT `state`) — so a Microsoft cred is
    never stored for a bot the caller doesn't own or a tenant without the feature. This mirrors the
    existing Google callback's `requireFeature` + `getOwnedBot` re-check exactly; Part B does not relax
    it.
  - **Microsoft-not-configured AFTER a cred already exists** (env vars removed): `connect-url`
    throws `MicrosoftNotConfiguredError`; **`disconnect` MUST still work** (it only updates our
    DB row `status='revoked'` + rekeys; best-effort Graph revoke is skipped/swallowed when
    unconfigured — never blocks local disconnect); free/busy + event CRUD that need a token →
    `getValidAccessToken` throws (no client) → free/busy **fails closed** (503), CRUD marks
    `sync_pending`. **`/status` does NOT need a token** — it reads the stored row only, so it
    returns the stored `connected:true, provider:'microsoft', accountEmail` (display) **and a
    distinct `misconfigured:true`** flag (env absent) — NOT `needsReauth` (which is owner-
    actionable; env-absent is OUR config problem). So we never tell the owner to reconnect for
    an env-missing condition; we surface a "calendar integration temporarily unavailable" ops
    state. (`reauth_required` is untouched.) This separates env-misconfig from owner-reauth and
    is explicitly tested; it mirrors the Google "configured-then-unconfigured" expectation.
    - **Reconciler must not requeue a misconfigured cred forever.** A sync that fails because the
      provider is unconfigured (or hits OUR-misconfig bucket (b)) increments `sync_attempts`
      under the EXISTING bounded backoff and goes **terminal after `MAX_ATTEMPTS`** with
      `sync_last_error` (the reconciler's existing `recordFailure`/terminal policy — no new
      mechanism), so it stops being re-claimed and surfaces for ops. It does not loop
      indefinitely. Env being restored before terminal lets a retry succeed normally.
- **Event CRUD (Graph). v1 is `'primary'`-only** (picker deferred), so in P6 every create
  targets `/me/events` and every update/delete targets `/me/events/{id}`. We do NOT implement
  non-default-calendar create paths now — that's part of the deferred picker. **Update/delete
  use `/me/events/{id}` regardless of which calendar the event lives on, and this is the
  validated Graph addressing rule** (an event is addressed by id alone; the calendar is not in
  the path), so `externalCalendarId` is NOT used to build update/delete URLs. The port keeps the
  `calendarId?` arg only so the future picker can pass a create-target without an interface
  change; in P6 it's always effectively `'primary'`. `BookingReference.externalCalendarId` is
  still stored (= `'primary'` for v1 Outlook) so a later picker's recreate-on-not-found can
  target the right calendar without a migration.
  - Create body: `subject` = summary, `body` `{contentType:'text', content: description}` from
    Part A's builder, `start`/`end` `{dateTime, timeZone}` (IANA tz, already passed).
  - **Teams online meeting with safe fallback (narrow, allow-listed):** attempt create with
    `isOnlineMeeting:true, onlineMeetingProvider:'teamsForBusiness'`. **Only retry without the
    online-meeting fields when the error is specifically the "this account can't create a Teams
    meeting" class** — i.e. a 4xx whose Graph error `code` is in a small allow-list (e.g.
    `ErrorInvalidRequest`/`OrganizerNotInDirectory`/the personal-account online-meeting-
    unsupported codes; the exact codes are confirmed against live Graph in P6c before locking).
    **Any OTHER 4xx (401/403 auth/permission, malformed body, calendar errors) does NOT trigger
    the no-Teams retry** — it propagates as the normal failure (auth/permission → throw →
    reauth/fail-closed; others → sync failure → `sync_pending`). So we never silently create a
    Teams-less event to paper over an auth/permission/body bug. On the allow-listed case,
    **retry the create once WITHOUT the online-meeting fields, carrying the SAME
    `transactionId`** (so the two attempts dedupe against each other — if the first attempt
    actually created an event server-side before erroring, the retry returns that existing event
    rather than a duplicate; and we inspect the returned event for `onlineMeeting.joinUrl`). We
    do NOT pre-detect account type (unreliable); we react to Graph's rejection. On success
    without Teams, `meetUrl = null` (the customer email omits a join link, the event still
    lands). On success with Teams, `meetUrl = onlineMeeting.joinUrl` → `BookingReference.
    meetingUrl`. The `transactionId` is constant across BOTH attempts and any transport retry.
    **Caveat (verified in P6c, not assumed):** the Teams rejection is almost always a validation
    error that fires BEFORE any event is created, so the no-Teams retry just creates the single
    event. If a Teams attempt DID create an event before erroring, the same-`transactionId` retry
    dedupes to it (Graph dedupe is per-id, payload-independent). Either way the ref-row-first
    check (idempotency step 1) is the durable backstop — we do not rely solely on
    `transactionId`. P6c includes a live-Graph check of this exact retry behavior before the
    path is locked.
  - **Idempotent create (Graph forbids client-set ids, so this differs from Google):**
    1. Before creating, look up `BookingReference (bookingId,'microsoft')`; if present, the
       create already happened → reuse it (no second create). The ref row is the **durable**
       idempotency anchor.
    2. Set a deterministic Graph `transactionId` = the booking uuid on the create payload, so
       even a retry that races *before* the ref row is written is deduped by Graph within its
       dedupe window.
    3. **The unavoidable narrow race + `transactionId` semantics:** Graph dedupes a create
       carrying a `transactionId` seen recently by returning **the existing event** (idempotent
       create) rather than a duplicate or hard error — so a retry inside the window recovers the
       event id and CAN write the ref. The residual hole is only: create succeeded, our process
       died before writing the ref, AND the retry lands OUTSIDE Graph's dedupe window. That
       window-miss can leave one orphan event (logged); it never double-books (events don't
       affect `calendar_key`) and never blocks the booking (DB is authoritative). This is the
       same residual risk Google's design tolerates.
  - **External call is NOT in a DB transaction (it can't be).** Ordering is explicit: (1) the
    booking row is already committed; (2) call Graph create; (3) on success, write the
    `BookingReference` row; (4) if (3) fails, mark `sync_pending` and return — the reconciler
    later re-runs, the ref-first check + `transactionId` recover the existing event and write
    the ref. "Same flow" means same in-process sequence, not an atomic DB+Graph transaction
    (which is impossible). This is the locked create/recover contract.
  - Update: `PATCH /me/events/{id}` start/end → Graph 404/410→`not_found`, 403→`no_access`.
    **`externalCalendarId` is used ONLY for recreate-on-not-found targeting, never for the
    PATCH/DELETE URL** — Graph addresses an existing event by id alone, so update/delete URLs
    are always `/me/events/{id}` regardless of which calendar the event lives on.
  - Delete: `DELETE /me/events/{id}` → swallow 404/410, 403→`no_access`.
  - Each call wraps a Graph-specific retry honoring `Retry-After` on 429 + 5xx, mirroring
    `withGoogleRetry`. **`MicrosoftNotConfiguredError` / `CALENDAR_REAUTH_REQUIRED` thrown by
    `getValidAccessToken` inside create/update/delete are caught by the EXISTING `InternalProvider`
    sync wrappers** (`syncGoogleCreate`-equivalent try/catch already logs + marks `sync_pending`)
    — they never bubble as a booking failure, because the booking row is already committed. The
    port's CRUD methods return status strings for HTTP outcomes; token/config errors throw and
    are absorbed by those same wrappers. This catch boundary is stated so a post-commit token
    error can't surface as a user-facing booking error.
- **Free/busy (Graph):** `getBusyMicrosoft(botId, startISO, endISO)` via
  `GET /me/calendarView?startDateTime=&endDateTime=` (default calendar) or
  `/me/calendars/{id}/calendarView` for a non-default calendar — chosen by the cred's
  `calendarId`, consistent with event CRUD. We use `calendarView` (NOT `getSchedule`) because
  it returns the concrete events with `showAs`/`isCancelled` we already model like Google's
  events.list; `getSchedule` returns coarser merged availability and a different shape.
  - **`showAs` mapping (explicit, fail-safe-toward-busy, locked):** count an event BUSY unless
    clearly free. BUSY ⇐ `showAs in ('busy','oof','workingElsewhere','tentative')` OR `showAs`
    absent/`unknown` (unknown ⇒ busy, never under-report). **`tentative` counts as BUSY** —
    under the fail-safe-toward-busy principle a tentative hold is a real conflict signal; we do
    NOT let the bot book over a tentative block. FREE (skip) ⇐ `showAs === 'free'` only. Always
    skip `isCancelled === true`. This is a product acceptance decision, test-pinned.
  - **Timezone / DST / all-day handling (locked, exact parse):** send `Prefer:
    outlook.timezone="UTC"` so Graph returns each event's `start`/`end` as a
    `{ dateTime, timeZone }` object where `dateTime` is a tz-less local-time string (e.g.
    `"2026-06-08T09:00:00.0000000"`) and `timeZone` is `"UTC"`. **Parse rule:** read
    `start.dateTime`/`end.dateTime` and interpret as UTC. **We ASSERT `timeZone === "UTC"`; if
    Graph ever returns a non-UTC zone (e.g. a Windows zone name like `"Pacific Standard Time"`)
    we do NOT attempt a Windows→IANA mapping — we FAIL CLOSED** (`getBusyMicrosoft` throws →
    503). No timezone-mapping library is introduced in P6; the `Prefer: outlook.timezone="UTC"`
    header is the contract, and a violation is treated as untrustworthy busy data. Build
    `Date` objects → `BusyInterval`. `calendarView` expands recurrences into concrete DST-correct
    instances. **All-day events** under this header come back with `dateTime` at `00:00:00` /
    next-day `00:00:00` and `timeZone==="UTC"` (Graph does NOT use the date-only `date` shape
    that Google's events.list uses here) — so they parse through the EXACT same path as timed
    events, covering the full day as busy. **Unparseable event ⇒ fail closed for the whole
    query (not a guessed interval, not a skip):** if any returned event lacks a parseable
    `start.dateTime`/`end.dateTime`, or yields `end <= start`, `getBusyMicrosoft` THROWS (logged)
    → `loadAllBusy` raises `BOOKING_TEMPORARILY_UNAVAILABLE` (503). Skipping would risk a
    double-book and "busy for its nominal day" is not a well-defined interval, so refusing to
    offer slots for that window is the safe choice. These cases (UTC, non-UTC fallback, all-day,
    unparseable→throw) are unit-tested because undercounting busy double-books.
  - **Pagination:** `calendarView` is paged; we MUST follow `@odata.nextLink` until exhausted
    (`$top=100`) — dropping pages under-counts busy and risks double-booking. **Each nextLink
    request carries the SAME `Authorization` bearer, the same `Prefer: outlook.timezone` header,
    and goes through the same Graph retry wrapper** as the first page (nextLink is an opaque
    absolute URL; we re-attach headers, we do NOT rely on them being embedded). Bounded by the
    caller's window (a few days), so pages are few.
  - **Private events / permissions:** `/me/...` reads the owner's own calendar, so private
    events are visible to us; no shared-calendar permission concerns in v1 (default/own
    calendar only).
  - **Failure modes:** mirror Google exactly. `loadAllBusy` wraps the provider call and throws
    `BOOKING_TEMPORARILY_UNAVAILABLE` (503, fail closed) on ANY thrown error — Graph 5xx,
    throttle exhaustion, `CALENDAR_REAUTH_REQUIRED`, or `MicrosoftNotConfiguredError`. The
    resolved port returns `null` **only** for the no-active-cred case; a present-but-broken
    provider THROWS. This `null`-vs-throw distinction is the load-bearing invariant and is
    explicitly unit-tested for both providers (no-cred ⇒ null ⇒ internal-only; broken-cred ⇒
    throw ⇒ 503 fail-closed). No change to `InternalProvider` — it depends on the port.
- **Identity → `calendar_key` (the critical invariant):** **v1 Outlook is locked to the
  account default calendar** (`calendarId='primary'`), so `resolveIdentityMicrosoft(botId)`
  returns the stable **`account_id`** (Graph user GUID). **It NEVER returns `null` to a
  booking/rekey caller for an active Microsoft cred:** a missing `account_id` on an active
  Microsoft cred is a broken-credential condition that sets `reauth_required` and **throws**
  `CALENDAR_REAUTH_REQUIRED` (fail closed) — it does NOT fall through to a null identity that
  would key on `bot:<botId>`. So a Microsoft booking either keys on `mscal:<account_id>` or
  doesn't happen at all; it can never silently land on the bot fallback. (The only `null`
  identity in the whole system is Google-legacy/unverified or no-provider — both Google-side.)
  - **Provider-scoped conflict key:** today `conflictKeyFor(botId, identity)` hard-codes
    `gcal:<identity>`. P6 makes it provider-aware: `conflictKeyFor(botId, identity, provider)`.
    **Locked strings:** Google keeps the EXACT existing `gcal:<identity>` (no rekey/migration of
    existing Google bookings); Microsoft uses `mscal:<account_id>`. A Google and an Outlook
    calendar are different real calendars even if the email matched, so they must NOT share a
    key. Two bots on the same Outlook account share `mscal:<account_id>` ⇒ protected by the gist
    EXCLUDE constraint, same as Google. Callers passing no provider (none after P6 — all sites
    updated) default to `'google'` to preserve the legacy string.
  - **Future picker note (so later code doesn't break the model):** if an Outlook calendar
    picker is ever added, a non-`primary` selected calendar's identity MUST become
    `mscal:<calendarId>` (a specific calendar, not the account) — i.e. the identity ladder is
    "selected non-primary calendarId, else account_id". v1 simply never hits the first rung.
    This is noted now so the conflict-key contract stays "identity = the most specific real
    calendar we write to."
  - **No-identity fallback `bot:<botId>` is INTENTIONALLY per-bot, not per-calendar.** When
    identity is `null` (legacy/unverified), a bot's bookings key on `bot:<botId>` — so they
    only protect *that bot* against itself, NOT cross-bot. This is the accepted degraded mode
    (same as Google today): without a resolvable calendar identity we cannot safely claim two
    bots share a calendar, so we fall back to the strictly-correct per-bot guard rather than
    risk a false-merge. **This `bot:<botId>` fallback is reachable ONLY for Google legacy creds
    (email unknown) and the no-provider case — NOT for Microsoft.** A Microsoft active cred
    always has `account_id` (always present from `/me`); a null `account_id` on an active
    Microsoft cred is treated as **broken/reauth-required** (above), so free/busy fails closed
    and bookings don't proceed on a degraded key — Microsoft never silently lands on
    `bot:<botId>`. **Note for future code (test-pinned):** `bot:<botId>` is deliberately
    providerless — do NOT assume every "connected provider" key is provider-prefixed; a
    connected-Google-legacy or no-provider bot legitimately keys on `bot:<botId>`.
  - The provider switch (Google→Outlook) changes the key prefix/identity ⇒ `rekeyBotBookings`
    re-stamps active future bookings (the switch already triggers it). A pre-existing real
    overlap that now collides surfaces as `CALENDAR_REKEY_CONFLICT` (left on old key, logged) —
    existing, unchanged behavior. **Mixed-key state after a partial rekey is SAFE, not a
    protection gap:** the gist EXCLUDE constraint protects within each key value, and a row left
    on `gcal:*` while new bookings are `mscal:*` simply means those two are NOT treated as the
    same calendar — which is the strictly-correct conservative outcome (we never *merge* two
    real overlapping appointments by force; a left-behind conflict is a real prior double-book
    being surfaced for the owner). New booking creation is NOT blocked by a leftover conflict:
    a new booking keys on the bot's CURRENT identity (`mscal:<account_id>`) and is validated
    against other `mscal:*` rows; the stranded `gcal:*` row only fails to migrate, it doesn't
    poison new creates. The `CALENDAR_REKEY_CONFLICT` log entry is the admin-repair signal
    (resolve the underlying double-book manually) — same contract as today's Google reconnect.
- **Portal:** add a "Microsoft / Outlook Calendar" block in `SchedulerSettings.tsx` mirroring
  the Google one (connect / status / disconnect), `useOutlookCalendarQueries`, redirect
  `?outlook=connected|error`. **Mutual exclusivity is enforced server-side** (the
  `exchangeAndStore` revoke-the-other-provider logic + the `(botId) where active` unique
  index); the UI is cosmetic — it shows the single active provider as "Connected" and the
  other as "Connect" with a note "Connecting Outlook will replace your Google connection" (and
  vice-versa). A direct API caller still safely switches (never two active). The status block
  also surfaces `needsReauth` ("Reconnect needed"). Calendar-picker (`/calendars`, `/calendar`)
  for Outlook
  is **optional / deferred** — v1 Outlook can write to the default calendar (`'primary'`)
  only, matching Google's original v1; the picker can be a follow-up. (Locked: Outlook v1 =
  default calendar only; picker out of scope for P6.)

### Out of scope (P6)
Apple/iCloud calendar; two-way sync (owner edits in calendar flowing back); dual active
providers / merged free/busy across providers; Outlook calendar picker (default calendar
only); capturing new intake/phone/address fields (P3/P5 own capture — P6 only renders);
changing the customer-facing email/ICS body; migrating old Google events on a provider switch.

---

## Slices (tracer bullets)

- **P6a — Rich event/record body (provider-agnostic, Google only).** New
  `booking-content.ts#buildBookingEventContent` (fixed field order, sorted intake keys, 500/
  4000-char caps); `syncGoogleCreate` + the reconciler's `loadEventMeta` both call it with the
  full booking row + service + `manageUrl`; `createBooking`'s INSERT adds **`source_channel`
  only** (= `ctx.session.channel`, zero new plumbing). *Demoable: book against a Google-
  connected bot with a service that has a description + notes → the Google event body shows
  Service / Customer / Notes / Manage lines (the Meet join button comes from native
  conferenceData, not the text); a reconciler-retried event's body string is identical
  (snapshot-equal). Intake/phone/address/aiSummary render only when an upstream slice has
  populated them; NULL ⇒ line omitted.* No OAuth, no schema DDL.

- **P6b — `CalendarProvider` port + Microsoft OAuth connect + the one migration.** Migration:
  swap to `(botId) where status='active'` unique index + add `account_id` + `reauth_required`
  columns. Extract the port interface, wrap Google as an adapter, `resolveCalendarProvider`
  selection (at-most-one, defensive on >1); add `outlook-calendar.service.ts` OAuth
  (`buildConnectUrl` with `provider:'microsoft'` state claim / `exchangeAndStore` writing
  `account_id` from `/me` + revoking the other provider in-txn / `getValidAccessTokenMicrosoft`
  with locked double-checked refresh + refresh-token rotation), `microsoft` config block,
  callback + authed routes (`connect-url`/`status` w/ `needsReauth`/`disconnect` working even
  when unconfigured). Status surfacing `needsReauth` added to Google too. *Demoable: owner
  connects Outlook in the portal; an active `microsoft` `CalendarCredential` (with `account_id`)
  is stored; connecting it while Google was connected switches the bot atomically (Google
  revoked, bookings rekeyed to `mscal:<account_id>`); `/status` reflects provider + reauth
  state.* Blocked by nothing, but Part A's builder should exist first so P6c can reuse it.

- **P6c — Outlook event CRUD + free/busy wired through `InternalProvider`.** Implement Graph
  `getBusy` (calendarView + nextLink pagination + `showAs` busy-mapping, fail-closed) /
  `createEvent` (ref-row + `transactionId` idempotency, Teams-then-retry-without fallback) /
  `updateEvent` / `deleteEvent` / `resolveIdentity` (stable `account_id`); `mscal:` conflict
  key via the provider-scoped `conflictKeyFor`; reconciler gains the `providerType='microsoft'`
  branch (and goes terminal for a ref whose provider has no active cred). `InternalProvider` +
  reconciler go through the resolved port (the no-cred⇒null vs broken⇒throw invariant is
  unit-tested). *Demoable: against an Outlook-connected bot, a chat booking creates an Outlook
  event with the Part A rich body (+ Teams join on a work account, gracefully none on a
  personal account), the bot won't offer a slot colliding with an existing Outlook event and
  fails closed (503) on a Graph error, and reschedule/cancel update/delete the Outlook event.*
  Blocked by P6a (body builder) + P6b (OAuth/creds/port).

---

## Implementation refinements (codex round 1 — authoritative over conflicting text above)

These resolve the round-1 review. Where a point is genuinely live-Graph behavior, it is
turned into an explicit, testable decision rule with a concrete fallback/guard (P6c verifies
the assumption, but the fallback is locked NOW so it is never hand-waved). Numbered to match
the review.

1. **Part A persistence claim narrowed (doc fix).** Part A does NOT make the *stored* Booking
   row carry new rich contact/intake content. The confirmed-path INSERT adds **`source_channel`
   only**. The rich-content columns (`customer_phone`, `customer_address`, `intake_answers`,
   `ai_summary`) stay whatever an upstream slice (P3/P5) wrote — NULL on the auto-confirm path
   today. Part A is precisely: **render existing Booking fields into the owner's calendar event
   body when present** (and persist `source_channel`). The "Current state" bullet that reads as
   if Part A backfills those columns is superseded by this line.

2. **`transactionId` on `/me/events` — verify, but the backstop is locked.** P6c MUST verify
   against live Graph that `POST /me/events` accepts a client-supplied `transactionId` on BOTH
   the Teams payload and the no-Teams retry payload, and observe its dedupe window. **Locked
   guard regardless of the verification outcome:** the **`BookingReference` ref-row lookup
   (idempotency step 1) is the durable anchor**, NOT `transactionId`. If P6c finds Graph ignores
   or rejects `transactionId` on `/me/events`, we DROP it from the payload and rely solely on
   (a) ref-row-first check before every create and (b) the reconciler's recreate-on-not-found
   recovering/relinking any orphan — `transactionId` is a best-effort *narrowing* of the
   process-died-between-create-and-ref window, never a correctness requirement. Removing it
   changes no other contract. Tests assert: ref-row present ⇒ no second create, independent of
   `transactionId` support.

3. **Teams fallback allow-list — concrete, fail-closed-on-unknown (locked).** The no-Teams
   retry fires ONLY when ALL hold: (i) HTTP status is **4xx** (never 5xx — 5xx is transient,
   retried by the Graph retry wrapper, not de-Teamed), (ii) the Graph error `code` is in the
   **explicit allow-list** below, (iii) it is the create call. **Allow-list (locked starting
   set):** `{ "OrganizerNotInDirectory",
   "ExceptionMessageRequiresOnlineMeetingProvider", "OnlineMeetingErrorMessage" }` plus any code
   whose message matches the case-insensitive substring `online meeting`. **`ErrorInvalidRequest` is
   generic and is NOT matchable by code alone (locked):** because `ErrorInvalidRequest` is Graph's
   catch-all bad-request code (it fires on malformed bodies and calendar errors too — which must NEVER
   de-Team), an `ErrorInvalidRequest` response de-Teams ONLY when its message ALSO matches the
   case-insensitive `online meeting` (or `onlineMeeting`/`teams`-online-meeting-specific) substring —
   i.e. it qualifies via the message-substring rule, never via the bare code. This prevents
   `ErrorInvalidRequest` from swallowing unrelated bad-request errors. **Unknown 4xx code ⇒
   FAIL CLOSED on the de-Team decision: do NOT retry-without-Teams; propagate as a normal sync
   failure (`sync_pending`).** P6c MAY ADD newly-observed personal-account codes to this
   allow-list (append-only) but MUST NOT widen the trigger to "any 4xx". 401/403/throttle/
   malformed-body are explicitly NOT in the list and never de-Team. This is the locked rule;
   P6c's live check only *extends* the allow-list, it cannot relax the unknown⇒fail-closed
   default.

4. **Switch orphan — precise admin surface (locked).** Two concrete, already-existing surfaces,
   no new UX promise: **(i)** at switch time the switch path emits exactly one
   `CALENDAR_PROVIDER_SWITCHED` log line carrying `{ botId, fromProvider, toProvider,
   rekeyedFutureBookingCount }`; **(ii)** for each old-provider booking later touched
   (reschedule/cancel) the row's **`sync_last_error`** is set to the literal
   `'no active <provider> credential for stored ref'` and `sync_pending` is cleared (terminal),
   which is the durable, admin-visible signal already rendered in the existing admin bookings
   view. No new table, no new field, no customer-facing claim. "Admin warning path" = these two.

5. **Post-switch availability acceptance criterion (locked).** **After a provider switch, the
   ACTIVE provider's calendar is the SOLE availability source.** Events stranded on the
   abandoned (old-provider) calendar are NOT consulted for free/busy; their bookings are still
   protected only via the in-scheduler rekey (`mscal:<account_id>`), not via reading the old
   calendar. Support/QA acceptance: "switched-bot free/busy reflects only the new calendar" is a
   pinned expectation, not a bug.

6. **Retryable-vs-terminal taxonomy (exact, locked).** For a CRUD/sync mirror failure on a
   booking row:
   - **`no_connection`** (ref's provider has no active cred — e.g. after a switch/disconnect):
     the reconciler routes by `ref.providerType`, finds no active cred, and goes **terminal
     IMMEDIATELY** (sets `sync_last_error`, clears `sync_pending`) — it does NOT consume
     `MAX_ATTEMPTS`, because retrying can never succeed (the cred is gone for good).
   - **Provider env unconfigured / OUR-misconfig bucket (b)** (`invalid_client` etc.): retryable
     under the **EXISTING bounded backoff**, terminal **after `MAX_ATTEMPTS`** (env may be
     restored before the cap). Not immediate-terminal, because it can self-heal.
   - **Owner-actionable reauth bucket (a)** (`invalid_grant`/policy): the cred is flagged
     `reauth_required`; the mirror is `sync_pending` and retried under bounded backoff, terminal
     after `MAX_ATTEMPTS`. Reconnect clears the flag and a fresh attempt can succeed.
   - **Transient bucket (c)** (5xx/network/throttle): retryable, bounded backoff, terminal after
     `MAX_ATTEMPTS`.
   So exactly ONE class is immediate-terminal (`no_connection` for a stored ref whose provider
   is gone); all others use the existing `MAX_ATTEMPTS` backoff. This removes the apparent
   contradiction between "caught + `sync_pending`" and "goes terminal."

7. **No credential WRITE on the read/identity path (locked, race-safe).** Identity resolution,
   free/busy, and rekey are READ-ONLY with respect to credential state — they MUST NOT write
   `reauth_required`. When `resolveIdentityMicrosoft`/`getBusyMicrosoft` observes a broken active
   Microsoft cred (null `account_id`, or `calendarId != 'primary'`), it **THROWS
   `CALENDAR_REAUTH_REQUIRED` WITHOUT writing the flag** (free/busy fails closed; identity caller
   fails closed). The `reauth_required` flag is set ONLY by the **token-refresh path** (bucket
   (a)), which already holds the cred row `FOR UPDATE` in its refresh txn — so the only writer of
   `reauth_required` is the locked refresh, and it never races reconnect/disconnect (those take
   the same per-bot advisory lock). A null-`account_id` active cred therefore reliably fails
   closed on every read AND gets flagged the next time a token refresh is attempted, with no
   write on the hot read path. This supersedes any earlier "set `reauth_required` and throw
   inside identity resolution" wording: it is **throw-only inside identity resolution; flag-set
   only inside the locked refresh.**

8. **Migration index swap — exact, with rollback (locked).** `up()`: (1) dedup as specified;
   (2) `DROP INDEX IF EXISTS "<existing partial-unique index name>"` — the implementer reads the
   actual index name from the migration that created it (the one defining
   `(botId, provider) WHERE status='active'`) and references it explicitly by that literal name
   (NOT a guessed name); if the name is uncertain it is resolved from
   `pg_indexes WHERE indexdef ILIKE '%status%active%' AND tablename='chatbot_calendar_credentials'`
   at write time and hard-coded. (3) `CREATE UNIQUE INDEX "ux_calcred_active_per_bot" ON
   chatbot_calendar_credentials (bot_id) WHERE status='active'`. `down()`: drop
   `ux_calcred_active_per_bot`, recreate the original `(botId, provider) WHERE status='active'`
   index under its original name. `IF EXISTS`/`IF NOT EXISTS` guards make both directions
   idempotent. The new index name is fixed (`ux_calcred_active_per_bot`) so later migrations
   reference a known literal.

9. **`getActiveCredential` is provider-scoped by adapter closure (doc fix, not a contradiction).**
   The port method signature stays `getActiveCredential(botId)` with **no provider arg** because
   **each adapter instance is bound to exactly one provider** (the Google adapter only ever
   queries `WHERE provider='google' AND status='active'`; the Microsoft adapter
   `WHERE provider='microsoft' AND status='active'`). The provider is a property of the adapter,
   not a parameter. `providerByType(ref.providerType)` returns the correctly-scoped adapter, so a
   Google-ref op reads only the Google cred. There is no interface/usage contradiction: the
   adapter closes over its provider.

10. **Status response shape (locked).** Each provider block calls its OWN status endpoint
    (`/integrations/google/status`, `/integrations/microsoft/status`). Each returns the SAME
    shape: `{ connected: boolean, provider: 'google'|'microsoft', accountEmail: string|null,
    needsReauth: boolean, misconfigured: boolean }`. **A provider reports `connected:true` ONLY
    when ITS OWN provider has the single active cred**; when the OTHER provider is active, this
    provider returns `connected:false` (its own active-cred query finds nothing — the
    single-active model means at most one provider is ever `connected:true`). The UI shows the
    active one as "Connected" and the inactive one as "Connect" + the switch-replaces copy. So
    the two status endpoints are independent and provider-scoped; they cannot both report
    connected.

11. **Microsoft disconnect is DB-only (locked).** Normal disconnect does NOT call any Graph
    token/consent-revocation endpoint; it sets the cred `status='revoked'` and rekeys. (Remote
    Graph revocation is out of scope for P6 — the owner revokes app consent in their Microsoft
    account settings if desired.) Therefore the env-missing case needs no special "swallow remote
    revoke" carve-out — there is no remote revoke to swallow; disconnect is always a local DB
    update and always works. This supersedes the earlier "best-effort Graph revoke is skipped/
    swallowed when unconfigured" wording: there is **no** remote revoke in any disconnect path.

12. **Create-time timezone — IANA-direct, verify, fail strategy locked.** The create payload
    sends `start`/`end` as `{ dateTime, timeZone: <IANA tz> }`. **Decision rule:** modern Graph
    accepts IANA zone names on event create when the request carries
    `Prefer: outlook.timezone="<IANA>"`-style support; P6c MUST verify a common IANA zone (e.g.
    `Europe/Paris`, `America/New_York`) is accepted on `POST /me/events`. **Locked fallback if
    verification shows Graph rejects the IANA name:** the create payload sends
    `timeZone: "UTC"` with `dateTime` converted to the absolute UTC instant (we already hold the
    absolute start/end), which Graph accepts universally — NO Windows-zone mapping library is
    introduced. So the event time is always correct regardless of IANA acceptance; the only
    difference is whether the stored zone label is IANA or UTC. A create that errors on the zone
    is NOT silently dropped — it falls to the UTC-instant form. Tests pin: create succeeds for a
    non-UTC IANA zone via whichever form P6c locks.

13. **All-day busy mapping (locked).** Under `Prefer: outlook.timezone="UTC"`, `calendarView`
    returns all-day events with `dateTime` at `00:00:00`/next-day `00:00:00` and
    `timeZone==="UTC"`; we parse them as UTC instants through the SAME path as timed events. We
    do NOT attempt to re-anchor an all-day event to the owner's local midnight — the busy
    interval is exactly what Graph returns under the UTC `Prefer` header. **Accepted consequence
    (locked, test-pinned):** an all-day event's busy window is its Graph-UTC span; if that
    differs from the owner's local-midnight intuition the bot is at worst MORE conservative
    (fail-safe-toward-busy), never less — so it can over-block but never under-block, which is
    the safe direction. No DST/all-day re-anchoring logic is added in P6.

14. **Google regression coverage (locked).** Because Part B touches shared Google code (token
    refresh → `FOR UPDATE` double-checked, state JWT → `provider:'google'` claim, status →
    `needsReauth`, active-cred uniqueness index, provider-aware `conflictKeyFor` defaulting to
    `gcal:`), P6b/P6c MUST include Google **regression** tests covering: connect (state mint +
    callback, including a legacy provider-less state within the cutoff), refresh (stable refresh
    token under the new `FOR UPDATE` path; no behavior change for non-rotating tokens), status
    (`needsReauth` true for a no-refresh-token legacy cred, false otherwise), rekey (`gcal:` key
    unchanged; no migration of existing Google bookings), free/busy (unchanged null-vs-busy),
    and create/update/delete (unchanged outcomes + same deterministic-id idempotency). These are
    listed so the shared-surface changes can't silently regress Google.

15. **4000 cap is an internal safety cap (doc fix).** The 4000 code-point `description` cap is an
    **internal safety bound**, NOT derived from a provider limit (Graph and Google both allow far
    larger bodies). Its job is to keep bodies bounded/snapshot-stable and avoid pathological
    payloads, not to satisfy an API maximum. Stated so no one "raises it to the provider limit."

16. **Reconciler must load the FULL body input set (locked fixture).** `loadEventMeta` (extended)
    MUST load every field `buildBookingEventContent` consumes so the reconciled body is
    byte-identical to the inline one: from the booking row — `attendeeName`, `attendeeEmail`,
    `customerPhone`, `customerAddress`, `intakeAnswers`, `aiSummary`, `notes`, `sourceChannel`,
    `bookingId` (for `manageUrl`); and the related `service` `{ name, description }`. The
    reconciler-parity test uses a fixture that populates ALL of these (non-null) and asserts the
    inline-vs-reconciler builder strings are equal — so a partially-loaded row would fail the
    test. This pins the exact load set.

17. **`buildManageUrl`/base-URL config must NOT block booking (locked).** `Manage:` is always
    appended, but a missing/invalid manage base-URL config MUST NOT throw out of the body builder
    and MUST NOT fail event creation. **Rule:** `buildBookingEventContent` treats `manageUrl` as
    just another value — if `buildManageUrl(bookingId)` returns null/empty (misconfig), the
    `Manage:` line is simply **omitted** (same as any empty field), the rest of the body renders,
    the event still creates, and the booking still succeeds. The builder never throws on manage
    config. (If current `buildManageUrl` can throw on missing config, the caller catches and
    passes `manageUrl=null`.) Booking success never depends on manage-URL config.

18. **Port throw-contract documented (locked).** The port's method contract:
    - `getBusy` → returns `BusyInterval[]` or `null` (`null` = no active cred only); **MAY THROW**
      on a present-but-broken provider (token/config/parse) — callers (`loadAllBusy`) catch and
      raise 503 (fail closed).
    - `createEvent` → returns `CalendarEventResult` or `'no_connection'`-equivalent `null` (no
      cred); **MAY THROW** token/config errors (`CALENDAR_REAUTH_REQUIRED`/
      `MicrosoftNotConfiguredError`) — caught by the `InternalProvider` sync wrappers, which mark
      `sync_pending` (booking already committed, never user-facing).
    - `updateEvent`/`deleteEvent` → return status strings for HTTP outcomes; **MAY THROW**
      token/config errors, absorbed by the same wrappers.
    - `resolveIdentity` → returns `string|null`; **MAY THROW** for a broken Microsoft cred
      (null `account_id`) — caller fails closed.
    - `getActiveCredential` → returns `CalendarCredential|null`; does not throw.
    Every call site of a throwing method is inside either `loadAllBusy` (→503) or a sync wrapper
    (→`sync_pending`); no throw reaches the customer-facing booking result.

19. **Delegated permissions only (locked).** P6 uses **delegated** Microsoft Graph permissions
    (the authorization-code user flow against `/me/...`); **application permissions are explicitly
    out of scope** and not requested. All Graph calls are `/me/...` with a per-owner delegated
    access token; there is no app-only token, no admin-consent-for-app-permissions path beyond the
    tenant-policy reauth bucket (a). This pins the token type so `/me` behavior is well-defined.

20. **Umbrella verify list — covered.** The live-Graph items (IANA timezone acceptance on
    create [#12], `transactionId` on `/me/events` [#2], Teams unsupported codes [#3], multitenant
    + personal callback/status [deployment prereq, already stated]) each now carry a locked
    fallback/guard above, so P6c's verification can only *confirm or pick the pre-locked
    fallback*, never leave the path undefined.

---

## Implementation refinements (codex round 2 — authoritative over conflicting text above)

Numbered to match the round-2 review.

1. **Outlook immutable IDs (locked).** All Outlook event addressing uses
   **`Prefer: IdType="ImmutableId"`** on the create call AND on every subsequent
   update/delete/fetch. We capture and store the **immutable** `id` from the create response in
   `BookingReference.externalEventId`, and send the same `Prefer: IdType="ImmutableId"` header on
   `PATCH`/`DELETE /me/events/{id}`. This prevents the owner moving an event between folders from
   changing its id (which would otherwise cause false `not_found`, duplicate recreates, or
   undeletable stale events). The header is part of the locked Graph contract for every Outlook
   event call (create/update/delete), exactly as `Prefer: outlook.timezone="UTC"` is for
   free/busy. P6c verifies the create response id is immutable.

2. **Booking path serializes with the provider switch via the SAME `calcred:<botId>` lock
   (locked).** The lock interaction gap is real: the credential exchange/switch takes
   `pg_advisory_xact_lock(hashtext('calcred:'||botId))`, but booking creation only took the
   per-`calendar_key` lock — so a booking could resolve the OLD provider/identity, then a switch
   rekeys, and the booking inserts under a now-stale key. **Fix (locked):** the booking-create
   path takes the `calcred:<botId>` advisory lock at the point it resolves the provider +
   computes the `calendar_key`, held in the same txn through the conflict-check + INSERT. Because
   the switch's revoke+insert and the booking's resolve+stamp now contend on the **same**
   `calcred:<botId>` lock, they serialize: either the booking commits fully under the old
   identity before the switch (then the switch's `rekeyBotBookings` re-stamps it), or it blocks
   until the switch commits and then resolves the NEW identity. No booking ever inserts under a
   key that's stale relative to a committed switch. (The per-`calendar_key` gist lock still does
   the overlap exclusion; `calcred:<botId>` is the additional outer serialization with the
   switch.) This is a precise lock-ordering rule: **acquire `calcred:<botId>` BEFORE the
   per-`calendar_key` lock** in the booking path to match the switch path's single lock and avoid
   any cross-lock deadlock (consistent global order: calcred → calendar_key).

3. **One ref per booking enforced by `bookingId`-only lookup (locked, supersedes
   `(bookingId,'microsoft')`).** The idempotency step-1 ref lookup is by **`bookingId` ALONE**,
   not `(bookingId, providerType)`. Before any create the path loads
   `BookingReference WHERE booking_id=$1` (any provider); if ANY ref exists, the booking already
   has a home provider and we **reuse that ref's provider** — we never create a second
   provider's ref. Combined with "reschedule/cancel/reconcile route by `ref.providerType`" and
   "only a brand-new booking (no ref at all) creates a ref under the active provider," this
   guarantees **exactly one `BookingReference` row per booking for life**. The unique constraint
   `(bookingId, providerType)` permits two rows physically, but the code path never writes a
   second because it checks `bookingId` alone first. (We do NOT add a DB `unique(bookingId)` —
   the column was left provider-scoped for the deferred dual-provider future; the single-ref
   guarantee is enforced by the bookingId-first lookup, which is unit-tested: a booking with a
   Google ref, after a switch to Outlook, never gains an Outlook ref on reschedule/cancel/
   reconcile.)

4. **`reauth_required` writes serialize on `calcred:<botId>`, not bare `FOR UPDATE` (locked,
   corrects the round-1 race claim).** Round-1 said the refresh's `FOR UPDATE` row lock
   serializes with reconnect/disconnect — but those take the `calcred:<botId>` advisory lock, a
   different primitive, so they would NOT actually serialize. **Corrected lock rule:** the
   token-refresh path (the only writer of `reauth_required` / rotated tokens) acquires the SAME
   `calcred:<botId>` advisory lock for the duration of its read-recheck-refresh-persist txn (in
   addition to, or instead of, the row `FOR UPDATE`). Connect/disconnect/switch already hold
   `calcred:<botId>`. So refresh, reconnect, disconnect, and switch are all mutually serialized on
   one primitive — a refresh can't flip `reauth_required` while a reconnect is clearing it, and a
   disconnect can't revoke mid-refresh. The double-checked "re-read and only refresh if still
   expired" runs inside this lock. (Read paths — free/busy/identity — take NO lock and NEVER
   write the flag, per round-1 #7.)

5. **Broken-cred invariants surfaced in `/status` (locked, fills the gap).** `/status` does NOT
   need a token, but it MUST inspect the stored row's structural invariants and report
   `needsReauth:true` when the active cred is structurally broken, so the portal never shows a
   healthy "Connected" over a cred that always fails closed. **Locked status rule:** for a
   Microsoft active cred, `needsReauth:true` if ANY of: `reauth_required===true`, OR
   `refreshTokenEnc` is null, OR **`account_id` is null**, OR **`calendarId != 'primary'`** (the
   two structural-broken conditions that throw on read). For Google: `reauth_required` OR no
   refresh token (unchanged). This makes the structural-broken conditions (round-1 #7's
   throw-only-on-read cases) visible in status without writing the flag — status DERIVES
   `needsReauth` from the stored row each call; it doesn't require the flag to be set.

6. **Cached-token rejection: one forced refresh + retry, then mapped (locked).** Graph can reject
   a still-unexpired cached access token (revoked grant, claims challenge). **Rule:** on a
   **401** from any Graph call (free/busy or CRUD), perform ONE forced token refresh (ignoring the
   60s-cushion cache) and retry the call once. If the forced refresh itself fails, map by the
   round-1 #6 refresh-failure taxonomy (bucket a/b/c). If the retried call still returns 401/403,
   treat as **bucket (a) owner-actionable** → throw `CALENDAR_REAUTH_REQUIRED` (free/busy fails
   closed; CRUD → `sync_pending`). **Exact 403 split (locked, resolves the `no_access`-vs-reauth
   inconsistency with Event CRUD):** a 403 is classified by WHETHER it is token/identity-level or
   event-operation-level:
   - **AUTH/POLICY 403 → bucket (a) reauth** (throw `CALENDAR_REAUTH_REQUIRED`): a 403 carrying a
     `WWW-Authenticate` challenge header, or a Graph error `code` indicating conditional-access /
     tenant-policy / consent / insufficient-SCOPE (the whole grant lacks `Calendars.ReadWrite`) — i.e.
     the *credential/grant itself* is the problem; a reconnect (re-consent / re-scope) is the fix.
   - **EVENT-LEVEL 403 → CRUD `no_access` status (NOT reauth)** (the round-2/Event-CRUD mapping holds):
     a 403 with no auth challenge whose Graph `code` denies the operation on THIS specific event while
     the token is otherwise valid (e.g. the event is on a calendar/object the delegated token can't
     modify) → `updateEvent`/`deleteEvent` return `'no_access'`, the booking row is flagged
     `sync_pending`/terminal per the taxonomy, and we do NOT flip `reauth_required` (reconnecting the
     SAME account won't change a per-event permission). 
   So the split is: credential/grant-level 403 (challenge or scope/policy code) ⇒ reauth; event-level
   403 (no challenge, operation-denied code on a valid token) ⇒ `no_access`. The forced-refresh+retry
   path (above) only escalates to reauth when the RETRY still 401/403s WITH an auth-level signal; an
   event-level 403 on the retry maps to `no_access`, not reauth. We do NOT add claims-challenge step-up
   handling (out of scope) — a claims challenge is an auth-level 403 and maps to (a) reauth. This is the
   exact mapping for cached-token rejection and for the standing Event-CRUD 403 outcome.

7. **Teams fallback: status gate BEFORE substring match (locked, removes the contradiction).**
   The de-Team decision evaluates in this exact order: (i) if status is 401/403/429 or any 5xx →
   **never de-Team** (return to normal failure handling: 401/403→reauth, 429/5xx→retry wrapper);
   (ii) ONLY for a remaining **4xx (i.e. 400/404/422-class, NOT 401/403/429)** do we then check
   the error `code` allow-list OR the `online meeting` message substring. So the substring rule
   can never catch a 401/403, because those are excluded one step earlier. The substring is a
   secondary matcher scoped to already-non-auth 4xx responses. (Round-1 #3's allow-list stands;
   this only fixes the evaluation order so 401/403 are filtered first.)

8. **`transactionId` recovery claim stated honestly + durable marker (locked).** Corrected: if
   `transactionId` is dropped/ignored and the process dies AFTER create but BEFORE the ref write,
   the reconciler cannot relink an arbitrary orphan by event-body content alone. **To keep
   recovery durable we write a stable searchable marker on the event at create time:** a
   **`singleValueExtendedProperty`** (a custom Graph extended property) carrying our `bookingId`,
   set in the SAME create payload. The reconciler's recreate-on-not-found path FIRST queries
   `/me/events?$filter=...singleValueExtendedProperty...eq '<bookingId>'` to find a pre-existing
   orphan and relink it (write the ref) instead of creating a duplicate; only if none is found
   does it create. So recovery does NOT depend on `transactionId` (which stays as a best-effort
   in-window dedupe) — the extended-property marker is the durable, queryable anchor.
   **Residual hole (honest):** create succeeded, marker write was part of the same create so it
   either both-landed or neither-landed; the only unrecoverable orphan is one where Graph created
   the event but we never learned its id AND the marker filter is eventually-consistent at query
   time — bounded, logged, never double-books (events don't affect `calendar_key`), never blocks
   the booking. P6c verifies the extended-property create + `$filter` round-trip.

9. **All-day free/busy: conservative expansion, not an unproven over-block claim (locked).** The
   round-1 "UTC span can only over-block" claim is NOT proven and could UNDER-cover owner-local
   hours. **Locked rule:** P6c verifies how Graph returns all-day events under
   `Prefer: outlook.timezone="UTC"`. **Conservative guard regardless of outcome:** if a returned
   event is all-day (`isAllDay===true`), we do NOT trust the raw UTC midnight-to-midnight span;
   we **expand it to cover the full owner-local day(s) it spans**, by treating the all-day event
   as busy from the start-of-day to end-of-day in the **booking/scheduling timezone** (the tz we
   already use for offering slots) for each date the event covers. This guarantees an all-day
   block can never UNDER-cover the owner-local day (it can only over-block at the edges, which is
   fail-safe-toward-busy). `isAllDay` is read from the event; if absent we fall back to the timed
   parse. Unit-tested: an all-day event blocks the entire owner-local day in the scheduling tz,
   regardless of the owner's UTC offset.

10. **Migration dedup: abort on real duplicates, no silent provider change (locked, supersedes
    "keep most-recent").** Because keeping the most-recent active row could silently change a
    bot's active provider WITHOUT repairing `calendar_key` (leaving future rows keyed to the
    abandoned provider), the migration does NOT auto-pick a winner when it finds a bot with **>1
    active cred of DIFFERENT providers**. **Locked behavior:** (a) if duplicates are all the SAME
    provider (benign **only when they share the same calendar identity** — see next sentence), keep
    greatest `(updated_at, id)`, revoke the rest (safe, identity/key unchanged). **Same-provider
    duplicates that point at DIFFERENT calendar identities are NOT benign (locked):** if same-provider
    active dups differ in their identity-bearing field (Google: `calendarId` differs, or `accountEmail`
    differs when `calendarId='primary'`; Microsoft: `account_id` differs), keeping newest would
    silently change the bot's calendar identity WITHOUT a rekey — so this case is treated like the
    cross-provider case: the migration **ABORTS** (or, equivalently, refuses to auto-pick) for that bot.
    Only same-provider dups whose identity field is identical (a true accidental duplicate of the same
    calendar) are auto-deduped by keeping newest. (b) if a bot has active creds of **two different
    providers** (the dangerous case), the migration **ABORTS with a loud error listing the
    affected bot ids** for manual operator repair — it does NOT guess and does NOT silently rekey.
    The abort list includes both the cross-provider bots AND the same-provider-different-identity bots,
    since both would otherwise change calendar identity without a rekey.
    In practice no bot has >1 active row today, so the abort is a guard, not an expected path.
    **`down()` completeness (locked):** `down()` reverses ALL three `up()` schema actions — drop
    `ux_calcred_active_per_bot` + recreate the original `(botId, provider)` partial index, drop
    `account_id`, drop `reauth_required`. (The dedup data change is not auto-reversed — revoked
    rows stay revoked, which is safe and auditable; `down()` only reverses DDL.)

11. **Legacy Google state: rely on JWT `exp` only, DROP the cutoff constant (locked, supersedes
    `LEGACY_STATE_CUTOFF`).** The "deploy time + 30m baked into build" constant is operationally
    ambiguous (rolling deploys, reused artifacts, clock skew). **Removed.** Replaced by: the
    Google callback accepts a provider-less state **iff the JWT itself is unexpired** (its own
    `exp`, already 30m). Since every state JWT expires in 30m, all pre-deploy provider-less Google
    states are naturally gone within 30m of the new build minting only `provider:'google'` states
    — no separate cutoff constant, no clock-skew dependency, no operational follow-up. A Microsoft
    state is still rejected by the Google callback regardless (provider mismatch), so no
    cross-provider replay. After ~30m post-deploy, only `provider:'google'` states exist and the
    leniency is moot. (This is strictly simpler and removes finding #11 entirely.)

12. **`sourceChannel` is persisted, NOT rendered — removed from the builder load contract (doc
    fix, resolves contradiction).** `source_channel` is written to the Booking row by P6a's INSERT
    (round-1 #1) but is **NOT** a line in the calendar event body — the fixed body order never
    renders it. Therefore round-1 #16's reconciler-load list is corrected: `loadEventMeta` loads
    only the fields the **builder consumes** — `attendeeName`, `attendeeEmail`, `customerPhone`,
    `customerAddress`, `intakeAnswers`, `aiSummary`, `notes`, `bookingId`, and `service`
    `{ name, description }`. **`sourceChannel` is dropped from the builder load set** (it's a
    stored-only field, not body input). No `sourceChannel` line exists in the body; no test
    asserts one.

13. **`manageUrl` normalized + capped like every other field (locked, closes the cap proof).**
    `manageUrl` goes through the SAME per-field normalization + 500-code-point cap as all other
    values before becoming the `Manage:` line. So a pathological base-URL config cannot make the
    `Manage:` line exceed 500 code-points, and the protected-tail arithmetic (HEAD+TAIL ≤ ~5×500 <
    4000) holds. If `buildManageUrl` returns null/empty, the line is omitted (round-1 #17). So
    `Manage:` is both bounded (cap) and non-blocking (omit-on-empty) — the 4000 invariant is
    preserved.

14. **One time serializer for create AND update (locked).** The IANA-vs-UTC time-serialization
    decision (round-1 #12) applies identically to `PATCH /me/events/{id}` reschedule start/end —
    the SAME serializer function builds the `{ dateTime, timeZone }` for both create and update.
    If P6c locks the UTC-instant fallback (Graph rejects IANA), BOTH create and reschedule use it;
    they can never diverge. Reschedule never sends a zone form the create path wouldn't.

15. **Graph retry budget (locked, controlled 503).** The Graph retry wrapper has a bounded
    budget: **max 3 attempts** per logical Graph call, honoring `Retry-After` (parsed as either
    delta-seconds OR an HTTP-date, whichever the header is) on 429 and 5xx, with an **overall
    elapsed cap of ~10s per logical call** (a `Retry-After` longer than the remaining budget is
    NOT slept on — we give up and throw). **Pagination shares ONE budget for the whole free/busy
    query:** all `@odata.nextLink` page fetches draw from a single per-query attempt/elapsed
    budget (e.g. an overall ~20s wall cap for the paged query) so a slow/throttling calendar ends
    in a controlled `BOOKING_TEMPORARILY_UNAVAILABLE` (503 fail-closed), never an unbounded wait.
    On budget exhaustion the wrapper THROWS (free/busy → 503; CRUD → `sync_pending`). Exact
    numbers (3 attempts / 10s call / 20s query) are the locked defaults; P6c may tune within this
    bounded shape but MUST keep a hard wall-clock cap.

---

## Implementation refinements (codex round 3 — authoritative over conflicting text above)

Numbered to match the round-3 review.

1. **The `calcred:<botId>` lock spans the ENTIRE busy-read → key → conflict-check → insert →
   mirror-provider-selection window (locked).** Acquire `calcred:<botId>` BEFORE reading
   provider free/busy, and hold it through `calendar_key` computation, the gist conflict check,
   the booking INSERT, and the choice of mirror provider for `createEvent`. So the provider used
   for the free/busy read, the identity used for the key, and the provider used for the mirror
   are ONE consistent snapshot — a concurrent switch cannot land between "read Google busy" and
   "insert/create against Outlook." If a switch is in flight it either completed before the lock
   (booking sees the new provider for busy+key+mirror) or blocks until the booking commits (then
   `rekeyBotBookings` re-stamps). This supersedes round-2 #2's narrower "resolve provider + key"
   wording: the lock covers the busy snapshot too. **What the lock guards vs. what it cannot
   (locked, removes the xact-vs-post-commit contradiction):** the `calcred:<botId>` advisory lock is
   a `pg_advisory_xact_lock` released at commit, so it CANNOT span a post-commit external Graph/Google
   call NOR the post-call `BookingReference` write (the ref write needs the external event id, which
   only exists AFTER the call). It guards exactly the SNAPSHOT-CONSISTENCY window: provider-selection
   (busy read + mirror provider) + the booking/conflict INSERT — held in one txn so the provider/key
   used can't be invalidated mid-flight by a committed switch. The external `createEvent` AND the
   `BookingReference` write both run AFTER that txn commits and the lock releases (round-2 #9: external
   call is NOT in a DB transaction; the booking is DB-authoritative and the external call is best-
   effort/retried). **Create- and ref-idempotency therefore do NOT rely on the advisory lock spanning
   the external call (it can't):** they are carried by (a) the bookingId-first ref lookup performed
   immediately before each create plus an **idempotent ref INSERT** keyed on the EXISTING
   `(bookingId, providerType)` unique constraint — `INSERT ... ON CONFLICT (booking_id, provider_type)
   DO NOTHING` (round-2 #3). Two post-commit creators converge to exactly ONE ref row because both
   choose the SAME provider: a no-ref booking's provider is `resolveCalendarProvider(botId)`, which is
   deterministic (the bot's single active cred) and identical for concurrent creators, so their two
   inserts target the SAME `(bookingId, providerType)` and the unique constraint makes the second a
   no-op. We do NOT add a bare `unique(booking_id)` (round-2 #3 keeps the column provider-scoped for the
   deferred dual-provider future); the single-ref-for-life guarantee comes from bookingId-first lookup +
   same-provider determinism + the `(bookingId, providerType)` constraint. **The one narrow window where
   two DIFFERENT-provider refs could be written (locked, honestly bounded):** if a provider SWITCH
   commits between two concurrent no-ref creators' `resolveCalendarProvider` reads, one creator may
   resolve the OLD provider and the other the NEW, so their inserts target DIFFERENT
   `(bookingId, providerType)` and do NOT collide → two refs briefly exist for one booking. This is
   bounded and self-healing: each ref points at a real event the corresponding creator made under its
   own provider; the bookingId-FIRST lookup (which loads `WHERE booking_id=$1` for ANY provider —
   round-2 #3) means the SECOND creator to reach the lookup sees the first's ref and reuses it, so the
   window is only the true tie where both read no-ref before either writes. The old-provider ref's event
   becomes a switch-orphan (logged, owner-cleanup, never double-books) exactly like any other
   post-switch old-provider event; reschedule/cancel route by `ref.providerType` and the
   reconnect-rearm (#5) handles each ref by its own provider. So the invariant is: **at most one ref
   per booking in the common case, and in the rare switch-during-concurrent-create tie a second
   old-provider ref whose event is a documented, logged switch-orphan — never a double-book, never an
   unbounded duplicate.** And
   (b) Graph `transactionId` + extended-property dedupe (round-2 #8, round-3 #7) dedupe the external
   event. **First-writer-wins on the ref is enforced by the `(bookingId, providerType)` idempotent
   insert + same-provider determinism, NOT by the advisory lock.** So "the lock covers the mirror" means
   ONLY that it covers the consistent CHOICE of mirror provider+key+busy snapshot; the external create
   and the ref write happen post-lock and are made safe by ref-idempotency, NOT lock duration —
   consistent with round-2 #9 everywhere.
   **Token refresh happens BEFORE the booking lock, never nested inside it (locked, avoids BOTH the
   self-deadlock AND the rolled-back-rotated-token loss):** the booking path does NOT trigger a token
   refresh while holding `calcred:<botId>`. Instead it **pre-warms the token first**: BEFORE opening the
   locked booking txn, it calls `getValidAccessToken*(botId)`, which (if needed) refreshes in its OWN
   short txn — taking `calcred:<botId>`, `FOR UPDATE`, double-checked refresh, persisting the new access
   token + expiry + any rotated Microsoft refresh token, and **committing that txn immediately** — then
   releases the lock. Only after the token is valid does the booking path open its locked txn and run
   busy-read → key → conflict-check → INSERT. So: (i) there is NO nested second acquisition of
   `calcred:<botId>` and therefore no self-deadlock and no need to thread a connection handle into
   `getBusy`; (ii) the rotated refresh token is persisted in its own COMMITTED txn before the booking
   txn even opens, so a later booking-txn ROLLBACK can never discard a rotated refresh token (round-2
   #4's "persist rotated refresh token" durability holds). The busy-read inside the locked booking txn
   then uses the just-warmed cached token (>60s from expiry, so it will not re-refresh in the narrow
   booking window); in the rare event Graph rejects it mid-window, the 401-forced-refresh path (round-2
   #6) runs as its own committed refresh txn AFTER the booking work, on the post-commit external-call
   side — never inside the booking's locked txn. This supersedes the earlier "refresh reuses the
   holder's txn" wording: refresh is **never** nested inside the booking lock; it is pre-warmed before
   and (if a mid-call 401 occurs) re-run on the post-commit side. Reschedule/cancel pre-warm the token
   the same way before taking their `calcred:<botId>` lock.
   **Reschedule and cancel are serialized identically — and reschedule's WHOLE availability snapshot is
   inside the lock (locked):** `syncReschedule`/`syncCancel` also mutate provider-routed state and can
   race a switch/rekey, so they take the SAME `calcred:<botId>` advisory lock. **For reschedule the lock
   spans the ENTIRE re-validation window, identical to create:** acquire `calcred:<botId>` BEFORE the
   reschedule's free/busy re-read for the new time, and hold it through the new `calendar_key`
   computation, the gist conflict re-check at the new time, the `ref.providerType` lookup, AND the
   booking-row mutation (new times, `sync_pending`/`sync_last_error` stamping) — all in one txn. So a
   reschedule's busy snapshot + identity/key + provider-route are ONE consistent snapshot, exactly like
   create (round-3 #1); a concurrent switch can't land between "read busy for new time" and "re-stamp
   key / route the PATCH." Cancel (no availability check) holds the lock around its ref lookup + row
   mutation. The external Graph PATCH/DELETE itself, like create, runs AFTER that committed DB step and
   is NOT required inside the lock (best-effort/retried by the reconciler, routed by `ref.providerType`).
   So create, reschedule, and cancel all serialize against connect/disconnect/switch/refresh on the one
   `calcred:<botId>` primitive, each over its full snapshot window (lock-order calcred → calendar_key,
   round-2 #2); none can compute its provider/key/busy from a snapshot a committed switch has already
   invalidated.

2. **Switch rekey runs INSIDE the same `calcred:<botId>`-held switch txn, before commit/release
   (locked).** `exchangeAndStore`'s revoke-old + insert-new + **`rekeyBotBookings`** all execute
   within the one transaction that holds `calcred:<botId>`; the lock is released only at commit.
   So there is NO window where the new cred is active but future bookings are not yet rekeyed: a
   new booking contending on `calcred:<botId>` blocks until the switch (including rekey) commits,
   then sees both the new active cred AND already-rekeyed future rows. Rekey is never "after
   commit / after lock release." (The fallible network work — code exchange, `/me` — still runs
   OUTSIDE and BEFORE this txn per the original ordering; only the DB revoke+insert+rekey is
   inside the locked txn.)

3. **Partial-rekey stranded row: re-protected by leaving it on its old key AND blocking
   overlapping NEW bookings via an explicit cross-key check is NOT done — instead the stranded
   row is made SAFE by keeping the switch atomic (locked, supersedes the "mixed-key is fine"
   hand-wave).** Because rekey now runs inside the switch txn (#2), the rekey is **all-or-nothing
   for the non-conflicting rows**: `rekeyBotBookings` re-stamps every active future booking to the
   new key. The ONLY row that can be left on the old `gcal:*` key is one whose re-stamp would
   violate the gist EXCLUDE (a genuine pre-existing overlap) → `CALENDAR_REKEY_CONFLICT`, left on
   old key, logged. **Locked safety statement for that residual row (honest about the bounded gap):**
   such a row represents a REAL pre-existing double-book (two overlapping appointments already booked);
   it is left on `gcal:*` because re-stamping it to `mscal:*` would itself violate the EXCLUDE. **There
   IS a bounded residual protection gap while it sits stranded:** because the stranded row is on a
   different key (`gcal:*`) from new `mscal:*` bookings, the gist EXCLUDE does NOT compare them, so a
   NEW `mscal:*` booking could be accepted that overlaps the stranded row's interval in the part NOT
   already covered by the appointment that conflicted with it — a genuine (if narrow) double-book
   against the stranded appointment until repair. **This is the SAME bounded gap today's Google
   reconnect rekey already has** (a `CALENDAR_REKEY_CONFLICT` row is always left on its old key by the
   existing behavior) — P6 does NOT widen it and does NOT silently auto-merge (which would be unsafe).
   **It is closed by operator repair, signalled by `CALENDAR_REKEY_CONFLICT` plus the switch-summary
   count** (the loud log P6 adds): the operator resolves the underlying real double-book, after which
   the row rekeys cleanly. We explicitly accept this bounded, surfaced, operator-actionable residual —
   it is not introduced by P6, it is the documented cost of an overlapping booking existing at
   rekey time — rather than claiming the stranded row creates no gap at all.

4. **`/status` derives `needsReauth`; the 401-after-forced-refresh path DOES write the flag, and
   it is on the refresh path — no contradiction (locked).** Reconciled: the forced-refresh+retry
   (round-2 #6) is PART OF the token-refresh path and runs under `calcred:<botId>`. When a forced
   refresh succeeds but the retried Graph call STILL returns 401/403 (revoked grant the refresh
   couldn't detect, or a policy denial), that is bucket (a) and **the refresh path writes
   `reauth_required=true`** — consistent with "only the refresh path writes the flag" (the
   forced-refresh+retry IS the refresh path). `/status` then reports `needsReauth:true` both
   because the flag is now set AND because status independently derives it from structural
   invariants (round-2 #5). So: the only writer remains the refresh path; status never shows a
   misleading "Connected" because it both reads the flag and re-derives from the row. The
   apparent contradiction was about WHERE the 401-after-refresh write lives — it lives on the
   refresh path, by definition.

5. **`no_connection` terminal rows are RECLAIMED on reconnect of that provider (locked).** A
   stored-ref provider with no active cred is terminal (`sync_last_error` set) — but it is NOT
   "gone for good"; the owner can reconnect that provider. **Locked rule:** when a provider is
   (re)connected (`exchangeAndStore` for that provider commits a new active cred), the connect
   path **re-arms** that provider's terminal-by-`no_connection` bookings: it clears
   `sync_last_error` and sets `sync_pending=true` for active future bookings whose
   `BookingReference.providerType` equals the reconnected provider AND whose `sync_last_error`
   was the `'no active <provider> credential for stored ref'` sentinel — so the reconciler retries
   the mirror and the stale event re-syncs. **Re-arm also covers MAX_ATTEMPTS-terminal reauth rows
   (locked):** because reconnect is the stated recovery for owner-actionable reauth (bucket (a)), the
   re-arm ALSO clears `sync_last_error` + sets `sync_pending=true` for that provider's active future
   bookings that went terminal after `MAX_ATTEMPTS` carrying the bucket-(a) reauth-required sentinel
   (the `CALENDAR_REAUTH_REQUIRED`/`invalid_grant`/policy-denial terminal error) for the reconnected
   provider — those are exactly the rows a fresh credential now lets succeed. So the re-arm set is:
   for the reconnected provider's refs, BOTH (i) the `'no active <provider> credential for stored ref'`
   `no_connection` sentinel AND (ii) the MAX_ATTEMPTS reauth-required sentinel. (Rows terminal for
   OTHER reasons — bucket (b) OUR-misconfig, real non-auth Graph errors — are still NOT re-armed by a
   reconnect; a reconnect doesn't fix those.) This makes both terminal-by-`no_connection` and
   terminal-by-reauth recoverable: terminal stops the retry loop, reconnect re-arms. **Re-arm scope
   covers pending CANCELs and ref-less CREATE failures, not only active reschedules (locked):** the
   re-arm selection is NOT limited to active future bookings — it re-arms ANY booking carrying an
   outstanding mirror obligation for the reconnected provider whose terminal error is one of the two
   sentinels above, specifically: (i) **cancelled** bookings whose stale external event was never
   deleted because the provider was disconnected/broken at cancel time (their `BookingReference` still
   points at the reconnected provider and the DELETE went `no_connection`/terminal) — re-armed so the
   reconciler deletes the stranded event; and (ii) **create failures that terminaled BEFORE any
   `BookingReference` was written** — these have no ref AND no durable attempted-provider, so they are
   identified by booking row state (`sync_last_error` = one of the two sentinels AND no ref row yet) and
   re-armed to retry the create under the bot's CURRENTLY-active provider via `resolveCalendarProvider`
   (round-3 #1) — which, right after a reconnect, IS the reconnected provider. The retry runs the
   extended-property marker lookup against the active provider first (recover-or-create), then writes the
   single ref. **Honest residual when a SWITCH intervened (locked, NOT a contradiction with round-3
   #8's "create may have succeeded before ref"):** a ref-less terminal create CAN have produced an
   orphan event (create reached Graph, ref write never landed — round-2 #8 / round-3 #8). If the bot
   has since SWITCHED providers, that orphan lives on the now-abandoned old-provider calendar, and the
   re-arm — targeting the currently-active provider — will NOT find it (it can't query the disconnected
   old provider) and will create a fresh event under the active provider. This is exactly the SAME
   accepted class as switch-orphans (round-1 #5 / the switch section): the old-calendar orphan is
   logged and left for owner cleanup, never double-books (events don't affect `calendar_key`), never
   blocks the booking. When NO switch intervened (the common reconnect-same-provider case), the marker
   lookup runs against the right calendar and RELINKS the orphan instead of duplicating. So: ref-LESS
   creates re-arm to the active provider; if that equals the original attempt's provider the orphan is
   recovered, and if a switch changed it the old orphan is the documented, logged switch cost — never an
   unbounded loop or a double-book. ref-BEARING obligations still route strictly by `ref.providerType`
   (only the matching provider's reconnect re-arms them). So reconnect re-arms stranded creates,
   reschedules, AND cancels — the full set of mirror obligations a missing credential left terminal —
   with the cross-switch orphan explicitly accepted, not claimed away.
   Without P6 doing this, the owner reconnecting wouldn't heal stranded rows — so it's
   in scope. Tested: reconnect of the original provider re-syncs its stranded bookings (create,
   reschedule, and cancel obligations); reconnect of the OTHER provider does not (those refs route to
   the still-absent provider).

6. **`getBusy` adapter loads the scheduling timezone internally (locked, no port-signature
   change).** The port stays `getBusy(botId, startISO, endISO)`. The all-day expansion (round-2
   #9) needs a tz; the Microsoft adapter loads the **bot's scheduling timezone** itself (the same
   source `InternalProvider` already uses to offer slots — the bot/service availability tz),
   inside `getBusyMicrosoft`, keyed by `botId`. No new port parameter. **Unknown-tz fallback is the
   MAXIMAL local-day span, NOT a bare UTC day (locked, corrects the under-block):** a UTC midnight-to-
   midnight span is NOT fail-safe for a non-UTC owner — their local day can extend up to ~14h ahead and
   ~12h behind UTC, so a bare UTC-day span would UNDER-block the owner-local edges. Therefore, if the
   scheduling tz is unavailable, the all-day expansion blocks the **widest possible local-day window**:
   from `(UTC start-of-day − 12h)` to `(UTC end-of-day + 14h)` for each date the event covers (covering
   every IANA offset from UTC−12 to UTC+14). This can only OVER-block (fail-safe-toward-busy) and can
   never miss the owner's real local day, whatever their actual offset. (When the scheduling tz IS
   available we use the precise local-day span per round-2 #9; the maximal window is only the
   tz-unknown safety net.) So the tz is an internal adapter concern, implementable from `botId` alone,
   and the fallback is conservatively over-blocking rather than potentially under-blocking.

7. **Extended-property constant pinned (locked).** The recovery marker (round-2 #8) is a
   `singleValueExtendedProperty` with a **fixed, hardcoded** definition:
   `id = "String {GUID} Name BookingId"` where `{GUID}` is a single constant GUID minted once for
   Axentrio and stored as a code constant (e.g. `AXENTRIO_BOOKING_ID_PROP_GUID`), `value =
   <bookingId>` (the uuid string). Create payload includes
   `singleValueExtendedProperties: [{ id: "<that id string>", value: "<bookingId>" }]`. Recovery
   query: `GET /me/events?$filter=singleValueExtendedProperties/any(ep: ep/id eq '<id string>'
   and ep/value eq '<bookingId>')` with the value URL-encoded and single-quotes escaped per OData
   (a uuid has no quotes so escaping is trivial, but the encoder is applied uniformly). The GUID
   and `Name BookingId` are constants, not per-tenant. P6c verifies the create+filter round-trip
   with the exact id string. **Multiple-match behavior (locked):** the marker `$filter` can return
   MORE than one event (if `transactionId` was ignored and several retries/workers each created an
   event before any ref committed, or eventual consistency surfaces duplicates) — so the recovery path
   does NOT assume exactly one. It deterministically **RELINKS the first match by created time
   (earliest `createdDateTime`, then by event id as a stable tie-break) into the single
   `BookingReference`**, and treats every OTHER match as a duplicate orphan: each is **logged** (with
   bookingId + event id) and left for owner cleanup (it never double-books — events don't affect
   `calendar_key` — and the booking still has exactly one ref). So "find the orphan" means "pick the
   canonical one deterministically, log the rest"; the count of duplicate orphans is bounded by the
   number of ignored-`transactionId` retries, not unbounded. **Escaping rules (locked, explicit for all
   Outlook URLs):** (a) the
   extended-property `id` string (`"String {GUID} Name BookingId"`) contains spaces and braces — as a
   literal inside the `$filter` it is wrapped in single-quotes and the WHOLE `$filter` value is
   percent-encoded as a query-string value (spaces/braces/quotes encoded); the `value` literal is
   likewise single-quoted and percent-encoded, with any embedded single-quote doubled per OData (`''`)
   — uuids contain none, but the encoder is applied uniformly so a non-uuid marker is still safe.
   (b) **Event ids in path segments** (`/me/events/{id}` for PATCH/DELETE/fetch) are OPAQUE and, under
   `IdType="ImmutableId"`, can contain URL-reserved characters (e.g. `/`, `+`, `=`): each event id is
   **percent-encoded as a single path segment** (`encodeURIComponent`-equivalent) before being placed
   in the URL — never concatenated raw — so an immutable id with reserved chars addresses correctly.
   (c) `@odata.nextLink` is an absolute pre-encoded URL and is used VERBATIM (we only re-attach
   headers, never re-encode it). These path/query/OData escaping rules are the locked contract for
   every Outlook URL the path builds; P6c's round-trip test uses an id/marker exercising reserved
   characters.

8. **Concurrent no-ref create race accepted honestly (locked).** Two workers can both observe no
   `BookingReference` for a booking and both `POST` a create before either ref commits — a true
   duplicate-create race. Mitigations, in order of strength: (i) **`transactionId`** (same uuid on
   both) dedupes them AT Graph if Graph honors it within its window → one event; (ii) if Graph
   ignores `transactionId`, two events are created, BUT (iii) only ONE `BookingReference` is ever
   written (the ref insert is idempotent on `(bookingId, providerType)` with same-provider
   determinism — round-2 #3 / round-3 #1 — first writer wins, second ref write is a no-op/loses), and
   (iv) the extended-property marker lets the reconciler find the canonical event and log every OTHER
   match as a duplicate orphan (round-3 #7's multiple-match rule). **Accepted residual:** in the
   (Graph-ignores-transactionId) case ONE OR MORE duplicate events can exist on the owner's calendar —
   bounded by the number of racing retries/workers, each logged + surfaced — but they NEVER double-book
   (events don't affect `calendar_key`) and the booking always has exactly one ref. (The earlier "at
   most one duplicate" phrasing is corrected to "bounded by the racing-create count"; the marker
   recovery deterministically keeps one and logs the rest.) **The advisory lock does NOT serialize the
   external create
   (corrected, consistent with round-3 #1):** the `calcred:<botId>` lock is released at the booking
   txn's commit, BEFORE the post-commit Graph create — so it does NOT collapse two concurrent external
   creates and we do NOT claim it does. What collapses duplicates to one ref is the idempotent
   `(bookingId, providerType)` insert (above); what bounds duplicate EVENTS is `transactionId` +
   marker recovery. The honest residual is exactly the (Graph-ignores-transactionId) reconciler-vs-
   inline / reconciler-vs-reconciler window: one-or-more duplicate events bounded by the racing-create
   count, exactly one ref, never a double-book. This is the honest, locked statement (not "transactionId
   prevents duplicates," and not "the lock serializes the external create").

9. **Created-but-no-joinUrl ⇒ `meetUrl = null` (locked, success path, not just error path).**
   Independent of any error/fallback: after a successful create, we read
   `onlineMeeting?.joinUrl` from the returned event; **if it is absent/empty, `meetUrl = null`**
   (customer email omits the join line, event still lands) — exactly the no-Teams outcome. So the
   join URL is determined by the RETURNED EVENT's `onlineMeeting.joinUrl`, never assumed from the
   request. A work account that requested Teams but Graph returned no `joinUrl` is treated as
   no-Teams (graceful), not an error. The demo's "Teams join on a work account" means "joinUrl
   present on the returned event"; absence is handled identically to the personal-account case.

10. **Retry budget: "attempts" = RETRIES PER HTTP REQUEST, pages are separate (locked, clarifies
    round-2 #15).** "Max 3 attempts" means **per single HTTP request** (initial + up to 2 retries
    on 429/5xx) — it does NOT cap the number of `calendarView` PAGES. A paged free/busy query may
    fetch many pages (`$top=100`, bounded by the few-day window); EACH page request independently
    gets up to 3 attempts. The SHARED limit across pages is the **overall ~20s wall-clock budget
    for the whole query** (not a page count): when that elapses, the query throws → 503. So: per
    request → ≤3 attempts honoring `Retry-After`; per whole paged query → one ~20s wall cap. Page
    count is bounded by the window, not by the retry count. This removes the "3 attempts vs >3
    pages" conflict.

11. **`intakeAnswers` non-object root ⇒ Intake block OMITTED entirely (locked).** The per-key
    rendering assumes `intakeAnswers` is a JSON object. **If the root value is NOT a plain object**
    (it's an array, string, number, boolean, or null at the root), the **entire `Intake:` block
    is omitted** — we do NOT attempt to render a non-object root. Only `typeof === 'object' &&
    !Array.isArray && !== null` enters the per-key path. This makes the body byte-stable for ANY
    arbitrary jsonb root shape (the column is arbitrary jsonb). Unit-tested: array root → no
    Intake block; scalar root → no Intake block; object root → sorted per-key rendering.

12. **`Prefer: IdType="ImmutableId"` on the orphan-lookup query + any id-returning fetch too
    (locked).** Round-2 #1 required the immutable-id header on create/update/delete; it ALSO
    applies to the recovery `$filter` query (round-3 #7) and ANY Graph read whose returned event
    ids we persist or address later. The header is opt-in per request, so EVERY Graph request in
    the Outlook path that returns or uses an event id carries `Prefer: IdType="ImmutableId"`
    (create, update, delete, free/busy `calendarView`, orphan `$filter` lookup). Consistent
    immutable ids everywhere prevents an id captured from one call being non-addressable in
    another. **Combined Prefer directives (locked):** any Graph call that needs BOTH the immutable-id
    directive AND the UTC-timezone directive — i.e. the free/busy `calendarView` page fetches and the
    orphan `$filter` lookup, which require both `IdType="ImmutableId"` and `outlook.timezone="UTC"` —
    MUST send BOTH in ONE comma-separated `Prefer` header
    (`Prefer: IdType="ImmutableId", outlook.timezone="UTC"`), NOT two separate `Prefer` headers and
    NEVER one directive overwriting the other. Each `@odata.nextLink` page re-attaches this same
    combined header (the round-2 pagination rule that re-attaches `Prefer` per page). Calls needing
    only one directive (create/update/delete need only `IdType="ImmutableId"`) send only that one.

13. **Timezone serialization is a SINGLE hardcoded result from P6c, not a per-request runtime
    fallback (locked, removes environment divergence).** The IANA-vs-UTC decision (round-1 #12,
    round-2 #14) is resolved ONCE during P6c against live Graph and **baked in as a single
    code-level constant/serializer choice** — NOT a per-request runtime probe and NOT an
    environment flag. Either P6c confirms IANA is accepted and the serializer always sends the
    IANA form, OR it doesn't and the serializer always sends the UTC-instant form. The SAME
    serializer is used by create and update (round-2 #14), so create/update can never diverge and
    behavior is identical across all environments (it's compiled-in, not probed). No runtime
    capability detection, no startup flag.
