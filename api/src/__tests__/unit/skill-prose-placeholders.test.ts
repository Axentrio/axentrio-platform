import { describe, it, expect } from 'vitest';
import { composeSystemPrompt } from '../../llm/compose-system-prompt';

// Per-template module/skill PROSE must get the same {placeholder} substitution as
// the main prompt body and custom instructions. Before this, skill prose was pushed
// raw, so a placeholder an author typed into a module's prose (e.g. "we're open
// {openingHours}") shipped to the model as the literal string "{openingHours}".

const base = (skillProse: { id: string; prose: string }[], openingHours?: string) =>
  composeSystemPrompt({
    mode: 'agent',
    ai: { enabled: true, brandVoice: { name: 'Acme', tone: 'friendly' } },
    tenantName: 'Acme',
    tools: [],
    skillProse,
    openingHours, // top-level live field (as agent.service passes it), not under `extras`
  } as any).prompt;

describe('placeholders in module/skill prose', () => {
  it('substitutes built-in placeholders ({tone}) in module prose', () => {
    const prompt = base([{ id: 'booking', prose: 'Speak in a {tone} way.' }]);
    expect(prompt).toContain('Speak in a friendly way.');
    expect(prompt).not.toContain('{tone}');
  });

  it('substitutes live booking placeholders ({openingHours}) from extras in module prose', () => {
    const prompt = base(
      [{ id: 'booking', prose: 'We are open {openingHours}.' }],
      'Mon–Fri 09:00–17:00',
    );
    expect(prompt).toContain('We are open Mon–Fri 09:00–17:00.');
    expect(prompt).not.toContain('{openingHours}');
  });

  it('leaves an UNKNOWN placeholder literal (same fail-safe as the main body)', () => {
    const prompt = base([{ id: 'booking', prose: 'Policy: {cancellationPolicy}.' }]);
    // unknown/unresolved keys stay literal rather than blanking — matches the body's behaviour
    expect(prompt).toContain('{cancellationPolicy}');
  });
});
