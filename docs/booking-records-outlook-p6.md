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
    from `MICROSOFT_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` (env, all optional). A separate
    redirect URI / callback path (`/integrations/microsoft/callback`) so the Azure app
    redirect matches.
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
