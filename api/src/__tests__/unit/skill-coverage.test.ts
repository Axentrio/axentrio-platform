/**
 * Skill coverage — the entitled-but-undelivered diagnostic (modules/skill-coverage.ts).
 *
 * Regression cover for the production incident: a Pro tenant's bot bound a template
 * whose selected_skill_ids was ["booking"], so the agent's template tool-gate
 * stripped capture_lead and the paid-for Leads feature was silently dead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findUnselectedEntitledSkills, computeUnselectedEntitledSkills } from '../../modules/skill-coverage';
import { registerModule, clearCatalogForTests, type ModuleDefinition } from '../../modules/module-catalog';
import type { Entitlements } from '../../billing/types';

// The three shipped feature-gated skills, in catalog shape. Injected rather than
// registered so these tests never depend on import-time registration order.
const CATALOG: ModuleDefinition[] = [
  { id: 'booking', displayName: 'Bookings', gate: { kind: 'feature', feature: 'bookings' }, tools: [] },
  { id: 'lead_capture', displayName: 'Lead capture', gate: { kind: 'feature', feature: 'leadCapture' }, tools: [] },
  { id: 'handoff', displayName: 'Human handoff', gate: { kind: 'feature', feature: 'handoff' }, tools: [] },
  // Bespoke per-tenant work — never promised by a plan, so never warned about.
  { id: 'bespoke_crm_sync', displayName: 'CRM sync', gate: { kind: 'enablement' }, tools: [] },
];

const PRO = { bookings: true, leadCapture: true, handoff: true } as const;

describe('findUnselectedEntitledSkills', () => {
  it('warns for an entitled feature whose skill no bound template selects (the incident)', () => {
    const warnings = findUnselectedEntitledSkills({
      selectedSkillIds: ['booking'],
      features: PRO,
      skills: CATALOG,
    });
    expect(warnings).toEqual([
      { feature: 'leadCapture', skillId: 'lead_capture', skillName: 'Lead capture' },
      { feature: 'handoff', skillId: 'handoff', skillName: 'Human handoff' },
    ]);
  });

  it('does NOT warn when a bound template selects the skill', () => {
    const warnings = findUnselectedEntitledSkills({
      selectedSkillIds: ['booking', 'lead_capture', 'handoff'],
      features: PRO,
      skills: CATALOG,
    });
    expect(warnings).toEqual([]);
  });

  it('does NOT warn for a feature the tenant is not entitled to', () => {
    // Essential-shaped: leadCapture off. Omitting a skill you never bought is not
    // a misconfiguration.
    const warnings = findUnselectedEntitledSkills({
      selectedSkillIds: ['booking'],
      features: { bookings: true, leadCapture: false, handoff: false },
      skills: CATALOG,
    });
    expect(warnings).toEqual([]);
  });

  it('does NOT warn for an entitled feature the tenant switched OFF', () => {
    // `features` is the EFFECTIVE map (ceiling ∧ preference) — a tenant-disabled
    // feature already resolves false there, so it must stay silent.
    const warnings = findUnselectedEntitledSkills({
      selectedSkillIds: ['booking'],
      features: { bookings: true, leadCapture: false, handoff: true },
      skills: CATALOG,
    });
    expect(warnings.map((w) => w.skillId)).toEqual(['handoff']);
  });

  it('ignores enablement-gated skills entirely', () => {
    const warnings = findUnselectedEntitledSkills({
      selectedSkillIds: ['booking', 'lead_capture', 'handoff'],
      features: PRO,
      skills: CATALOG,
    });
    expect(warnings.some((w) => w.skillId === 'bespoke_crm_sync')).toBe(false);
  });
});

// ── Async wrapper: binding resolution + the two deliberate silences ───────────

vi.mock('../../templates/template-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../templates/template-resolver')>();
  return { ...actual, resolveBoundTemplates: vi.fn() };
});
import { resolveBoundTemplates } from '../../templates/template-resolver';

/** A resolved binding carrying just the fields the selection reads. */
const bound = (selectedSkillIds: string[] | null, expectedModules: string[] = []) =>
  ({ selectedSkillIds, expectedModules }) as never;

const entitlements = { features: PRO } as unknown as Entitlements;
const BOT = { templateId: 'tpl-1', templateVersion: 'latest' };

describe('computeUnselectedEntitledSkills', () => {
  beforeEach(() => {
    process.env.COMPOSABLE_TEMPLATES_ENABLED = 'true';
    vi.mocked(resolveBoundTemplates).mockReset();
    // The wrapper reads the REGISTERED catalog (that's the point — the mapping is
    // derived, not hardcoded), so stand up the shipped shape via the test seam
    // instead of importing modules/index and its whole runtime dependency tree.
    clearCatalogForTests();
    for (const def of CATALOG) registerModule(def);
  });
  afterEach(() => {
    delete process.env.COMPOSABLE_TEMPLATES_ENABLED;
    clearCatalogForTests();
  });

  it('warns for the skills the bound templates omit', async () => {
    vi.mocked(resolveBoundTemplates).mockResolvedValue([bound(['booking'])]);
    const warnings = await computeUnselectedEntitledSkills(BOT, entitlements);
    expect(warnings.map((w) => w.skillId)).toEqual(['lead_capture', 'handoff']);
  });

  it('unions ALL bindings — a secondary template covering the skill silences it', async () => {
    vi.mocked(resolveBoundTemplates).mockResolvedValue([bound(['booking']), bound(['lead_capture'])]);
    const warnings = await computeUnselectedEntitledSkills(BOT, entitlements);
    expect(warnings.map((w) => w.skillId)).toEqual(['handoff']);
  });

  it('falls back to expectedModules for a legacy template with no selected_skill_ids', async () => {
    vi.mocked(resolveBoundTemplates).mockResolvedValue([bound(null, ['booking', 'lead_capture', 'handoff'])]);
    expect(await computeUnselectedEntitledSkills(BOT, entitlements)).toEqual([]);
  });

  it('is silent with composable gating OFF — no tools are dropped, so nothing is dead', async () => {
    process.env.COMPOSABLE_TEMPLATES_ENABLED = 'false';
    vi.mocked(resolveBoundTemplates).mockResolvedValue([bound(['booking'])]);
    expect(await computeUnselectedEntitledSkills(BOT, entitlements)).toEqual([]);
  });

  it('is silent for an unbound bot — the empty state already says it has no skills', async () => {
    vi.mocked(resolveBoundTemplates).mockResolvedValue([]);
    expect(await computeUnselectedEntitledSkills({}, entitlements)).toEqual([]);
  });
});
