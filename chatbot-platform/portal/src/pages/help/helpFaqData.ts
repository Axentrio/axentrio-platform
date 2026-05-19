/**
 * FAQ structure. The actual question and answer text lives in the i18n
 * locale files under `help.faq.sections.<sectionId>.items.<itemId>.{q,a}` —
 * this file only knows the shape and the ordering. Section title comes from
 * `help.faq.sections.<sectionId>.title`.
 */

export interface FaqItem {
  /** Stable id used to look up `q` and `a` translation keys. */
  id: string;
}

export interface FaqSection {
  /** Stable id used to look up section title + item translation keys. */
  id: string;
  items: FaqItem[];
}

export const FAQ_DOC_FILENAME = 'HandsOff_FAQ.pdf';
export const FAQ_DOC_PATH = `/${FAQ_DOC_FILENAME}`;

export const faqSections: FaqSection[] = [
  {
    id: 'getting-started',
    items: [
      { id: 'what-is-handsoff' },
      { id: 'how-to-get-started' },
      { id: 'what-channels' },
      { id: 'need-coding' },
      { id: 'free-trial' },
    ],
  },
  {
    id: 'ai-bot',
    items: [
      { id: 'configure-identity' },
      { id: 'bot-instructions' },
      { id: 'change-tone' },
      { id: 'disable-temporarily' },
      { id: 'greeting-message' },
    ],
  },
  {
    id: 'knowledge-base',
    items: [
      { id: 'what-is-kb' },
      { id: 'file-formats' },
      { id: 'add-documents' },
      { id: 'only-from-kb' },
      { id: 'update-content' },
    ],
  },
  {
    id: 'custom-responses',
    items: [
      { id: 'what-are' },
      { id: 'create' },
      { id: 'categorize' },
      { id: 'when-used' },
    ],
  },
  {
    id: 'appearance',
    items: [
      { id: 'customize' },
      { id: 'company-logo' },
      { id: 'launcher-label' },
      { id: 'welcome-message' },
      { id: 'preview' },
    ],
  },
  {
    id: 'channels',
    items: [
      { id: 'platforms' },
      { id: 'connect-telegram' },
      { id: 'connect-facebook' },
      { id: 'unified-inbox' },
    ],
  },
  {
    id: 'analytics',
    items: [
      { id: 'metrics' },
      { id: 'chat-volume' },
      { id: 'export' },
      { id: 'setup-checklist' },
    ],
  },
  {
    id: 'team',
    items: [
      { id: 'invite-members' },
      { id: 'roles' },
      { id: 'add-agent' },
      { id: 'schedule-shifts' },
      { id: 'statistics' },
    ],
  },
  {
    id: 'handoff',
    items: [
      { id: 'what-is' },
      { id: 'visitor-request' },
      { id: 'where-appear' },
      { id: 'ai-resume' },
      { id: 'enable-disable' },
    ],
  },
  {
    id: 'capabilities',
    items: [
      { id: 'what-are' },
      { id: 'lead-capture' },
      { id: 'book-appointments' },
      { id: 'connect-calendar' },
      { id: 'team-notifications' },
    ],
  },
  {
    id: 'integrations',
    items: [
      { id: 'api' },
      { id: 'webhook-url' },
      { id: 'inbound-webhook' },
      { id: 'secure-webhooks' },
      { id: 'regenerate-key' },
    ],
  },
  {
    id: 'settings',
    items: [
      { id: 'update-profile' },
      { id: 'notifications' },
      { id: 'theme' },
      { id: 'logo-name' },
      { id: 'embed-widget' },
      { id: 'sessions' },
    ],
  },
  {
    id: 'troubleshooting',
    items: [
      { id: 'not-responding' },
      { id: 'widget-not-showing' },
      { id: 'kb-not-used' },
      { id: 'handoff-not-reaching' },
      { id: 'reset-password' },
      { id: 'additional-support' },
    ],
  },
];

/**
 * i18n key helpers — keep all key construction in one place so renaming
 * sections or items doesn't scatter string concatenation across components.
 */
export const sectionTitleKey = (sectionId: string) =>
  `help.faq.sections.${sectionId}.title`;

export const itemQuestionKey = (sectionId: string, itemId: string) =>
  `help.faq.sections.${sectionId}.items.${itemId}.q`;

export const itemAnswerKey = (sectionId: string, itemId: string) =>
  `help.faq.sections.${sectionId}.items.${itemId}.a`;
