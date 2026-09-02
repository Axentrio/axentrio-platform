# Grouping prefers a Slot; it never refuses one, and it buys its own routing

Efficiency has been out of scope for the whole travel epic, and deliberately so: `travel-gate.ts`
says "it never asks whether a job is a GOOD use of the day. Feasibility blocks; efficiency must
not", and the plan's risk table names "efficiency logic creeping into a hard block" as the failure
to prevent. **Geographic Grouping** is the first thing to cross that line on purpose, so the terms on
which it crosses have to be written down rather than discovered by whoever implements it.

**Preference may reorder what the Agent offers. It may never refuse, withhold, downgrade, or
otherwise change what a Slot is.** A Slot that **Travel Time** found reachable stays exactly as
reachable, as confirmable, and in exactly the same class, whether grouping likes it or not. The
owner's detour threshold decides whether a Slot is *preferred*; it never decides whether a Slot is
*offered*.

**The trap this ADR exists to close is the routing budget, and it looks free.** An availability
check may spend ten route lookups and eight seconds (`travel-gate.ts`), spent walking a
chronologically sorted slot list. A Slot the haversine bounds already settled costs nothing and keeps
its verdict either way; only a Slot in the undecided band needs a paid lookup, and once the budget is
gone such a Slot stays undecided and becomes a Request. The obvious way to make grouping bite is
therefore to spend that budget on the near candidates first. It needs no new Google spend, it looks
like pure reordering, and it is wrong: a Slot in the band that would have been measured and cleared
is now a Request, because an efficiency preference got in the queue ahead of it. That is precisely
the downgrade the epic forbids, arrived at through a change that never mentions feasibility.
**Grouping therefore buys its own elements, counted separately, and when that budget is spent the
remaining candidates are neutral and unscored - never Requests.** If grouping cannot afford to rank a
Slot, the Slot is offered exactly as it would have been without the feature.

**Two anchor sets, never merged.** Grouping anchors on `confirmed` Bookings only. That is recorded
here as the founder's rule rather than justified by a lifecycle, because no booking path in this
codebase currently writes a `pending` row - bookings insert as `confirmed`. "A pending job might not
happen" would be reasoning about a state nothing produces. Feasibility meanwhile keeps counting
`pending` and `confirmed` alike, because a Booking in either state holds time the owner has to be
somewhere for (`travel-neighbours.ts`).

**This is not the Request distinction, and conflating the two is easy.** The statuses are
`pending | confirmed | cancelled | request_created`. A **Request** is `request_created` and holds no
time at all; a `pending` **Booking** holds time exactly as a confirmed one does. Feasibility already
excludes Requests, and **grouping must exclude them too** - the grouping set does not exist yet, so
that is an instruction rather than an observation. Narrowing the feasibility query to confirmed-only
in order to serve grouping would delete a real constraint from the safety check, and the two rules
read similarly enough that this is a live risk rather than a theoretical one.

Note the nouns, because getting them wrong here is how the rule gets misread: a **Slot** is advisory
and is never held, and a **Booking** is the thing that holds time.

---

**The founder's ordering requirement cannot be met as stated, and is weakened here rather than
quietly missed.** The ask was that the final plan should not follow the order the bookings arrived
in: four customers wanting one day should end up grouped by geography regardless of who confirmed
first. The platform cannot do that. Confirmed Bookings are immutable to the optimiser, and
concurrent conversations share no hold state, so whoever confirms first sets an anchor that
everything later is ranked against.

So the requirement is: **booking order does not dictate how the REMAINING Slots are ranked.** The
second Saint Gilles customer is grouped with the first when they arrive afterwards. They cannot be
grouped when the better plan requires moving a job somebody has already been promised.

Owner-approved re-sequencing was the considered alternative and was rejected for now: telling a
customer their confirmed appointment has been moved is a notification, not consent, and the ordinary
reschedule path already exists for a human who decides to do it deliberately. Provisional holds
across concurrent conversations would solve it properly and are their own epic. Recorded here
because a future reader will otherwise compare the shipped behaviour against the original ask and
conclude something is broken.

**Consequence worth stating plainly.** This feature is weaker than what was asked for, and it is
weaker in a way no amount of implementation effort fixes. It also cannot see external calendar
events, which block time but carry no location by design, so it optimises the Axentrio-held part of
a day and must never be described to an owner as optimising their agenda.

---

## Amendment, 2026-08-10: grouping spends, and "never refuses" now has one exception

"Grouping may prefer a Slot and may never refuse one" was written about the SLOT LIST, and there
it still holds absolutely: nothing in the scorer reorders the returned list, changes a Slot's
feasibility class, or removes a time. That part is not weakened.

What is weakened is a second-order claim the original wording implied. The scorer buys Google
Distance Matrix elements from the same monthly per-Tenant counter the feasibility gate draws on.
So grouping can bring a Tenant to exhaustion sooner than they would otherwise reach it, and an
exhausted gate turns confirmable Slots into Requests. **A booking customer later that month can
therefore be offered a Request where they would have been offered a Slot, because grouping spent
first.** That is a refusal grouping caused, at one remove, and this ADR must say so rather than let
the code contradict it.

### Why the spend is not optional

The scorer needs three legs per candidate: the two beside it, and the baseline `prev→next` that
says what the two surrounding jobs cost each other with nobody between them. The feasibility gate
routes the first two and never the baseline, because it never needs it. A strictly free scorer was
built first and measured live: 10 offers, 63 Slots, and every Slot it managed to score had a job on
ONE side only. Every candidate BETWEEN two jobs missed the baseline and went neutral - so the
scorer was blind to precisely the mid-day insertion the feature exists to find, and its headline
measurement read "no cheaper alternative ever existed" for a structural reason rather than a real
one. Spending nothing does not make the feature safe; it makes it useless and dishonest about it.

### What bounds it

- **Only the baseline is ever bought.** The two legs beside a candidate are read from the
  conversation's drive cache or not had at all, because buying one is grouping paying to redo the
  gate's own work.
- **One purchase per gap, by construction.** The leg is per-gap rather than per-candidate, and the
  pass memoises it locally - so a null session, an unavailable Redis, a failed answer or a
  departure crossing the traffic horizon cannot turn the magnitude into per-candidate.
- **Four purchases per pass, hard.** Past that the pass reads cache-only: a baseline already in
  the cache still scores, and only a MISS leaves that candidate neutral. No further element is
  bought either way, and neutral refuses nothing.
- **No purchase is BEGUN after the customer has been answered.** The pass is raced against a
  deadline, and a race abandons the wait rather than the work - so the deadline is carried down to
  the reservation itself, not just to the decision to look. A reservation already awaiting, or a
  request already in flight, still completes: a check-then-act cannot promise otherwise. Those
  finish bounded by the router's own timeout and their answers go to the drive cache.

Single figures per conversation, shaped by how many jobs are in the diary rather than by how long
the Slot list is.

### The alternative that was rejected, and why it stays rejected

A fractional share of the monthly cap - grouping may spend up to 30%, feasibility keeps 70%. It was
built, reviewed and removed. It bounds the harm without removing it: a Tenant who would have used
80 of a 100-element cap and never exhausted it is refused after 70 once grouping has taken 30. A
ceiling cannot make fungible spend un-fungible, so a share buys a guarantee it cannot deliver while
reading like one that can. A small explicit magnitude, written down here, is the honest version of
the same trade.

### What would retire the exception

A `prev→next` duration the platform already holds. The gate could route the baseline itself
whenever it is cheap to do so, or a per-day route cache scoped to the itinerary would make the leg
free on the second conversation of the day. Either removes the spend without removing the
capability. Neither is built.

---

## Amendment, 2026-08-17: Route Priority is presentation-only, and it is named here so nobody upgrades it

The spec asked for a **Route Priority** selector — Auto Optimize, Nearest First, Farthest First —
that orders a mobile business's day by travel efficiency. Read literally, "Auto Optimize" is route
optimisation, which this ADR forbids. The decision (#151) is that it is not that: **Route Priority
is a sort applied to the Slot list feasibility has already produced, and nothing else.** The three
modes choose the sort key; feasibility alone decides membership. Auto orders by the grouping
scorer's existing preference; Nearest First and Farthest First order by the same already-computed
detour figures, ascending or descending. A Slot the scorer left neutral — budget exhausted, cache
miss, no anchors — keeps its chronological position among its neighbours, because an unscored Slot
must not be pushed to the back of the list by a feature that never measured it.

Every invariant above applies unchanged and none is weakened further: no mode refuses, withholds,
downgrades, or reclassifies a Slot; no mode buys a single routing element beyond the bounded
grouping spend of the 2026-08-10 amendment; the feasibility budget is never touched. Farthest First
exists because the owner asked for it, not because it is efficient — it is the clearest proof the
feature is presentation, since no optimiser would offer it.

Genuine route optimisation — the selector influencing which Slots are offered — was the considered
alternative and is rejected, not deferred vaguely: it reverses "efficiency must never become a hard
block", which is a founder-level rule, and nothing yet shows reorder-only is insufficient. If that
evidence arrives, the reversal needs a new ADR superseding this one, written before the code.

2026-09-02: Route Priority removed and Maximum Travel Time became a
feasibility ceiling for the Agent; see ADR-0019.
