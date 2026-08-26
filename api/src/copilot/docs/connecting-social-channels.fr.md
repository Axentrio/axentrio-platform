---
slug: connecting-social-channels
title: Connecter Facebook, Instagram, WhatsApp et Telegram
locale: fr
tags:
  - integrations
  - social
  - channels
  - facebook
  - instagram
  - whatsapp
  - telegram
---

# Connecter les réseaux sociaux

Votre bot peut répondre aux messages privés sur Facebook, Instagram, WhatsApp Business et Telegram — chaque message envoyé à votre profil social est traité par le même bot, avec les mêmes connaissances.

Ouvrez *Paramètres → Canaux* pour voir tous les canaux.

**Facebook et Instagram :** cliquez sur **Facebook**. Une fenêtre s’ouvre pour Facebook Login for Business (vous restez sur cette page). Autorisez la page Meta. Le bot prend alors en charge les messages Messenger. Il n'existe pas de connexion Instagram séparée. Si la page sélectionnée a un compte Instagram professionnel (business/créateur) lié et que *DM Instagram* est activé sous *Paramètres → Fonctionnalités*, Instagram se connecte automatiquement en même temps que Facebook. Sans ce lien côté Meta, seul Facebook est connecté.

Liez d'abord Instagram côté Meta : le compte doit être Professionnel et relié à une page Facebook dont vous êtes admin (réglages de l'app Instagram / réglages de la page → Comptes liés, ou Meta Business Suite). Instagram ne gère que les messages privés — pas de publications du fil, de stories ni de commentaires — et nécessite Essential ou plus. Déconnecter la page Facebook déconnecte aussi Instagram.

**WhatsApp :** cliquez sur **WhatsApp**. Une fenêtre demande le Phone Number ID et le jeton d'accès de votre numéro WhatsApp Cloud API (depuis Meta Business). Vous pouvez aussi indiquer l'ID du compte WhatsApp Business.

**Telegram :** il n'y a pas de bouton de connexion Telegram sur la page des canaux. Les connexions Telegram existantes apparaissent toujours dans la liste.

**Activer ou désactiver un canal :** chaque canal — Facebook Messenger, DM Instagram, WhatsApp et Telegram — s'active ou se désactive sous *Paramètres → Fonctionnalités*. Désactiver une fonctionnalité conserve la ligne de connexion mais arrête les réponses. Le bouton poubelle sur une connexion la supprime entièrement.
