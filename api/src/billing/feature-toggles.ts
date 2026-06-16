/**
 * Tenant self-service feature toggles — the allowlist of feature keys a
 * tenant's own admin may switch on/off (within their entitlement ceiling).
 *
 * Plan: .scratch/plan-tenant-feature-toggles.md § 2.
 *
 * Only these keys are tenant-toggleable. Dependent children (`crm`,
 * `calendarSync`, `gapEvidence`, `aiBusinessInsights`) are NOT listed — they
 * follow their parent through `enforceFeatureDependencies`. Plan-traits
 * (hideWidgetAttribution, customWidgetAppearance, fileUpload) are billing
 * positioning, never tenant-toggleable.
 *
 * The `satisfies` clause ties this runtime list to the `ToggleableFeatureKey`
 * wire type — adding a non-existent or non-toggleable key fails tsc.
 */
import type { ToggleableFeatureKey } from '../contracts/entitlements';

export type { ToggleableFeatureKey };

export const TENANT_TOGGLEABLE_FEATURES = [
  'channelWhatsapp',
  'channelMessenger',
  'channelInstagram',
  'channelTelegram',
  'leadCapture',
  'bookings',
  'gapInsights',
] as const satisfies readonly ToggleableFeatureKey[];

const TOGGLEABLE_SET: ReadonlySet<string> = new Set(TENANT_TOGGLEABLE_FEATURES);

/** Type guard: is `key` a tenant-toggleable feature? */
export function isToggleableFeature(key: string): key is ToggleableFeatureKey {
  return TOGGLEABLE_SET.has(key);
}
