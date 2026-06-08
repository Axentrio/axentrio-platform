# P4: Business-type presets

A solo owner who picks "Barber" gets a usable bookable catalog in one apply —
a handful of `ServiceType` rows (name / duration / mode / price defaults) plus a
sensible default weekly availability — instead of hand-building each service in the
Services editor. (UX is pick-then-apply: open a preset picker, choose one, confirm —
"one click to a full catalog", not literally a single tap; see the trigger
decision.) P4 is pure onboarding acceleration: it **reuses the existing
service-create seam**; it adds no new booking behaviour the agent or slot engine
depends on.

## What earlier slices already provide

- **K3 service create:** `createService` (`scheduler.controller.ts`) takes a
  `serviceInputSchema`-validated body, calls `uniqueSlug(repo, botId, name)`, and
  saves a `ServiceType` for the anchor bot (`getAnchorBotConfig(tenantId)`). Its
  whole body is: feature gate → parse → `repo.create({ tenantId, botId, ...data, slug
  })` → `repo.save` → log. **No mapping, no post-parse transform, no other side
  effect** (verified). Every preset service is just one such row.
  `serviceInputSchema` already defaults every field except `name`/`durationMin`, so a
  preset only has to specify what differs from the defaults.
- **Availability:** `AvailabilityRule` is one row per bot — enforced by a DB unique
  index `@Index(['botId'], { unique: true })` (verified) — with `timezone,
  weeklyHours, dateOverrides, slotGranularityMin`, upserted by
  `updateSchedulerConfig` when `data.availability` is present. A preset's default
  schedule is exactly such an availability payload. The unique index means a second
  concurrent insert fails at the DB, so "create only if absent" can never produce two
  rows.
- **Portal:** `ServicesSection` renders the catalog via `useServices`; the
  empty-state copy ("No services yet…") is the natural home for a "start from a
  preset" affordance. `useCreateService` already invalidates both `servicesKey` and
  `schedulerKey` on success, so the list and the scheduler config refresh after a
  preset is applied.
- **Entitlement:** `createService` and `updateSchedulerConfig` both call
  `requireFeature(tenantId, 'calendarIntegrations', CALENDAR_FEATURE_ERROR)`. The
  apply endpoint reuses the **same** gate.

## Locked decisions

- **Presets are a static TS config in the api**, NOT a DB table.
  `api/src/scheduler/presets.ts` exports a frozen `BUSINESS_PRESETS` array. Each
  preset is a fixed, code-reviewed seed; owners never author presets, so there is
  nothing to persist or admin. A DB table would add a migration, CRUD, and tenancy
  for zero gained capability. (If presets ever become tenant-editable, that is a
  later slice — this one stays static.)
- **A preset shape mirrors the existing seams, no new vocabulary:**
  ```ts
  interface BusinessPreset {
    key: string;            // stable id, e.g. 'barber' (the apply param)
    label: string;          // "Barber", shown in the portal
    description: string;    // one line under the label
    services: PresetService[];     // 1..N service seeds
    availability?: PresetAvailability; // optional default weekly schedule
  }
  // PresetService = the SAME fields serviceInputSchema accepts (a subset; the rest
  // fall back to serviceInputSchema defaults). name + durationMin always set.
  // PresetAvailability = the SAME shape availabilityInputSchema accepts.
  ```
  **Validation uses a dedicated strict preset schema, not bare
  `serviceInputSchema`.** Two gaps make `serviceInputSchema.parse` insufficient as
  the preset guard: (a) it's a non-strict `z.object`, so it **silently strips**
  unknown keys — a typo like `booking_mode`/`slot_granularity_min` would be dropped,
  not rejected; (b) it does **not** cross-check price fields, so `priceDisplayType:
  'fixed'` with no `fixedPrice`, `'range'` missing a bound, or `minPrice > maxPrice`
  all pass. So `presets.ts` defines `presetServiceSchema =
  serviceInputSchema.strict().superRefine(...)` that (1) rejects unknown keys
  (`.strict()`) and (2) enforces: `fixed`/`from` ⇒ `fixedPrice` present; `range` ⇒
  `minPrice` and `maxPrice` present with `minPrice ≤ maxPrice`; `none`/`on_request`
  ⇒ no numeric price field set.
  **Availability** uses a strict variant `presetAvailabilitySchema`. Because Zod's
  top-level `.strict()` does not propagate into nested schemas, it is **rebuilt from
  strict pieces** rather than `.strict()`-ing the existing one: a `strictTimeWindow =
  timeWindow.strict()`, a `strictDateOverride = dateOverride.extend({ windows:
  z.array(strictTimeWindow).optional() }).strict()`, and the availability object
  rebuilt as `z.object({ timezone, weeklyHours: z.record(weekday,
  z.array(strictTimeWindow)), dateOverrides: z.array(strictDateOverride),
  slotGranularityMin }).strict()` — so unknown keys are rejected at **every** level
  (window, override, day array, top). A `superRefine` then asserts `start < end` on
  every window. **Export prerequisite (P4a must do this first):** `timeWindow` and
  `dateOverride` are currently module-private in `scheduler.schema.ts` and `slugify` is
  private to its module — P4a **exports** all three so `presets.ts` reuses the exact
  runtime pieces (and `uniqueSlug`'s slugify) rather than re-declaring them, which would
  let the preset guards drift from runtime behaviour. The slug-collision invariant
  (below) imports that same exported `slugify`. **Timezone validation is environment-robust:** validate against
  `Intl.supportedValuesOf?.('timeZone')` **when the API exists**, else fall back to a
  try/`new Intl.DateTimeFormat(undefined, { timeZone })` probe (throws on an invalid
  zone on every modern Node/ICU build); `'UTC'` always passes. This avoids a
  CI-vs-prod ICU-list mismatch while still catching a typo'd preset timezone, and
  catches inverted windows, at CI time. (`24:00` is permitted by the
  existing `hhmm` regex only as an end bound; preset seeds never use it, and the slot
  engine already handles the existing schema's range, so we don't tighten the shared
  regex here.)
  **Preset-level invariants** (a `superRefine` over `BUSINESS_PRESETS` as a whole, run
  in the P4a test): `key` is unique across presets and non-empty; `services` is
  non-empty (≥1 — "full catalog" requires at least one service); and no two services
  within one preset collide on **`slugify(name)`** (checking the slugified form, not the
  raw `name`, so two differently-spelled names that reduce to the same slug — e.g.
  "Men's haircut" vs "Mens haircut" — are also caught; otherwise they'd produce a `-2`
  suffix and a confusing duplicate-looking catalog). A violation fails CI.
  **All preset field names are the entity/schema camelCase names** — `name`,
  `durationMin`, `bookingMode`, `priceDisplayType`, `fixedPrice`, `minPrice`,
  `maxPrice`, `priceNote`, `locationType`, `customerAddressRequired` — never DB column
  names (`booking_mode` etc.); `.strict()` now makes any column-name typo a hard error.
  These schemas run over **every** seed in a unit test (P4a) — the authoritative guard:
  a malformed static preset **fails CI loudly** before it can ship, which the bare
  non-strict schema would not catch. The runtime apply path also parses the service
  seeds (always) and the availability seed (only when actually inserting one — step 8
  skips parse+insert if a rule already exists), so CI, not runtime, is what guarantees
  a clean `BUSINESS_PRESETS`; runtime parsing is a belt-and-braces backstop, never the
  primary check.
- **Shared create helper (avoids drift from `createService`).** Extract the
  per-service insert from `createService` into a small helper
  `createServiceRow(manager, tenantId, botId, data)` where `data` is the
  **already-parsed** service input (`z.infer<typeof serviceInputSchema>` — the
  parse/validation happens in the **caller**, not the helper). The helper does only:
  `repo.create({ tenantId, botId, ...data, slug: await uniqueSlug(repo, botId,
  data.name) })` → `repo.save`, with `repo = manager.getRepository(ServiceType)`.
  **No re-parse, so defaults/transforms run exactly once.** `createService` parses
  the request body with `serviceInputSchema` then calls the helper; the preset
  endpoint parses each seed with `presetServiceSchema` then calls the helper.
  `presetServiceSchema` is `serviceInputSchema.strict().superRefine(...)`, so its
  parse output is assignable to the helper's `data` type (the extra strictness is
  parse-time only; the resolved object shape is identical). One insert code path, so
  future create logic can't diverge between manual-add and preset; the feature gate
  and logging stay in the controllers.
  **Preset seeds must not carry catalog-state fields.** `presetServiceSchema` also
  forbids `isActive` and `sortOrder` in the seed (they're omitted from the strict
  shape, so providing either is a strict-mode error): a preset always produces
  **active** services (`isActive` defaults `true`), and `sortOrder` is assigned by the
  apply loop (`= i`), never by the seed. This keeps "the catalog the preset produces is
  active and index-ordered" a guarantee, not a per-seed accident.
- **Apply is one new endpoint that bulk-creates services (+ optionally availability),
  reusing the per-service create logic** — NOT a client loop over `POST
  /services`. Endpoint: `POST /scheduler/presets/:key/apply`. It:
  1. `requireFeature(... 'calendarIntegrations' ...)` (same gate as create);
  2. resolves the preset by `:key` against `BUSINESS_PRESETS` (404
     `PRESET_NOT_FOUND` if unknown) — done **before** opening the transaction;
  3. resolves the anchor bot via `getAnchorBotConfig(tenantId)` → `bot.id`
     (`= botId`), exactly as every other scheduler handler does — also before the
     transaction (all inserts need `tenantId`/`botId`);
  4. opens **one transaction** (`AppDataSource.transaction(async (manager) => …)`);
     all of steps 5–8 use that `manager`;
  5. **serializes the check-and-insert** by taking a per-bot advisory lock as the
     first statement in the transaction:
     `manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['preset:'
     + botId])` — `botId` is concatenated into a **text** key and passed as a bind
     param, so there is no UUID-vs-text cast fragility (`hashtextextended(text, bigint)`
     returns the `bigint` the lock needs). This **hash-based** lock serializes
     concurrent preset applies for the same bot; like any advisory-lock hashing it has
     a theoretical chance of an unrelated bot's key hashing to the same `bigint`, which
     would at worst make two unrelated applies briefly wait on each other — never a
     correctness problem (the empty-catalog re-read inside each lock is still per-bot).
     This is the only race the design guarantees against. It does NOT
     serialize against a concurrent manual `POST /services` (that path takes no lock,
     and adding one is out of scope). The apply-vs-manual-create window is **accepted
     as a benign best-effort edge**, because: (a) `createServiceRow` always routes
     through `uniqueSlug`; in the overwhelmingly common case this yields a `-2` suffixed
     slug and both rows insert fine. (`uniqueSlug` reads-then-writes without a retry, so
     in the razor-thin window where a racing manual insert commits the *same* slug
     between the preset's slug computation and its own insert, the preset's
     `(bot_id, slug)` insert can fail — and because that's inside the apply transaction,
     the **whole apply rolls back cleanly with no partial seed**. Note the catalog is then
     non-empty (it holds the one racing manual row), so a **re-apply 409s** —
     the owner finishes the catalog by manually adding services (or deletes the stray row
     first, then re-applies). Either way: no crash, no partial seed, no corruption — worst
     case a rare clean rollback that leaves a single manual row to build from.); (b) the realistic outcome is at worst a
     catalog with the seed plus one manually-added service, which the owner can trivially
     prune in the editor; (c) the scenario
     requires a brand-new owner to both click "Add service" and apply a preset within
     the same few milliseconds, which the UI doesn't naturally produce (the preset
     button only shows on an empty catalog). We explicitly do **not** try to make
     apply-vs-manual atomic — the cost (locking `POST /services`) isn't worth closing a
     near-impossible, non-destructive edge. The strict empty-catalog 409 stands for the
     common case and for apply-vs-apply.
  6. **enforces the empty-catalog precondition** (below) using the locked read:
     `manager.getRepository(ServiceType).count({ where: { botId } }) > 0 → 409`.
     (`botId`-only matches the existing `listServices`/`createService` scoping; a
     `ServiceType.botId` belongs to exactly one tenant, and the anchor bot was already
     resolved from `tenantId` in step 3, so there is no cross-tenant ambiguity. We do
     not add `tenantId` to the predicate to stay consistent with the sibling handlers.)
  7. for each preset service (index `i`, 0-based): parse `seed` with
     `presetServiceSchema`, then `createServiceRow(manager, tenantId, botId, {
     ...parsed, sortOrder: i })`. Because the catalog is empty (step 6), `sortOrder = i`
     starting at 0 is safe — no existing rows to collide with, and `sortOrder` has no
     uniqueness constraint anyway (it's only an `ORDER BY` key in
     `listServices`/`readConfig`);
  8. if the preset has `availability` **and** `manager.getRepository(AvailabilityRule)
     .findOne({ where: { botId } })` returns none, insert it with an
     **`ON CONFLICT (bot_id) DO NOTHING`** statement (not a plain `save` + try/catch):
     `manager.createQueryBuilder().insert().into(AvailabilityRule).values({ tenantId,
     botId, ...parsedAvailability }).orIgnore('(bot_id)').execute()` (where
     `parsedAvailability = presetAvailabilitySchema.parse(preset.availability)`). The
     **`'(bot_id)'` conflict-target argument is required** — a bare `.orIgnore()` emits
     an untargeted `ON CONFLICT DO NOTHING` that would also swallow unrelated unique
     conflicts; targeting `(bot_id)` makes it no-op **only** the bot-availability
     collision the design intends. This sets **every required
     column explicitly** — `tenantId`, `botId`, plus the parsed `timezone`,
     `weeklyHours`, `dateOverrides`, `slotGranularityMin`. (Preset availability seeds
     are **fully specified** — all four fields present, including `dateOverrides: []` —
     so the schema's optional-field defaults never actually fire for a preset; this
     avoids any ambiguity about what an omitted field would become.) Matching the
     create branch in
     `updateSchedulerConfig`, but on the transaction `manager` (we do NOT call
     `updateSchedulerConfig` itself). **Why `ON CONFLICT DO NOTHING` and not a caught
     `23505`:** a unique-violation raised mid-transaction aborts the whole Postgres
     transaction, so catching the error and continuing would fail at commit; `ON
     CONFLICT … DO NOTHING` lets the engine no-op the duplicate **without** aborting,
     so the already-committed-in-this-tx service rows still commit. (Conflict target
     `(bot_id)` is valid: the entity's `@Index(['botId'], { unique: true })` on column
     `bot_id` generates a plain, non-partial, non-expression unique index — a usable
     `ON CONFLICT` arbiter. This is the **single** availability-race implementation;
     there is no separate `23505` try/catch — the earlier-draft "catch 23505" wording
     is superseded by `ON CONFLICT`.) If a rule already
     exists (found by the `findOne`, or inserted by a racing `updateSchedulerConfig`
     between the read and the insert), it is **left untouched** — the owner's real
     hours win, and the services are never undone by a lost availability race. The
     opposite ordering is also safe: if the preset inserts the rule first and the owner
     **then** saves real hours via `updateSchedulerConfig`, that path's existing
     find-then-update branch finds the preset row and **updates** it to the owner's
     hours. **One narrow race, accurately stated (not over-claimed):**
     `updateSchedulerConfig` does find-then-insert, not an atomic upsert — so in the
     razor-thin window where it reads "no rule", the preset then inserts, and the owner
     insert then fires, the owner save can hit the `bot_id` unique constraint and **fail
     once**; the owner re-saves and the now-find-then-update path writes their hours. An
     explicit owner save wins **after at most one retry**, not unconditionally first-try.
     (P4 adds no new write path to `AvailabilityRule` beyond this one conditional insert;
     `updateSchedulerConfig` is unchanged — making it an upsert is an out-of-scope follow-up.)
  9. after the transaction commits, **re-reads the catalog through the same query
     `listServices` uses** (`repo.find({ where: { botId }, order: { sortOrder: 'ASC',
     createdAt: 'ASC' } })`) and returns `{ services }` — identical shape and
     ordering to `GET /scheduler/services`, so the portal refresh path is unchanged.
     The response intentionally carries **only** `{ services }`, not an
     availability-created flag: the portal must NOT infer whether availability was
     inserted or skipped from apply success — it relies on `schedulerKey` invalidation
     + the availability re-hydrate (below) to reflect whatever the config now is. (Apply
     success means "the catalog was seeded"; availability is best-effort and its state
     is read back from config, never inferred from the apply result.)
  A read-only `GET /scheduler/presets` lists `{ key, label, description, serviceCount
  }` for the picker. It is gated for **reads** the same as `/services`
  (`requireRole('admin','supervisor','agent')`) **plus** the `calendarIntegrations`
  feature (server returns the entitlement error otherwise). **Accurate UX consequence
  (no client entitlement gate is added):** like `useServices`/`useSchedulerConfig`
  today, the section still renders for a non-entitled tenant and the "Start from a
  preset" button can still appear on an empty catalog — the entitlement failure surfaces
  only when the dialog loads presets (or on apply), as the inline "Couldn't load presets"
  message. So the gate is server-authoritative, not "presets are invisible to
  non-entitled tenants." Apply is `requireRole('admin')`, matching service mutations —
  see "Role consistency" below.
- **Idempotency / overwrite: require an empty catalog.** Apply is rejected with
  `409 CATALOG_NOT_EMPTY` if the bot has **any** `ServiceType` row at all. The check
  is a row-existence count, **not** filtered by `isActive`: `repo.count({ where: {
  botId } }) > 0 → 409`. `deleteService` soft-deletes by setting `isActive = false`
  (the row stays, keeping its `(bot_id, slug)` for existing bookings' service
  context), so a catalog the owner "cleared" still has rows that own their slugs and
  would collide/muddy a fresh seed — hence inactive rows count. Rationale: a preset
  is an onboarding kickstart, not a merge tool.
  "Append" risks duplicate/half-overlapping services the owner must then prune;
  "overwrite" risks destroying real configured services and is irreversible. The
  empty-catalog rule is the only one with no destructive or confusing edge case.
  The portal offers the preset affordance only when the catalog is empty. The portal's
  `services.length === 0` check is **consistent with the server's count**: `useServices`
  (=`listServices` = `find({ where: { botId } })`) returns **all** rows including
  inactive/soft-deleted ones, the same set the server's `count({ where: { botId } })`
  sees — so the UI never shows the preset button for a bot the server would 409, and
  never hides it for an empty one. **The `length === 0` check is gated on a settled
  fetch:** the empty state (and thus the preset button) renders only when `useServices`
  has resolved successfully with zero rows — not while `isLoading` (show the existing
  loading state, no button) and not on a fetch error (show the existing error/empty copy
  without the preset button, since catalog emptiness is unknown). This prevents offering
  the button on unconfirmed state. A well-behaved client thus never hits the 409; the
  server still enforces it for direct-API/race callers.
  **Scope of the empty-catalog invariant:** it is guaranteed for the common UI path and
  for **preset-vs-preset** concurrency (advisory lock + re-read). It is **not** a global
  cross-endpoint invariant: a manual `POST /services` racing inside the apply window can
  still produce a merged catalog (a seeded set + one manual row). That is the accepted,
  non-destructive edge from the apply decision above — `uniqueSlug` keeps slugs valid
  and `sortOrder = i` on the seeds is unaffected by a racing manual row (the manual
  row's own `sortOrder` defaults to 0 from `serviceInputSchema`; the resulting relative
  order of that one stray row vs. the seeds is unspecified but harmless and
  owner-editable). We do not phrase the invariant as global.
  **Availability is NOT part of the empty-catalog check** — it has its own "only if
  absent" rule in step 8, independent of services.
- **Initial presets (5), service sets below.** All durations in minutes; booking
  mode is the `bookingMode` field; price uses `priceDisplayType`. Fields not listed
  fall to `serviceInputSchema` defaults (`bookingMode:'auto'`,
  `priceDisplayType:'none'`, `locationType:'custom'`, buffers 0, `minNoticeMin:0`,
  `maxHorizonDays:60`, `isActive:true`). `locationType` is set per preset where the
  real-world default is obvious. Price values are illustrative starting points the
  owner edits in the Services editor. **Exact required price fields per
  `priceDisplayType`** (matching `serviceInputSchema` + the portal's `toInput`, and
  enforced by `presetServiceSchema`): `'fixed'`/`'from'` set `fixedPrice` (a number);
  `'range'` set `minPrice` + `maxPrice` (`minPrice ≤ maxPrice`); `'on_request'` and
  `'none'` set no numeric field. Example fully-specified seed (Barber, men's
  haircut): `{ name: "Men's haircut", durationMin: 30, bookingMode: 'auto',
  locationType: 'in_person', priceDisplayType: 'fixed', fixedPrice: 25 }`. (We do
  NOT use `priceNote` to flag placeholders — `ServicesSection` doesn't render
  `priceNote`, so it would be an invisible cue. The "these are starting prices" hint
  lives in the preset dialog's intro copy instead, where the owner actually sees it.)
  Placeholder numbers (e.g. 25/15/35 for the barber services, "from" 80/150/110 for
  cleans) are inline in `presets.ts` and validated by `presetServiceSchema`, so any
  missing/inconsistent price fails CI.
  - **Barber** (`in_person`, all `priceDisplayType:'fixed'`): Men's haircut 30m auto;
    Beard trim 15m auto; Haircut + beard 45m auto.
  - **Cleaner** (`in_person`, `customerAddressRequired:true`, all
    `priceDisplayType:'from'`): Standard home clean 120m **request**; Deep clean 240m
    **request**; Move-out clean 180m **request**. (Cleans are quote-y → request-only.)
  - **Consultant** (`google_meet`): Free intro call 30m auto (`priceDisplayType:
    'none'`); Strategy session 60m auto (`priceDisplayType:'fixed'`); Project
    consultation 90m **request** (`priceDisplayType:'on_request'`).
  - **Tutor** (`google_meet`, all `priceDisplayType:'fixed'`): Trial lesson 30m auto;
    1-hour lesson 60m auto; Exam-prep block 90m auto.
  - **Photographer** (`in_person`): Portrait session 60m **request**
    (`priceDisplayType:'on_request'`); Event coverage 120m **request**
    (`priceDisplayType:'on_request'`); Discovery call 20m auto (`google_meet`,
    `priceDisplayType:'none'`). (Shoots are scoped/quoted → request-only +
    on-request pricing.)
  Each preset ships a default `availability` whose `weeklyHours` has the five weekday
  keys `mon`–`fri` each set to `[{ start: '09:00', end: '17:00' }]` and **omits `sat`
  and `sun`** (the entity's `WeeklyHours` is `Partial<Record<Weekday, …>>` and the slot
  engine treats a missing day as closed — matching how `SchedulerSettings` only emits
  enabled days), `dateOverrides: []` (explicit, no holidays seeded), `slotGranularityMin:
  30`, `timezone: 'Europe/Brussels'` — the same timezone the
  scheduler UI defaults to today (`SchedulerSettings` initial state), so the preset
  default is consistent with the rest of the product rather than a surprising UTC.
  The owner can change it in the availability section right below. (We pick a concrete
  default the codebase already uses over guessing per-tenant; if a tenant timezone
  field is later wired into onboarding, sourcing it here is an additive follow-up.)
  Step 8's "only if absent" rule means this never overrides hours the owner already
  set.
- **Owner trigger: a button in the Services section, not a forced onboarding step.**
  When `services.length === 0`, `ServicesSection`'s empty state shows a "Start from a
  preset" button beside "Add service". It opens a dialog that lists the presets
  (label + description + service count) with intro copy noting prices/hours are
  starting points to edit. Selecting a preset and pressing the dialog's **Apply**
  button (an explicit confirm step — selection alone does not mutate; the button is
  disabled while the mutation is pending so a double-click can't fire two applies)
  calls the apply mutation. After success, the dialog closes and the **services list**
  refreshes immediately (the `servicesKey`/`useServices` query is invalidated). When
  the catalog is non-empty, the preset affordance is hidden (matches the server's
  empty-catalog rule; "Add service" remains for manual additions). No separate
  onboarding wizard, no route change — the existing Services settings surface is where
  catalog setup already lives.
- **Availability editor refresh after a preset seeds hours.** `SchedulerSettings`
  hydrates its local availability form **once** (the `hydrated` guard), so a plain
  `schedulerKey` invalidation does NOT push newly-seeded preset hours into that form's
  inputs — the day rows would still show the pre-apply state until a reload. To avoid a
  confusing "I picked Barber but the hours look empty" moment, P4b uses **one concrete
  approach** (no alternatives): `ServicesSection` already receives an `onApplied`
  callback prop; `SchedulerSettings` (which owns the `hydrated` flag and the
  availability state, and already renders `ServicesSection`) passes a callback that
  **awaits a fresh config then re-hydrates** — avoiding the stale-cache trap. Concretely:
  `onApplied` calls `await queryClient.refetchQueries({ queryKey: schedulerKey })` (or
  awaits `useSchedulerConfig().refetch()`), and **only in its resolution** sets
  `setHydrated(false)`. Because the cache now holds the **post-apply** config before
  `hydrated` flips, the existing hydrate `useEffect` (`if (!data || hydrated) return; …
  setHydrated(true)`) re-runs against the seeded hours, not the old cache. (We do NOT
  flip `hydrated` before the refetch resolves — that's the ordering bug; flipping after
  guarantees the effect sees fresh `data`.) The
  exact component boundary: the preset dialog and button live in `ServicesSection`; the
  only `SchedulerSettings` change is passing an **async** `onApplied` that
  `await`s `refetchQueries({ queryKey: schedulerKey })` and **then** (in the awaited
  resolution) calls `setHydrated(false)` — NOT the naive `onApplied={() =>
  setHydrated(false)}`, which would re-hydrate against the stale pre-apply cache (the
  ordering bug). This refetch-then-rehydrate is the single P4b change that touches
  `SchedulerSettings`.
- **Availability IS part of the preset** (each preset carries the Mon–Fri default),
  but applied **conservatively** (step 8: only when the bot has no `AvailabilityRule`
  yet). This makes "pick Barber" produce a genuinely bookable setup for a brand-new
  owner (services + hours), while never clobbering hours a returning owner configured.
- **Availability is NOT part of the empty-catalog check.** The empty-catalog 409 is
  about `ServiceType` rows only (step 6); availability has its own independent "only
  if absent" rule (step 8). A bot can have an `AvailabilityRule` but no services and
  still apply a preset (it just won't touch the rule).
- **Portal failures are surfaced, never silent.** The apply mutation's `onError`
  toasts `extractApiErrorMessage(err)` (the existing pattern in
  `useSchedulerQueries`). The **user-reachable** server errors are `409
  CATALOG_NOT_EMPTY` (race/direct-API only — the button hides on a non-empty catalog),
  `404 PRESET_NOT_FOUND` (stale picker), the `calendarIntegrations` entitlement error,
  and a `403` (non-admin); all flow through the global `ApiError`/`asApiError` handler
  to a readable toast, and the dialog stays open so the owner can retry or close. A
  malformed **static** preset is NOT a user-retryable runtime condition — it's caught
  by the P4a CI schema test and never ships; if one somehow reached production the
  runtime `presetServiceSchema.parse` would throw a ZodError that the global
  `asApiError` handler maps to a **422 VALIDATION_ERROR** (not a 500), surfaced as a
  generic failure toast (no special-casing — the fix is a code change to the static
  preset, not a user retry).
- **Picker load failure UX + entitlement reality.** `SchedulerSettings` is rendered
  **unconditionally** in `IntegrationTab` today (verified — no client-side
  `calendarIntegrations` gate around it), so a non-entitled tenant already sees the
  booking section and already gets server `402`s from `useServices`/`useSchedulerConfig`
  there. P4 does not change that and does not add a new gate (entitlement gating the
  whole section is a separate, pre-existing concern). `usePresets()` failing — an
  entitlement `402`, or any error — is handled in the dialog like any query: a brief
  loading state while pending, and on error a short inline "Couldn't load presets"
  message with the `extractApiErrorMessage` text and a close button. The preset path is
  an accelerator, not the only way to build a catalog. (For a non-entitled tenant
  "Add service" also returns `402` — that's the existing behaviour of this section, not
  something P4 introduces or is responsible for fixing.)
- **`google_meet` services are bookable without a Google connection.** The internal
  scheduler's availability source is `AvailabilityRule`, not Google (per the keystone
  / P2), so a `google_meet` service is bookable on entitlement alone; a connected
  Google Calendar only adds the Meet link + real-calendar conflict checking. Presets
  therefore make the catalog genuinely bookable for a brand-new owner regardless of
  whether they've connected Google. (No Google dependency is introduced by P4.)
- **Role consistency front-to-back.** `GET /scheduler/presets` is readable by
  `admin/supervisor/agent` (the same roles that can read `/services` and so render
  `ServicesSection`); **apply is `requireRole('admin')`**, matching the service
  mutations `POST/PUT/DELETE /services`. **The server is the authoritative gate.**
  Today `ServicesSection` does NOT client-side role-gate its existing
  Add/Edit/Delete buttons (verified — no `useRole`/`isAdmin` in the component): a
  non-admin who reaches it and clicks a mutation gets a server 403 surfaced as a
  toast. The "Start from a preset" button follows that **same existing pattern** — it
  is shown to anyone who can see the section, and a non-admin who applies gets the
  identical 403 toast as for any other service mutation. P4 introduces **no new**
  client role gating (adding it across all service controls is a separate,
  out-of-scope change). This is internally consistent: the doc does not claim a
  hidden-for-non-admins button; it claims parity with how service mutations already
  behave in this component. **Accepted UX edge:** because the affordance is multi-step
  (open dialog → pick → Apply), a non-admin only learns at Apply time via the `403`
  toast — a slightly longer dead-end than the single-click Add/Edit buttons. We accept
  this rather than add P4-only client role gating; it's a rare path (non-admins seldom
  open booking settings to seed a catalog) and the failure is a clear toast, not a
  silent or destructive one.

## Implementation refinements (codex round 2 — authoritative over any conflicting text above)

1. **Availability conflict insert — use a raw parameterized statement, not `orIgnore('(bot_id)')`.**
   TypeORM's `orIgnore(string)` arg is unreliable across versions (it can emit an
   *untargeted* `ON CONFLICT DO NOTHING`). P4a instead runs an explicit
   `manager.query('INSERT INTO chatbot_availability_rules (tenant_id, bot_id, timezone,
   weekly_hours, date_overrides, slot_granularity_min) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
   ON CONFLICT (bot_id) DO NOTHING', [...])` so the conflict is targeted to `(bot_id)`
   exactly (jsonb columns cast explicitly). Same semantics the design intends; no
   dependence on ORM sugar. (Use the real table/column names from the `AvailabilityRule` entity.)
   **jsonb params MUST be `JSON.stringify`'d:** node-pg serializes a top-level JS array as
   a Postgres *array literal* (`[]`→`{}`), so binding `parsedAvailability.dateOverrides`
   (or `weeklyHours`) directly to a `$n::jsonb` param would store the wrong shape and break
   the slot engine's `(rule.dateOverrides || []).find(...)`. Pass
   `JSON.stringify(parsedAvailability.weeklyHours)` and
   `JSON.stringify(parsedAvailability.dateOverrides)` for `$4`/`$5`. P4a adds a test
   asserting the inserted rule's `dateOverrides` reads back as `[]` (a JSON array), not `{}`.
2. **`presetServiceSchema` must `.omit({ isActive, sortOrder, intakeQuestions }).strict()`.**
   `serviceInputSchema.strict()` alone still *accepts + defaults* `isActive`/`sortOrder`
   (they're known keys), contradicting "seeds never carry catalog-state fields." So omit
   them (and `intakeQuestions`, see #3) before `.strict()`. The helper then relies on the
   **entity** default (`isActive=true`) and the apply loop's `sortOrder=i`. The omitted
   shape is still assignable to `createServiceRow`'s data (those fields are optional there).
3. **`createService` now reconciles `intakeQuestions` (P3a) — the "create seam" is no
   longer a bare spread.** `createServiceRow(manager, tenantId, botId, data)` takes
   already-parsed **and (for the manual path) already-reconciled** data and does only
   `repo.create({...}) → save`. `createService` performs its `reconcileIntakeQuestions`
   step BEFORE calling the helper; presets omit `intakeQuestions` entirely (out of scope),
   so the preset path passes none and seeds carry no intake. Extracting the helper must
   preserve manual-create's intake reconciliation (don't move reconciliation into the
   helper, or move it such that both callers keep today's behavior).
4. **`slugify` stays in its current module; `presets.ts` does NOT import it at runtime**
   (the controller imports `presets`, so importing controller-side `slugify` into
   `presets.ts` would risk a cycle). The runtime apply path slugs via the existing
   `createServiceRow → uniqueSlug` in the controller. Only the **CI invariant test**
   needs `slugify` for the intra-preset slug-collision check — tests may import it freely
   (no runtime cycle). If a shared home is cleaner, extract `slugify` to a tiny
   dependency-free util both import; either way `presets.ts` carries no controller import.
5. **Entitlement wording corrected:** `GET /scheduler/config` and `GET /scheduler/services`
   do NOT currently call `requireFeature` (only the mutations + `listBookings` do), so
   non-entitled tenants do **not** already get 402s from those reads. P4's gated
   `GET /scheduler/presets` is therefore the **new** read-time entitlement failure in the
   dialog path; the dialog handles it via the inline "Couldn't load presets" message. (P4
   does not add or change gating on the existing config/services reads.)
6. **Window `start < end` is compared numerically, not by string.** The shared `hhmm`
   regex accepts unpadded hours (`9:00`), and `'9:00' > '17:00'` lexically — a real bug.
   The preset availability `superRefine` parses each `HH:MM` to minutes (`h*60+m`) and
   asserts `startMin < endMin`. (Preset seeds are zero-padded regardless, but the check
   must not depend on that.)
7. **Apply-vs-manual race, inverse loser stated:** a manual `POST /services` can compute
   the same slug just before the preset commits and then lose the `(bot_id, slug)` race,
   surfacing as a `23505` on the **manual** path. Today `createService` does not
   special-case `23505`, so that manual call would 500. This is a **pre-existing**
   property of `createService` under any concurrent same-slug insert (not introduced by
   P4); hardening `createService`'s slug-race handling is out of scope. P4 only guarantees
   its own apply transaction rolls back cleanly; the concurrent manual caller's 500 is the
   accepted, pre-existing edge.
8. **Price refine rejects irrelevant fields both ways:** `fixed`/`from` ⇒ `fixedPrice`
   present AND `minPrice`/`maxPrice` absent; `range` ⇒ `minPrice`+`maxPrice` present
   (`min ≤ max`) AND `fixedPrice` absent; `none`/`on_request` ⇒ no numeric price field
   set. So a stale numeric field on the wrong `priceDisplayType` fails CI, not just a
   missing one.
9. **`createServiceRow`'s data param is a helper-specific type, not `z.infer<typeof
   serviceInputSchema>`.** In Zod 3 a `.default()` field is *required* in the inferred
   output, so the omitted `isActive`/`sortOrder` (refinement #2) wouldn't be assignable,
   and manual-create can pass `intakeQuestions: null`. Define
   `type ServiceRowInput = Omit<z.infer<typeof serviceInputSchema>, 'isActive' |
   'sortOrder' | 'intakeQuestions'> & { isActive?: boolean; sortOrder?: number;
   intakeQuestions?: IntakeQuestion[] | null }` (or equivalent) as the helper's `data`
   type, so both callers (manual reconciled + preset omitted) type-check.
10. **Preset times use a stricter parser than the shared `hhmm` regex.** `hhmm` accepts
    `24:00`–`24:59` (it exists only because the slot engine treats `24:00` solely as an
    end-of-day marker); a preset like `24:00`–`24:30` would pass a numeric `start < end`
    check yet be skipped by slot generation. The preset availability `superRefine`
    therefore validates each time with the **same rule the slot engine uses** — reject any
    `start` of `24:00`+ and any hour > 23 except `24:00` as an `end` — i.e. mirror the
    slot-engine time parser (or simply require preset times to match `^([01]\d|2[0-3]):[0-5]\d$`
    for starts, allowing `24:00` only as an end). Preset seeds use plain 09:00–17:00, but
    the guard must catch a future bad seed at CI.

## Out of scope (later / other epics)

- Tenant-authored or editable presets, a preset marketplace, importing a competitor's
  catalog.
- Merge/append/overwrite onto a non-empty catalog (the empty-catalog rule stands).
- Per-service availability or per-preset blocked dates (business availability stays
  one shared `AvailabilityRule`, per the keystone).
- Intake questions on preset services (P3 owns intake; presets seed only the
  `ServiceType` + availability fields that exist today — if/when P3 lands intake,
  adding default intake to a preset is an additive follow-up, not part of P4).
- Localising preset copy / currency (copy is English, prices are bare numbers the
  owner edits; the Services editor already renders `€`).
- Re-seeding or "reset to preset" after first use.

## Slices (tracer bullets)

- **P4a — Preset config + apply endpoint.** `presets.ts` (`BUSINESS_PRESETS`, 5
  presets, plus `presetServiceSchema`/strict availability schema), the extracted
  `createServiceRow(manager, …)` helper (used by both `createService` and the new
  endpoint), `GET /scheduler/presets` (list), `POST /scheduler/presets/:key/apply`
  (anchor-bot lookup → transaction → per-bot advisory lock → empty-catalog check →
  bulk create via the helper with `sortOrder=index` → conditional availability create
  → commit → re-read via the `listServices` query), empty-catalog `409
  CATALOG_NOT_EMPTY` guard, `PRESET_NOT_FOUND` 404, `calendarIntegrations` feature
  gate, admin role on apply. Routes added to `scheduler.routes.ts`. **Tests:** (a) a
  unit test running every seed through `presetServiceSchema`, every preset's
  availability through `presetAvailabilitySchema`, and the whole `BUSINESS_PRESETS`
  through the preset-level invariants — **plus negative fixtures** proving the guards
  actually reject (a seed with a snake_case key like `booking_mode` → strict error;
  `priceDisplayType:'fixed'` with no `fixedPrice` → refine error; `'range'` with
  `minPrice > maxPrice` → error; an inverted availability window `start ≥ end` → error;
  a bad timezone → error; a duplicate `key` and an empty `services` → invariant error);
  (b) apply on an empty
  catalog seeds the expected services in `sortOrder` order and (when absent) an
  `AvailabilityRule`; (c) apply preserves an **existing** `AvailabilityRule`
  untouched; (d) apply on a bot with any service (active or inactive) → 409; (e)
  unknown `:key` → 404; (f) **concurrency, made deterministic** (not wall-clock
  racing): use a test seam that pauses the first apply transaction right after it
  acquires the advisory lock and passes the empty-catalog check, fire the second apply,
  then release the first — assert exactly one full seed and one 409, deterministically
  exercising the lock path; and for the availability race, insert a conflicting
  `AvailabilityRule` mid-apply via the same seam and assert the services still commit
  while the losing availability insert is no-op'd by `ON CONFLICT (bot_id) DO NOTHING`
  (rule count stays 1, services committed); (g) **`GET /scheduler/presets`** returns the
  `{ key, label, description, serviceCount }` list shape; (h) **gate coverage**: apply
  without the `calendarIntegrations` feature → entitlement error, apply as a non-admin
  role → 403, and the preset reads require `admin/supervisor/agent` — asserting the
  stated security/picker contract. *Demoable: with
  an empty catalog, `POST
  /scheduler/presets/barber/apply` creates the Barber services (and an availability
  rule if none existed) and returns them; a second apply, or apply on a bot that
  already has any service, returns 409.*
- **P4b — Portal "Start from a preset" affordance.** `useSchedulerQueries`: add
  `usePresets()` (GET) and `useApplyPreset()` (POST `/scheduler/presets/:key/apply`,
  `onSuccess` invalidates `servicesKey` + `schedulerKey` like `useCreateService`,
  `onError` toasts `extractApiErrorMessage(err)` — the existing error pattern, so
  409/404/403/entitlement all surface a readable message). `ServicesSection`: in the
  `services.length === 0` empty state, add a "Start from a preset" button beside "Add
  service" + a dialog listing `usePresets()` rows (label / description / service
  count) with an explicit **Apply** button (disabled while the mutation is pending). On
  success the dialog closes, the services list refreshes, and the availability editor
  re-hydrates (via the `onApplied` callback into `SchedulerSettings`); on error the
  dialog stays open with the toast. **Tests** (component-level, matching the portal's
  existing test style): the preset button shows only in the empty state and is absent
  once services exist; the dialog renders presets from a mocked `usePresets()`;
  pressing Apply fires `useApplyPreset()` with the chosen key; the Apply button is
  disabled while pending (a second click can't fire a second apply); on success the
  dialog closes; on an error response the dialog stays open and a toast is shown; a
  failing `usePresets()` renders the inline "Couldn't load presets" message (the
  picker-load-failure path); and the preset button is absent while `useServices` is
  loading or errored. *Demoable: a new owner opens Bookings settings, clicks "Start from a
  preset", picks "Barber", presses Apply, and immediately sees the seeded services in
  the list.* Blocked by P4a.
