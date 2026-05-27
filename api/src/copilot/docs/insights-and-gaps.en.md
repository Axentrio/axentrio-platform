---
slug: insights-and-gaps
title: Understanding Insights and Gaps
locale: en
tags:
  - insights
  - gaps
  - success-meter
---

# Insights and Gaps

The *Success Meter* sidebar surface (the route is `/insights`) shows **Gaps** — topics your customers ask about that your bot couldn't satisfy.

**What's a Gap?** When the same topic comes up across 3+ unique visitors in the last 7 days and the bot's answers don't satisfy them, that topic surfaces as a Gap.

**Why care about Gaps?** Each Gap is a chance to either:
- Upload a knowledge document that answers it (the most common fix)
- Adjust your bot's custom instructions

After a fix, the next nightly refresh checks whether the Gap is resolved. If yes, it drops off the list automatically.

**Severity:**
- **Red** — frequent + recent (high priority)
- **Orange** — moderate
- **Green** — closed (satisfied recently, kept visible briefly so you can see your work paid off)

**How Gaps are detected:** an LLM judge reads each chat session at night, decides whether the visitor's question was satisfied, and aggregates patterns. Details in *Help & FAQ → Insights*.

**Tier:** Insights is included on every paid tier.
