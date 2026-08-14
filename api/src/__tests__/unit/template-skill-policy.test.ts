/**
 * Blank means "no specialty identity", not "no capabilities".
 *
 * Issue #103. `Blank (no template)` is offered to every tenant as a neutral starting point, and
 * selecting it removed every entitled skill from the bot — booking, lead capture and handoff all
 * stopped being delivered, silently. Two of the three affected production bots, including a paying
 * customer, were broken purely by choosing a documented option.
 *
 * The fix is NOT "an empty skill list means all skills". That would switch tools on for templates
 * that are deliberately knowledge-only, and for a binding that has gone unavailable — the template
 * gate exists precisely so a bot cannot hold a tool its template never gave it.
 *
 * Instead the template says what it intends, and `effectiveSkillIds` is the one place that reads
 * it. Every surface that needs to know a bot's skills — the agent's tool gate, readiness, the
 * coverage advisory — goes through this function, so they cannot drift apart. That drift is the
 * whole bug class: readiness called a bot live while the runtime denied it the tools.
 */
import { describe, it, expect } from 'vitest';
import { effectiveSkillIds } from '../../templates/template-resolver';
import { featureGatedSkillIds } from '../../modules/module-catalog';
import type { ResolvedTemplate } from '../../templates/template-resolver';
import '../../modules'; // register the catalog

/** A resolved binding, with only the fields skill resolution reads. */
function tpl(over: Partial<ResolvedTemplate> = {}): ResolvedTemplate {
  return {
    templateId: 't1',
    body: 'body',
    config: {},
    resolvedVersion: 1,
    category: null,
    expectedModules: [],
    selectedSkillIds: null,
    skillPolicy: 'explicit',
    skillProse: null,
    variables: null,
    pinnedButUnavailable: false,
    templateUnavailable: false,
    ...over,
  } as ResolvedTemplate;
}

const ALL_ON = () => true;
const NONE_ON = () => false;

describe('featureGatedSkillIds — what a plan can inherit', () => {
  it('lists every feature-gated skill when the plan allows all of them', () => {
    expect(featureGatedSkillIds(ALL_ON).sort()).toEqual(['booking', 'handoff', 'lead_capture']);
  });

  it('lists nothing when the plan allows nothing', () => {
    expect(featureGatedSkillIds(NONE_ON)).toEqual([]);
  });

  it('follows the plan per feature, so a free tenant cannot inherit a paid tool', () => {
    const onlyHandoff = featureGatedSkillIds((f) => f === 'handoff');
    expect(onlyHandoff).toEqual(['handoff']);
    expect(onlyHandoff).not.toContain('booking');
  });
});

describe('effectiveSkillIds — explicit templates are unchanged', () => {
  it('a specialty template gets exactly what it selected', () => {
    const skills = effectiveSkillIds([tpl({ selectedSkillIds: ['lead_capture', 'handoff'] })], featureGatedSkillIds(ALL_ON));
    expect(skills.sort()).toEqual(['handoff', 'lead_capture']);
  });

  it('does NOT inherit for an explicit template, however much the plan allows', () => {
    // The kappers template selects lead_capture + handoff on a plan that includes bookings.
    // Curation is a decision, and inheriting past it would silently undo it.
    const skills = effectiveSkillIds([tpl({ selectedSkillIds: ['lead_capture', 'handoff'] })], featureGatedSkillIds(ALL_ON));
    expect(skills).not.toContain('booking');
  });

  it('still falls back to the legacy expectedModules column', () => {
    const skills = effectiveSkillIds([tpl({ selectedSkillIds: null, expectedModules: ['booking'] })], []);
    expect(skills).toEqual(['booking']);
  });
});

describe('effectiveSkillIds — Blank inherits what the plan already allows', () => {
  it('gives an inheriting template every feature-gated skill the plan enables', () => {
    const skills = effectiveSkillIds(
      [tpl({ skillPolicy: 'inherit_entitled', selectedSkillIds: null })],
      featureGatedSkillIds(ALL_ON),
    );
    expect(skills.sort()).toEqual(['booking', 'handoff', 'lead_capture']);
  });

  it('inherits NOTHING the plan does not allow', () => {
    const skills = effectiveSkillIds(
      [tpl({ skillPolicy: 'inherit_entitled' })],
      featureGatedSkillIds((f) => f === 'leadCapture'),
    );
    expect(skills).toEqual(['lead_capture']);
  });

  it('unions inheritance with a second binding\'s explicit selection, without duplicates', () => {
    const skills = effectiveSkillIds(
      [tpl({ skillPolicy: 'inherit_entitled' }), tpl({ templateId: 't2', selectedSkillIds: ['booking'] })],
      featureGatedSkillIds(ALL_ON),
    );
    expect(skills.sort()).toEqual(['booking', 'handoff', 'lead_capture']);
    expect(skills.filter((s) => s === 'booking')).toHaveLength(1);
  });
});

describe('effectiveSkillIds — the cases that must stay tool-free', () => {
  it('a deliberately knowledge-only template grants nothing, even with a full plan', () => {
    const skills = effectiveSkillIds(
      [tpl({ skillPolicy: 'none', selectedSkillIds: ['booking'] })],
      featureGatedSkillIds(ALL_ON),
    );
    expect(skills).toEqual([]);
  });

  it('an UNBOUND bot inherits nothing — no template, no skills', () => {
    expect(effectiveSkillIds([], featureGatedSkillIds(ALL_ON))).toEqual([]);
  });

  it('a binding whose template is unavailable inherits nothing', () => {
    // A vertical that was archived must not silently become the everything-bot.
    const skills = effectiveSkillIds(
      [tpl({ skillPolicy: 'inherit_entitled', templateUnavailable: true, resolvedVersion: null })],
      featureGatedSkillIds(ALL_ON),
    );
    expect(skills).toEqual([]);
  });

  it('treats a missing policy as explicit, so a cached pre-migration bundle cannot inherit', () => {
    // Bundles are cached; one written before the column existed deserialises with no policy.
    // Defaulting to `inherit_entitled` there would hand tools to every template in the cache.
    const legacy = tpl({ selectedSkillIds: ['handoff'] });
    delete (legacy as Partial<ResolvedTemplate>).skillPolicy;
    expect(effectiveSkillIds([legacy], featureGatedSkillIds(ALL_ON))).toEqual(['handoff']);
  });
});
