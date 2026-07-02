import { describe, it, expect } from 'vitest';
import { gatedToolNames, skillPromptAllowed, allModules } from '../../modules';
import { ToolRegistry } from '../../agent/tool-registry';
// Registers the real skills (booking / lead_capture / handoff) into the catalog.
import '../../modules';

const ACTIVE = ['booking', 'lead_capture', 'handoff'];

describe('gatedToolNames — template-authoritative skill gating', () => {
  it('drops EVERY tool of an unselected skill, including tools missing from `provides` (list_bookings regression)', () => {
    // Bot bound to lead_capture only → booking + handoff tools must all drop.
    const drop = gatedToolNames(['lead_capture'], ACTIVE);
    // list_bookings is in booking's `tools` but NOT its curated `provides` — the
    // exact leak this guards against.
    expect(drop.has('list_bookings')).toBe(true);
    expect(drop.has('check_availability')).toBe(true);
    expect(drop.has('create_booking')).toBe(true);
    expect(drop.has('escalate_to_human')).toBe(true); // handoff, also unselected
    // The selected skill's tool is NOT dropped.
    expect(drop.has('capture_lead')).toBe(false);
  });

  it('drops nothing a bot fully selects; drops the complement', () => {
    // Bound to booking only → capture_lead + escalate_to_human drop; booking stays.
    const drop = gatedToolNames(['booking'], ACTIVE);
    expect(drop.has('capture_lead')).toBe(true);
    expect(drop.has('escalate_to_human')).toBe(true);
    expect(drop.has('check_availability')).toBe(false);
    expect(drop.has('list_bookings')).toBe(false);
  });

  it('no template selection (unbound) → every active skill drops (KB-only bot)', () => {
    const drop = gatedToolNames([], ACTIVE);
    for (const t of ['check_availability', 'create_booking', 'list_bookings', 'capture_lead', 'escalate_to_human']) {
      expect(drop.has(t)).toBe(true);
    }
  });
});

describe('tool attribution completeness (H3 — every loadable tool must be gateable)', () => {
  // kb_search is an always-on core capability, not a gateable skill.
  const CORE_ALLOWLIST = new Set(['kb_search']);

  it('every shipped tool is core-allowlisted or owned by exactly one skill', () => {
    const registry = new ToolRegistry();
    const shipped = registry.getBuiltinToolNames();
    // tool name → owning skill ids, from the catalog's provides ∪ tools.
    const owners: Record<string, Set<string>> = {};
    for (const m of allModules()) {
      for (const n of [...(m.provides ?? []), ...m.tools.map((t) => t.name)]) {
        (owners[n] ??= new Set()).add(m.id);
      }
    }
    // Unattributed = the list_bookings/escalate_to_human bug class: a tool the template
    // gate can NEVER drop (gatedToolNames only reaches tools owned by an active skill).
    const unattributed = shipped.filter((n) => !CORE_ALLOWLIST.has(n) && !(owners[n]?.size));
    const collisions = shipped.filter((n) => (owners[n]?.size ?? 0) > 1).map((n) => `${n} → ${[...owners[n]].join(',')}`);
    expect(unattributed).toEqual([]);
    expect(collisions).toEqual([]);
  });
});

describe('skillPromptAllowed — prompt gated in lockstep with tools (LEAK-1 regression)', () => {
  it('a gated skill\'s prompt section is excluded, matching its dropped tools', () => {
    // lead_capture-only bot: booking's SERVICES/"you MUST call create_booking" section must NOT be built.
    expect(skillPromptAllowed('booking', ['lead_capture'], true)).toBe(false);
    expect(skillPromptAllowed('lead_capture', ['lead_capture'], true)).toBe(true);
  });
  it('unbound bot builds no skill sections; flag off preserves legacy (all sections)', () => {
    expect(skillPromptAllowed('booking', [], true)).toBe(false);      // KB-only → no booking prompt
    expect(skillPromptAllowed('booking', [], false)).toBe(true);      // flag off → legacy behaviour
  });
});
