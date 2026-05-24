/**
 * Initial seed for the Help FAQ. Snapshot of the previous static help.faq.*
 * locale-JSON content, frozen at the point we cut over to a DB-backed,
 * super-admin-editable FAQ. After this migration runs once, the source of
 * truth lives in the database; this file is not re-applied.
 */

export interface FaqSeedTranslation {
  en: string;
  nl?: string;
  fr?: string;
}

export interface FaqSeedItem {
  slug: string;
  position: number;
  question: FaqSeedTranslation;
  answer: FaqSeedTranslation;
}

export interface FaqSeedSection {
  id: string;
  position: number;
  isReserved: boolean;
  titles: FaqSeedTranslation;
  items: FaqSeedItem[];
}

export const INITIAL_FAQ_SEED: readonly FaqSeedSection[] = [
  {
    "id": "getting-started",
    "position": 0,
    "isReserved": false,
    "titles": {
      "en": "Getting Started",
      "nl": "Aan de slag",
      "fr": "Premiers pas"
    },
    "items": [
      {
        "slug": "what-is-handsoff",
        "position": 0,
        "question": {
          "en": "What is HandsOff?",
          "nl": "Wat is HandsOff?",
          "fr": "Qu'est-ce que HandsOff ?"
        },
        "answer": {
          "en": "HandsOff is an AI-powered automation platform that helps businesses automate customer conversations across multiple channels. It combines an intelligent AI chatbot, live agent handoff, analytics, and team management tools into one unified dashboard.",
          "nl": "HandsOff is een AI-gedreven automatiseringsplatform dat bedrijven helpt klantgesprekken over meerdere kanalen te automatiseren. Het combineert een intelligente AI-chatbot, overdracht naar live agents, analyses en team-managementtools in één centraal dashboard.",
          "fr": "HandsOff est une plateforme d'automatisation propulsée par l'IA qui aide les entreprises à automatiser les conversations clients sur plusieurs canaux. Elle combine un chatbot IA intelligent, le transfert vers un agent humain, des analyses et des outils de gestion d'équipe au sein d'un dashboard unifié."
        }
      },
      {
        "slug": "how-to-get-started",
        "position": 1,
        "question": {
          "en": "How do I get started with HandsOff?",
          "nl": "Hoe ga ik aan de slag met HandsOff?",
          "fr": "Comment démarrer avec HandsOff ?"
        },
        "answer": {
          "en": "After signing up, follow the setup checklist in your Analytics dashboard: (1) Enable your AI Assistant, (2) Configure your brand voice and bot identity, (3) Upload knowledge base documents, (4) Connect your booking calendar (optional), and (5) Set up automations. Each step has a direct link to the relevant settings page.",
          "nl": "Na het aanmaken van een account doorloop je de installatiechecklist in je Analytics-dashboard: (1) Activeer je AI-assistent, (2) Configureer je merkstem en botidentiteit, (3) Upload kennisbankdocumenten, (4) Koppel je boekingsagenda (optioneel) en (5) Stel automatiseringen in. Elke stap bevat een rechtstreekse link naar de bijhorende instellingenpagina.",
          "fr": "Après votre inscription, suivez la checklist de configuration dans votre dashboard Analyses : (1) Activez votre Assistant IA, (2) Configurez la voix de votre marque et l'identité du bot, (3) Téléversez les documents de votre base de connaissances, (4) Connectez votre calendrier de réservation (optionnel) et (5) Configurez les automatisations. Chaque étape contient un lien direct vers la page de paramètres correspondante."
        }
      },
      {
        "slug": "what-channels",
        "position": 2,
        "question": {
          "en": "What channels can I connect to HandsOff?",
          "nl": "Welke kanalen kan ik aan HandsOff koppelen?",
          "fr": "Quels canaux puis-je connecter à HandsOff ?"
        },
        "answer": {
          "en": "HandsOff currently supports website chat widgets, Telegram bots, and Facebook Pages. You can manage all conversations from these channels in a single unified Inbox. Additional channels are added regularly.",
          "nl": "HandsOff ondersteunt momenteel chatwidgets voor websites, Telegram-bots en Facebook-pagina's. Je kan alle gesprekken vanuit deze kanalen beheren in één centrale Inbox. Er worden regelmatig nieuwe kanalen toegevoegd.",
          "fr": "HandsOff prend actuellement en charge les widgets de chat pour sites web, les bots Telegram et les pages Facebook. Vous pouvez gérer toutes les conversations issues de ces canaux dans une Boîte de réception unifiée. De nouveaux canaux sont ajoutés régulièrement."
        }
      },
      {
        "slug": "need-coding",
        "position": 3,
        "question": {
          "en": "Do I need coding skills to use HandsOff?",
          "nl": "Heb ik programmeerkennis nodig om HandsOff te gebruiken?",
          "fr": "Faut-il des compétences en programmation pour utiliser HandsOff ?"
        },
        "answer": {
          "en": "No. HandsOff is designed to be fully no-code. You can configure your AI bot, customize appearances, connect channels, and manage conversations entirely through the user-friendly dashboard. The only technical step is copying a small embed snippet to add the chat widget to your website.",
          "nl": "Nee. HandsOff is volledig no-code opgezet. Je kan je AI-bot configureren, het uiterlijk aanpassen, kanalen koppelen en gesprekken beheren via het gebruiksvriendelijke dashboard. De enige technische stap is het kopiëren van een kleine embed-snippet om de chatwidget op je website te plaatsen.",
          "fr": "Non. HandsOff est conçu pour être entièrement no-code. Vous pouvez configurer votre bot IA, personnaliser son apparence, connecter des canaux et gérer les conversations entièrement depuis un dashboard convivial. La seule étape technique consiste à copier un petit extrait d'intégration pour ajouter le widget de chat à votre site web."
        }
      },
      {
        "slug": "free-trial",
        "position": 4,
        "question": {
          "en": "Is there a free trial available?",
          "nl": "Is er een gratis proefperiode beschikbaar?",
          "fr": "Existe-t-il une période d'essai gratuite ?"
        },
        "answer": {
          "en": "Yes, HandsOff offers a free trial period so you can explore all features before committing. During the trial, you have full access to AI bot configuration, knowledge base uploads, channel connections, and analytics.",
          "nl": "Ja, HandsOff biedt een gratis proefperiode waarin je alle functies kan uitproberen voor je een keuze maakt. Tijdens de proefperiode heb je volledige toegang tot AI-botconfiguratie, kennisbank-uploads, kanaalkoppelingen en analyses.",
          "fr": "Oui, HandsOff propose une période d'essai gratuite afin que vous puissiez explorer toutes les fonctionnalités avant de vous engager. Pendant l'essai, vous bénéficiez d'un accès complet à la configuration du bot IA, au téléversement de la base de connaissances, à la connexion des canaux et aux analyses."
        }
      }
    ]
  },
  {
    "id": "ai-bot",
    "position": 1,
    "isReserved": true,
    "titles": {
      "en": "AI Bot Configuration",
      "nl": "AI-botconfiguratie",
      "fr": "Configuration du bot IA"
    },
    "items": [
      {
        "slug": "configure-identity",
        "position": 0,
        "question": {
          "en": "How do I configure my AI bot's identity?",
          "nl": "Hoe configureer ik de identiteit van mijn AI-bot?",
          "fr": "Comment configurer l'identité de mon bot IA ?"
        },
        "answer": {
          "en": "Navigate to AI & Content > AI Bot. Here you can set your Chatbot Name (the display name visitors see), Support Email (used for escalations), Voice Tone (Friendly, Professional, Casual, Formal, or Custom), and detailed Bot Instructions that guide how your AI responds to visitors.",
          "nl": "Ga naar AI & Content > AI-bot. Hier stel je de Chatbot-naam in (de weergavenaam die bezoekers zien), het Support-e-mailadres (gebruikt voor escalaties), de Spraaktoon (Vriendelijk, Professioneel, Casual, Formeel of Aangepast) en de gedetailleerde Botinstructies die bepalen hoe je AI antwoordt aan bezoekers.",
          "fr": "Rendez-vous dans IA et Contenu > Bot IA. Vous pourrez y définir le Nom du chatbot (le nom affiché aux visiteurs), l'E-mail de support (utilisé pour les escalades), le Ton de voix (Amical, Professionnel, Décontracté, Formel ou Personnalisé), ainsi que des Instructions du bot détaillées qui guident la manière dont votre IA répond aux visiteurs."
        }
      },
      {
        "slug": "bot-instructions",
        "position": 1,
        "question": {
          "en": "What are Bot Instructions and how do I use them?",
          "nl": "Wat zijn Botinstructies en hoe gebruik ik ze?",
          "fr": "Que sont les Instructions du bot et comment les utiliser ?"
        },
        "answer": {
          "en": "Bot Instructions are system prompts that tell your AI how to behave. You can start from a template (Blank or FAQ-based) or write your own custom instructions. Use placeholders like {botName}, {tone}, {supportEmail}, {businessName}, {fallbackMessage}, {offHoursMessage}, {maxResponseLength}, and {topicsToAvoid} to make instructions dynamic.",
          "nl": "Botinstructies zijn systeemprompts die je AI vertellen hoe hij zich moet gedragen. Je kan starten vanaf een sjabloon (Blanco of FAQ-gebaseerd) of je eigen aangepaste instructies schrijven. Gebruik placeholders zoals {botName}, {tone}, {supportEmail}, {businessName}, {fallbackMessage}, {offHoursMessage}, {maxResponseLength} en {topicsToAvoid} om instructies dynamisch te maken.",
          "fr": "Les Instructions du bot sont des prompts système qui indiquent à votre IA comment se comporter. Vous pouvez partir d'un modèle (Vierge ou basé sur la FAQ) ou rédiger vos propres instructions personnalisées. Utilisez des espaces réservés tels que {botName}, {tone}, {supportEmail}, {businessName}, {fallbackMessage}, {offHoursMessage}, {maxResponseLength} et {topicsToAvoid} pour rendre vos instructions dynamiques."
        }
      },
      {
        "slug": "change-tone",
        "position": 2,
        "question": {
          "en": "How do I change my bot's tone of voice?",
          "nl": "Hoe wijzig ik de spraaktoon van mijn bot?",
          "fr": "Comment changer le ton de voix de mon bot ?"
        },
        "answer": {
          "en": "In the AI Bot settings, select one of the five Voice Tone options: Friendly (warm and approachable), Professional (polite and business-focused), Casual (relaxed and conversational), Formal (strict and corporate), or Custom (define your own style in the Bot Instructions).",
          "nl": "Kies in de instellingen van de AI-bot een van de vijf opties voor Spraaktoon: Vriendelijk (warm en toegankelijk), Professioneel (beleefd en zakelijk gericht), Casual (ontspannen en conversationeel), Formeel (strikt en corporate) of Aangepast (definieer je eigen stijl in de Botinstructies).",
          "fr": "Dans les paramètres du Bot IA, sélectionnez l'une des cinq options de Ton de voix : Amical (chaleureux et accessible), Professionnel (courtois et orienté business), Décontracté (détendu et conversationnel), Formel (strict et corporatif) ou Personnalisé (définissez votre propre style dans les Instructions du bot)."
        }
      },
      {
        "slug": "disable-temporarily",
        "position": 3,
        "question": {
          "en": "Can I temporarily disable the AI bot?",
          "nl": "Kan ik de AI-bot tijdelijk uitschakelen?",
          "fr": "Puis-je désactiver temporairement le bot IA ?"
        },
        "answer": {
          "en": "Yes. The AI Bot section has a toggle switch labeled \"Enable AI-powered responses for visitors.\" Turning this off will disable automated responses while keeping your configuration intact for when you want to re-enable it.",
          "nl": "Ja. De AI-bot-sectie bevat een schakelaar met het label \"AI-antwoorden voor bezoekers inschakelen\". Door deze uit te zetten worden geautomatiseerde antwoorden uitgeschakeld, terwijl je configuratie bewaard blijft voor wanneer je ze opnieuw wil inschakelen.",
          "fr": "Oui. La section Bot IA comporte un interrupteur intitulé « Activer les réponses propulsées par l'IA pour les visiteurs ». Le désactiver coupera les réponses automatisées tout en conservant votre configuration intacte pour quand vous souhaiterez le réactiver."
        }
      },
      {
        "slug": "greeting-message",
        "position": 4,
        "question": {
          "en": "What is the Greeting Message and how do I change it?",
          "nl": "Wat is het Begroetingsbericht en hoe pas ik het aan?",
          "fr": "Qu'est-ce que le Message d'accueil et comment le modifier ?"
        },
        "answer": {
          "en": "The Greeting Message is the first message visitors see when they open the chat widget. The default is \"Welcome! How can I help you today?\" You can customize this in the Advanced Settings section of the AI Bot tab.",
          "nl": "Het Begroetingsbericht is het eerste bericht dat bezoekers zien wanneer ze de chatwidget openen. De standaardtekst is \"Welkom! Hoe kan ik je vandaag helpen?\" Je kan dit aanpassen in de sectie Geavanceerde instellingen van het tabblad AI-bot.",
          "fr": "Le Message d'accueil est le premier message que les visiteurs voient lorsqu'ils ouvrent le widget de chat. Par défaut, il s'agit de « Bienvenue ! Comment puis-je vous aider aujourd'hui ? » Vous pouvez le personnaliser dans la section Paramètres avancés de l'onglet Bot IA."
        }
      }
    ]
  },
  {
    "id": "knowledge-base",
    "position": 2,
    "isReserved": false,
    "titles": {
      "en": "Knowledge Base",
      "nl": "Kennisbank",
      "fr": "Base de connaissances"
    },
    "items": [
      {
        "slug": "what-is-kb",
        "position": 0,
        "question": {
          "en": "What is the Knowledge Base?",
          "nl": "Wat is de Kennisbank?",
          "fr": "Qu'est-ce que la Base de connaissances ?"
        },
        "answer": {
          "en": "The Knowledge Base is where you upload and store information that your AI bot uses to answer visitor questions. This can include PDF documents, pasted text, FAQs, product descriptions, pricing details, and company policies.",
          "nl": "De Kennisbank is de plek waar je informatie uploadt en opslaat die je AI-bot gebruikt om vragen van bezoekers te beantwoorden. Dit kan PDF-documenten, geplakte tekst, FAQ's, productbeschrijvingen, prijsinformatie en bedrijfsbeleid omvatten.",
          "fr": "La Base de connaissances est l'endroit où vous téléversez et stockez les informations que votre bot IA utilise pour répondre aux questions des visiteurs. Cela peut inclure des documents PDF, du texte collé, des FAQ, des descriptions de produits, des détails tarifaires et des politiques d'entreprise."
        }
      },
      {
        "slug": "file-formats",
        "position": 1,
        "question": {
          "en": "What file formats are supported for knowledge base uploads?",
          "nl": "Welke bestandsformaten worden ondersteund voor kennisbank-uploads?",
          "fr": "Quels formats de fichiers sont pris en charge pour les téléversements vers la base de connaissances ?"
        },
        "answer": {
          "en": "Currently, you can upload PDF documents, paste plain text directly, or manually add FAQ entries. The AI processes this content and uses it to provide accurate, context-aware responses to visitor inquiries.",
          "nl": "Momenteel kan je PDF-documenten uploaden, platte tekst rechtstreeks plakken of handmatig FAQ-items toevoegen. De AI verwerkt deze inhoud en gebruikt ze om nauwkeurige, contextbewuste antwoorden te geven op vragen van bezoekers.",
          "fr": "Actuellement, vous pouvez téléverser des documents PDF, coller directement du texte brut ou ajouter manuellement des entrées de FAQ. L'IA traite ce contenu et l'utilise pour fournir des réponses précises et contextuelles aux demandes des visiteurs."
        }
      },
      {
        "slug": "add-documents",
        "position": 2,
        "question": {
          "en": "How do I add documents to the knowledge base?",
          "nl": "Hoe voeg ik documenten toe aan de kennisbank?",
          "fr": "Comment ajouter des documents à la base de connaissances ?"
        },
        "answer": {
          "en": "Go to AI & Content > Knowledge Base and click \"Add Document\" or \"Add your first document.\" You can then upload PDFs or paste text. Once uploaded, the AI will automatically reference this content when answering relevant questions.",
          "nl": "Ga naar AI & Content > Kennisbank en klik op \"Document toevoegen\" of \"Voeg je eerste document toe\". Je kan vervolgens PDF's uploaden of tekst plakken. Eenmaal geüpload zal de AI deze inhoud automatisch raadplegen bij het beantwoorden van relevante vragen.",
          "fr": "Rendez-vous dans IA et Contenu > Base de connaissances et cliquez sur « Ajouter un document » ou « Ajouter votre premier document ». Vous pouvez alors téléverser des PDF ou coller du texte. Une fois téléversé, l'IA fera automatiquement référence à ce contenu pour répondre aux questions pertinentes."
        }
      },
      {
        "slug": "only-from-kb",
        "position": 3,
        "question": {
          "en": "Does the AI bot only answer from the knowledge base?",
          "nl": "Antwoordt de AI-bot enkel op basis van de kennisbank?",
          "fr": "Le bot IA répond-il uniquement à partir de la base de connaissances ?"
        },
        "answer": {
          "en": "The AI primarily answers from your knowledge base to ensure accuracy and brand consistency. However, it can also use its general intelligence for conversational pleasantries, clarifying questions, and handling topics not covered in your documents. You control this balance through Bot Instructions.",
          "nl": "De AI antwoordt primair vanuit je kennisbank om nauwkeurigheid en merkconsistentie te garanderen. Daarnaast kan hij zijn algemene intelligentie inzetten voor conversationele beleefdheden, verduidelijkende vragen en onderwerpen die niet in je documenten staan. Je stuurt deze balans via de Botinstructies.",
          "fr": "L'IA répond principalement à partir de votre base de connaissances afin de garantir la précision et la cohérence de la marque. Toutefois, elle peut également utiliser son intelligence générale pour les civilités conversationnelles, les questions de clarification et les sujets non couverts par vos documents. Vous contrôlez cet équilibre via les Instructions du bot."
        }
      },
      {
        "slug": "update-content",
        "position": 4,
        "question": {
          "en": "How do I update or remove knowledge base content?",
          "nl": "Hoe werk ik kennisbankinhoud bij of verwijder ik die?",
          "fr": "Comment mettre à jour ou supprimer le contenu de la base de connaissances ?"
        },
        "answer": {
          "en": "Navigate to AI & Content > Knowledge Base. You'll see a list of all uploaded documents with search functionality. You can delete outdated documents and add new ones at any time. The AI updates its responses automatically based on the current knowledge base content.",
          "nl": "Ga naar AI & Content > Kennisbank. Je ziet een lijst met alle geüploade documenten en een zoekfunctie. Je kan verouderde documenten verwijderen en nieuwe toevoegen wanneer je wil. De AI past zijn antwoorden automatisch aan op basis van de huidige kennisbankinhoud.",
          "fr": "Rendez-vous dans IA et Contenu > Base de connaissances. Vous y verrez la liste de tous les documents téléversés avec une fonctionnalité de recherche. Vous pouvez supprimer les documents obsolètes et en ajouter de nouveaux à tout moment. L'IA met à jour ses réponses automatiquement en fonction du contenu actuel de la base de connaissances."
        }
      }
    ]
  },
  {
    "id": "custom-responses",
    "position": 3,
    "isReserved": false,
    "titles": {
      "en": "Custom Responses",
      "nl": "Vooraf opgestelde antwoorden",
      "fr": "Réponses prédéfinies"
    },
    "items": [
      {
        "slug": "what-are",
        "position": 0,
        "question": {
          "en": "What are Custom Responses?",
          "nl": "Wat zijn Vooraf opgestelde antwoorden?",
          "fr": "Que sont les Réponses prédéfinies ?"
        },
        "answer": {
          "en": "Custom Responses (also called canned responses) are pre-written answers to common questions. They ensure consistency across conversations and help your AI deliver precise, approved messaging for specific topics.",
          "nl": "Vooraf opgestelde antwoorden (ook wel canned responses genoemd) zijn vooraf geschreven antwoorden op veelgestelde vragen. Ze zorgen voor consistentie tussen gesprekken en helpen je AI om precieze, goedgekeurde berichten te leveren voor specifieke onderwerpen.",
          "fr": "Les Réponses prédéfinies (également appelées réponses types) sont des réponses pré-rédigées aux questions courantes. Elles garantissent la cohérence à travers les conversations et aident votre IA à délivrer des messages précis et validés sur des sujets spécifiques."
        }
      },
      {
        "slug": "create",
        "position": 1,
        "question": {
          "en": "How do I create a Custom Response?",
          "nl": "Hoe maak ik een Vooraf opgesteld antwoord aan?",
          "fr": "Comment créer une Réponse prédéfinie ?"
        },
        "answer": {
          "en": "Go to AI & Content > Custom Responses and click \"New Response.\" Fill in the Title (for internal reference), Content (the actual message), Shortcut (a quick code to trigger it), Category (for organization), and Scope (which contexts it applies to).",
          "nl": "Ga naar AI & Content > Vooraf opgestelde antwoorden en klik op \"Nieuw antwoord\". Vul de Titel in (voor intern gebruik), de Inhoud (het eigenlijke bericht), de Snelkoppeling (een korte code om het op te roepen), de Categorie (voor organisatie) en de Scope (in welke contexten het van toepassing is).",
          "fr": "Rendez-vous dans IA et Contenu > Réponses prédéfinies et cliquez sur « Nouvelle réponse ». Remplissez le Titre (à usage interne), le Contenu (le message proprement dit), le Raccourci (un code rapide pour la déclencher), la Catégorie (pour l'organisation) et la Portée (les contextes auxquels elle s'applique)."
        }
      },
      {
        "slug": "categorize",
        "position": 2,
        "question": {
          "en": "Can I organize Custom Responses by category?",
          "nl": "Kan ik Vooraf opgestelde antwoorden per categorie organiseren?",
          "fr": "Puis-je organiser les Réponses prédéfinies par catégorie ?"
        },
        "answer": {
          "en": "Yes. You can assign categories to each custom response and filter by category using the dropdown menu. This makes it easy to manage responses for different departments, products, or conversation topics.",
          "nl": "Ja. Je kan aan elk vooraf opgesteld antwoord een categorie toewijzen en filteren op categorie via het dropdownmenu. Dit maakt het eenvoudig om antwoorden te beheren voor verschillende afdelingen, producten of gespreksonderwerpen.",
          "fr": "Oui. Vous pouvez attribuer des catégories à chaque réponse prédéfinie et filtrer par catégorie à l'aide du menu déroulant. Cela facilite la gestion des réponses pour différents départements, produits ou sujets de conversation."
        }
      },
      {
        "slug": "when-used",
        "position": 3,
        "question": {
          "en": "How does the AI know when to use a Custom Response?",
          "nl": "Hoe weet de AI wanneer een Vooraf opgesteld antwoord te gebruiken?",
          "fr": "Comment l'IA sait-elle quand utiliser une Réponse prédéfinie ?"
        },
        "answer": {
          "en": "Custom Responses can be triggered by shortcuts (typed by agents), or the AI can be instructed to use specific responses for certain topics through your Bot Instructions. The USED column in the responses table shows how often each response has been utilized.",
          "nl": "Vooraf opgestelde antwoorden kunnen worden geactiveerd via snelkoppelingen (door agents getypt), of de AI kan via je Botinstructies aangestuurd worden om specifieke antwoorden te gebruiken voor bepaalde onderwerpen. De kolom GEBRUIKT in de antwoordentabel toont hoe vaak elk antwoord is ingezet.",
          "fr": "Les Réponses prédéfinies peuvent être déclenchées par des raccourcis (saisis par les agents), ou l'IA peut être instruite, via vos Instructions du bot, d'utiliser des réponses spécifiques pour certains sujets. La colonne UTILISÉE dans le tableau des réponses indique la fréquence d'utilisation de chaque réponse."
        }
      }
    ]
  },
  {
    "id": "appearance",
    "position": 4,
    "isReserved": false,
    "titles": {
      "en": "Chatbot Appearance & Branding",
      "nl": "Chatbot-weergave & branding",
      "fr": "Apparence du chatbot et image de marque"
    },
    "items": [
      {
        "slug": "customize",
        "position": 0,
        "question": {
          "en": "How do I customize the chat widget's appearance?",
          "nl": "Hoe pas ik het uiterlijk van de chatwidget aan?",
          "fr": "Comment personnaliser l'apparence du widget de chat ?"
        },
        "answer": {
          "en": "Go to AI & Content > Chatbot Appearances. You can set the Primary Color, Bot Avatar URL, Launcher Position (Bottom Right or Bottom Left), Launcher Label (text next to the chat icon), and preview all changes in real-time.",
          "nl": "Ga naar AI & Content > Chatbot-weergave. Je kan de Primaire kleur, de URL van de bot-avatar, de Launcher-positie (rechtsonder of linksonder), het Launcher-label (de tekst naast het chatpictogram) instellen en alle wijzigingen in realtime bekijken.",
          "fr": "Rendez-vous dans IA et Contenu > Apparence du chatbot. Vous pouvez définir la Couleur principale, l'URL de l'avatar du bot, la Position du lanceur (en bas à droite ou en bas à gauche), le Libellé du lanceur (texte affiché à côté de l'icône de chat) et prévisualiser toutes les modifications en temps réel."
        }
      },
      {
        "slug": "company-logo",
        "position": 1,
        "question": {
          "en": "Can I use my company logo as the bot avatar?",
          "nl": "Kan ik mijn bedrijfslogo gebruiken als bot-avatar?",
          "fr": "Puis-je utiliser le logo de mon entreprise comme avatar du bot ?"
        },
        "answer": {
          "en": "Yes. In the Chatbot Appearances tab, enter a URL to your logo image in the \"Bot avatar URL\" field. If left empty, the widget will automatically use your company logo when available. The recommended size is 256x256px in PNG or SVG format.",
          "nl": "Ja. Geef in het tabblad Chatbot-weergave een URL naar je logoafbeelding op in het veld \"URL van bot-avatar\". Als het leeg blijft, gebruikt de widget automatisch je bedrijfslogo wanneer beschikbaar. De aanbevolen grootte is 256x256 px in PNG- of SVG-formaat.",
          "fr": "Oui. Dans l'onglet Apparence du chatbot, saisissez l'URL de votre image de logo dans le champ « URL de l'avatar du bot ». Si ce champ reste vide, le widget utilisera automatiquement le logo de votre entreprise lorsqu'il est disponible. La taille recommandée est de 256 × 256 px au format PNG ou SVG."
        }
      },
      {
        "slug": "launcher-label",
        "position": 2,
        "question": {
          "en": "What is the Launcher Label and how do I change it?",
          "nl": "Wat is het Launcher-label en hoe pas ik het aan?",
          "fr": "Qu'est-ce que le Libellé du lanceur et comment le modifier ?"
        },
        "answer": {
          "en": "The Launcher Label is the text displayed next to the chat icon on your website, such as \"Chat with us.\" You can customize this text in the Chatbot Appearances section to match your brand voice.",
          "nl": "Het Launcher-label is de tekst die naast het chatpictogram op je website verschijnt, bijvoorbeeld \"Chat met ons\". Je kan deze tekst aanpassen in de sectie Chatbot-weergave zodat hij aansluit bij je merkstem.",
          "fr": "Le Libellé du lanceur est le texte affiché à côté de l'icône de chat sur votre site web, comme « Discutez avec nous ». Vous pouvez personnaliser ce texte dans la section Apparence du chatbot pour qu'il corresponde à la voix de votre marque."
        }
      },
      {
        "slug": "welcome-message",
        "position": 3,
        "question": {
          "en": "Where does the Welcome Message appear?",
          "nl": "Waar verschijnt het Welkomstbericht?",
          "fr": "Où apparaît le Message de bienvenue ?"
        },
        "answer": {
          "en": "The Welcome Message appears at the top of the chat widget when a visitor first opens it. It is configured in the AI Bot settings under Advanced Settings, not in the Appearances tab.",
          "nl": "Het Welkomstbericht verschijnt bovenaan de chatwidget wanneer een bezoeker hem voor het eerst opent. Het wordt geconfigureerd in de AI-botinstellingen onder Geavanceerde instellingen, niet in het tabblad Weergave.",
          "fr": "Le Message de bienvenue apparaît en haut du widget de chat lorsque le visiteur l'ouvre pour la première fois. Il se configure dans les paramètres du Bot IA, sous Paramètres avancés, et non dans l'onglet Apparence."
        }
      },
      {
        "slug": "preview",
        "position": 4,
        "question": {
          "en": "Can I preview my chat widget before going live?",
          "nl": "Kan ik mijn chatwidget bekijken voor ik live ga?",
          "fr": "Puis-je prévisualiser mon widget de chat avant la mise en ligne ?"
        },
        "answer": {
          "en": "Yes. The Chatbot Appearances tab includes a live preview panel showing exactly how your widget will look to visitors. You can also click \"Open full widget test\" to see the complete experience, and use \"Test Chat\" from any page to interact with your bot.",
          "nl": "Ja. Het tabblad Chatbot-weergave bevat een live-previewpaneel dat exact toont hoe je widget eruit zal zien voor bezoekers. Je kan ook op \"Volledige widgettest openen\" klikken om de volledige ervaring te zien, of via \"Chat testen\" op elke pagina met je bot interageren.",
          "fr": "Oui. L'onglet Apparence du chatbot inclut un panneau d'aperçu en direct montrant exactement à quoi ressemblera votre widget pour les visiteurs. Vous pouvez aussi cliquer sur « Ouvrir le test complet du widget » pour voir l'expérience intégrale, et utiliser « Tester le chat » depuis n'importe quelle page pour interagir avec votre bot."
        }
      }
    ]
  },
  {
    "id": "channels",
    "position": 5,
    "isReserved": false,
    "titles": {
      "en": "Channels & Social Media",
      "nl": "Kanalen & social media",
      "fr": "Canaux et réseaux sociaux"
    },
    "items": [
      {
        "slug": "platforms",
        "position": 0,
        "question": {
          "en": "Which messaging platforms does HandsOff support?",
          "nl": "Welke berichtenplatformen ondersteunt HandsOff?",
          "fr": "Quelles plateformes de messagerie HandsOff prend-il en charge ?"
        },
        "answer": {
          "en": "Currently, HandsOff supports Telegram bots and Facebook Pages. You can connect one or both platforms, and all messages will flow into your unified Inbox for centralized management.",
          "nl": "Momenteel ondersteunt HandsOff Telegram-bots en Facebook-pagina's. Je kan één of beide platformen koppelen, en alle berichten komen samen in je centrale Inbox voor gecentraliseerd beheer.",
          "fr": "Actuellement, HandsOff prend en charge les bots Telegram et les pages Facebook. Vous pouvez connecter l'une, l'autre ou les deux plateformes, et tous les messages alimenteront votre Boîte de réception unifiée pour une gestion centralisée."
        }
      },
      {
        "slug": "connect-telegram",
        "position": 1,
        "question": {
          "en": "How do I connect a Telegram bot?",
          "nl": "Hoe koppel ik een Telegram-bot?",
          "fr": "Comment connecter un bot Telegram ?"
        },
        "answer": {
          "en": "Go to AI & Content > Social Media Integrations or Settings > Channels. Click the Telegram button and follow the instructions to link your existing Telegram bot using its API token. Once connected, all messages sent to your bot will appear in the Inbox.",
          "nl": "Ga naar AI & Content > Social media-integraties of Instellingen > Kanalen. Klik op de knop Telegram en volg de instructies om je bestaande Telegram-bot te koppelen via zijn API-token. Eenmaal gekoppeld verschijnen alle berichten naar je bot in de Inbox.",
          "fr": "Rendez-vous dans IA et Contenu > Intégrations réseaux sociaux ou Paramètres > Canaux. Cliquez sur le bouton Telegram et suivez les instructions pour relier votre bot Telegram existant à l'aide de son token API. Une fois connecté, tous les messages envoyés à votre bot apparaîtront dans la Boîte de réception."
        }
      },
      {
        "slug": "connect-facebook",
        "position": 2,
        "question": {
          "en": "How do I connect a Facebook Page?",
          "nl": "Hoe koppel ik een Facebook-pagina?",
          "fr": "Comment connecter une page Facebook ?"
        },
        "answer": {
          "en": "In the Social Media Integrations or Channels section, click the Facebook button and authenticate with your Facebook account. Select the Page you want to connect, and HandsOff will automatically receive and respond to messages sent to that Page.",
          "nl": "Klik in de sectie Social media-integraties of Kanalen op de knop Facebook en authenticeer je met je Facebookaccount. Selecteer de pagina die je wil koppelen, en HandsOff zal automatisch berichten naar die pagina ontvangen en beantwoorden.",
          "fr": "Dans la section Intégrations réseaux sociaux ou Canaux, cliquez sur le bouton Facebook et authentifiez-vous avec votre compte Facebook. Sélectionnez la page que vous souhaitez connecter ; HandsOff recevra et répondra automatiquement aux messages envoyés à cette page."
        }
      },
      {
        "slug": "unified-inbox",
        "position": 3,
        "question": {
          "en": "Can I manage all channels from one inbox?",
          "nl": "Kan ik alle kanalen beheren vanuit één inbox?",
          "fr": "Puis-je gérer tous les canaux depuis une seule boîte de réception ?"
        },
        "answer": {
          "en": "Yes. The Inbox dashboard consolidates conversations from your website widget, Telegram, and Facebook into a single view. You can filter by channel using the tabs: All, Bot, Handoff, and Agent.",
          "nl": "Ja. Het Inbox-dashboard brengt gesprekken vanuit je websitewidget, Telegram en Facebook samen in één overzicht. Je kan filteren per kanaal via de tabs: Alle, Bot, Overdracht en Agent.",
          "fr": "Oui. Le dashboard Boîte de réception regroupe les conversations issues de votre widget web, de Telegram et de Facebook dans une vue unique. Vous pouvez filtrer par canal à l'aide des onglets : Tous, Bot, Transfert et Agent."
        }
      }
    ]
  },
  {
    "id": "analytics",
    "position": 6,
    "isReserved": false,
    "titles": {
      "en": "Analytics & Reporting",
      "nl": "Analyses & rapportering",
      "fr": "Analyses et rapports"
    },
    "items": [
      {
        "slug": "metrics",
        "position": 0,
        "question": {
          "en": "What metrics does HandsOff track?",
          "nl": "Welke statistieken houdt HandsOff bij?",
          "fr": "Quelles métriques HandsOff suit-il ?"
        },
        "answer": {
          "en": "HandsOff provides comprehensive analytics including: Active Chats, Pending Handoffs, Online Agents, Average Response Time, CSAT (Customer Satisfaction) Score, and Total Chats. You can view trends over time with the Last 7 Days filter (other time ranges available).",
          "nl": "HandsOff biedt uitgebreide analyses, waaronder: Actieve chats, Openstaande overdrachten, Online agents, Gemiddelde reactietijd, CSAT-score (klanttevredenheid) en Totaal aantal chats. Je kan trends bekijken over tijd met de filter Laatste 7 dagen (andere tijdsbereiken zijn beschikbaar).",
          "fr": "HandsOff fournit des analyses complètes comprenant : les Conversations actives, les Transferts en attente, les Agents en ligne, le Temps de réponse moyen, le score CSAT (Satisfaction client) et le Total de conversations. Vous pouvez visualiser les tendances dans le temps avec le filtre Sept derniers jours (d'autres plages temporelles sont disponibles)."
        }
      },
      {
        "slug": "chat-volume",
        "position": 1,
        "question": {
          "en": "What is the Chat Volume graph?",
          "nl": "Wat is de Chatvolume-grafiek?",
          "fr": "Qu'est-ce que le graphique Volume de conversations ?"
        },
        "answer": {
          "en": "The Chat Volume graph shows the number of conversations over time, broken down by Bot (AI-handled), Human (agent-handled), and Handoff (transferred) conversations. This helps you understand how workload is distributed between AI and your team.",
          "nl": "De Chatvolume-grafiek toont het aantal gesprekken over tijd, opgesplitst per Bot (door AI afgehandeld), Mens (door agents afgehandeld) en Overdracht (overgedragen) gesprekken. Zo zie je hoe de werklast verdeeld is tussen AI en je team.",
          "fr": "Le graphique Volume de conversations affiche le nombre de conversations au fil du temps, réparties entre Bot (gérées par l'IA), Humain (gérées par un agent) et Transfert (conversations transférées). Cela vous aide à comprendre comment la charge de travail est répartie entre l'IA et votre équipe."
        }
      },
      {
        "slug": "export",
        "position": 2,
        "question": {
          "en": "Can I export my analytics data?",
          "nl": "Kan ik mijn analysegegevens exporteren?",
          "fr": "Puis-je exporter mes données d'analyse ?"
        },
        "answer": {
          "en": "Yes. The Analytics dashboard includes an Export button that allows you to download your performance data for further analysis or reporting in external tools.",
          "nl": "Ja. Het Analytics-dashboard bevat een Exporteer-knop waarmee je je prestatiegegevens kan downloaden voor verdere analyse of rapportering in externe tools.",
          "fr": "Oui. Le dashboard Analyses inclut un bouton Exporter qui vous permet de télécharger vos données de performance pour une analyse ou un reporting plus poussé dans des outils externes."
        }
      },
      {
        "slug": "setup-checklist",
        "position": 3,
        "question": {
          "en": "What is the setup checklist in Analytics?",
          "nl": "Wat is de installatiechecklist in Analytics?",
          "fr": "Qu'est-ce que la checklist de configuration dans Analyses ?"
        },
        "answer": {
          "en": "The checklist at the top of the Analytics page tracks your onboarding progress: AI Assistant enabled, Brand voice configured, Knowledge base docs uploaded, Booking calendar connected, and Automations set up. Each item links directly to the relevant configuration page.",
          "nl": "De checklist bovenaan de Analytics-pagina volgt je onboardingvoortgang op: AI-assistent geactiveerd, Merkstem geconfigureerd, Kennisbankdocumenten geüpload, Boekingsagenda gekoppeld en Automatiseringen ingesteld. Elk item linkt rechtstreeks naar de bijhorende configuratiepagina.",
          "fr": "La checklist en haut de la page Analyses suit votre progression d'onboarding : Assistant IA activé, Voix de la marque configurée, Documents de base de connaissances téléversés, Calendrier de réservation connecté et Automatisations configurées. Chaque élément renvoie directement à la page de configuration correspondante."
        }
      }
    ]
  },
  {
    "id": "team",
    "position": 7,
    "isReserved": false,
    "titles": {
      "en": "Team Management",
      "nl": "Teambeheer",
      "fr": "Gestion de l'équipe"
    },
    "items": [
      {
        "slug": "invite-members",
        "position": 0,
        "question": {
          "en": "How do I invite team members to HandsOff?",
          "nl": "Hoe nodig ik teamleden uit voor HandsOff?",
          "fr": "Comment inviter des membres de mon équipe dans HandsOff ?"
        },
        "answer": {
          "en": "Go to the Team section and click \"Invite\" in the Members tab. Enter the email address of the person you want to invite, and they will receive an invitation to join your organization.",
          "nl": "Ga naar de sectie Team en klik op \"Uitnodigen\" in het tabblad Leden. Voer het e-mailadres in van de persoon die je wil uitnodigen en zij ontvangen een uitnodiging om lid te worden van je organisatie.",
          "fr": "Rendez-vous dans la section Équipe et cliquez sur « Inviter » dans l'onglet Membres. Saisissez l'adresse e-mail de la personne que vous souhaitez inviter ; elle recevra une invitation à rejoindre votre organisation."
        }
      },
      {
        "slug": "roles",
        "position": 1,
        "question": {
          "en": "What roles are available in HandsOff?",
          "nl": "Welke rollen zijn beschikbaar in HandsOff?",
          "fr": "Quels rôles sont disponibles dans HandsOff ?"
        },
        "answer": {
          "en": "The primary role shown is Admin, which has full access to all settings and features. You can manage member roles through the dropdown in the Members table. Additional role tiers may be available depending on your plan.",
          "nl": "De primaire rol die getoond wordt is Admin, die volledige toegang heeft tot alle instellingen en functies. Je beheert ledenrollen via het dropdownmenu in de Ledentabel. Afhankelijk van je abonnement kunnen er bijkomende rolniveaus beschikbaar zijn.",
          "fr": "Le rôle principal affiché est Admin, qui dispose d'un accès complet à tous les paramètres et fonctionnalités. Vous pouvez gérer les rôles des membres via le menu déroulant du tableau des Membres. Des niveaux de rôle supplémentaires peuvent être disponibles selon votre formule."
        }
      },
      {
        "slug": "add-agent",
        "position": 2,
        "question": {
          "en": "How do I add a live agent?",
          "nl": "Hoe voeg ik een live agent toe?",
          "fr": "Comment ajouter un agent en direct ?"
        },
        "answer": {
          "en": "In the Team section, click \"Add Agent.\" You can set up agent profiles, assign shifts, and track performance metrics. Agents appear in the Agents tab with their online status and chat assignments.",
          "nl": "Klik in de sectie Team op \"Agent toevoegen\". Je kan agentprofielen instellen, shifts toewijzen en prestatiestatistieken bijhouden. Agents verschijnen in het tabblad Agents met hun onlinestatus en chattoewijzingen.",
          "fr": "Dans la section Équipe, cliquez sur « Ajouter un agent ». Vous pouvez créer des profils d'agents, attribuer des shifts et suivre des métriques de performance. Les agents apparaissent dans l'onglet Agents avec leur statut en ligne et leurs attributions de conversations."
        }
      },
      {
        "slug": "schedule-shifts",
        "position": 3,
        "question": {
          "en": "Can I schedule shifts for my team?",
          "nl": "Kan ik shifts plannen voor mijn team?",
          "fr": "Puis-je planifier des shifts pour mon équipe ?"
        },
        "answer": {
          "en": "Yes. The Team section includes a Shifts tab where you can create and manage agent schedules. This ensures coverage during peak hours and helps balance workload across your team.",
          "nl": "Ja. De sectie Team bevat een tabblad Shifts waar je agentplanningen kan aanmaken en beheren. Zo verzeker je dekking tijdens piekmomenten en help je de werklast in je team in balans te houden.",
          "fr": "Oui. La section Équipe comprend un onglet Shifts dans lequel vous pouvez créer et gérer les plannings des agents. Cela garantit une couverture pendant les heures de pointe et aide à équilibrer la charge de travail au sein de votre équipe."
        }
      },
      {
        "slug": "statistics",
        "position": 4,
        "question": {
          "en": "What team statistics are available?",
          "nl": "Welke teamstatistieken zijn beschikbaar?",
          "fr": "Quelles statistiques d'équipe sont disponibles ?"
        },
        "answer": {
          "en": "The Team dashboard shows Total Agents, Online Now (current active agents), Total Chats Month-to-Date, and Average CSAT Score. The Performance tab provides individual agent metrics for coaching and recognition.",
          "nl": "Het Team-dashboard toont Totaal aantal agents, Nu online (huidige actieve agents), Totaal aantal chats deze maand (Month-to-Date) en Gemiddelde CSAT-score. Het tabblad Prestaties biedt individuele agentstatistieken voor coaching en erkenning.",
          "fr": "Le dashboard Équipe affiche le Total d'agents, le nombre d'agents En ligne maintenant (agents actuellement actifs), le Total de conversations du mois en cours et le Score CSAT moyen. L'onglet Performance fournit des métriques individuelles par agent à des fins de coaching et de reconnaissance."
        }
      }
    ]
  },
  {
    "id": "handoff",
    "position": 8,
    "isReserved": false,
    "titles": {
      "en": "Human Handoff",
      "nl": "Overdracht naar mens",
      "fr": "Transfert humain"
    },
    "items": [
      {
        "slug": "what-is",
        "position": 0,
        "question": {
          "en": "What is Human Handoff?",
          "nl": "Wat is Overdracht naar mens?",
          "fr": "Qu'est-ce que le Transfert humain ?"
        },
        "answer": {
          "en": "Human Handoff is a feature that seamlessly transfers conversations from the AI bot to a live human agent when the bot cannot resolve an inquiry or when a visitor explicitly requests to speak with a person.",
          "nl": "Overdracht naar mens is een functie die gesprekken naadloos overdraagt van de AI-bot naar een live menselijke agent wanneer de bot een vraag niet kan oplossen of wanneer een bezoeker expliciet vraagt om met iemand te spreken.",
          "fr": "Le Transfert humain est une fonctionnalité qui transfère de manière fluide les conversations du bot IA vers un agent humain en direct lorsque le bot ne peut pas résoudre une demande ou lorsqu'un visiteur demande explicitement à parler à une personne."
        }
      },
      {
        "slug": "visitor-request",
        "position": 1,
        "question": {
          "en": "How does a visitor request a human agent?",
          "nl": "Hoe vraagt een bezoeker een menselijke agent aan?",
          "fr": "Comment un visiteur peut-il demander à parler à un agent humain ?"
        },
        "answer": {
          "en": "Visitors can request a human agent at any time during the conversation. The AI is trained to recognize phrases like \"speak to a human,\" \"talk to an agent,\" or \"I need help from a person\" and will initiate the handoff automatically.",
          "nl": "Bezoekers kunnen op elk moment in het gesprek om een menselijke agent vragen. De AI is getraind om zinnen te herkennen zoals \"ik wil iemand spreken\", \"praat met een agent\" of \"ik heb hulp van een persoon nodig\" en zal de overdracht automatisch starten.",
          "fr": "Les visiteurs peuvent demander à parler à un agent humain à tout moment de la conversation. L'IA est entraînée à reconnaître des formulations telles que « parler à un humain », « discuter avec un agent » ou « j'ai besoin de l'aide d'une personne » et déclenche automatiquement le transfert."
        }
      },
      {
        "slug": "where-appear",
        "position": 2,
        "question": {
          "en": "Where do handoff requests appear?",
          "nl": "Waar verschijnen overdrachtsverzoeken?",
          "fr": "Où apparaissent les demandes de transfert ?"
        },
        "answer": {
          "en": "Handoff requests appear in the Inbox under the \"Handoff\" tab. Agents can see pending handoffs and claim them to start the conversation. The Inbox also shows real-time metrics for Pending Handoffs.",
          "nl": "Overdrachtsverzoeken verschijnen in de Inbox onder het tabblad \"Overdracht\". Agents zien openstaande overdrachten en kunnen ze claimen om het gesprek over te nemen. De Inbox toont ook realtime statistieken voor Openstaande overdrachten.",
          "fr": "Les demandes de transfert apparaissent dans la Boîte de réception, sous l'onglet « Transfert ». Les agents peuvent voir les transferts en attente et les prendre en charge pour démarrer la conversation. La Boîte de réception affiche également des métriques en temps réel pour les Transferts en attente."
        }
      },
      {
        "slug": "ai-resume",
        "position": 3,
        "question": {
          "en": "Can the AI resume a conversation after handoff?",
          "nl": "Kan de AI een gesprek hervatten na een overdracht?",
          "fr": "L'IA peut-elle reprendre une conversation après un transfert ?"
        },
        "answer": {
          "en": "The AI maintains context throughout the conversation. After a human agent resolves the issue and closes the chat, the AI can resume handling new inquiries from that visitor with full awareness of the conversation history.",
          "nl": "De AI behoudt de context gedurende het hele gesprek. Nadat een menselijke agent de kwestie heeft opgelost en de chat heeft afgesloten, kan de AI nieuwe vragen van die bezoeker opnieuw afhandelen met volledig besef van de gespreksgeschiedenis.",
          "fr": "L'IA conserve le contexte tout au long de la conversation. Après qu'un agent humain a résolu le problème et fermé la conversation, l'IA peut reprendre le traitement des nouvelles demandes de ce visiteur en ayant une connaissance complète de l'historique de la conversation."
        }
      },
      {
        "slug": "enable-disable",
        "position": 4,
        "question": {
          "en": "How do I enable or disable Human Handoff?",
          "nl": "Hoe schakel ik Overdracht naar mens in of uit?",
          "fr": "Comment activer ou désactiver le Transfert humain ?"
        },
        "answer": {
          "en": "Human Handoff can be toggled in Settings > Capabilities. Look for the \"Human Handoff\" card and toggle it on or off. When enabled, the AI will automatically offer to connect visitors with a human agent when appropriate.",
          "nl": "Overdracht naar mens kan worden in- of uitgeschakeld in Instellingen > Functionaliteiten. Zoek de kaart \"Overdracht naar mens\" en zet de schakelaar aan of uit. Wanneer ingeschakeld zal de AI bezoekers automatisch aanbieden om hen door te verbinden met een menselijke agent wanneer dat gepast is.",
          "fr": "Le Transfert humain peut être activé ou désactivé dans Paramètres > Fonctionnalités. Recherchez la carte « Transfert humain » et activez-la ou désactivez-la. Lorsqu'il est activé, l'IA proposera automatiquement de mettre les visiteurs en relation avec un agent humain le cas échéant."
        }
      }
    ]
  },
  {
    "id": "capabilities",
    "position": 9,
    "isReserved": false,
    "titles": {
      "en": "Capabilities & Features",
      "nl": "Functionaliteiten & features",
      "fr": "Fonctionnalités"
    },
    "items": [
      {
        "slug": "what-are",
        "position": 0,
        "question": {
          "en": "What capabilities can I enable for my chatbot?",
          "nl": "Welke functionaliteiten kan ik inschakelen voor mijn chatbot?",
          "fr": "Quelles fonctionnalités puis-je activer pour mon chatbot ?"
        },
        "answer": {
          "en": "HandsOff offers four main capabilities: Answer Questions (using your knowledge base), Lead Capture (collecting visitor contact information), Human Handoff (connecting to live agents), and Appointments (booking, rescheduling, and canceling meetings).",
          "nl": "HandsOff biedt vier hoofdfunctionaliteiten: Vragen beantwoorden (op basis van je kennisbank), Lead Capture (contactgegevens van bezoekers verzamelen), Overdracht naar mens (verbinden met live agents) en Afspraken (afspraken boeken, verzetten en annuleren).",
          "fr": "HandsOff propose quatre fonctionnalités principales : Répondre aux questions (à partir de votre base de connaissances), Capture de prospects (collecte des informations de contact des visiteurs), Transfert humain (connexion avec des agents en direct) et Rendez-vous (réservation, replanification et annulation de rendez-vous)."
        }
      },
      {
        "slug": "lead-capture",
        "position": 1,
        "question": {
          "en": "How does Lead Capture work?",
          "nl": "Hoe werkt Lead Capture?",
          "fr": "Comment fonctionne la Capture de prospects ?"
        },
        "answer": {
          "en": "When enabled, the chatbot collects visitor contact information such as name, email, and phone number when they show interest in your products or services. This data is captured automatically and can trigger team notifications.",
          "nl": "Wanneer ingeschakeld verzamelt de chatbot contactgegevens van bezoekers zoals naam, e-mail en telefoonnummer wanneer ze interesse tonen in je producten of diensten. Deze gegevens worden automatisch vastgelegd en kunnen teamnotificaties activeren.",
          "fr": "Lorsqu'elle est activée, le chatbot collecte les informations de contact des visiteurs telles que nom, e-mail et numéro de téléphone lorsqu'ils manifestent de l'intérêt pour vos produits ou services. Ces données sont capturées automatiquement et peuvent déclencher des notifications pour l'équipe."
        }
      },
      {
        "slug": "book-appointments",
        "position": 2,
        "question": {
          "en": "Can the chatbot book appointments?",
          "nl": "Kan de chatbot afspraken boeken?",
          "fr": "Le chatbot peut-il prendre des rendez-vous ?"
        },
        "answer": {
          "en": "Yes, with the Appointments capability enabled, visitors can book, reschedule, or cancel appointments directly through the chat. The bot supports checking availability, creating bookings, listing existing bookings, rescheduling, and canceling.",
          "nl": "Ja, met de functie Afspraken ingeschakeld kunnen bezoekers afspraken boeken, verzetten of annuleren rechtstreeks via de chat. De bot ondersteunt het controleren van beschikbaarheid, het aanmaken van boekingen, het opvragen van bestaande boekingen, verzetten en annuleren.",
          "fr": "Oui, lorsque la fonctionnalité Rendez-vous est activée, les visiteurs peuvent réserver, replanifier ou annuler des rendez-vous directement depuis le chat. Le bot prend en charge la vérification des disponibilités, la création de réservations, la liste des réservations existantes, la replanification et l'annulation."
        }
      },
      {
        "slug": "connect-calendar",
        "position": 3,
        "question": {
          "en": "How do I connect a booking calendar?",
          "nl": "Hoe koppel ik een boekingsagenda?",
          "fr": "Comment connecter un calendrier de réservation ?"
        },
        "answer": {
          "en": "Go to Settings > Integrations and find the Appointment Booking section. Enter your Cal.com API key (found at Cal.com > Settings > Developer > API Keys) and click Connect. Once linked, the chatbot can manage your calendar automatically.",
          "nl": "Ga naar Instellingen > Integraties en zoek de sectie Afsprakenboeking. Voer je Cal.com API-sleutel in (te vinden via Cal.com > Settings > Developer > API Keys) en klik op Verbinden. Eenmaal gekoppeld kan de chatbot je agenda automatisch beheren.",
          "fr": "Rendez-vous dans Paramètres > Intégrations et trouvez la section Réservation de rendez-vous. Saisissez votre clé API Cal.com (disponible dans Cal.com > Settings > Developer > API Keys) et cliquez sur Connecter. Une fois la liaison établie, le chatbot pourra gérer votre calendrier automatiquement."
        }
      },
      {
        "slug": "team-notifications",
        "position": 4,
        "question": {
          "en": "What are Team Notifications?",
          "nl": "Wat zijn Teamnotificaties?",
          "fr": "Que sont les Notifications d'équipe ?"
        },
        "answer": {
          "en": "Team Notifications alert your team when important events occur. You can enable \"New Lead Alert\" to notify the team when a new lead is captured, and \"Conversation Summary\" to send a summary of each completed conversation to the team inbox.",
          "nl": "Teamnotificaties waarschuwen je team wanneer belangrijke gebeurtenissen plaatsvinden. Je kan \"Nieuwe lead-melding\" inschakelen om het team te waarschuwen wanneer een nieuwe lead wordt vastgelegd, en \"Gespreksoverzicht\" om een samenvatting van elk afgerond gesprek naar de teaminbox te sturen.",
          "fr": "Les Notifications d'équipe alertent votre équipe lorsque des événements importants surviennent. Vous pouvez activer « Alerte nouveau prospect » pour notifier l'équipe lorsqu'un nouveau prospect est capturé, et « Résumé de conversation » pour envoyer un résumé de chaque conversation terminée dans la boîte de réception de l'équipe."
        }
      }
    ]
  },
  {
    "id": "integrations",
    "position": 10,
    "isReserved": false,
    "titles": {
      "en": "Integrations & API",
      "nl": "Integraties & API",
      "fr": "Intégrations et API"
    },
    "items": [
      {
        "slug": "api",
        "position": 0,
        "question": {
          "en": "Does HandsOff offer an API?",
          "nl": "Biedt HandsOff een API aan?",
          "fr": "HandsOff propose-t-il une API ?"
        },
        "answer": {
          "en": "Yes. HandsOff provides API access for advanced integrations. Your unique API Key is available in Settings > Integrations. Use this key to authenticate API requests and build custom workflows.",
          "nl": "Ja. HandsOff biedt API-toegang voor geavanceerde integraties. Je unieke API-sleutel vind je in Instellingen > Integraties. Gebruik deze sleutel om API-verzoeken te authenticeren en aangepaste workflows te bouwen.",
          "fr": "Oui. HandsOff fournit un accès API pour les intégrations avancées. Votre clé API unique est disponible dans Paramètres > Intégrations. Utilisez cette clé pour authentifier vos requêtes API et créer des workflows personnalisés."
        }
      },
      {
        "slug": "webhook-url",
        "position": 1,
        "question": {
          "en": "What is the Webhook URL used for?",
          "nl": "Waarvoor wordt de Webhook-URL gebruikt?",
          "fr": "À quoi sert l'URL du webhook ?"
        },
        "answer": {
          "en": "The Outbound Webhook URL in Settings > Integrations allows you to send conversation events, lead captures, and other data to external systems. Enter your webhook endpoint URL, test the connection, and save to start receiving real-time events.",
          "nl": "Met de Outbound Webhook-URL in Instellingen > Integraties kan je gespreksevents, lead captures en andere gegevens naar externe systemen sturen. Voer je webhook-endpoint-URL in, test de verbinding en bewaar om realtime events te ontvangen.",
          "fr": "L'URL du webhook sortant, dans Paramètres > Intégrations, vous permet d'envoyer les événements de conversation, les captures de prospects et d'autres données vers des systèmes externes. Saisissez l'URL de votre endpoint webhook, testez la connexion et enregistrez pour commencer à recevoir des événements en temps réel."
        }
      },
      {
        "slug": "inbound-webhook",
        "position": 2,
        "question": {
          "en": "What is the Inbound Webhook Endpoint?",
          "nl": "Wat is het Inbound Webhook-endpoint?",
          "fr": "Qu'est-ce que l'endpoint Webhook entrant ?"
        },
        "answer": {
          "en": "The Inbound Webhook Endpoint is a read-only URL that allows external automation workflows to send messages or triggers into HandsOff. Include your tenant ID in the request body when configuring your external tools.",
          "nl": "Het Inbound Webhook-endpoint is een alleen-lezen URL waarmee externe automatiseringsworkflows berichten of triggers naar HandsOff kunnen sturen. Voeg je tenant-ID toe aan de request body wanneer je je externe tools configureert.",
          "fr": "L'endpoint Webhook entrant est une URL en lecture seule qui permet à des workflows d'automatisation externes d'envoyer des messages ou des déclencheurs vers HandsOff. Incluez l'identifiant de votre tenant dans le corps de la requête lorsque vous configurez vos outils externes."
        }
      },
      {
        "slug": "secure-webhooks",
        "position": 3,
        "question": {
          "en": "How do I secure my webhook connections?",
          "nl": "Hoe beveilig ik mijn webhook-verbindingen?",
          "fr": "Comment sécuriser mes connexions webhook ?"
        },
        "answer": {
          "en": "Use the Webhook Secret (found in Settings > Integrations) to verify that incoming webhook requests are genuine. Configure your automation platform to include this secret key in request headers for secure authentication.",
          "nl": "Gebruik het Webhook-geheim (te vinden in Instellingen > Integraties) om te verifiëren dat binnenkomende webhook-verzoeken authentiek zijn. Configureer je automatiseringsplatform om deze geheime sleutel mee te sturen in de request headers voor veilige authenticatie.",
          "fr": "Utilisez le Secret du webhook (disponible dans Paramètres > Intégrations) pour vérifier que les requêtes webhook entrantes sont authentiques. Configurez votre plateforme d'automatisation pour inclure cette clé secrète dans les en-têtes des requêtes, afin d'assurer une authentification sécurisée."
        }
      },
      {
        "slug": "regenerate-key",
        "position": 4,
        "question": {
          "en": "Can I regenerate my API key?",
          "nl": "Kan ik mijn API-sleutel opnieuw genereren?",
          "fr": "Puis-je régénérer ma clé API ?"
        },
        "answer": {
          "en": "Yes. In Settings > Integrations, your API Key has a regenerate button next to it. Regenerating the key will invalidate the old one, so make sure to update any systems using the previous key immediately.",
          "nl": "Ja. In Instellingen > Integraties staat naast je API-sleutel een knop om hem opnieuw te genereren. Door de sleutel opnieuw te genereren wordt de oude ongeldig, dus zorg ervoor dat je alle systemen die de vorige sleutel gebruiken onmiddellijk bijwerkt.",
          "fr": "Oui. Dans Paramètres > Intégrations, votre clé API dispose d'un bouton de régénération à côté d'elle. La régénération de la clé invalide l'ancienne ; veillez donc à mettre immédiatement à jour tous les systèmes qui utilisaient la clé précédente."
        }
      }
    ]
  },
  {
    "id": "settings",
    "position": 11,
    "isReserved": false,
    "titles": {
      "en": "Settings & Account Management",
      "nl": "Instellingen & accountbeheer",
      "fr": "Paramètres et gestion du compte"
    },
    "items": [
      {
        "slug": "update-profile",
        "position": 0,
        "question": {
          "en": "How do I update my profile information?",
          "nl": "Hoe werk ik mijn profielgegevens bij?",
          "fr": "Comment mettre à jour les informations de mon profil ?"
        },
        "answer": {
          "en": "Go to Settings > Profile. You can update your First Name and Last Name. Your email address is managed by Clerk (our authentication provider) and cannot be changed directly in HandsOff. Use the Clerk user menu to manage email and password.",
          "nl": "Ga naar Instellingen > Profiel. Je kan je Voornaam en Achternaam aanpassen. Je e-mailadres wordt beheerd door Clerk (onze authenticatieprovider) en kan niet rechtstreeks in HandsOff worden gewijzigd. Gebruik het gebruikersmenu van Clerk om je e-mail en wachtwoord te beheren.",
          "fr": "Rendez-vous dans Paramètres > Profil. Vous pouvez mettre à jour votre Prénom et votre Nom. Votre adresse e-mail est gérée par Clerk (notre fournisseur d'authentification) et ne peut pas être modifiée directement dans HandsOff. Utilisez le menu utilisateur Clerk pour gérer votre e-mail et votre mot de passe."
        }
      },
      {
        "slug": "notifications",
        "position": 1,
        "question": {
          "en": "How do notification settings work?",
          "nl": "Hoe werken de notificatie-instellingen?",
          "fr": "Comment fonctionnent les paramètres de notifications ?"
        },
        "answer": {
          "en": "In Settings > Notifications, you can configure: Sound Notifications (with adjustable volume), Desktop Notifications (browser alerts), and Handoff Notifications Only (receive alerts only for handoff requests, not all messages).",
          "nl": "In Instellingen > Notificaties kan je het volgende configureren: Geluidsnotificaties (met aanpasbaar volume), Desktopnotificaties (browsermeldingen) en Enkel overdrachtsnotificaties (alleen meldingen voor overdrachtsverzoeken, niet voor alle berichten).",
          "fr": "Dans Paramètres > Notifications, vous pouvez configurer : les Notifications sonores (avec volume ajustable), les Notifications bureau (alertes du navigateur) et les Notifications de transfert uniquement (recevez des alertes uniquement pour les demandes de transfert, pas pour tous les messages)."
        }
      },
      {
        "slug": "theme",
        "position": 2,
        "question": {
          "en": "Can I change the dashboard theme?",
          "nl": "Kan ik het thema van het dashboard wijzigen?",
          "fr": "Puis-je changer le thème du dashboard ?"
        },
        "answer": {
          "en": "Yes. Go to Settings > Appearance and choose between Light, Dark, or System (follows your OS preference). This changes the appearance of your HandsOff dashboard only, not the chat widget.",
          "nl": "Ja. Ga naar Instellingen > Weergave en kies tussen Licht, Donker of Systeem (volgt je OS-voorkeur). Dit wijzigt enkel het uiterlijk van je HandsOff-dashboard, niet van de chatwidget.",
          "fr": "Oui. Rendez-vous dans Paramètres > Apparence et choisissez entre Clair, Sombre ou Système (suit la préférence de votre OS). Cela modifie uniquement l'apparence de votre dashboard HandsOff, pas celle du widget de chat."
        }
      },
      {
        "slug": "logo-name",
        "position": 3,
        "question": {
          "en": "How do I update my organization logo and display name?",
          "nl": "Hoe werk ik mijn organisatielogo en weergavenaam bij?",
          "fr": "Comment mettre à jour le logo et le nom d'affichage de mon organisation ?"
        },
        "answer": {
          "en": "Go to Settings > Widget & Brand. Upload your logo (recommended: 256x256px, PNG or SVG), update your Display Name, and view your active session status. These changes apply to the chat widget header that visitors see.",
          "nl": "Ga naar Instellingen > Widget & merk. Upload je logo (aanbevolen: 256x256 px, PNG of SVG), pas je Weergavenaam aan en bekijk je actieve sessiestatus. Deze wijzigingen worden toegepast op de header van de chatwidget die bezoekers te zien krijgen.",
          "fr": "Rendez-vous dans Paramètres > Widget et Marque. Téléversez votre logo (recommandé : 256 × 256 px, PNG ou SVG), mettez à jour votre Nom d'affichage et consultez le statut de votre session active. Ces modifications s'appliquent à l'en-tête du widget de chat visible par les visiteurs."
        }
      },
      {
        "slug": "embed-widget",
        "position": 4,
        "question": {
          "en": "How do I embed the chat widget on my website?",
          "nl": "Hoe embed ik de chatwidget op mijn website?",
          "fr": "Comment intégrer le widget de chat sur mon site web ?"
        },
        "answer": {
          "en": "In Settings > Widget & Brand, you'll find the Embed Widget section with a ready-to-use HTML script snippet. Copy this snippet and paste it into your website's HTML, just before the closing </body> tag. The widget will appear immediately.",
          "nl": "In Instellingen > Widget & merk vind je de sectie Widget embedden met een kant-en-klaar HTML-scriptsnippet. Kopieer dit snippet en plak het in de HTML van je website, net voor de afsluitende </body>-tag. De widget verschijnt onmiddellijk.",
          "fr": "Dans Paramètres > Widget et Marque, vous trouverez la section Intégrer le widget avec un extrait de script HTML prêt à l'emploi. Copiez cet extrait et collez-le dans le code HTML de votre site, juste avant la balise de fermeture </body>. Le widget apparaîtra immédiatement."
        }
      },
      {
        "slug": "sessions",
        "position": 5,
        "question": {
          "en": "What are Active Sessions and Max Sessions?",
          "nl": "Wat zijn Actieve sessies en Max sessies?",
          "fr": "Que sont les Sessions actives et le nombre maximum de sessions ?"
        },
        "answer": {
          "en": "Active Sessions shows how many visitors are currently chatting with your bot. Max Sessions indicates your plan's session limit. If you approach this limit, consider upgrading your plan for uninterrupted service.",
          "nl": "Actieve sessies geeft aan hoeveel bezoekers op dit moment met je bot chatten. Max sessies geeft de sessielimiet van je abonnement aan. Als je deze limiet nadert, overweeg dan om je abonnement te upgraden om de dienst ononderbroken te houden.",
          "fr": "Les Sessions actives indiquent combien de visiteurs sont actuellement en train de discuter avec votre bot. Le Nombre maximum de sessions indique la limite de sessions de votre formule. Si vous approchez de cette limite, envisagez de passer à une formule supérieure pour un service ininterrompu."
        }
      }
    ]
  },
  {
    "id": "troubleshooting",
    "position": 12,
    "isReserved": false,
    "titles": {
      "en": "Troubleshooting",
      "nl": "Problemen oplossen",
      "fr": "Dépannage"
    },
    "items": [
      {
        "slug": "not-responding",
        "position": 0,
        "question": {
          "en": "My chatbot is not responding. What should I check?",
          "nl": "Mijn chatbot antwoordt niet. Wat moet ik controleren?",
          "fr": "Mon chatbot ne répond pas. Que dois-je vérifier ?"
        },
        "answer": {
          "en": "First, verify that the AI Bot toggle is enabled in AI & Content > AI Bot. Next, check that you have content in your Knowledge Base. Ensure your widget embed code is correctly installed on your website. Finally, verify that your account status is active in Settings > Widget & Brand.",
          "nl": "Controleer eerst of de schakelaar van de AI-bot is ingeschakeld in AI & Content > AI-bot. Controleer vervolgens of er inhoud in je Kennisbank staat. Verzeker je ervan dat je widget-embedcode correct geïnstalleerd is op je website. Controleer ten slotte of je accountstatus actief is in Instellingen > Widget & merk.",
          "fr": "Vérifiez d'abord que l'interrupteur du Bot IA est activé dans IA et Contenu > Bot IA. Ensuite, assurez-vous que votre Base de connaissances contient du contenu. Vérifiez que le code d'intégration de votre widget est correctement installé sur votre site web. Enfin, vérifiez que le statut de votre compte est actif dans Paramètres > Widget et Marque."
        }
      },
      {
        "slug": "widget-not-showing",
        "position": 1,
        "question": {
          "en": "The chat widget is not showing on my website. Why?",
          "nl": "De chatwidget verschijnt niet op mijn website. Waarom?",
          "fr": "Le widget de chat ne s'affiche pas sur mon site. Pourquoi ?"
        },
        "answer": {
          "en": "Check that the embed script is placed before the closing </body> tag. Verify your API key in the script matches your current key in Settings > Integrations. Check browser console for JavaScript errors. Ensure no ad blockers or content security policies are blocking the widget.",
          "nl": "Controleer of het embed-script vóór de afsluitende </body>-tag is geplaatst. Controleer of de API-sleutel in het script overeenkomt met je huidige sleutel in Instellingen > Integraties. Bekijk de browserconsole voor JavaScript-fouten. Zorg ervoor dat geen enkele adblocker of content security policy de widget blokkeert.",
          "fr": "Vérifiez que le script d'intégration est placé avant la balise de fermeture </body>. Vérifiez que la clé API dans le script correspond à votre clé actuelle dans Paramètres > Intégrations. Consultez la console du navigateur pour repérer d'éventuelles erreurs JavaScript. Assurez-vous qu'aucun bloqueur de publicité ni politique de sécurité de contenu ne bloque le widget."
        }
      },
      {
        "slug": "kb-not-used",
        "position": 2,
        "question": {
          "en": "My knowledge base documents are not being used by the AI. Why?",
          "nl": "Mijn kennisbankdocumenten worden niet gebruikt door de AI. Waarom?",
          "fr": "Les documents de ma base de connaissances ne sont pas utilisés par l'IA. Pourquoi ?"
        },
        "answer": {
          "en": "Ensure documents are successfully uploaded (check AI & Content > Knowledge Base for the document list). The AI only uses processed documents — give the system a few minutes after upload. Also verify that your Bot Instructions reference the knowledge base for answering questions.",
          "nl": "Controleer of documenten succesvol zijn geüpload (bekijk AI & Content > Kennisbank voor de documentenlijst). De AI gebruikt enkel verwerkte documenten — geef het systeem enkele minuten na het uploaden. Controleer ook of je Botinstructies verwijzen naar de kennisbank voor het beantwoorden van vragen.",
          "fr": "Assurez-vous que les documents ont été téléversés avec succès (vérifiez la liste dans IA et Contenu > Base de connaissances). L'IA n'utilise que les documents traités — laissez quelques minutes au système après le téléversement. Vérifiez également que vos Instructions du bot font bien référence à la base de connaissances pour répondre aux questions."
        }
      },
      {
        "slug": "handoff-not-reaching",
        "position": 3,
        "question": {
          "en": "Handoff requests are not reaching my agents. What should I do?",
          "nl": "Overdrachtsverzoeken bereiken mijn agents niet. Wat moet ik doen?",
          "fr": "Les demandes de transfert ne parviennent pas à mes agents. Que dois-je faire ?"
        },
        "answer": {
          "en": "Ensure Human Handoff is enabled in Settings > Capabilities. Check that you have agents added in the Team section. Verify notification settings are configured correctly in Settings > Notifications. Confirm agents are online and available in the Inbox.",
          "nl": "Controleer of Overdracht naar mens is ingeschakeld in Instellingen > Functionaliteiten. Controleer of je agents hebt toegevoegd in de sectie Team. Verifieer dat de notificatie-instellingen correct zijn geconfigureerd in Instellingen > Notificaties. Bevestig dat agents online en beschikbaar zijn in de Inbox.",
          "fr": "Assurez-vous que le Transfert humain est activé dans Paramètres > Fonctionnalités. Vérifiez que vous avez des agents ajoutés dans la section Équipe. Vérifiez que les paramètres de notifications sont correctement configurés dans Paramètres > Notifications. Confirmez que les agents sont en ligne et disponibles dans la Boîte de réception."
        }
      },
      {
        "slug": "reset-password",
        "position": 4,
        "question": {
          "en": "How do I reset my password?",
          "nl": "Hoe reset ik mijn wachtwoord?",
          "fr": "Comment réinitialiser mon mot de passe ?"
        },
        "answer": {
          "en": "HandsOff uses Clerk for authentication. To change your password, use the Clerk user menu (accessible from your profile dropdown) or visit your Clerk account settings directly.",
          "nl": "HandsOff gebruikt Clerk voor authenticatie. Om je wachtwoord te wijzigen, gebruik je het Clerk-gebruikersmenu (toegankelijk via je profieldropdown) of ga je rechtstreeks naar je Clerk-accountinstellingen.",
          "fr": "HandsOff utilise Clerk pour l'authentification. Pour modifier votre mot de passe, utilisez le menu utilisateur Clerk (accessible depuis le menu déroulant de votre profil) ou rendez-vous directement dans les paramètres de votre compte Clerk."
        }
      },
      {
        "slug": "additional-support",
        "position": 5,
        "question": {
          "en": "Where can I get additional support?",
          "nl": "Waar kan ik bijkomende ondersteuning krijgen?",
          "fr": "Où puis-je obtenir de l'aide supplémentaire ?"
        },
        "answer": {
          "en": "If you need help beyond this FAQ, contact our support team using the Support Email configured in your AI Bot settings. You can also check the HandsOff documentation portal for detailed guides and video tutorials.",
          "nl": "Heb je meer hulp nodig dan deze FAQ biedt? Neem contact op met ons supportteam via het Support-e-mailadres dat is geconfigureerd in je AI-botinstellingen. Je kan ook het HandsOff-documentatieportaal raadplegen voor gedetailleerde gidsen en videotutorials.",
          "fr": "Si vous avez besoin d'aide au-delà de cette FAQ, contactez notre équipe de support via l'E-mail de support configuré dans vos paramètres du Bot IA. Vous pouvez également consulter le portail de documentation HandsOff pour des guides détaillés et des tutoriels vidéo."
        }
      }
    ]
  }
];
