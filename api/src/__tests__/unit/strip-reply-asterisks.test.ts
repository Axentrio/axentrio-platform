import { describe, it, expect } from 'vitest';
import { stripReplyAsterisks } from '../../guardrails/strip-reply-asterisks';

describe('stripReplyAsterisks', () => {
  it('unwraps stars around a service name and price', () => {
    expect(
      stripReplyAsterisks(
        'De dienst *Prijs test vast* kost *€75 inclusief btw* en duurt 30 minuten.',
      ),
    ).toBe('De dienst Prijs test vast kost €75 inclusief btw en duurt 30 minuten.');
  });

  it('leaves a reply with no stars unchanged', () => {
    expect(stripReplyAsterisks('A haircut costs €30. Would you like to book?')).toBe(
      'A haircut costs €30. Would you like to book?',
    );
  });

  it('unwraps markdown **bold**', () => {
    expect(stripReplyAsterisks('That is **€75**.')).toBe('That is €75.');
  });

  it('drops leftover unpaired stars', () => {
    expect(stripReplyAsterisks('Price is *€75')).toBe('Price is €75');
  });

  it('returns empty text unchanged', () => {
    expect(stripReplyAsterisks('')).toBe('');
  });
});
