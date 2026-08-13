# Chatbot Platform

A multi-tenant chatbot platform where SMB owners configure an AI agent that talks to their customers across channels, grounded in the owner's knowledge base.

## Language

**Tenant**:
An SMB owner who configures and pays for the platform (e.g. a plumber). Owns Agents, KnowledgeBases, and a tier.
_Avoid_: customer, client, user, account.

**Agent**:
The configured AI bot that talks to a Tenant's customers. A Tenant may have multiple Agents.
_Avoid_: bot, assistant.

**ChatSession**:
A single conversation between an Agent and one of the Tenant's customers, composed of Messages.
_Avoid_: chat, conversation, thread.

**KnowledgeBase**:
The corpus of documents (`KnowledgeDocument`, chunked into `KnowledgeChunk`) the Agent retrieves from when answering.
_Avoid_: docs, content, RAG store.

**Insight**:
A persistent finding about a Tenant's ChatSessions and/or KnowledgeBase, with a fingerprint, a severity (Red/Orange/Green), evidence, a recommendation, and a lifecycle state. The user-facing primitive of the Insights feature. In v1, every Insight is a **Gap**.
_Avoid_: finding, observation, alert, signal, success meter.

**Gap**:
The v1 kind of Insight: a topic that one or more ChatSession customers asked about, which the Agent/KnowledgeBase did not satisfy. Identified by a fingerprint of `(tenantId, canonicalTopicId)`. Resolved by uploading a KnowledgeDocument that the next daily refresh confirms answers the topic.
_Avoid_: hole, missing answer, knowledge gap (use Gap).

**Canonical Topic**:
A normalised, human-readable topic phrase (e.g. `"pricing"`, `"emergency availability"`) that lives in a per-Tenant registry. Each Gap is keyed on one Canonical Topic. Created lazily as the LLM encounters new topic phrases in ChatSessions.
_Avoid_: tag, category, label, cluster.

**Qualifying Pain**:
The bar that gates Gap lifecycle transitions: ≥3 distinct visitorIds with an unsatisfied ask of the Canonical Topic in the last 7 days. Only Qualifying Pain opens or reopens a Gap — a satisfied ask, or a single new ask, never does. See [ADR-0005](./docs/adr/0005-gap-lifecycle-state-machine.md).
_Avoid_: signal, threshold, trigger.

**Judgment**:
One LLM verdict on one ChatSession, produced during the nightly `RefreshInsightsJob`. Stores `{ hadQuestion, satisfied, topicPhrase, canonicalTopicId, evidenceMessageIds, reasoning }`. Gap evidence is sourced exclusively from Judgments. See [ADR-0004](./docs/adr/0004-unsatisfied-detection-via-llm-judge.md).
_Avoid_: verdict, analysis, review.

**Outcome**:
A rollup count of business-valued events on the Analytics surface — conversations handled, Bookings created, Leads captured — for a date range, with a vs-previous-period delta. Served by `GET /analytics/outcomes`. Outcomes are *reporting* (plain aggregation, identical shape for every paying tier), distinct from Insights (detected findings with lifecycle). See [ADR-0013](./docs/adr/0013-tiered-insights-ladder.md).
_Avoid_: KPI, success metric, business result, outcome insight (an Outcome is not an Insight).

**Tier**:
A Tenant's subscription level, stored on `Tenant.tier`. Marketed values are **Essential**, **Pro**, **Enterprise**. The DB enum additionally contains **`free`** as an internal-only cancellation terminal state — never offered for signup, never shown in upgrade UI, never sold. Cancellation lands a Tenant on `free`; reactivation moves them back to a marketed tier via Stripe.
_Avoid_: plan, subscription level, account type (use Tier).

**Channel**:
A messaging surface a Tenant's customers reach the Agent through. The **widget** is the native channel (always available — it is the product); **WhatsApp, Messenger, Instagram, and Telegram** are external channels, each connected via a `ChannelConnection` and individually gated by a Feature (Pro+ tiers). Which bot answers a channel is the connection's routing assignment, not an entitlement.
_Avoid_: integration (that's calendar/Cal.com territory), platform, social (the sidebar label "Social Media" is a UI alias).

**Feature**:
A sellable on/off capability defined in the plan catalog (e.g. bookings, crm). A Tenant's effective Features are the Tier's defaults adjusted by any Feature Overrides. Features answer "is this Tenant entitled to this capability?"
_Avoid_: flag, entitlement (informally OK, but the catalog term is Feature), toggle, module (a Module is a different thing).

**Feature Override**:
An explicit per-Tenant admin exception that turns a single Feature on or off regardless of Tier (e.g. a comped capability, or one disabled by contract). Overrides persist across Tier changes until removed, and are entirely ignored on the `free` cancellation sink — cancellation is an absolute deny.
_Avoid_: custom flag, tenant setting, exception (use Feature Override).

**Module**:
A deployable unit of Agent capability — the tools, prompt contribution, and optional config the Agent composes at runtime. Each Module has exactly one gate: **feature-gated** (active when the Tenant's effective Feature is on; e.g. Booking) or **enablement-gated** (bespoke per-Tenant work, active only when explicitly enabled for that Tenant). No Module is active for a non-billable Tenant (`free` Tier or non-active status).
_Avoid_: plugin, extension, skill (Agent skills are a different existing concept), feature (a Feature is the entitlement, a Module is the capability).

**Lead**:
A contact captured during a ChatSession by the agent's `capture_lead` tool. Promoted to its own entity (rather than ChatSession metadata) at Essential tier. Holds `name`, `email`, `normalizedEmail`, `phone`, `source`, `status`, `notes`, `capturedAt`, `customFields` (Pro+ tier), and optional `assignedUserId` / `score` / `scoreReason` (Pro+/Enterprise). Upserted by `(tenantId, normalizedEmail)` so a returning visitor doesn't create duplicates. The sidebar surface is **Leads** (the things); the agent-behaviour setting/toggle is called **Lead Capture**.
_Avoid_: contact, prospect, customer, visitor (use Lead).

**Copilot**:
The platform-side AI that answers tenant-admin questions inside the portal — explaining how Axentrio works, surfacing the admin's own tenant state, pointing at the right settings page. Distinct from `Agent`, which serves the Tenant's customers via the chat widget. Pro+ feature (`platformAssistant` entitlement flag). Marketed user-facing as **AI Platform Assistant**; in code, ADRs, API responses, DB columns, and engineering discussion, always use `Copilot`.
_Avoid_: assistant, bot, helper, AI Platform Assistant (use Copilot — the marketing label is an alias, not a domain term).

**Service**:
One bookable thing a Tenant offers (e.g. "Boiler repair"), with a duration, a `bookingMode` (`auto` — the Agent may confirm it outright, or `request` — it may only capture the ask), and its own optional timing. A Tenant has a catalog of them. The entity is `ServiceType` and the API still exposes a singular `eventType` for the pre-catalog UI; both are back-compat spellings of this one concept.
_Avoid_: event type, appointment type, offering, product, treatment.

**Booking Customer**:
The person talking to an Agent and asking for an appointment. Distinct from the **Tenant**, who is the business owner configuring the platform, and from a **Lead**, who is a captured contact rather than a party to a Booking - the same person may be all three at different moments, which is exactly why the word needs pinning down. Named positively because the glossary previously only said what NOT to call things: `customer` is listed under `_Avoid_` for both **Tenant** and **Lead**, so the term was half-anticipated and never defined. The location-planning spec was malformed on precisely this collision, using "customer" for the business owner in every Work Location paragraph while also using it for the person booking.
_Avoid_: customer on its own in any document that also discusses the owner (it is fine where only one party is in play), client, end user, guest, attendee (an attendee is the invite field, not the person).

**Booking**:
One row in a Tenant's diary. Status is `pending` (held, not yet confirmed), `confirmed` (the customer has a calendar invite), `cancelled`, or `request_created` (a captured Request, see below). Only `pending` and `confirmed` hold time — every capacity rule and the exclusion constraint count exactly those two.
_Avoid_: appointment, reservation, event (an event is the calendar mirror, not the booking), slot (a Slot is an offer, a Booking is a commitment).

**Request**:
A booking the Agent captured but did not confirm — stored as a Booking with status `request_created`. Raised whenever the Agent may not decide alone: a `request` Service, no healthy calendar connection, an address outside the Service Area, or a length it could not resolve. A Request consumes no capacity and blocks no time; only the Tenant accepting it does. Accepting is what turns it into a real Booking.
_Avoid_: enquiry, lead (a Lead is a contact, a Request is a proposed booking), pending booking (that is the `pending` status, a different state), tentative.

**Slot**:
A start time the engine currently believes is bookable — computed, never stored. Slots are advisory: they are filtered from availability, buffers, capacity and busy time, but a Slot the customer sees can still be refused at write time, because only the database constraint and the capacity gates run under a lock.
_Avoid_: opening, availability (that's the rule), free time, timeslot.

**Availability Rule**:
The one row per Agent that answers *when* the Tenant is bookable: a timezone, weekly hours per day, slot granularity, and Date Overrides. Exactly one per Agent.
_Avoid_: schedule, working hours, opening hours, calendar (a Calendar is the external mirror).

**Date Override**:
A named exception to the weekly hours on a specific date — either a closure or different hours. Distinct from a Booking: an override changes what is *offered*, a Booking consumes what was offered.
_Avoid_: holiday, exception, blackout, time off.

**Service Area**:
The places a Tenant will travel to, as a list of picked Belgian provinces and municipalities plus free-text notes. It only gates Services that require a customer address, and it is fail-safe-to-request: an address outside the area, or one that cannot be placed at all, becomes a Request rather than a refusal. Typed free-text entries are notes for the owner, never rules.
_Avoid_: coverage, catchment, radius, travel zone, region.

**Capacity Ceiling**:
A business-wide limit that applies *on top of* whatever a Service says, where the stricter of the two binds: bookings per day, booked minutes per day, and the Minimum Gap. `null` or `0` means unlimited on all three — a malformed limit must read as "no limit", never as "no bookings".
_Avoid_: quota, cap, limit (ambiguous on its own — say which), max bookings (that is one of three).

**Business Default**:
A Tenant-level timing value (buffers, minimum notice, maximum horizon) used only where the Service left that field null. Resolution is Service → Business Default → platform fallback, and an explicit `0` anywhere in that chain is a real answer, not an absent one. The opposite of a Capacity Ceiling: a ceiling always applies and the stricter wins; a default applies only in the absence of an opinion.
_Avoid_: global setting, fallback (that's the platform layer specifically), default value, ceiling (they are opposites).

**Buffer**:
Padding a Service reserves around its own bookings for prep and cleanup, set per Service. Distinct from the **Minimum Gap**, which is business-wide breathing room and travel time applied around *every* appointment regardless of Service. Both are additive.
_Avoid_: padding, break, gap (say which), travel time as a name for a Buffer (**Travel Time** is its own term — a Buffer is never it).

**Minimum Gap**:
Business-wide clearance held around *every* appointment regardless of Service — the owner's breathing room and their travel time between jobs. One of the three **Capacity Ceilings**, and the one that scopes to the **Itinerary Key** rather than the Agent, because it is a claim about one person's day. It is a floor rather than a fixed value: where the platform can estimate the drive between two consecutive appointments, the clearance is the larger of the owner's stated gap and that drive plus their slack, so a short drive never shortens the gap they asked for and a long one is never silently ignored. Additive with **Buffer**, which the **Blocked Range** already contains.
_Avoid_: travel time as a name for the gap (the gap is the floor **Travel Time** raises, not the thing itself), padding, buffer (a Buffer is per-Service), minGap.

**Travel Time**:
The drive between two consecutive Bookings on one **Itinerary Key**, and the hard feasibility constraint derived from it: a Slot the owner could not physically reach in the clearance available is not offered. It raises the **Minimum Gap** to a floor of `max(minGap, drive + slack)` — it never lowers it, and it is never a term in a sum with it. Feasibility only: whether a job further out is *worth* doing is the owner's decision, so nothing here may refuse a booking that is merely inefficient. That rule governs what may be **refused**; whether the platform may *prefer* one reachable Slot over another is a separate question, and its answer is **Geographic Grouping** (ADR-0017). Sold as its own **Feature** (`travelTime`) rather than as part of bookings, because it is the only booking capability with a per-use external cost. Until 2026-08 this glossary listed "travel time" as a name to avoid, when it was only ever the Minimum Gap's *purpose*; ADR-0014 made it a thing in its own right.
_Avoid_: travel buffer (a Buffer is per-Service prep/cleanup), distance, drive time (say Travel Time), routing, ETA.

**Base**:
The business's own premises, standing in as the predecessor of a day's FIRST Booking, so that an owner who starts at their workshop is not offered an early job an hour's drive away. It is not a new kind of thing — it is a **Placed Address** occupying the position a preceding Booking would occupy, departing at that day's first opening instant, so every rule **Travel Time** already applies applies to it unchanged. Three situations mean there is no Base at all and they are indistinguishable downstream: the per-Agent setting is off, the business is always-open, or the day has no opening window — in none of them is there a departure instant to measure from. Any preceding Booking that is not phone-or-online suppresses it, *including* one whose position could not be obtained, so a Base can only ever apply to a genuinely empty morning. It constrains the drive OUT only: the journey home is never gated. It is the SAME stored address as the business's own premises rather than a second field, and it is the owner's to choose: explicitly not their registered or VAT address, and never backfilled from one. Only meaningful for a Tenant whose Services send them out - a business whose customers come to it has premises rather than a Base, and that same address is simply where the appointment happens.
_Avoid_: home, home base, depot, office, HQ, start location, starting point, registered address (it is deliberately not that) (owner-facing copy may say "your business address"; the domain term is Base), venue (the **Venue** is the address field an owner types; the Base is what the gate does with it).

**Travel Check**:
What the travel gate actually did to one Booking, recorded on the row. `ok` means routing measured **every** leg that constrained the verdict. `degraded` means it did not — and that is a statement about provenance, **not** a fault: it covers the ordinary, healthy case of a short hop the haversine floor settled for free just as much as it covers an outage or a spent element cap. `captured` is held as a **Request** because there was nothing to reason over, and `overridden` is the owner confirming one anyway. **That override is an invariant, not a loophole**: feasibility is a hard constraint on the **Agent** and never on the person who owns the diary, so accepting a Request runs no travel check at all. A Request the gate captured would otherwise be refused by the same gate that captured it, and the owner could never clear it - the feature would have built a queue with no exit. The owner also knows things the platform does not: a job finishing early, a cancellation, already being nearby. Absent means no leg constrained the verdict at all — the gate did not apply, or there was simply no drive to consider — which is not a fifth verdict.

**A sustained run of `degraded` is therefore NOT an outage signal**, and reading it as one would alert on every business whose jobs are close together. Whatever watches for silent degradation must key on the structured cause the gate returns (`no_route`, `cap_exhausted`, `api_error`, `budget_spent`, `settled_by_bounds`, …), never on this column. The column answers "was this verified"; only the cause answers "why not".

What now watches is `booking/travel/travel-health.ts`, and it does not watch causes ALONE. The causes only arrive when somebody is booking, so with the feature inert or the night quiet they say the same thing whether routing is healthy or entirely broken. A synthetic traffic-aware probe answers that question independently, and the causes cover the failures one fixed journey cannot reach. Each source clears only the incident it raised: a healthy probe is not evidence that a failure real bookings are hitting has ended.
_Avoid_: travel status, verified (that is one of four values, not the concept), unavailable (the old single fail-open state — ADR-0015 split it three ways by cause).

**Geographic Grouping**:
The preference that a Booking should sit near the jobs already around it - the second thing the platform does with travel time, after **Travel Time** itself. It is a *reading* of the diary rather than a stored thing: the jobs already confirmed in a period are the group, so cancelling one simply makes the group different and nothing is ever written against it. It may only reorder what the Agent offers first. It may never refuse, withhold or downgrade a **Slot** that Travel Time already found reachable, and never spend the routing budget feasibility depends on (ADR-0017). It anchors on confirmed Bookings alone, which is the one query in this feature that deliberately ignores pending ones - feasibility still counts both. The period is the owner's choice of a half day or a whole day, and `none` switches grouping off. A half day's boundary is the clock midpoint of that day's opening hours and is not owner-settable. A whole day compares a candidate against every job of that local day, so an afternoon slot can be preferred for where the van already is in the morning. Choosing between DAYS is deliberately not a period: it would need to know the Booking Customer is flexible across days, and the platform does not ask.
_Avoid_: cluster (the glossary already spends that word on **Canonical Topic**, and geography is not topic), day scoring, route optimisation (nothing is optimised and no route is ever produced), zone, batch, territory.

**Preferred Slot**:
A **Slot** the platform puts first because it suits an existing **Geographic Grouping**, together with the reason the person booking may be told. Preference is presentation and nothing else: a preferred Slot is not more available, not more confirmable, and not held - and an unpreferred one is offered on exactly the terms it always was. The distinction is load-bearing rather than pedantic, because the obvious reading, that the platform has decided which Slot someone *should* take, is a promise the platform does not make.
_Avoid_: recommended, best slot, suggested time (what a business offers off the back of a **Request** is a different act), reserved, held.

**Address Suggestion**:
A row in the list a person sees while typing an address - Google's own text plus a durable place identity, and nothing else. It is deliberately NOT a **Placed Address**: it carries no coordinates and no precision, so nothing may route from it, refuse a **Slot**, or be written to a Booking. It becomes a placement only when somebody PICKS it and the identity is resolved. Suggestions are billed per request rather than per session, which is why a minimum query length, a debounce and a rate limit are all load-bearing rather than polish.
_Avoid_: autocomplete result (the mechanism, not the thing), prediction (Google's wire word), match, lookup.

**Address Binding**:
Which address a widget conversation is about, held against the chat session for as long as the session is live. It holds an identity and its verified spelling and never coordinates, so it inherits no 30-day retention duty. Only the **Booking Customer** may change it: an address the assistant asserts in a tool call can raise a **Pending Correction** but can never replace the binding, because a tool argument is written by the model and a model can reformat, invent, or drop one.
_Avoid_: session address, selected address, sticky address, cached address (it is not a cache - losing it is safe and simply returns the conversation to typed addresses).

**Pending Correction**:
A question waiting on the Booking Customer: something suggested a different address from the one they chose. It changes nothing on its own and never blocks them from booking. It carries the id of the proposal it belongs to, so an answer that arrives after they have moved on cannot settle a question they have already left behind.

Its lifecycle is `none → RECORDED → ASKED → SETTLED`. Recording is not asking: booking tools may
record freely, but only a persisted reply on a channel that renders the server-authored control is
ASKED. The question snapshots the one Address Binding it is about and an ASKED question cannot be
superseded. Picking again, expiry, or a Booking/Request consuming that binding voids it; the next
contested turn records a new question rather than re-pointing the old one.
_Avoid_: address conflict, mismatch, dispute, override.

**Placed Address**:
Where a Booking's customer address actually is, once Google has been asked: a durable place identity that may be kept for as long as the Booking, coordinates that are a derived cache with a 30-day life, the verified spelling of the address that was checked, and a precision. The precision is the load-bearing part rather than a label, because it decides what the position may be used for: a rooftop or street-level one can clear a drive, a town-centre one may only refuse a drive, and an address that will not place at all is not a refusal but a **Request**. An address is only ever placed for a Service that asks for one, on an Agent whose **Travel Time** is on, and every placement spends a metered Google element. **One exception, added deliberately when address suggestions shipped**: an address a person PICKED from a suggestion list is placed when they pick it, which is before any Booking exists and therefore before Travel Time can be consulted. That covers a Booking Customer choosing theirs in the widget and an owner choosing their **Venue** in settings - the second is not a Booking's address at all. The gate that survives is the spend cap, which still meters every one of those placements against the Tenant. The reasoning: picking an address is how one gets VERIFIED, so requiring Travel Time to already be on would offer verified addresses precisely where they were least needed and withhold them everywhere else. The coordinates expiring does not unplace the Booking: a daily job deletes them, the identity stays, and the next thing that needs a position resolves one from that identity. With a 60-day booking horizon that is the ordinary life of a far-future appointment rather than an exception. Two words on purpose: a bare "place" is already what a **Service Area** is a list of, and those are picked Belgian municipalities with no coordinates at all.
_Avoid_: geocode as a noun (to geocode is a fine verb), coordinates or lat/lng as a name for the whole thing (they are the part that expires), place on its own (that is a Service Area entry - though note `places.service.ts` and the `/places/*` routes carry Google's own product name, **Places**, which is a proper noun rather than this word), pin (a customer sharing their location is a different provenance, and the platform does not capture one yet).

**Blocked Range**:
The stored, buffer-expanded time span a Booking occupies, held as a `tstzrange` and protected by an exclusion constraint on `(calendar_key, blocked_range)`. It is the only race-proof guarantee that two customers cannot take the same time. It understands overlap and nothing else — day counts, minutes budgets and gaps cannot be expressed in it, which is why those run as their own locked checks.
_Avoid_: busy time (that is the merged in-memory view including the external calendar), reservation window, lock.

**Itinerary Key**:
Whose day a Booking sits in, and the scope of every question about what is parked *next to* it: the lock that serialises writes, the busy intervals availability is computed against, the **Minimum Gap**, and the travel time that rides on it. It equals the connected calendar's identity today, so two Agents pointed at one real calendar are one itinerary and a business with no calendar is its own — which means a second person on the road is a second itinerary rather than a new shape of Booking. Nothing may be stored against it: connecting, switching or disconnecting a calendar rewrites it, so configuration stays on the Agent. Distinct from the Agent, which is who *sold* the work — the day and minute **Capacity Ceilings** count per Agent, adjacency scopes per itinerary.
_Avoid_: calendar key (that is the stored column, not the concept), conflict key, driver, resource, technician.

**Calendar Mirror**:
The event written into the Tenant's connected Google or Outlook calendar for a confirmed Booking. A mirror, not the source of truth: the Booking row is authoritative, and a Booking whose mirror is missing or stale is still a real Booking. Reconciled asynchronously.
_Avoid_: sync, calendar event (ambiguous with the Tenant's own events), Google event.

## Relationships

- A **Tenant** owns one or more **Agents** and one or more **KnowledgeBases**
- An **Agent** participates in many **ChatSessions**
- An **Insight** is scoped to a **Tenant** (and may reference specific **ChatSessions** as evidence)
- An **Agent** has one **Availability Rule** and a catalog of **Services**
- A **Booking** is made against exactly one **Service**, and originates in a **ChatSession** on some **Channel**
- Accepting a **Request** produces a **Booking**; until then it holds no time

## Flagged ambiguities

- **"Success Meter" vs "Insight"** — used interchangeably in early discussion. Resolved: **Insight** is the persistent primitive (row with lifecycle); a "meter" or "score" is a derived rollup over Insights, not a stored object. Not building a meter primitive in v1. **Sidebar exception**: `Success Meter` is the user-facing sidebar label for the Insights surface (route stays `/insights`). In code, ADRs, API responses, DB columns, and engineering discussion, always use `Insight` / `Gap`. The label is a marketing alias, not a new domain concept.
- **Three candidate Insight kinds** (Gap / Correlation / Sentiment) — resolved per [ADR-0001](./docs/adr/0001-insights-v1-gaps-only.md): v1 ships only **Gap**. Correlation and Sentiment return in v2 reframed as experiments.
- **"Service" vs "event type"** — the entity is `ServiceType` and the scheduler API still returns a singular `eventType` alongside the full `services` catalog, from before a Tenant could have more than one. Both name the same concept. New code and all discussion say **Service**; the `eventType` field is a back-compat alias that should not spread.
- **Ceiling vs default** — the two business-level timing surfaces read alike and behave oppositely, and conflating them is the most expensive mistake in this domain: a **Capacity Ceiling** always applies and the stricter of (Service, Business) wins, while a **Business Default** applies *only* where the Service is silent and the Service always wins. Every field is one or the other, never both.
- **"Request" vs "pending"** — a Request is status `request_created` and holds no time; `pending` is a held Booking that does. They are adjacent in the enum and opposite in meaning. A capacity rule that counts `request_created` lets a Tenant fill their own day by receiving enquiries.
