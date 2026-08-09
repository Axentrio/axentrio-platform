# Location-aware planning - corrected specification (LP0)

> **Moved out of `.scratch/` on 2026-08-09 (#85, Decision 1).** This is the BUILD CONTRACT for
> epic #78 - the scoring formula, the half-day boundary rules and the offer-record schema that
> #79 onward are built from. It lived in `.scratch/`, which is gitignored, so it existed on one
> laptop while the tickets that tell people to read it did not. That was a reasonable choice
> while the person who wrote a plan was the person who built it; this epic is meant to be handed
> over, so it is a specification other people build from rather than scratch working material.
>
> Where this document and an ADR disagree, the ADR wins. See
> [ADR-0017](../adr/0017-grouping-prefers-it-never-refuses.md).

Written 2026-08-07. Supersedes the raw founder spec for implementation purposes. The raw text is
kept verbatim in the epic so the original intent stays auditable, but nothing should be built from
it directly: it conflates the business owner with the booking customer, defines two grouping periods
that mean the same thing, and promises a route sequence the system is not allowed to produce.

Reviewed by Codex against the code. Where this document and an ADR disagree, the ADR wins.

---

## The three corrections, and why

**1. "Customer" now means one thing.** The raw spec used "customer" for the business owner in every
Work Location paragraph and in AC2 to AC5, while also using it for the person booking ("Customer A:
Antwerp"). Throughout this document:

- **Owner** - the business configuring the system. Chooses Work Location, Home Base, grouping.
- **Booking customer** - the person talking to the Agent. Supplies a job address and their
  availability.

**2. Group by Week is dropped.** The raw spec's Full Day and Week examples describe identical
behaviour: a new Antwerp booking customer is steered to the day that already holds Antwerp jobs.
Week supplied no different invariant, no different scoring horizon and no different outcome. It is
not deferred pending build capacity; it is removed pending a definition. If a distinct meaning
exists (a weekly territory rota, for instance) it needs writing down before it is a requirement.

**3. Route Priority becomes "Prefer".** The raw spec promised "farthest from Home Base earlier,
gradually working back". The system cannot produce that. Confirmed appointments are never moved by
the optimiser (AC9), and bookings arrive one at a time, so a day is never sequenced, only inserted
into. The options are renamed to say what they can honestly do:

| Was | Is |
|---|---|
| Auto Optimize | **Auto** - lowest marginal insertion cost |
| Nearest First | **Prefer Nearer Earlier** |
| Farthest First | **Prefer Farther Earlier** |

---

## Vocabulary

**Work Location** is a **projection**, never a stored scheduling authority. It summarises what the
owner's services already say. A second enum controlling behaviour independently would guarantee
drift against `ServiceType`, which is where the facts actually live.

| Work Location | Derived from |
|---|---|
| No Location | no service is physical |
| At One Location | every physical service is at the business's own address |
| On The Road | every physical service is at the booking customer's address |
| Both | both kinds of physical service exist |

**Service Location Mode** is one per service - `remote` / `business_location` / `customer_location` -
and LP1 introduces it **as a resolver, not as a stored column.** Today the same fact is spread across
`ServiceType.locationType` and `ServiceType.customerAddressRequired`, and those two already
contradict each other: `event-location.ts:58` treats `customerAddressRequired` as the stronger signal
even when `locationType = 'custom'`.

The distinction matters and the first draft of this document fudged it. A **stored enum** is new
authority and needs a migration, a backfill, compatibility reads and a deprecation path for the old
columns. A **resolver** is a canonical projection over what already exists, computed in one place.
Start with the resolver. Introduce stored authority later, if ever, and only behind an explicit
migration plan, never as a side effect of this phase.

**The mode is READ-ONLY, and the second draft of this document got that wrong too.** It said the
portal would edit the three-value concept and write back to the legacy columns atomically. It cannot:
`remote` collapses `google_meet`, `phone` and `custom`, which are three different behaviours
(`ServiceType.ts:24`) and one of them creates a meeting link. Choosing "remote" does not say which to
persist, so a round trip through the new concept would lose information the owner had set.

So: the resolver answers *who travels*, and it is derived, never written. The remote **modality**
stays its own control, edited as it is today. The portal may present them together; it may not
collapse them.

**Home Base** is the address a van leaves from. It is the existing `BookingSettings.venue_*`
address, which is already owner-entered, already nullable, and already separate from any legal or
VAT address, so **AC5 is satisfied by the code as it stands**.

One caveat the raw spec collapses: under `Both`, the raw text makes one address serve as the
appointment location *and* the route reference. A salon with a separate workshop needs two. LP1
keeps them as one field and records this as a known limitation rather than inventing a second
address nobody has asked for yet.

**Service Area** is untouched and orthogonal. It answers "where is the owner willing to travel",
not "who travels", and applies only when the booking customer's address is required.

---

## Geographic Grouping

Applies only to `customer_location` services, only when the owner has declared a single driver, and
only when **Travel Time** is entitled and on.

- **No Grouping** - the default.
- **Group by Half Day** - prefer slots in the half day that already holds nearby jobs. The boundary
  is the owner's to set and defaults to the midpoint of that day's effective opening hours.
- **Group by Full Day** - the whole local day is one group. A booking customer who is flexible
  across several days is offered the day with the lowest marginal insertion cost.

**Grouping only ever reorders what the Agent offers first.** It never refuses a slot, never
withholds one, and never turns a confirmable slot into a Request. This is not a preference of this
document; it is ADR-0017 and it is the invariant the whole travel feature rests on.

### The anchor split, which is easy to get wrong

The raw spec says "only confirmed bookings influence geographic grouping". That is correct **for
grouping** and dangerous if applied anywhere else. Feasibility deliberately treats `pending` and
`confirmed` Bookings alike, because a Booking in either state holds time the owner has to be
somewhere for (`travel-neighbours.ts`). So:

- **Grouping anchors**: `confirmed` Bookings only.
- **Feasibility constraints**: `pending` and `confirmed`, unchanged.
- **Requests** (`request_created`) hold no time and belong to neither set. Feasibility already
  excludes them; grouping must too.

Two sets, never merged. Narrowing the feasibility query to confirmed-only would let a pending job
vanish from the safety check.

Watch the nouns. A **Slot** is advisory and never held; a **Booking** is what holds time. "Held
slot" is a phrase this document must not use, because it makes the rule above read backwards.

**What counts as an anchor is not only mobile work.** An at-premises Booking is a real node on the
owner's route: they have to be at the venue for it. Grouping anchors are therefore every `confirmed`
Booking with a known position in the period, whether that position is the customer's address or the
venue - not only `customer_location` jobs. Getting this wrong makes a salon-and-van business rank as
though its premises days were empty.

---

## The scoring contract

"Lowest marginal insertion cost" is not implementable on its own. All of the following are part of
the requirement.

**The formula**, over the period's fixed chronological itinerary, using directional travel times:

```
cost(candidate) = t(prev → candidate) + t(candidate → next) − t(prev → next)
```

- At the period's first edge, `prev` is the **Home Base** only when start-from-base is on and the
  candidate would be the first constraining Booking of the **whole local day**. Otherwise there is
  no `prev` term. Never invent a return leg: start-from-base says nothing about going home.
- At the last edge there is no `next` term.
- **An unanchored period produces no preference at all.** Every slot in it is neutral, not
  "all equally preferred" and not "all preferred". A period with nothing in it and no base has
  nothing to be near.

**Anchors** are every `confirmed` Booking in the period with a known position, whether that position
is the booking customer's address or the venue. At-premises jobs are real route nodes.

**The threshold.** `travel_max_detour_min` bounds the marginal minutes **one candidate** adds. Null
means no threshold and everything scored is eligible to be preferred. The comparison is `<=`, so a
candidate exactly at the threshold is preferred. Over it means **not preferred** and nothing else:
the slot keeps its feasibility class, stays confirmable, and is still offered.

**Boundary-crossing.** A candidate's buffer-expanded **Blocked Range** must fit wholly inside one
period to be scored. A straddling candidate is neutral. It is never scored against both periods and
never assigned to the one it mostly occupies.

**What is scored, and what happens when scoring fails.** Four rules, because two correct-looking
scorers would otherwise disagree:

- **Only confirmable `slots` are scored.** `travel.requestableSlots` stay chronological and
  unpreferred: a slot travel could not clear is not a slot to steer anyone toward.
- **Only trusted placed positions participate.** A coarse (town-centre) or unresolved position makes
  the candidate neutral. ADR-0014's rule that coarse may refuse but never clear applies to preference
  as well: a dot standing for a municipality cannot say a drive is efficient.
- **Any required leg that cannot be measured makes the candidate neutral**, whether the grouping
  budget ran out or the lookup failed. Never a partial score, never a fallback to distance.
- **Departure times are fixed, not chosen.** `prev -> candidate` and `prev -> next` depart at
  `prev.blockedEnd`; `candidate -> next` departs at `candidate.blockedEnd`. Traffic-aware answers are
  departure-bucketed, so leaving this open would make the same itinerary score differently run to run.

**Ordering, and it must be deterministic.** Preferred confirmable slots by ascending cost, then
unpreferred and neutral confirmable slots in chronological order, then requestable slots - which are
never promoted above confirmable ones. Ties inside any group break chronologically.

## The half-day boundary

The default is the **midpoint between that day's first opening instant and its last closing
instant**, taken from the effective windows (`windowsForDay`, which already applies date overrides).
Deliberately not the midpoint of elapsed open time across the union of windows: an owner who says
"morning" means the clock, not their integrated availability.

- The owner may override it with a clock time.
- **Two or more windows**: the largest gap between them is *suggested* to the owner as a boundary,
  never applied automatically. Two windows may be a school run rather than a morning and afternoon.
- **A day with no effective windows**: no periods exist, so grouping does not run on it.
- **`always_open` mode**: Half Day does not run. A day with no shape has no morning and no
  afternoon, and 12:00 would be an invention. Full Day still applies, because a day is still a day.

## The offer record

> **SUPERSEDED by [`lp3-offer-record.md`](./lp3-offer-record.md)** (approved after five review
> rounds, #80). The section below is kept because the reasoning is still sound, but five of its
> statements are wrong in detail - most importantly "one record per availability call", "retention
> follows the Booking", and the assumption that the slots a customer receives are the slots the
> agent produced. Build from the companion document.


The weakest surface to specify loosely, because two teams can build incompatible versions and both
believe they are done.

**One record per availability call that reaches a booking customer.** A conversation with three
availability calls produces three records.

What "offered" means has to be pinned, because three different lists exist: what the tool returned,
what the quick-reply UI rendered - **the first eight array entries** (`agent.service.ts:102`) - and
what the model wrote in prose. The record stores **the slots presented, in presentation order**,
and which of them were rendered as quick replies.

Each record carries: the service, duration, requested local day, the address identity, the
confirmed anchor itinerary as it stood at that moment, the ranking metadata and reason codes (empty in LP3, populated by LP4's
shadow scores before the pilot ever ranks anything - which is what makes LP4's counterfactual
comparable to LP3's baseline), and the outcome - selected, explicitly declined, or abandoned
- linked to the resulting Booking or Request and to that exact offer version.

Retention follows the Booking, as every other customer-derived record in this area does. The owner's
audit view shows why a slot was preferred **without naming another customer or their address**.

---

## Customer flexibility

New, structured, and collected rather than inferred. The availability tool currently receives only a
date range, a service, a duration and an address (`booking.tool.ts`), and a wide `startDate` to
`endDate` is **not** evidence that the booking customer is free across it.

What gets collected and stored:

- one or more permissible date and time windows
- the business timezone
- an optional preferred window
- an explicit "alternatives acceptable" signal

The Agent may collect these facts. The server validates them and builds the candidate set. **A
flexible booking customer authorises the system to OFFER alternatives, never to SELECT one.**

---

## Rules

1. Travel time governs, not kilometres. Distance is only a pre-filter for whether a paid lookup is
   worth buying.
2. Grouping anchors on confirmed bookings; feasibility keeps pending and confirmed both.
3. The optimiser never moves a confirmed appointment. A human still can, through the ordinary
   reschedule path.
4. Booking-customer availability and flexibility are respected, and never inferred from silence.
5. Appointment duration and buffers are already inside the **Blocked Range** and stay there.
6. A booking customer's address is required for `customer_location` services.
7. Only a `customer_location` candidate is *scored*. Its **anchors** may still include at-premises
   Bookings, because the owner has to be at the venue for those too. "Grouping applies only when the
   owner travels" is about which slot is ranked, never about which jobs count as neighbours.
8. Availability and travel feasibility are re-checked under the lock before confirmation. **Already
   built** (#65b), and it covers feasibility only, not ranking.
9. Simultaneous requests cannot create conflicting appointments. **Already built** (#65b).
10. Grouping buys its own routing capacity and never spends the feasibility budget. Overflow yields
    neutral, unscored slots, never Requests.
11. Both parties are told when a slot is preferred: the booking customer in restrained wording, the
    owner as an audit trail.

---

## Acceptance criteria, rewritten

- **AC1** No Location: the address field is hidden and grouping is unavailable.
- **AC2** At One Location: an address field is shown and the **owner** chooses which address to use
  as the business location.
- **AC3** On The Road: an address field is shown and the **owner** chooses which address to use as
  the Home Base.
- **AC4** Both: an address field is shown and the **owner** chooses the address serving as business
  location and Home Base. The known limitation that these cannot differ is documented.
- **AC5** The owner is never forced to use their registered company address. *Already satisfied by
  shipped code* (`BookingSettings.ts:97`: never the VAT/legal address, starts null, never
  backfilled). LP1 still has UX work: the portal currently tells the owner this address is
  **not** used for jobs they travel to, which is exactly what Home Base needs it to be.
- **AC6** Where grouping is on, the slot with the lowest marginal insertion cost is offered first.
  It is never offered *instead of* the others. Note the raw spec's "nearby appointments receive
  preference" is loose: every candidate slot is for the same booking customer at the same address,
  so no slot is geographically nearer than another. What differs is what each slot's **neighbours**
  would be, and therefore what it costs to insert.
- **AC7** Half Day and Full Day rank according to the selected period. Week is out of scope.
- **AC8** Auto ranks by lowest marginal insertion cost, measured in travel time.
- **AC9** The optimiser never moves a confirmed appointment.
- **AC10** Availability and travel feasibility are re-checked under the lock before confirmation.
- **AC11** *(new)* Grouping never changes a slot's feasibility class and never consumes the
  feasibility routing budget.
- **AC12** *(new)* Grouping runs only where the owner has declared a single driver.

---

## Deliberately not in this specification

- **Group by Week**, until it has a meaning distinct from Full Day.
- **Customer Can Choose.** It reads like a small addition to `Both` and is not: it needs a
  service-level choice mode, a per-booking resolved mode, address collection before availability,
  conditional Service Area and travel gating, correct calendar location, and reschedule behaviour.
  Its own epic. Two explicit services are simpler for most owners and available today.
- **Whole-agenda optimisation.** External calendar events block time but carry no location by
  design (`travel-neighbours.ts`), so the system can only ever optimise Axentrio-held located jobs.
  Nothing may claim otherwise to an owner.
- **Multi-worker businesses.** There is no driver or resource model (ADR-0016), and Gate 4 cannot
  detect one Agent and one calendar driven by two people (#59). The one-driver declaration is the
  interim guard.
- **Moving confirmed bookings**, in any automated form.

---

## Phases

**Numbered `LP` for Location Phase**, because the travel plan's P1 to P9 already mean something else
and a bare "phase 3" in a ticket comment would be ambiguous between two live documents.

LP0 is this document. Each later phase is gated on evidence rather than on argument, and the gates
are the point: the ranking work is the last thing built, not the first.

**The critical path to Half Day**, which is what was actually asked for:

| Phase | Ships | Gate to pass before the next |
|---|---|---|
| **LP1** | Service Location Mode resolver; Work Location as projection; conditional venue and Service Area controls | Owners configure modes without contradiction |
| **LP2** | #67, #68, #76, one-driver declaration, telemetry. Feasibility only | Latency, Routes success rate, bounded element spend, enough placed bookings, one-driver assumption holds |
| **LP3** | An offer and decision record. Nothing is ranked yet | A pre-steering baseline exists over enough bookings to compare against |
| **LP4** | Marginal-insertion scorer running in shadow, no visible change | Score distributions, ranking stability, element cost and latency are acceptable, **and** lower-cost alternatives exist often enough to be worth steering toward |
| **LP5** | Live Half Day pilot behind a tenant flag | First-offer acceptance and recovered capacity improve, not merely ordering |

**Off that path**, and only if Half Day proves out:

| Phase | Ships | Gate |
|---|---|---|
| **LP6a** | Structured customer flexibility | LP3's records show a real share of availability calls span more than one day *and* convert |
| **LP6b** | Full Day | LP6a and LP4 both show cross-day value beyond Half Day |
| **LP7** | Prefer Nearer / Farther Earlier | Owners want them and they beat Auto for a recognisable segment |

## The gates, as numbers (#85 Decision 2)

The gates above are adjectives - "enough", "acceptable", "often enough", "improve" - and #85 is
right that those become post-hoc arguments the moment results are visible: whoever wants to ship
will find the number acceptable.

**PRE-REGISTERED, WHICH MEANS NOW.** #85 guessed these wanted LP2's data first. They do not, and
waiting for it is the failure it was trying to avoid - a bar set after the results are in is
exactly the post-hoc argument the complaint is about. Every number below is derived from
something that already exists: Google's pricing, a timeout in the code, or the arithmetic of
statistical power. None of them needs an outcome to be known.

Two are deliberately left as FORM rather than value, and the reason is stated with them.

### LP2 - feasibility

| Gate | Threshold | Where the number comes from |
|---|---|---|
| Routes success rate | **≥ 98%** of routing attempts return a route, over 14 consecutive days | Below this, ADR-0015's degraded branch is the normal path rather than the exception - and per ADR-0015's own amendment, degraded mode in Belgium is close to capture-everything-as-a-Request. A feature that captures 1 booking in 50 as a Request has not shipped |
| Element spend | **≤ 3,500 elements/month** platform-wide | The Routes Pro free tier is 5,000/month and `travel-health`'s probe takes ~1,440 of it at a 30-minute cadence. 3,500 leaves the probe intact with ~60 to spare, so feasibility never silently starts costing money |
| Availability latency | **p95 ≤ 8s** added to the availability call | `LAZY_GEOCODE_DEADLINE_MS` is already 8,000 in `travel-neighbours.ts`. The gate is that the existing deadline is respected at p95, not a new budget invented for the occasion |
| Placed bookings | **≥ 100** bookings with a known position | Below this the success rate above has a confidence interval wider than the 2% it is measuring |
| One-driver assumption | **Zero** Agents with travel on and a shared itinerary key, for the whole window | Already detected and alerted (#68). It is a boolean, not a rate: one sharing tenant makes the feature actively worse for that business |

### LP3 - the baseline

| Gate | Threshold | Where the number comes from |
|---|---|---|
| Baseline size | **≥ 135 attributed bookings** | The power calculation below. This is the number LP5 needs per arm, so collecting less means LP5 cannot conclude anything whatever it shows |

### LP4 - the scorer in shadow

| Gate | Threshold | Where the number comes from |
|---|---|---|
| Ranking stability | **100%** - scoring the same diary twice produces the same order | Determinism is a property, not a rate. A scorer that reorders on a re-run cannot be reasoned about at all |
| Element cost | **≤ 1.5 elements per scored offer**, mean over a full month | The spec notes one exact marginal-insertion cost can need three directional lookups. 1.5 means the cache and the bounds are doing most of the work; at 3 the feature costs its whole budget on shadow scoring that changes nothing |
| Added latency | **p95 ≤ 2s** on top of LP2's measured availability latency | `routes.service.ts` already times out a matrix at 5,000ms. Two seconds at p95 means the common case is cached or bounded rather than reaching Google |
| Cheaper alternatives exist | **≥ 20%** of scored offers contain a slot at least 10 minutes cheaper than the one ranked first today | Below one offer in five, steering changes almost nothing and the pilot cannot move the numbers in LP5 whatever it does. The 10-minute floor is the smallest saving worth a customer being nudged |

### LP5 - the pilot

| Gate | Threshold | Where the number comes from |
|---|---|---|
| First-offer acceptance | **+15 percentage points absolute**, one-sided, α = 0.05, power 0.80, **n ≥ 135 attributed bookings per arm** | Two-proportion power: n ≈ (z<sub>α</sub> + z<sub>β</sub>)² · [p₁(1−p₁) + p₂(1−p₂)] / (p₁−p₂)². With z = 1.645 and 0.84, a 40% → 55% shift needs ~134 per arm. A 10-point effect would need ~303, which this platform's volume cannot supply, so 15 points is the smallest effect that is actually detectable here rather than the smallest worth having |
| Recovered capacity | **Form, not value**: bookable minutes per working day must rise, measured against the same tenant's own pre-pilot fortnight, with the direction and the window fixed here and the magnitude read from LP3 | The magnitude genuinely cannot be pre-set - "how much capacity is recoverable" depends on the diary density LP3 is measuring. What IS pre-set is that the comparison is within-tenant, against a fixed prior window, and that ordering alone does not count |

### LP6a and beyond

| Gate | Threshold | Where the number comes from |
|---|---|---|
| Multi-day share (#84) | **≥ 25%** of well-formed availability calls span more than one day, AND those calls convert at no worse than 0.8× the single-day rate | Below a quarter, structured flexibility is collection nobody uses. The conversion clause stops a high share of window-shopping being read as demand |
| LP7 segment | **Form, not value**: a named segment must beat Auto on first-offer acceptance by the same test as LP5 | There is no segment to size yet |

**Why two are left as form.** A pre-registered number that nobody can derive is worse than an
adjective, because it looks rigorous. Recovered capacity depends on diary density and the LP7
segment does not exist yet; for both, what is fixed now is the comparison, the window and the
direction, which is what stops the argument being had after the fact.

**These bind.** Missing a gate means the phase does not ship, and the epic having cost one ticket
rather than a live feature is the outcome the phasing was designed for.

---

**LP4 cannot prove capacity, and its gate no longer claims to.** A scorer that changes nothing
visible can prove what the scores look like, that ranking is stable and deterministic, what it costs
in elements and latency, and how often a cheaper alternative was available. It cannot prove
recovered capacity or that customers accept steering, because nobody was steered. Those are LP5
outcomes and they belong to LP5's gate.

**LP4 runs contemporaneously, not as historical replay.** Score each offer as it happens and persist
the inputs alongside the output. Reconstructing later is not equivalent: bookings get cancelled and
moved, and coordinates are deleted at thirty days (ADR-0014), so a backward replay scores a diary
that no longer exists and sometimes cannot be rebuilt at all.

**LP6a's gate must not be circular.** "Do customers have more than one feasible day" cannot be
answered by the feature that collects flexibility, or LP6a gates on its own output. It is answerable
from LP3: the availability call already carries a requested date range, so the record shows how often
that range spans several days and how often those convert. That is a proxy rather than consent, and
it is enough to decide whether building the real thing is worth it.

**Half Day needs no flexibility data**, which is why LP6a sits after the pilot rather than before it.
Flexibility is what makes it legitimate to move somebody between *days*, so it is a Full Day
prerequisite, and building it earlier would delay the primary ask to no purpose.

**But "the customer already named a day" is an assumption the code does not currently enforce.**
`check_availability` accepts an arbitrary date range (`booking.tool.ts`) and records nothing saying
the booking customer chose it. **LP5 therefore accepts only single-local-day availability calls** (`startDate == endDate`), which
is mechanically enforceable, and records that fact.

What it must NOT claim is that the booking customer chose that day. The tool receives dates the
model selected and carries no provenance field, so a flag asserting "the customer picked this" would
be the model marking its own homework. Establishing real provenance needs LP6a's structured
collection. Until then the single-day rule is a guard against ranking across days on no authority,
not evidence of consent.

**LP3 must precede LP5, and the reason is easy to lose.** The pilot has to prove that
steering works, which means knowing how often a booking customer took the first slot offered
*before* anything reordered them. That baseline cannot be reconstructed afterwards. Ship the record
early, let it run, and the "before" number exists.

LP2 is mostly existing tickets. LP6b and LP7 are deliberately unticketed: creating tickets for
work gated on evidence nobody has collected invites someone to start it.
