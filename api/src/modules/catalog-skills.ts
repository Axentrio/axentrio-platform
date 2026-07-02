/**
 * Catalog-only engineered skills. These make a capability BINDABLE by a module and
 * give it a per-tenant state (entitled → ready) in Bot Studio, but they contribute
 * NO tools and NO prompt section themselves — the actual runtime behaviour stays in
 * the existing builtin blocks + tool registry (kept intact to avoid prompt churn).
 *
 * A module bound to one of these surfaces its authored wording when the skill is
 * ready; the skill's real work (the capture_lead / escalate_to_human tools) is
 * unchanged. `provides` is display metadata only. Promoting these to fully
 * self-contained skills (owning their prompt section too) is a later, careful pass.
 */
import type { ModuleDefinition } from './module-catalog';

export const leadCaptureSkill: ModuleDefinition = {
  id: 'lead_capture',
  displayName: 'Lead capture',
  description: 'Collects a visitor’s name and contact details so your team can follow up.',
  readinessHint: 'Ready as soon as your plan includes lead capture — no setup needed.',
  defaultProse: 'When the customer describes what they need or shares their name, email, or phone, capture it so the team can follow up — then keep helping them in the same reply.',
  provides: ['capture_lead'],
  gate: { kind: 'feature', feature: 'leadCapture' },
  tools: [],
};

export const handoffSkill: ModuleDefinition = {
  id: 'handoff',
  displayName: 'Human handoff',
  description: 'Hands the conversation to a human when the customer asks or the bot is unsure.',
  readinessHint: 'Ready as soon as your plan includes handoff — no setup needed.',
  defaultProse: 'When the customer asks for a person, or you have reached the limit of what you can help with, offer to connect them with the team.',
  provides: ['escalate_to_human'],
  gate: { kind: 'feature', feature: 'handoff' },
  tools: [],
};
