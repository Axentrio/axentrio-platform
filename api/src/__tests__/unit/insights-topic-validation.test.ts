import { describe, it, expect } from 'vitest';
import { validateTopic, normalizeTopic } from '../../insights/topic-validation';

describe('insights · topic validation (ADR-0009 layer 2)', () => {
  it('accepts specific short phrases', () => {
    expect(validateTopic('pricing')).toBeNull();
    expect(validateTopic('emergency availability')).toBeNull();
    expect(validateTopic('Pricing Info')).toBeNull(); // stopwords are exact, not substring
    expect(validateTopic('boiler repair cost')).toBeNull();
  });

  it('rejects empty / null / whitespace', () => {
    expect(validateTopic(null)).toBe('empty');
    expect(validateTopic(undefined)).toBe('empty');
    expect(validateTopic('   ')).toBe('empty');
  });

  it('rejects exact stopwords', () => {
    expect(validateTopic('info')).toBe('stopword');
    expect(validateTopic('  Help ')).toBe('stopword');
    expect(validateTopic('general')).toBe('stopword');
  });

  it('rejects degenerate shapes', () => {
    expect(validateTopic('?')).toBe('empty'); // trailing punctuation strips to nothing
    expect(validateTopic('---')).toBe('punctuation_only');
    expect(validateTopic('ab')).toBe('too_short');
    expect(validateTopic('a'.repeat(61))).toBe('too_long');
    expect(validateTopic('one two three four five six seven')).toBe('too_many_words');
    expect(validateTopic('can you tell me. about pricing')).toBe('sentence_style');
  });

  it('normalizes case, whitespace, and trailing punctuation', () => {
    expect(normalizeTopic('  Pricing  Info!! ')).toBe('pricing  info'.replace(/\s+/g, ' '));
    expect(normalizeTopic('PRICING')).toBe('pricing');
  });
});
