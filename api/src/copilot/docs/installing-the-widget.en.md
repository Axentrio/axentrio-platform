---
slug: installing-the-widget
title: Installing the chat widget on your website
locale: en
tags:
  - widget
  - install
  - embed
---

# Installing the chat widget

The widget is a small JavaScript snippet you paste once into your website's HTML. It loads asynchronously and adds a chat bubble to the bottom-right of every page.

**Get the snippet:** *AI Bot & Content → Embed*. Copy the `<script>` block.

**Install it:** paste the snippet immediately before `</body>` in your site's HTML template. On WordPress this is `footer.php`; on Shopify it's the theme `theme.liquid`; on Webflow it's *Settings → Custom Code → Footer Code*.

**Verify it's working:** load any page of your site, look for the chat bubble. Click it — the widget opens and shows your bot's welcome message.

**Common issues:**
- *No bubble appears:* check the snippet is before `</body>` and not blocked by an ad-blocker.
- *Wrong bot replies:* the snippet is tenant-specific — make sure you copied yours, not a teammate's example.
