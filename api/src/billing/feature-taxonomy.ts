/**
 * Feature taxonomy — static metadata over the flat feature keys: display
 * label, logical group, and parent dependency. The resolved entitlement
 * shape stays a flat boolean map (every gate reads `features.x`); this file
 * only adds structure on top:
 *
 *   - `requires`: a child feature is meaningless without its parent (calendar
 *     sync mirrors bookings; CRM scores leads). `enforceFeatureDependencies`
 *     forces a child off whenever its parent is off — fail closed, applied
 *     AFTER the override merge so neither a tier default nor an admin
 *     override can produce the nonsense state.
 *   - `group` / FEATURE_GROUPS: how the super-admin UI clusters the rows
 *     ("plan traits" collapsed by default — positioning, not operations).
 */
import type { FeatureKey } from './types';

export interface FeatureMeta {
  label: string;
  group: 'bookings' | 'channels' | 'leads' | 'inbox' | 'platform' | 'insights' | 'plan-traits';
  /** Parent feature this one depends on — forced off when the parent is off. */
  requires?: FeatureKey;
}

export const FEATURE_GROUPS: Record<FeatureMeta['group'], { label: string; collapsed?: boolean }> = {
  bookings: { label: 'Bookings' },
  channels: { label: 'Channels' },
  leads: { label: 'Leads & CRM' },
  inbox: { label: 'Inbox & support' },
  platform: { label: 'Platform' },
  insights: { label: 'AI Insights' },
  'plan-traits': { label: 'Plan traits', collapsed: true },
};

export const FEATURE_TAXONOMY: Record<FeatureKey, FeatureMeta> = {
  bookings: { label: 'Bookings', group: 'bookings' },
  calendarSync: {
    label: 'Calendar sync (Google/Outlook)',
    group: 'bookings',
    requires: 'bookings',
  },
  // The widget is the native channel — always on, no key, never listed here.
  channelWhatsapp: { label: 'WhatsApp', group: 'channels' },
  channelMessenger: { label: 'Facebook Messenger', group: 'channels' },
  channelInstagram: { label: 'Instagram DMs', group: 'channels' },
  channelTelegram: { label: 'Telegram', group: 'channels' },
  leadCapture: { label: 'Lead capture', group: 'leads' },
  crm: { label: 'CRM', group: 'leads', requires: 'leadCapture' },
  unifiedInbox: { label: 'Unified inbox', group: 'inbox' },
  handoff: { label: 'Human handoff', group: 'inbox' },
  platformAssistant: { label: 'AI Platform Assistant', group: 'platform' },
  // Tiered Insights ladder (ADR-0013 / Deviation 36). Tier→flag mapping
  // lives in plans.ts — never branch on tier names in insights code.
  gapInsights: { label: 'AI Insights (Gaps)', group: 'insights' },
  gapEvidence: { label: 'Gap evidence drill-down', group: 'insights', requires: 'gapInsights' },
  aiBusinessInsights: {
    label: 'AI Business Insights (digest, correlation, sentiment, export)',
    group: 'insights',
    requires: 'gapInsights',
  },
  hideWidgetAttribution: { label: 'Hide widget attribution', group: 'plan-traits' },
  customWidgetAppearance: { label: 'Custom widget appearance', group: 'plan-traits' },
  fileUpload: { label: 'File upload', group: 'plan-traits' },
};

/**
 * Force every dependent feature off when its parent is off. Mutates the
 * (already-cloned) feature map in place. Deps are single-level today; the
 * loop-until-stable handles any future chain without ordering concerns.
 */
export function enforceFeatureDependencies(features: Record<FeatureKey, boolean>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, meta] of Object.entries(FEATURE_TAXONOMY) as Array<[FeatureKey, FeatureMeta]>) {
      if (meta.requires && features[key] && !features[meta.requires]) {
        features[key] = false;
        changed = true;
      }
    }
  }
}
