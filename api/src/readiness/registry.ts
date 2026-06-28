/**
 * Capability-readiness registry (.scratch/plan-capability-readiness-framework.md,
 * Decision 2). A standalone registry — deliberately NOT an extension of
 * `ModuleDefinition` (that has no `appliesTo`/`readiness` and only booking is a
 * module; answering/lead are skills, channels are rows).
 *
 * Each capability contributes ONE entry keyed by `key`. `appliesTo` decides
 * whether to evaluate/surface the capability for a bot (the tenant's declared
 * INTENT — see Decision 3). `check` returns an ARRAY: the singleton capabilities
 * return a single element; the channel contributor returns one per
 * ChannelConnection row. The endpoint flat-maps the arrays.
 *
 * Registration is static, import-time, and mirrors the module pattern: a
 * duplicate key THROWS at registration so two contributors can never silently
 * collide.
 */
import type { Bot } from '../database/entities/Bot';
import type { Entitlements } from '../billing/types';

export type CapabilityKey = 'booking' | 'answering' | 'lead_capture' | 'channel';

export type ReadinessState = 'not_ready' | 'live';

/** A deep-link CTA for a missing step or attention item. */
export interface ReadinessCta {
  route: string;
  label: string;
}

/** One readiness result. Singletons emit one; the channel contributor emits one
 *  per ChannelConnection row (each carrying its own `instanceId`/`detail`). */
export interface ReadinessResult {
  capability: CapabilityKey;
  /** The ChannelConnection id for `channel` (one result per row); undefined for the singletons. */
  instanceId?: string;
  state: ReadinessState;
  /** ORDERED PATH TO `live` ONLY — empty when state === 'live' (even a live-but-degraded booking). */
  missingSteps: { id: string; label: string; cta?: ReadinessCta }[];
  /** Silent-degradation / can't-do-MORE, non-blocking (e.g. live booking that can't auto-confirm). */
  attention?: { code: string; label: string; cta?: ReadinessCta }[];
  /** Capability-specific detail (e.g. booking: { willAutoConfirm, bookingTemplateActive, calendar }). */
  detail?: Record<string, unknown>;
}

/** The per-bot context passed to every contributor. Resolved ONCE at the
 *  endpoint; checks read it purely (never re-resolve). */
export interface ReadinessBotCtx {
  tenantId: string;
  /** Pre-resolved bot row (settings, templateBindings, status). */
  bot: Bot;
  /** Resolved ONCE at the endpoint and passed in; checks read it purely. */
  entitlements: Entitlements;
}

export interface CapabilityReadiness {
  /** ONE contributor per capability — `channel` is a single contributor, not `channel:<type>`. */
  key: CapabilityKey;
  /** Whether to evaluate/surface this capability for the bot (declared intent). */
  appliesTo(ctx: ReadinessBotCtx): Promise<boolean> | boolean;
  /** The singletons return one element; the channel contributor returns one per row. */
  check(ctx: ReadinessBotCtx): Promise<ReadinessResult[]>;
}

const registry = new Map<CapabilityKey, CapabilityReadiness>();

/** Register a capability contributor. Duplicate key throws (mirrors the module
 *  registry) so import-time collisions surface immediately. */
export function registerCapability(capability: CapabilityReadiness): void {
  if (registry.has(capability.key)) {
    throw new Error(`Capability already registered: ${capability.key}`);
  }
  registry.set(capability.key, capability);
}

/** All registered capability contributors (registration order). */
export function getCapabilities(): CapabilityReadiness[] {
  return [...registry.values()];
}
