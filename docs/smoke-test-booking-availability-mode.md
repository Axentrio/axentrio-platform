# Smoke test — booking availability mode + out-of-hours fallback

Covers commit `bd1bd95` (feat(booking): always-open mode + no-dead-end out-of-hours fallback).

**What changed (the 3 behaviors to prove):**
1. `availabilityMode` = `always_open` → bot offers slots 24/7 (only calendar busy / notice / buffers limit them).
2. Empty availability or an out-of-hours request → bot captures a **request** (`request_appointment`), never dead-ends with "no times / contact the team".
3. The bot answers "when are you open?" from the configured hours (an `## OPENING HOURS` prompt block), not the KB.

**Origin bug:** ClickUp `86ca8m5x9` — Dutch loodgieter bot said *"ik kan de beschikbare tijden niet vinden… laat me je verbinden met ons team"* because `weeklyHours` was empty → zero slots.

---

## 0. Pre-checks (prod)

- [ ] Prod API up: `curl -s -o /dev/null -w "%{http_code}" https://api.axentrio.com/health` → `200`.
- [ ] Migration applied (column exists). Either: API booted clean (migrations run on boot, so 200 ⇒ applied), **or** confirm directly:
      `SELECT availability_mode FROM chatbot_availability_rules LIMIT 1;` → column resolves, existing rows = `business_hours`.

---

## 1. Portal UI (app.axentrio.com → Settings → Appointment Booking)

- [ ] **Availability** section shows two cards: **Set business hours** / **Always open (24/7)**.
- [ ] Default for an existing bot = **Set business hours** (weekly grid visible).
- [ ] Select **Always open (24/7)** → weekly-hours grid is replaced by the "Open 24/7…" note; **Save** is NOT blocked by weekly-hours validation.
- [ ] Save → reload the page → the selected mode persists (hydrates from `GET /scheduler`).
- [ ] Switch back to **Set business hours** → weekly grid returns with previously saved hours; Save persists.
- [ ] Date overrides (holiday "Closed") still editable in **both** modes.

> Tip: the live app is shadow-DOM React — use real DOM clicks via the `axentrio-live-debug` method (CDP browser), not synthetic clicks.

---

## 2. Always-open mode — 24/7 slots

Use a test bot/tenant (NOT a live customer page). Drive the agent via the widget REST flow
(`init` → `message` → `history`), per the **booking live-test method** — test-chat is unreliable for this.

- [ ] Set the bot to **Always open**, ensure ≥1 active **auto-book** service, save.
- [ ] Portal **Preview → next 7 days** shows slots on every day (incl. weekend / late-night), not just business days.
- [ ] In chat: "I'd like to book \<service\>" → bot offers tappable slots that include times **outside** 9–5 and on weekends.
- [ ] Pick an evening/weekend slot → `create_booking` confirms it; booking appears in **portal → Bookings** and on **Google Calendar** (if connected).
- [ ] Add a date override "Closed" for tomorrow → tomorrow shows **no** slots (closure still wins in always-open).

---

## 3. Out-of-hours / empty availability — NO dead-end (the original bug)

This is the regression guard for the ClickUp ticket.

- [ ] **Empty-hours bot:** business-hours mode with NO weekday enabled (reproduces the bug state).
      In chat ask to book → bot must **NOT** say "no available times / I'll connect you with the team".
      It must instead offer to **capture a request** and call `request_appointment` (preferred time taken in the
      customer's words). Verify a row lands in **portal → Bookings → Requests**.
- [ ] **Out-of-hours request:** business-hours bot (e.g. Mon–Fri 9–17). Ask for a **Sunday / 22:00** appointment →
      bot does not refuse; it captures it as a request (tells the customer the business will confirm). Request row appears.
- [ ] Repeat the original scenario in **Dutch** ("ik wil een afspraak maken … vanavond/dit weekend") → no
      "geen beschikbare tijden / verbinden met ons team" dead-end; a request is captured.
- [ ] **Request-only service** unchanged: still no slots offered, asks for preferred time, captures request (no regression).

---

## 4. Opening-hours question

- [ ] **Always open:** ask "When are you open?" → bot answers ~"around the clock / 24/7" (no KB needed).
- [ ] **Business hours** (some days set): ask "What are your opening hours?" → bot states the configured days/times
      in the bot's timezone; days not listed are described as closed.
- [ ] **Business hours, none set:** no false hours asserted — bot falls back to KB / honest "not sure", and still
      offers to capture a request if they want to book.

---

## 5. Regression / unaffected paths

- [ ] Existing **business-hours** bot with real weekly hours: slot offering + auto-booking unchanged.
- [ ] Reschedule / cancel an existing booking still works.
- [ ] **Analytics:** an always-open bot reports **no "after-hours" sessions** (24/7 ⇒ never after hours);
      a business-hours bot still classifies after-hours sessions as before.
- [ ] Business-type **presets** still apply (they don't set `availabilityMode` → DB default `business_hours`).

---

## Pass criteria

All boxes checked. The single hard gate for the reported bug: **§3 — the bot never dead-ends with
"no available times / contact the team"; it always either offers slots or captures a request.**
