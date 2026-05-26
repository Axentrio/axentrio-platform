---
slug: why-bot-not-replying
title: Why isn't my bot replying?
locale: en
tags:
  - troubleshooting
  - bot
  - widget
---

# Why isn't my bot replying

The four most common reasons:

1. **Widget snippet not installed correctly.** Open your site, view source, search for `axentrio` — if nothing matches, the snippet isn't loading. Re-paste it before `</body>`.

2. **Bot is paused.** *AI Bot & Content → Status* — if the toggle is off, the bot is silent. Turn it back on.

3. **Daily LLM cap hit.** Free / Essential tiers have a daily message cap. *Settings → Usage* shows today's count. If you've hit the cap, the bot replies with a fallback message until midnight UTC.

4. **No knowledge uploaded + restrictive instructions.** If the bot has no knowledge documents and your custom instructions are very strict ("Only answer from uploaded documents"), the bot may decline most questions. Either upload knowledge or relax the instruction.

**Still not working?** Open the widget yourself in an incognito tab, ask "hello" — if even that gets no reply, contact support@axentrio.com with your tenant name and a screenshot of the *AI Bot & Content* page.
