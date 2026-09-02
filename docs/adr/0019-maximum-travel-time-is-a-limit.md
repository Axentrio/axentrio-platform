# Maximum Travel Time refuses a drive for the Agent; the owner may still book it

The owner's **Maximum Travel Time** is a ceiling on one drive. The drive is the job before to the candidate, the candidate to the job after, or the **Base** leg when start-from-base is on.

Under the customer / Agent policy (`enforce`), a drive over the ceiling makes the **Slot** `unreachable`. The Agent does not offer it. The Agent does not confirm it.

Under the owner policy (`annotate`), the Slot stays on screen and is marked "too far". The owner may pick it. Accept of a **Request** still skips the travel gate.

This supersedes the 2026-08-17 amendment of ADR-0017 for this one setting only. Grouping itself still never refuses a Slot.

Reason: founder decision 2026-09-02 (spec clarification 5). A plumber who books a 70-minute leg against a 45-minute limit cancels the last job of the day. That outcome is worse than not offering the time.

**Route Priority is removed.** Auto Optimize (cheapest insertion first) is the only order. Nearest First and Farthest First were presentation-only. Those modes made sense only for a whole route at once. The platform never plans a whole route. Confirmed Bookings are never moved.

**The safety margin on a drive is the Minimum Gap.** Required free time between two jobs is drive plus Minimum Gap, plus the Buffers already inside the Blocked Range. The separate "Extra minutes per journey" setting is removed. One cushion cannot be charged twice.

## Consequences

The optimistic haversine bound (`couldReachWithin` false) is a proof. It may refuse a drive over the ceiling without a lookup.
A routing estimate (`estimated: true`) or the pessimistic floor may not refuse. Those stay `undecided` (a Request). An estimate may refuse nothing (ADR-0015).
