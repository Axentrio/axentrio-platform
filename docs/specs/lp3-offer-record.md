# LP3 offer record - the build contract (#80)

> Revision 5, APPROVED after five independent review rounds. #85 parked LP3 because earlier rounds
> "kept finding gaps in the offer record"; this is that pass. Each round found real defects and
> round 4 found one that resized the ticket, so the history is worth keeping rather than
> flattening into a clean-looking spec that hides how it got here.
>
> Companion to [`location-aware-planning.md`](./location-aware-planning.md), whose "offer record"
> section this SUPERSEDES.

Four rounds, each finding real defects. Round 4's second point is decisive and changes what this
ticket IS, so it is stated first.

## The finding that resizes the ticket

**The delivered payload cannot support attribution, and the two requirements collide.**

Round 3 established that the record must store what the CUSTOMER received, because
`channels/types.ts` truncates quick replies by `capabilities.maxQuickReplies` and drops them where
the channel does not support them - so recording the agent's set would record slots nobody saw.

Round 4 establishes that the delivered payload is useless for matching. `buildSlotQuickReplies`
(`agent.service.ts:102`) emits:

```
{ title: "Wed 2:00 PM",
  value: "Book Boiler repair on Wednesday 3 September at 2:00 PM (Europe/Brussels)" }
```

Natural-language strings. The canonical ISO instant exists one line earlier as `s.start` and is
thrown away. So "the slots the customer saw" and "the slots I can match a Booking against" are
currently two different things, and neither one alone satisfies #80.

**So LP3 is not one table and a write.** It is a context-threading change: a structured
offered-slot shape carrying the canonical instant ALONGSIDE the presented text, passed from the
agent turn, through message persistence, to dispatch - where the channel's own cap is applied to
the structured list rather than only to the strings. `routeOutboundMessage` also currently
receives no `availability_call_id`, no resolved `service_id` and no `location_mode`; all three
have to travel with it or be inferred afterwards, and inference would produce a materially
different implementation.

This is the honest size of the work, and it was not visible from the ticket.

## The shape, simplified per round 4

Round 4's simpler alternative is adopted: **`delivery_key`, `supersedes_offer_id` and
`matching_offer_count` are dropped from LP3.** Supersession is derivable from `(session_id,
service_id, created_at)` at query time, which is where round 2 put every other cohort, and a
stored link is only worth its complexity once something reads it. Attribution ambiguity is
observable the same way.

**1. `chatbot_availability_calls`** - one row per `check_availability` call, surfaced or not.
`(id, tenant_id, bot_id, session_id, service_id nullable, requested_start_date date nullable,
requested_end_date date nullable, requested_range_raw text, range_valid boolean, slot_count,
created_at)`.

Raw text is kept beside the parsed dates so a malformed range is recordable rather than
unrepresentable - round 4's fourth point. A call with an unresolved service is still recorded with
a null `service_id`: it is a customer asking, which is what the range metric counts.

**2. `chatbot_booking_offers`** - one row per outbound message that carried slots.
`(id, tenant_id, bot_id, session_id, service_id, availability_call_id, location_mode, channel,
offered_slots jsonb, offered_count, delivery_basis, created_at)`

`offered_slots` is an ordered array of `{ start: ISO instant, title: string }` - canonical AND
presented - truncated to exactly what the channel sent. `delivery_basis` is a static enum
captured at write time: `provider_accepted` | `provider_rejected` | `widget_assumed`. No link to
`MessageDelivery`, whose rows are deleted at 7 days. CHECK: `offered_count =
jsonb_array_length(offered_slots)`.

**An offer is mechanically rendered slots only.** Prose that mentions times is explicitly outside
this baseline - round 4's third question - because "slots the model mentioned, in order" cannot be
recovered from free text, which is #80's own reasoning.

**3. `chatbot_offer_selections`** - `(id, offer_id, selection_entity_id, selection_type,
selected_ordinal, created_at)`, **unique on `selection_entity_id`**.

## Attribution, stated so two engineers build the same thing

Round 4's first point, closed:

> The attributed offer is the **latest** `chatbot_booking_offers` row where `session_id` matches,
> `service_id` matches, `delivery_basis` is `provider_accepted` or `widget_assumed` (never
> `provider_rejected`), `created_at` is strictly before the Booking's `created_at`, and
> `offered_slots` contains an entry whose `start` equals the Booking's `start_utc` **exactly**.
> Ties break by `id` descending. No match means no selection row - unattributed, not guessed.

`selected_ordinal` is that entry's 1-based index in `offered_slots`.

`selection_type` is a snapshot of the Booking's status at selection time (`request` when
`request_created`, otherwise `booking`) and is never re-derived, or every accepted Request would
migrate from expressed-choice into conversion and the baseline would improve on its own.

## Canonical metrics

```
first_offer_acceptance = selections with selected_ordinal = 1 AND selection_type = 'booking'
                       / selections with selection_type = 'booking'

offer_conversion       = offers with any selection (booking OR request)
                       / offers where delivery_basis IN ('provider_accepted','widget_assumed')

multi_day_share        = availability calls where requested_end_date > requested_start_date
                       / availability calls where range_valid
```

Delivered excludes `provider_rejected` and includes `widget_assumed`, because excluding the latter
would silently omit most of the traffic. Later cancellations never revisit a selection.

Retention 400 days, purged daily on `created_at`, no positional data, no ADR-0014 interaction.

## Ask

Round 5, the last. Buildable as written, or not?
