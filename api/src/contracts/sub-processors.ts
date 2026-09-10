/**
 * Sub-processors, in one place.
 *
 * The privacy notice and the public sub-processor page both render THIS list, and
 * a test asserts the DPA draft names every entry. Three copies of a compliance
 * disclosure is three chances to be wrong in public, and the one a customer reads
 * is never the one that was updated.
 *
 * Deliberately no `location` field: the processing region for each vendor has to
 * come from their own DPA, not from our recollection, and publishing a guess about
 * where data lives is worse than publishing nothing. The transfer mechanism
 * belongs in the DPA.
 */
export interface SubProcessor {
  /** As the vendor is commonly known — the name a customer would search for. */
  name: string;
  /** What we use them for, in the customer's words. */
  purpose: string;
  /** The categories of personal data that reach them. */
  data: string;
}

export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    name: 'Railway',
    purpose: 'Application hosting, managed PostgreSQL and Redis',
    data: 'All platform data',
  },
  {
    name: 'Cloudflare',
    purpose: 'DNS, file storage (R2) and database backups',
    data: 'Uploaded files; database backups',
  },
  {
    name: 'OpenAI',
    purpose: 'Language-model inference for AI replies and insights',
    data: 'Conversation content and prompts sent for a turn',
  },
  {
    name: 'Anthropic',
    purpose: 'Language-model inference for AI replies',
    data: 'Conversation content and prompts sent for a turn',
  },
  {
    name: 'Clerk',
    purpose: 'Authentication and organisation management',
    data: 'Staff account identifiers and email addresses',
  },
  {
    name: 'Stripe',
    purpose: 'Payments, invoices and subscription billing',
    data: 'Customer billing details and invoice records',
  },
  {
    name: 'Resend',
    purpose: 'Transactional email',
    data: 'Recipient email addresses and message content',
  },
  {
    name: 'Sentry',
    purpose: 'Error monitoring',
    data: 'Error context, which may incidentally contain personal data',
  },
  {
    name: 'Google',
    purpose: 'Calendar, maps and file integrations',
    data: 'Only when a Customer connects them',
  },
  {
    name: 'Microsoft',
    purpose: 'Outlook calendar and OneDrive integrations',
    data: 'Only when a Customer connects them',
  },
  {
    name: 'Meta',
    purpose: 'WhatsApp, Instagram and Messenger message delivery',
    data: 'Only for the channels a Customer connects',
  },
];
