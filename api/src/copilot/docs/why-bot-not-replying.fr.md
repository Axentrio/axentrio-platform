---
slug: why-bot-not-replying
title: Pourquoi mon bot ne répond-il pas ?
locale: fr
tags:
  - troubleshooting
  - bot
  - widget
---

# Pourquoi mon bot ne répond pas

Les quatre causes les plus fréquentes :

1. **L'extrait de code est mal installé.** Ouvrez votre site, affichez le code source et cherchez `axentrio` — si rien ne ressort, l'extrait ne se charge pas. Recollez-le juste avant `</body>`.

2. **Le bot est en pause.** Ouvrez *Bot IA & Contenu → Statut* — si l'interrupteur est éteint, le bot se tait. Réactivez-le.

3. **La limite quotidienne est atteinte.** Les formules d'entrée de gamme ont un plafond de messages par jour. *Paramètres → Utilisation* affiche le compteur du jour. Une fois la limite atteinte, le bot renvoie un message de repli jusqu'à minuit (UTC).

4. **Aucune connaissance téléversée et des instructions trop strictes.** Si le bot n'a aucun document et que vos instructions disent par exemple « Répondez uniquement à partir des documents téléversés », il refusera la plupart des questions. Téléversez des connaissances ou assouplissez l'instruction.

**Toujours rien ?** Ouvrez vous-même le widget dans une fenêtre privée et tapez « bonjour » — si même cela reste sans réponse, écrivez à support@axentrio.com avec le nom de votre entreprise et une capture d'écran de la page *Bot IA & Contenu*.
