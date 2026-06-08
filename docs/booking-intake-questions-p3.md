# P3: Intake questions

Per-service questions the agent asks the customer in the booking turn, **before** it fires
the write tool that confirms a booking or captures a request, with the answers stored on the
booking and shown to the owner. The
keystone already made the persistence seam exist (`Booking.intake_answers` jsonb); P3 makes
it a *flow*: the owner authors questions on a service, the agent asks them and threads the
answers into the booking/request, and they surface in the portal Bookings/Requests tabs.

## Goal

Let a solo owner attach a short list of intake questions to a service so the agent collects
the answers in-chat and persists them on the resulting `Booking.intake_answers`, visible in
the portal.

## What the keystone / P2 already provide

- **Persistence seam:** `Booking.intake_answers` jsonb column + `intakeAnswers?:
  Record<string, unknown>` field already exist (added in the keystone, commented "P3"). No
  `Booking` migration needed. **The entity field stays the broad `Record<string, unknown>`** (it
  may hold legacy/hand-edited shapes); P3 only guarantees the **write contract** produces a flat
  `{ string: string } | null`, and the **read path defensively coerces** — we don't narrow the
  column type and break legacy compatibility.
- **Per-service catalog injection:** `prompt-builder.ts` already injects a `## SERVICES
  (bookable)` block, one line per active `ServiceType`, and per-service booking rules. That
  block is where per-service intake instructions get appended.
- **Service-resolution + two write paths:** `create_booking` and `request_appointment`
  (`booking.tool.ts`) both resolve a single `ServiceType` (sole-active default /
  `SERVICE_REQUIRED` / `SERVICE_NOT_FOUND`) inside `InternalProvider` and both funnel into a
  raw `INSERT INTO chatbot_bookings` (the auto-confirm insert in `createBooking`, the
  `createRequest()` insert). Those two inserts are the only places `intake_answers` must be
  written.
- **Services editor:** `ServicesSection.tsx` (portal) is the add/edit dialog for a
  `ServiceType`, backed by `serviceInputSchema`/`serviceUpdateSchema` and the
  `createService`/`updateService` controller handlers — the place to author questions.
- **Bookings/Requests display:** `Bookings.tsx` already renders attendee, service name, and
  notes per row across the `upcoming`/`past`/`requests` tabs; `adminListBookings` already
  builds the `AdminBookingRow`. That's where answers surface.

## Locked decisions

- **Questions live in a jsonb column on `ServiceType`, NOT a new table.** Add
  `intake_questions jsonb null` (entity field `intakeQuestions?: IntakeQuestion[] | null`).
  A question is `{ id: string, label: string, type: 'text' | 'choice', required: boolean,
  options?: string[] }`. Rationale: questions are a small (≤ ~8), owner-authored,
  always-loaded-with-the-service list with no independent query/FK needs — a jsonb array
  mirrors the existing `weeklyHours`/`dateOverrides`/`reminder_job_ids` jsonb precedent and
  avoids a join. **This is the only schema change in P3** (the `Booking` side already exists).
  **Migration:** a single `ADD COLUMN intake_questions jsonb NULL` (nullable, no default, no
  backfill) — every existing `ServiceType` row stays `null`, which the entity and prompt read
  as "no questions" (today's behavior). No data migration; the column is purely additive.
- **Question `id` is a server-generated uuid, stable across edits.** A uuid (not `q1`/`q2`)
  sidesteps any high-water/reuse bookkeeping: deleting then re-adding a question never collides
  with a deleted id, so a stored answer keyed by id can never be mis-labeled by a reused id.
  **The server is the sole authority on ids.** On update, `updateService` **first loads the
  service's currently-stored `intakeQuestions`** (it already loads the row to apply the update),
  then reconciles the submitted array against it; `createService` has no stored set. A submitted
  `id` is kept **only if it matches an existing stored question id on this
  service**; any submitted `id` that is unknown (forged/stale) OR missing is replaced with a
  fresh `crypto.randomUUID()` (treated as a new question — a client cannot pin an arbitrary
  uuid); any previously-stored id absent from the submitted array is dropped (removed).
  **Reconciliation runs ONLY when the `intakeQuestions` key is present in the payload** — an
  absent key (`.partial()`) leaves the stored questions untouched and never triggers a clear (it
  is NOT treated as an empty array). If the same `id` appears twice in the payload, the **first
  in submitted array order wins** and the rest get fresh uuids (submitted order is the stable
  display/prompt order, so "first" is well-defined; no duplicate ids ever reach storage — keeps
  the answer/label maps unambiguous). **On
  `createService` there is no stored set, so every submitted `id` is unknown and replaced —
  i.e. all ids are minted fresh.** The owner authors `label`/`type`/`required`/`options`; the
  client never *invents* an id that the server honors. **Duplicate labels are allowed** — two
  questions may share a trimmed label; they stay distinct by id, and the owner display/prompt
  may show the same label twice (acceptable; we don't dedupe on label).
- **`intakeQuestions` is treated like the other service fields on update: present ⇒ replace,
  absent ⇒ leave unchanged.** `serviceUpdateSchema` is `.partial()`, so an omitted
  `intakeQuestions` key means "don't touch questions" (matches every other field). To *clear*
  all questions the client sends `intakeQuestions: []`, which the server stores as `null`. The
  empty-list-⇒-`null` collapse happens server-side at persist, so "omitted" and "`[]`" are
  distinguishable on the wire. The schema accepts an **array only** for `intakeQuestions`; an
  explicit `intakeQuestions: null` payload **fails validation (400)** — clearing is `[]`, never
  `null`. (The portal client only ever sends `[]` or a populated array.)
- **Validation rules (`serviceInputSchema`/`serviceUpdateSchema`):** `intakeQuestions` is an
  optional array, max **8** questions. Each field is `.trim()`-transformed *before* the length/
  duplicate checks so whitespace-only values can't sneak through: `label`
  `z.string().trim().min(1).max(200)`, `required` boolean, `type` `enum('text','choice')`,
  `options` an array of `z.string().trim().min(1).max(80)` strings. A `choice` question requires
  `min(2).max(10)` options with **no duplicates after trim, compared case-insensitively** (the
  refine lowercases the trimmed value, so `"VIP"`, `" VIP "`, and `"vip"` all collide; the
  original casing is preserved in storage). **To make a type-flip to `text` never 400 on stale
  options, the per-question schema is `z.preprocess(...)`** that, before field validation,
  deletes `options` when `type==='text'` (Zod `.transform` runs *after* parse, so it can't
  prevent an option-rule 400 — a `preprocess`/pre-parse step is required, not a trailing
  transform). After preprocess, the `choice`-only `min(2)`/non-empty option rules apply solely to
  `choice` questions; stored `text` questions never carry an `options` key. **The submitted `id`
  is accepted permissively (`z.string().optional()`, not strict-uuid) because the reconciliation
  step is the real authority:** any submitted `id` — temp/non-uuid from a new portal row, a
  well-formed-but-unknown uuid, or a forged value — that doesn't match a currently-stored
  question id is replaced with a fresh server `crypto.randomUUID()`; only an `id` matching a
  stored question on this service is honored. (So the portal may freely send a temp client id for
  a new row; it is simply reminted.) A blank/whitespace/empty submitted `id` matches no stored
  id and is therefore reminted like any other unknown value — no special-casing needed.
- **Two `type`s only: `text` and `choice`.** `choice` carries `options: string[]`. No date/
  number/file types in P3 (file upload is P5; dates/numbers are collected as free text). This
  keeps the agent prompt and the portal editor minimal. **A `choice` answer is NOT
  server-constrained to the current `options`** — `options` is prompt/UI guidance to steer the
  agent and (if we ever add a customer-facing form) the picker; the agent may store a free-text
  answer. Normalization (below) validates only key + non-empty value, never value-against-options.
- **The agent collects answers conversationally and passes them as ONE new tool param**
  `intakeAnswers` (an object keyed by question id) on **both** `create_booking` and
  `request_appointment` — NOT a separate "answer intake" tool and NOT one param per question.
  Each tool's JSON-Schema `parameters` (in `booking.tool.ts`) gains an optional `intakeAnswers`
  property typed as `{ type: 'object', additionalProperties: { type: 'string' } }` (a flat
  map of question-id → string answer — no nesting, string values only) whose `description`
  tells the LLM to key answers by the question ids listed in the SERVICES block, and each
  tool's top-level `description` notes that intake answers should be collected first — schema +
  prompt together, since a prompt mention alone won't make the LLM emit the field. The
  `execute` methods pass `args.intakeAnswers` through to the service. (The provider normalizer
  is still the backstop for any non-conforming object the LLM produces.)
- **Which questions the agent asks (concrete prompt rule):** "Before calling the booking tool,
  ask any `required` intake question the customer hasn't already answered. You may also ask
  `optional` questions, but never block the booking on them. Pass every answer you have in
  `intakeAnswers`, keyed by question id. If a booking tool returns an error (e.g. it asks which
  service), fix the issue and re-call it, re-including the intake answers you already collected."
  (The optional-question heuristic is intentionally a soft steer, not a verifiable acceptance
  gate — see the next bullet.) The agent passes whatever
  it has collected; missing answers are simply absent from `intakeAnswers` (no server rejection).
- **`required` is a *behavioral* steer for the agent, NOT a hard gate (accepted tradeoff).**
  The tool param stays optional and the provider never rejects a missing required answer (see
  "Answers are stored verbatim" below), so a booking *can* in principle be confirmed without a
  required answer if the agent skips it. **The goal's "collects the answers" is delivered at the
  prompt/agent layer, not enforced at the DB** — we explicitly accept best-effort collection for
  P3 because a hard server gate (rejecting `create_booking` on a missing required answer) is Out
  of scope and would break the sole-active / mid-rollout no-`intakeAnswers` paths. The owner sees
  what was (and wasn't) captured, which is the visibility the goal requires.
- **Prompt injects the full question shape, not just id+label, in a fixed line format:** under
  each service's SERVICES line, an indented `Intake questions:` sub-block lists one line per
  question in array order, using a stable template:
  `  - <id> · "<label>" · <text|choice> · <required|optional>[ · options: a, b, c]`. The agent
  is told to ask `required` questions before the write tool and to key each answer in
  `intakeAnswers` by the leading `<id>`. The fixed `<id> · …` shape (mirroring the existing
  service-catalog line format) gives the LLM an unambiguous id to echo, minimizing
  malformed/missed answers. (Compact: ≤8 short lines per service.) **Owner text is sanitized for
  the line (exact, testable rule):** for `label` and each `option`, replace every run of
  whitespace (incl. newlines/tabs) with a single space, then delete the characters `·` and `"`,
  then `trim()`. (Order: collapse → delete → trim.) This keeps each value on one line and out of
  the quoted/delimited segments; values are already length-capped by the schema. The real safety
  property is that answers are keyed by the leading `<id>`, **never** by label/option text, so
  even adversarial label text can't mis-key an answer — the sanitization is purely cosmetic
  line-hygiene. (If a label/option were ALL `·`/`"`/whitespace it'd sanitize to empty; the
  authoring schema's `.trim().min(1)` runs on the *raw* value so a non-empty raw label always
  has at least one surviving char in practice — and even an empty sanitized segment can't mis-key
  since keying is by `<id>`.)
- **Collection happens at the create/request step, after the service is resolved** (and, for
  auto-book, after a time is chosen). The doc's "before it confirms / captures" means *in the
  same tool turn, before the write tool fires* — not a separate earlier step. For request-mode,
  the agent still resolves a service first (P2's prompt rule "ask which service — never guess";
  this is a *behavioral* guarantee, not a tool-boundary one). "Resolved" here means **resolved
  in the conversation** — the agent has identified the service and collected its answers *before
  it calls the write tool*; the tool boundary itself does not enforce ordering. Either way the
  **provider re-resolves the service authoritatively** inside `createBooking`/
  `requestAppointment` and normalizes the answers against *that* resolved service — so even if
  the agent collected answers loosely, they are only ever stored against the service the row is
  actually booked for (a forged/mismatched service id can't mis-file answers). **If the provider
  resolve throws (`SERVICE_REQUIRED`/`SERVICE_NOT_FOUND`/`BOOKING_NOT_CONFIGURED`), no row is
  written and the collected answers are simply discarded** — the tool returns the error and the
  agent re-asks which service, then retries the write tool **re-passing the answers it already
  collected**. There is **no special retry state** — the answers live in the chat transcript and
  the standard tool-error→re-call loop applies, the same way the agent already re-passes
  `attendeeName`/`attendeeEmail`/`preferredTime` after a `SERVICE_REQUIRED` today (P2). We accept
  the small risk that the LLM drops an answer on retry as no worse than P2's existing retry of
  those required args; if it does, the customer is simply re-asked. **Idempotency note
  (important):** the existing tool keys are `${runId}:create_booking:${startTime}` /
  `${runId}:request_appointment:${preferredTime}` — they do NOT include `intakeAnswers`. This is
  fine for *this* failure path because `SERVICE_REQUIRED`/`SERVICE_NOT_FOUND` throws **before any
  row is inserted**, so there is no existing row to short-circuit to and the retry is a genuine
  first successful insert that carries the answers. We deliberately **keep P2's key shape** (no
  `intakeAnswers` in the key), accepting the out-of-scope edge that a same-run retry at the same
  time *after a successful insert* won't rewrite answers (answers are collected before the first
  successful write, not amended after). `check_availability` never collects intake.
- **Answers are stored verbatim as the jsonb value with no server-side
  schema-completeness enforcement.** The provider persists whatever `intakeAnswers` object the
  agent passes (after a light normalization, below) into `Booking.intake_answers`. We do NOT
  reject a booking for a missing required answer — "required" is an instruction to the agent,
  not a DB constraint (a hard server gate would block legitimate edge cases and break the
  sole-active / mid-rollout no-`intakeAnswers` path). The owner sees what was captured.
- **Normalization at the provider seam (single place):** a `normalizeIntakeAnswers(service,
  raw)` helper, given the **resolved `ServiceType`** (whose `intakeQuestions` is already loaded
  — `resolveService` returns the full row, so no extra query), keeps only entries whose key
  matches a current question id and whose value coerces to a **trimmed non-empty string**.
  Coercion rule: `string` → trimmed; `number`/`boolean` → `String(v)`; **`null`/`undefined`/
  arrays/objects → dropped** (not stringified — we never persist `"[object Object]"`). The
  trimmed string is then **capped at 2000 chars** (truncated, mirroring the schema's bound on
  authored text) so an over-long LLM answer can't bloat the row or the portal. It
  stores `{ <id>: <trimmedString> }`, or `null` if nothing remains. Whitespace-only answers
  (`"   "`) are dropped. This prevents the LLM from injecting arbitrary keys and keeps the
  column a flat `{ string: string }` map for the portal. Both write paths call this same helper
  on the resolved service before insert. **Defensive read of `service.intakeQuestions` too:**
  every consumer of a service's questions (this normalizer, the prompt injector, the portal
  display join) treats a non-array stored value (legacy/hand-edited `null`/object) as "no
  questions" rather than throwing — a malformed service jsonb degrades to no-questions, never a
  crash in prompt build, booking, or list. **Consequence:** a freshly written `intake_answers` can
  only ever contain ids that were current questions at write time; an answer keyed by a *now-
  deleted* question id can therefore only exist on a **pre-deletion historical row** (the
  portal's deleted-question fallback handles exactly those). Number/boolean coercion exists only
  as a backstop for a non-conforming LLM payload (the tool schema asks for strings).
- **Answers persist by extending the two existing raw inserts** in `internal.provider.ts`
  (the `createBooking` auto-confirm insert and the `createRequest` insert) with an
  `intake_answers` column bound to a `$n::jsonb` param (the normalized object JSON-stringified,
  or `null`). `intakeAnswers` (raw) is threaded as a new optional trailing arg through
  `booking.service.ts` (`createBooking`, `requestBooking`), the `BookingProvider.createBooking`
  interface signature, `requestAppointment`, and `createRequest`. Each write path first resolves
  the service (it already does), then normalizes against that service, then inserts. No new
  table, no new INSERT. The new `intake_answers` column + its bound value are appended at the
  **end** of each insert's column list and `VALUES` placeholder sequence (a new trailing `$n`),
  so no existing `$1..$k` placeholder index shifts — the change is purely additive to each
  statement (P3b acceptance: existing booking/request inserts still bind every prior column to
  its original index). **These two inserts are the only writers of `intake_answers`:**
  reschedule/cancel issue UPDATEs that never name the `intake_answers` column, so the original
  jsonb value is preserved untouched (verified against the reschedule/cancel UPDATE statements
  in `internal.provider.ts`, which set only time/status/sequence/notes columns). **Verified
  there is no third `INSERT INTO chatbot_bookings` path:** the only two inserts in
  `internal.provider.ts` are `createBooking` (auto-confirm) and `createRequest`; both
  `create_booking` (request-mode short-circuit) and `request_appointment` route through one of
  these two, so threading `intakeAnswers` into both covers every booking-creation path (P3b
  asserts this — grep for `INSERT INTO chatbot_bookings`).
- **Questions surface in the portal Services editor** as a small repeatable list inside the
  existing `ServicesSection.tsx` add/edit dialog (label input + type select + required
  checkbox + options editor for `choice`; add/remove rows). **Options-editing model:** each
  `choice` question's `options` are edited as **individual add/remove text rows** (not a
  delimited string), so trim/duplicate/max-10 map cleanly to per-row state. **Validation errors:
  the portal validates the same rules client-side before submit** (label non-empty, choice ≥2
  distinct options, ≤8 questions) and disables save / shows an inline message on the offending
  row — so a server 400 is a backstop, not the primary UX; the server stays authoritative and
  the form does not need to map arbitrary server field-path errors back to rows.
  `formFromService`/`toInput` gain an `intakeQuestions` field; **`toInput` MUST echo back each
  existing question's `id`** (carried as a hidden field on the form row), or every save would
  re-mint ids and orphan historical answer labels — `formFromService` preserves `id` into form
  state and `toInput` sends it. `serviceInputSchema`/`serviceUpdateSchema` gain an
  `intakeQuestions` array; the `Service`/`ServiceInput` portal types gain `intakeQuestions`
  (each `IntakeQuestion` including its `id`). **Array order is
  the question order** and is preserved end-to-end — the editor renders/saves rows in array
  order, the column stores the array as-is, the prompt injects in array order, and the portal
  answer display follows the service's question order. (No separate `sortOrder` per question;
  no reorder UI in P3 — list order only, per Out of scope.) Sending `intakeQuestions: []`
  clears; omitting the key leaves questions unchanged. **In responses, `intakeQuestions` is
  always the stored value (`[]`-cleared collapses to `null`), so a non-portal API consumer reads
  `null`/absent ⇒ no questions and a populated array ⇒ questions — there is no "empty list"
  response state to distinguish (clear-vs-empty matters only on the *request* side: `[]` clears,
  omitted leaves unchanged).** `formFromService` maps response `null` → `[]` so the editor
  always renders an empty, add-able list rather than crashing on `null.map`.
- **Answers display read-only** in the Bookings/Requests tabs. The server pre-builds an
  **ordered, pre-labeled display list** so the portal doesn't have to iterate a map: for each
  row, `adminListBookings` adds `intakeAnswers: Array<{ label: string; answer: string }> |
  null` to `AdminBookingRow`, built by **walking the service's `intakeQuestions` in array
  order** and emitting `{ label, answer }` for each question that has a stored answer (so the
  display order is exactly the authored question order). **Read-side normalization (defensive):**
  the stored jsonb is treated as `Record<string, unknown>` — a non-object value (array, string,
  `null`) is read as "no answers", and each individual value is run through the **same coercion
  as the write-side `normalizeIntakeAnswers`** (string→trim, number/boolean→`String`, arrays/
  objects/null dropped, capped) so reads and writes agree on what a "displayable answer" is. This
  shields the display from any legacy/hand-edited row. Any stored answer key that no longer matches a current question (deleted question)
  is appended **after** the ordered entries, in a **deterministic order — sorted by key** (not
  relying on jsonb key order, which Postgres does not guarantee), each with its raw id as the
  label. **Display labels are the raw stored `label` (NOT the prompt-sanitized form — that
  sanitization is only for the single-line prompt template); React escapes them, and they're
  schema-length-capped, so newlines/quotes render harmlessly as text.** To get the
  questions, the existing per-row service lookup `adminListBookings` already runs (the `In(
  serviceIds)` `ServiceType.find({ where })` it uses for `serviceName`) returns the **full
  `ServiceType` entity** (no `select` projection / DTO), so `intakeQuestions` is already on the
  loaded rows — we just map it into a `Map<serviceId, IntakeQuestion[]>` alongside the existing
  name map (no extra query, no query change). **If a row's service is missing/deleted** (no
  matching id in the loaded service rows — e.g. a hard-deleted service, though P3/keystone only
  soft-deactivate, so the row is normally still present), the join finds no questions and **all**
  that row's stored answers fall through to the deleted-question branch (rendered raw-id-keyed,
  **sorted by key** — the same deterministic order as the deleted-question branch below). The answers are never dropped — only their labels degrade.
  **Accepted degraded displays (explicit, both acceptable for P3 — the goal is owner
  *visibility*, not pretty labels):** (a) a **deleted question's** answer shows with its raw uuid
  as the label; (b) editing a still-present question's `label`/`type`/`options` after a booking
  re-labels/re-contextualizes that historical answer (the stored answer string is unchanged, but
  the label/options shown reflect today's question — and an answer that was valid against the
  *old* options is shown without any "outside current options" marker). We don't snapshot the
  question per booking. The `AdminBooking` portal type
  gains `intakeAnswers`; the `Bookings.tsx` row renders the `label: answer` list as its **own
  sibling block in a fixed row position (immediately after the notes block), guarded by its own
  `intakeAnswers?.length` condition** — NOT nested inside the notes conditional. So answers
  appear in the same place whether or not `notes` is present; an empty/absent answer list renders
  nothing (no spacing); answers + notes coexist as two independent blocks. No editing of answers in the portal. **All three tabs
  share one row shape and mapping:** `adminListBookings` builds every `AdminBookingRow` (across
  `upcoming`/`past`/`requests`) through the same `rows.map`, so `intakeAnswers` is computed and
  returned uniformly for confirmed bookings *and* request rows — requests show their captured
  answers identically (a request row is just `status='request_created'`).
- **The same questions apply to auto-book and request-mode services.** Intake is orthogonal to
  `booking_mode`; a question list attaches to any service and both write paths persist it.

## Out of scope (later epics / not P3)

- File-upload answer type and file→booking linkage (P5).
- Date/number/typed answer validation; conditional/branching questions; per-question ordering
  UI beyond list order.
- Hard server-side enforcement that all required questions were answered (rejecting a
  booking); answer editing in the portal; surfacing answers in the owner email / webhook
  payload (P2's `sendRequestNotificationEmail` and `booking.request_created` payload stay
  unchanged — answers live on the row + portal).
- Asking intake questions in `check_availability` (intake is collected at the
  create/request step, after a time is chosen).
- Reschedule/cancel touching intake answers — their UPDATE statements never reference the
  `intake_answers` column, so the value carries forward untouched (no code change needed).

## Slices (tracer bullets)

- **P3a — Schema + authoring.** Add `intake_questions jsonb NULL` to `ServiceType` (entity +
  additive migration) and the `IntakeQuestion` type; extend
  `serviceInputSchema`/`serviceUpdateSchema` with the validated `intakeQuestions` array
  (max 8; label/type/required/options rules + the `choice`-needs-2..10-options refine, the
  no-duplicate-options-after-trim-case-insensitive refine, and the **`z.preprocess` that strips
  `options` for `type==='text'` before validation** — per the locked validation decision, NOT a
  trailing transform); have `updateService` **load the currently-stored `intakeQuestions` first**, then
  `createService`/`updateService` reconcile + (re)assign uuid `id`s server-side (echoed ids that
  match a stored id kept, all others minted, dropped ids removed) and collapse `[]`→`null` at
  persist; ensure the service GET/CREATE/UPDATE responses return `intakeQuestions` (the
  controllers `sendSuccess` the full entity today, so it round-trips); add the repeatable
  questions editor to
  `ServicesSection.tsx` + the `intakeQuestions` field on the portal `Service`/`ServiceInput`
  types and `formFromService`/`toInput`. *Demoable: an owner adds two questions (one `text`,
  one `choice`) to a service in the portal and they round-trip in array order with stable ids;
  clearing them (`[]`) removes them.*
- **P3b — Agent collects + persists.** Inject each service's questions (the **full shape**:
  `id`, `label`, `type`, `required`, and `choice` `options`, in array order) into the SERVICES
  prompt block with rules to ask required questions (and optional ones unless already
  volunteered) before the write tool; add the optional `intakeAnswers`
  object param to **both** `create_booking` and `request_appointment` JSON-Schemas (+ tool
  description note) and pass it through their `execute`; thread the raw `intakeAnswers` through
  `booking.service.ts` (`createBooking`, `requestBooking`) → the `BookingProvider.createBooking`
  signature / `requestAppointment` / `createRequest`; normalize it against the resolved
  service via `normalizeIntakeAnswers` and write it into both raw inserts' new `intake_answers`
  column. *Demoable: a customer books an auto service and (separately) requests a request-only
  service that each carry questions; the agent asks them and the trimmed, id-keyed answers land
  in `Booking.intake_answers` (verified by DB / portal row); unknown keys, blank answers, and
  non-string values (number/bool coerced, arrays/objects/null dropped, capped at 2000) are
  normalized.* **Acceptance is phrased around persistence, not guaranteed collection:** the
  verifiable criteria are (a) the prompt lists the questions with ids and a "ask required first"
  rule, and (b) **whatever the agent passes is correctly normalized + persisted** — required-
  answer *completeness* is best-effort (no server gate), per the locked `required`-is-soft
  decision. Normalizer tests are written **at the provider seam directly** (calling
  `createBooking`/`requestAppointment` with crafted `intakeAnswers`, bypassing the tool JSON-
  schema) so number/boolean/array/null and label-keyed (dropped) inputs can be exercised even
  though a schema-compliant tool call only emits strings. Blocked by P3a.
- **P3c — Answers in the portal.** `adminListBookings` returns an ordered, pre-labeled
  `intakeAnswers: Array<{ label; answer }> | null` on `AdminBookingRow` (questions walked in
  array order off the already-loaded service rows, deleted-question answers appended with the
  raw id as label); the `AdminBooking` type + `Bookings.tsx` row render that read-only
  `label: answer` list as its own block (fixed position after notes) across
  upcoming/past/requests. *Demoable: the owner sees each booking's captured intake answers, in
  question order, in the portal.* **Acceptance explicitly covers the accepted historical-display
  tradeoff:** answers display with the service's *current* labels (so a label/options edit after
  a booking re-labels historical answers) and a deleted question shows its raw id — visibility is
  guaranteed, exact original-question fidelity is not. Blocked by P3a (parallel with P3b; needs
  P3b data to show non-empty answers, but the rendering ships independently).
