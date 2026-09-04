# The calendar mirror follows the booking row

Google Calendar and Outlook events created by Axentrio are a **mirror** of the booking row, not a second editable document.

`syncCalendarMirror` now patches `summary` and `description` on every confirmed or pending update, not only on reschedule. When a customer adds notes, a phone number, or file names after booking, the owner's connected calendar sees the same body the platform stores — within about a minute, without a manual refresh.

That deliberately overwrites an owner's hand-edited calendar description. A body that never changes was how post-booking notes and photos stayed invisible in report 6; keeping the mirror frozen would preserve a stale description forever.

Inbound calendar sync remains **times-only** on restore. External edits to start/end are reconciled; Axentrio does not push a body back through that path.

## Consequences

Owners who typed their own description in Google Calendar will see it replaced on the next Axentrio update.
The trade is recorded here so a future "skip when externally edited" mode would need a new column, not a silent behaviour change.
Email lines (`Customer:`, `Email:`, named files) and mirror content share `buildBookingEventContent`, so the split email line and named attachments stay aligned.
