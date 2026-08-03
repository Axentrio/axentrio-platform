---
slug: why-bot-not-replying
title: Waarom antwoordt mijn bot niet?
locale: nl
tags:
  - troubleshooting
  - bot
  - widget
---

# Waarom antwoordt mijn bot niet

De vier meest voorkomende oorzaken:

1. **Het codefragment staat er niet goed in.** Open je site, bekijk de broncode en zoek op `axentrio` — vind je niets, dan laadt het fragment niet. Plak het opnieuw vlak voor `</body>`.

2. **De bot staat op pauze.** Ga naar *AI-bot & inhoud → Status* — staat de schakelaar uit, dan zwijgt de bot. Zet hem weer aan.

3. **De daglimiet is bereikt.** Op de lagere abonnementen geldt een maximum aantal berichten per dag. *Instellingen → Verbruik* toont de stand van vandaag. Is de limiet bereikt, dan geeft de bot een terugvalbericht tot middernacht (UTC).

4. **Geen kennis geüpload in combinatie met strenge instructies.** Heeft de bot geen enkel kennisdocument en staat er in je instructies iets als "Antwoord uitsluitend op basis van de geüploade documenten", dan weigert hij de meeste vragen. Upload kennis of maak die instructie soepeler.

**Werkt het nog altijd niet?** Open je widget zelf in een incognitovenster en typ "hallo" — komt daar geen antwoord op, neem dan contact op met support@axentrio.com met je bedrijfsnaam en een schermafbeelding van de pagina *AI-bot & inhoud*.
