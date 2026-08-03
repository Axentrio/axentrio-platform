/**
 * Where things live in the portal — the only destinations Copilot may name.
 *
 * The spec asks the assistant to "pinpoint where the settings are located when asked",
 * which turns a plausible sentence into a promise: send someone to `/settings/whatsapp`
 * and they get a 404 with no idea whether the feature exists. So the assistant is given
 * the list rather than left to infer it, and told not to invent paths.
 *
 * This is a WHITELIST, not documentation. Every entry must be a real route in
 * portal/src/App.tsx — `copilot-portal-routes.test.ts` asserts that, so a route rename
 * breaks the build instead of silently pointing customers at nothing.
 *
 * Deliberately excluded: `/admin/*` (super-admin only — a tenant admin sent there gets a
 * permission wall) and dynamic routes like `/ai/bots/:id` (Copilot has no resource ids
 * by design; see the registry's no-resource-id invariant).
 */
export interface PortalRoute {
  path: string;
  /** What the customer would call it, matching the sidebar. */
  label: string;
  /** What they can do there — this is what the model matches a question against. */
  purpose: string;
}

export const PORTAL_ROUTES: readonly PortalRoute[] = [
  { path: '/inbox', label: 'Inbox', purpose: 'read conversations, take over from the assistant' },
  {
    path: '/ai',
    label: 'AI & Content',
    purpose:
      'configure the assistant (name, tone, instructions, business hours), upload and manage knowledge documents, test the bot',
  },
  { path: '/analytics', label: 'Analytics', purpose: 'conversation volumes and trends' },
  {
    path: '/channels',
    label: 'Channels',
    purpose: 'connect WhatsApp, Facebook Messenger, Instagram and Telegram',
  },
  { path: '/leads', label: 'Leads', purpose: 'view, edit and export captured leads' },
  {
    path: '/bookings',
    label: 'Bookings',
    purpose: 'connect a calendar, set availability and slot length, manage services and appointments',
  },
  {
    path: '/success-meter',
    label: 'Success Meter',
    purpose: 'AI insights into what customers asked for and what the assistant could not answer',
  },
  { path: '/team', label: 'Team', purpose: 'invite colleagues and set their roles' },
  { path: '/help', label: 'Help & FAQ', purpose: 'written help articles' },
  {
    path: '/settings/widget',
    label: 'Settings → Widget & brand',
    purpose: 'company name, logo, and the embed snippet for the website widget',
  },
  {
    path: '/settings/appearance',
    label: 'Settings → Appearance',
    purpose: 'portal theme and widget colours',
  },
  {
    path: '/settings/features',
    label: 'Settings → Features',
    purpose: 'switch features on or off for the workspace (channels, leads, bookings, Success Meter)',
  },
  {
    path: '/settings/capabilities',
    label: 'Settings → Capabilities',
    purpose: 'choose what the assistant is allowed to do',
  },
  {
    path: '/settings/integrations',
    label: 'Settings → Integrations',
    purpose: 'Google Calendar, Outlook and other external connections',
  },
  {
    path: '/settings/channels',
    label: 'Settings → Channels',
    purpose: 'per-channel message settings',
  },
  {
    path: '/settings/billing',
    label: 'Settings → Billing',
    purpose: 'plan, invoices, payment method, cancelling or upgrading',
  },
  {
    path: '/settings/notifications',
    label: 'Settings → Notifications',
    purpose: 'which emails and alerts you receive',
  },
  { path: '/settings/profile', label: 'Settings → Profile', purpose: 'your name and language' },
];

/** Rendered into the system prompt. */
export function renderRouteDirectory(): string {
  return PORTAL_ROUTES.map((r) => `- ${r.path} — ${r.label}: ${r.purpose}`).join('\n');
}
