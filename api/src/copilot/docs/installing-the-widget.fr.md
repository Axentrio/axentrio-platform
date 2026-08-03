---
slug: installing-the-widget
title: Installer le widget de chat sur votre site
locale: fr
tags:
  - widget
  - install
  - embed
---

# Installer le widget de chat

Le widget est un petit script JavaScript que vous collez une seule fois dans le HTML de votre site. Il se charge de façon asynchrone et ajoute une bulle de chat en bas à droite de chaque page.

**Récupérer l'extrait :** *Bot IA & Contenu → Embed*. Copiez le bloc `<script>`.

**L'installer :** collez l'extrait juste avant `</body>` dans le modèle HTML de votre site. Sur WordPress c'est `footer.php`, sur Shopify `theme.liquid`, sur Webflow *Settings → Custom Code → Footer Code*.

**Vérifier que ça marche :** ouvrez n'importe quelle page de votre site et cherchez la bulle de chat. Cliquez dessus — le widget s'ouvre et affiche le message d'accueil de votre bot.

**Problèmes fréquents :**
- *Aucune bulle n'apparaît :* vérifiez que l'extrait se trouve avant `</body>` et qu'un bloqueur de publicité ne l'empêche pas de se charger.
- *Le mauvais bot répond :* l'extrait est propre à votre compte — assurez-vous d'avoir copié le vôtre et non l'exemple d'un collègue.
