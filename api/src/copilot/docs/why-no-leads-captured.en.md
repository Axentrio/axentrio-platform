---
slug: why-no-leads-captured
title: Why aren't leads being captured?
locale: en
tags:
  - troubleshooting
  - leads
  - capture
---

# Why aren't leads being captured

If people are chatting with your bot but the *Leads* inbox stays empty, check these in order:

1. **Lead Capture is enabled.** *Lead Capture* in the sidebar — the master toggle must be on. If off, the bot never asks for contact info.

2. **The bot's instructions tell it to ask.** Open *AI Bot & Content → Custom Instructions* — make sure there's a line like "When a visitor seems interested, ask for their name and email so we can follow up." Without an explicit ask, the bot only captures leads if the visitor volunteers contact info.

3. **Visitors are actually giving contact info.** Open *Chats* and read a few recent conversations — are visitors providing emails? If they're asking questions and leaving without giving anything, you may need a more proactive bot instruction or a stronger CTA on your site.

4. **The lead isn't a duplicate.** If a returning visitor with an already-captured email chats again, no new Lead row is created — the existing one is updated instead.

If Leads is on, instructions say to ask, and visitors are giving emails but nothing appears, contact support — there may be a delivery issue between the bot and the Leads table.
