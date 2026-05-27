---
slug: connecting-calcom
title: Connecting Cal.com for bookings
locale: en
tags:
  - integrations
  - calcom
  - bookings
  - pro
---

# Connecting Cal.com

Cal.com integration lets your bot book meetings directly into your calendar — no copy-pasting links, no follow-up emails.

**Tier:** requires Pro or Enterprise. On Essential, the *Bookings* sidebar item shows a Pro lock.

**Setup:**
1. Open *Bookings → Integrations* in the sidebar.
2. Click **Connect Cal.com**. You'll be redirected to Cal.com to authorize Axentrio.
3. After authorization, pick which event type the bot should offer (e.g. "30-minute consultation").
4. The bot now offers slots and books meetings during conversations.

**How the bot uses it:** when a visitor asks about availability or wants a meeting, the bot calls Cal.com's free-busy API for live slots and creates the booking when the visitor confirms.

**Disconnecting:** *Bookings → Integrations → Disconnect*. Existing bookings stay in Cal.com; the bot just stops offering new slots.
