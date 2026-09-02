# Smoke test — calendar mirror, inbox live tail, and language split

Manual checklist for the seven booking/inbox/email fixes. Run against **app.axentrio.com** with a connected test calendar and a WhatsApp or widget test channel.

Use real DOM clicks (Clerk session + `api.axentrio.com`), not synthetic API-only checks.

---

## 0. Pre-checks

- [ ] Prod API: `curl -s -o /dev/null -w "%{http_code}" https://api.axentrio.com/health` → `200`
- [ ] Migration `1794900000000-AddBookingConfirmationEmailExtras` applied (`confirmation_extra_info`, `confirmation_attachments` on `chatbot_booking_settings`)

Local unit + smoke (from repo root):

```bash
cd api && npx tsc --noEmit
cd api && npm run smoke:day-part
cd api && npm run smoke:confirmation-extras   # needs .env.local + test tenant
cd portal && npx vitest run src/queries/conversationLive.test.ts
```

---

## 1. Report 1 — Day-part ("namiddag")

- [ ] From WhatsApp, ask for a weekday **"ergens in de namiddag"** on a 60-minute customer-location service
- [ ] Provide the address when asked
- [ ] Every offered chip is **12:00 or later** (local)
- [ ] When the afternoon is genuinely full, the bot says so and offers **no** morning chips

---

## 2. Report 2 — Inbox live thread

- [ ] Open the conversation in **Inbox** (thread pane visible)
- [ ] Send one more customer message
- [ ] Bot reply appears in the **open pane** without refresh or reselect (within ~5 s if socket is deaf)

---

## 3. Report 5 — Dutch preparation heading

- [ ] In a Dutch conversation, complete a booking with a service that has preparation instructions
- [ ] Preparation message uses a **Dutch** heading (not "Before your appointment:")

---

## 4. Reports 4 & 6 — Calendar body

- [ ] Open the created event in **Google Calendar**
- [ ] Confirm a separate **`Email:`** line (not folded into Customer)
- [ ] Ask the bot to add a **note**, **phone number**, and **photo**
- [ ] Same event body updates with note, phone, and file name within ~1 minute

---

## 5. Report 3 — Confirmation email extras

- [ ] **Bookings → Setup**: set information text + one PDF attachment
- [ ] Book once with a customer email
- [ ] Customer confirmation email contains the text (unchanged) and both `invite.ics` and the PDF

---

## 6. Report 7 — Customer vs business language

- [ ] Set **Business language** to English in notification settings
- [ ] Hold the conversation in Dutch; book with a Dutch note
- [ ] Customer email stays Dutch
- [ ] Owner email shows English translation of the note with Dutch original underneath

---

## Cleanup

Delete every smoke booking and restore test settings when finished.
