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
  // A tier default on Pro and Enterprise. It was deliberately off at every tier during
  // rollout, granted only by per-tenant override, because a tier default would have
  // entitled every Pro tenant the moment it deployed and the gates were not yet closed.
  // All of them now are: #63 (unreachable slots are not offered), #66 (coordinate
  // expiry), #67 (portal settings + Google attribution), #68 (degradation is loud), #77
  // (a captured Request says why), and the Google billing account is off its free trial.
  //
  // Entitling a tenant still spends nothing on its own. `travel_time_enabled` on
  // BookingSettings defaults false, so an owner must switch it on per Agent before a
  // single Google element is bought. The ceiling is commercial; that toggle is the tap.
  //
  // `requires: bookings` keeps it off Free and Essential whatever the catalog says, so
  // "every tier that can book" is exactly Pro and Enterprise.
  travelTime: {
    label: 'Travel-time aware scheduling',
    group: 'bookings',
    requires: 'bookings',
  },
  // The widget is the native channel — always on, no key, never listed here.
  channelWhatsapp: { label: 'WhatsApp', group: 'channels' },
  channelMessenger: { label: 'Facebook Messenger', group: 'channels' },
  channelInstagram: { label: 'Instagram DMs', group: 'channels' },
  channelTelegram: { label: 'Telegram', group: 'channels' },
  channelLinkedin: { label: 'LinkedIn', group: 'channels' },
  channelTiktok: { label: 'TikTok', group: 'channels' },
  channelX: { label: 'X', group: 'channels' },
  leadCapture: { label: 'Lead capture', group: 'leads' },
  leadEnrichment: {
    label: 'Structured lead data',
    group: 'leads',
    requires: 'leadCapture',
  },
  // Label says "not implemented" on purpose: this is the super-admin override grid, and
  // granting this key today changes nothing at all. Its chip-offer implementation was
  // removed as unreachable (see OPT_IN_FEATURES in feature-toggles.ts) and the
  // prompt-level replacement is not built, so a super admin toggling it for a tenant
  // would otherwise be promising a behaviour the product cannot deliver.
  proactiveLeadCapture: {
    label: 'Ask for missing contact details (not implemented)',
    group: 'leads',
    requires: 'leadCapture',
  },
  crm: { label: 'CRM', group: 'leads', requires: 'leadCapture' },
  unifiedInbox: { label: 'Unified inbox', group: 'inbox' },
  handoff: { label: 'Human handoff', group: 'inbox' },
  platformAssistant: { label: 'AI Platform Assistant', group: 'platform' },
  // Tiered Insights ladder (ADR-0013 / Deviation 36). Tier→flag mapping
  // lives in plans.ts — never branch on tier names in insights code.
  gapInsights: { label: 'AI Insights (Gaps)', group: 'insights' },
  gapEvidence: {
    label: 'Gap evidence, recommendations & weekly snapshots',
    group: 'insights',
    requires: 'gapInsights',
  },
  aiBusinessInsights: {
    label: 'AI Business Insights (correlation, sentiment, alerts, export)',
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
