---
slug: installing-the-widget
title: De chatwidget op je website installeren
locale: nl
tags:
  - widget
  - install
  - embed
---

# De chatwidget installeren

De widget is een klein stukje JavaScript dat je één keer in de HTML van je website plakt. Het laadt asynchroon en zet een chatbel rechtsonder op elke pagina.

**Codefragment ophalen:** *AI-bot & inhoud → Embed*. Kopieer het `<script>`-blok.

**Installeren:** plak het fragment vlak voor `</body>` in het HTML-sjabloon van je site. Bij WordPress is dat `footer.php`, bij Shopify `theme.liquid`, bij Webflow *Settings → Custom Code → Footer Code*.

**Controleren of het werkt:** open eender welke pagina van je site en kijk of de chatbel er staat. Klik erop — de widget opent en toont het welkomstbericht van je bot.

**Veelvoorkomende problemen:**
- *Geen bel te zien:* controleer of het fragment vóór `</body>` staat en niet geblokkeerd wordt door een adblocker.
- *De verkeerde bot antwoordt:* het fragment is klantspecifiek — zorg dat je het jouwe hebt gekopieerd en niet het voorbeeld van een collega.
