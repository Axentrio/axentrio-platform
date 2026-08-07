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
