/**
 * Template-vs-tenant guardrail precedence.
 *
 * A bound template owns the POLICY guardrails, but "owns" has to mean the keys it
 * actually set. `effectiveConfigFrom` fills every key from PLATFORM_DEFAULT_CONFIG
 * so direct readers get a complete object — and overlaying THAT onto a bot used to
 * replace the tenant's greeting/fallback/off-hours with '' whenever the template
 * was silent about them.
 *
 * That shipped: "Valyro prompt" v1 sets only maxResponseLength + confidenceThreshold,
 * so a Dutch tenant's "Laat me je verbinden met ons team" was blanked and WhatsApp
 * customers got the hardcoded English "Something went wrong…" instead. The template
 * editor writes these keys only when non-empty, so absent means unset, never
 * "deliberately empty".
 */
import { describe, it, expect } from 'vitest';
import {
  effectiveConfigFrom,
  effectiveConfigFromList,
  withEffectiveConfig,
  type ResolvedTemplate,
} from '../../templates/template-resolver';

const resolved = (config: ResolvedTemplate['config'], id: string | null = 't1'): ResolvedTemplate => ({
  templateId: id,
  body: 'body',
  config,
  resolvedVersion: 1,
  category: null,
  expectedModules: [],
  selectedSkillIds: null,
  skillProse: null,
  variables: null,
  pinnedButUnavailable: false,
  templateUnavailable: false,
});

/**
 * A tenant that has configured its own Dutch messages, as Valyro had. Carries the
 * full guardrail set a real bot stores — including the numeric policy keys, whose
 * values are deliberately NOT the platform defaults so an assertion that the
 * template won cannot pass by coincidence.
 */
const dutchBot = () => ({
  brandVoice: { tone: 'vriendelijk en professioneel' },
  guardrails: {
    greetingMessage: 'Welkom, waar kan ik je mee van dienst zijn?',
    fallbackMessage: 'Laat me je verbinden met ons team',
    offHoursMessage: 'Momenteel buiten kantooruren.',
    escalationKeywords: ['human agent'],
    topicsToAvoid: ['concurrenten'],
    confidenceThreshold: 0.1,
    maxResponseLength: 999,
  },
});

describe('withEffectiveConfig — a silent template must not blank tenant messages', () => {
  it('keeps the tenant messages when the template sets only numeric policy', () => {
    // The exact shape of "Valyro prompt" v1 in production.
    const eff = effectiveConfigFromList([
      resolved({ guardrails: { maxResponseLength: 500, confidenceThreshold: 0.7 } }),
    ]);
    const out = withEffectiveConfig(dutchBot(), eff);

    expect(out.guardrails.greetingMessage).toBe('Welkom, waar kan ik je mee van dienst zijn?');
    expect(out.guardrails.fallbackMessage).toBe('Laat me je verbinden met ons team');
    expect(out.guardrails.offHoursMessage).toBe('Momenteel buiten kantooruren.');
    // …while the keys it DID set still win over the bot's 999 / 0.1.
    expect(out.guardrails.maxResponseLength).toBe(500);
    expect(out.guardrails.confidenceThreshold).toBe(0.7);
  });

  it('still lets a template that sets a message override the tenant', () => {
    const eff = effectiveConfigFromList([
      resolved({ guardrails: { fallbackMessage: 'Template fallback' } }),
    ]);
    const out = withEffectiveConfig(dutchBot(), eff);

    expect(out.guardrails.fallbackMessage).toBe('Template fallback');
    // Untouched siblings stay the tenant's.
    expect(out.guardrails.greetingMessage).toBe('Welkom, waar kan ik je mee van dienst zijn?');
  });

  it('leaves the bot alone entirely when no template is bound', () => {
    const eff = effectiveConfigFromList([]);
    const out = withEffectiveConfig(dutchBot(), eff);

    expect(out.guardrails).toEqual(dutchBot().guardrails);
  });

  it('preserves operational, tenant-owned fields', () => {
    const eff = effectiveConfigFromList([resolved({ guardrails: { maxResponseLength: 300 } })]);
    const out = withEffectiveConfig(dutchBot(), eff);

    expect(out.guardrails.escalationKeywords).toEqual(['human agent']);
    // Tone is bot-owned and must never be overwritten here.
    expect(out.brandVoice.tone).toBe('vriendelijk en professioneel');
  });

  it('does not wipe the tenant topicsToAvoid when no template declares any', () => {
    const eff = effectiveConfigFromList([
      resolved({ guardrails: { maxResponseLength: 500 } }),
      resolved({}, 't2'),
    ]);
    const out = withEffectiveConfig(dutchBot(), eff);

    expect(out.guardrails.topicsToAvoid).toEqual(['concurrenten']);
  });

  it('still unions topicsToAvoid across templates when they declare them', () => {
    const eff = effectiveConfigFromList([
      resolved({ guardrails: { topicsToAvoid: ['pricing'] } }),
      resolved({ guardrails: { topicsToAvoid: ['legal', 'pricing'] } }, 't2'),
    ]);
    const out = withEffectiveConfig(dutchBot(), eff);

    expect([...out.guardrails.topicsToAvoid].sort()).toEqual(['legal', 'pricing']);
  });
});

describe('effectiveConfigFrom — provenance vs resolved view', () => {
  it('reports only the keys the template supplied', () => {
    const eff = effectiveConfigFrom(resolved({ guardrails: { maxResponseLength: 500 } }));

    expect(eff.providedGuardrails).toEqual({ maxResponseLength: 500 });
    expect(eff.source).toBe('template');
  });

  it('still exposes a fully defaults-filled `guardrails` for direct readers', () => {
    // handleBotHandoff reads eff.guardrails.fallbackMessage directly and expects
    // every key present, so this view must stay complete.
    const eff = effectiveConfigFrom(resolved({ guardrails: { maxResponseLength: 500 } }));

    expect(eff.guardrails.fallbackMessage).toBe('');
    expect(eff.guardrails.confidenceThreshold).toBe(0.7);
  });

  it('counts an explicitly-set value as provided even when it equals the default', () => {
    // Provenance is "did the author write this key", not "does it differ from the
    // default" — otherwise a deliberate 500 would be silently dropped.
    const eff = effectiveConfigFrom(resolved({ guardrails: { maxResponseLength: 500 } }));

    expect(eff.providedGuardrails.maxResponseLength).toBe(500);
  });

  it('provides nothing for an unbound template', () => {
    const eff = effectiveConfigFrom(resolved({}, null));

    expect(eff.providedGuardrails).toEqual({});
    expect(eff.source).toBe('fallback');
  });
});
