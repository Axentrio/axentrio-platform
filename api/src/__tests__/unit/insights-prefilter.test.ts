/**
 * Layer 1 — the cheap gate in front of the LLM judge.
 *
 * The asymmetry is the whole design, so most of this file asserts what it REFUSES to
 * skip. A wrong skip loses a real customer question permanently: it never becomes a Gap
 * and nothing revisits it. A wrong keep costs a fraction of a cent.
 */
import { describe, it, expect } from 'vitest';
import { prefilterTranscript, type PrefilterMessage } from '../../insights/prefilter';

const user = (content: string): PrefilterMessage => ({ sender: 'user', content });
const bot = (content: string): PrefilterMessage => ({ sender: 'bot', content });

describe('prefilterTranscript — skips only what cannot yield a topic', () => {
  it('skips a conversation the visitor never wrote in', () => {
    // 6.9% of production sessions: the widget opened, a greeting was sent, nobody typed.
    // The judge was being paid to report that silence contained no question.
    const d = prefilterTranscript({ messages: [bot('Welcome! How can I help?')], isHandoff: false });
    expect(d).toMatchObject({ judge: false, reason: 'no_customer_text' });
  });

  it('skips a pure greeting exchange', () => {
    const d = prefilterTranscript({ messages: [bot('Welcome!'), user('hi'), bot('Hello!'), user('thanks')], isHandoff: false });
    expect(d).toMatchObject({ judge: false, reason: 'greeting_only' });
  });

  it('skips greetings in Dutch and French too', () => {
    expect(prefilterTranscript({ messages: [user('hallo'), user('bedankt')], isHandoff: false })).toMatchObject({ judge: false });
    expect(prefilterTranscript({ messages: [user('bonjour'), user('merci')], isHandoff: false })).toMatchObject({ judge: false });
  });

  it('ignores punctuation and case when matching a pleasantry', () => {
    expect(prefilterTranscript({ messages: [user('Hallo!!')], isHandoff: false })).toMatchObject({ judge: false });
    expect(prefilterTranscript({ messages: [user('  THANKS.  ')], isHandoff: false })).toMatchObject({ judge: false });
  });
});

describe('prefilterTranscript — everything ambiguous goes to the judge', () => {
  it('never skips a question, however short', () => {
    // The strongest cheap signal there is, and it survives every language.
    expect(prefilterTranscript({ messages: [user('prijs?')], isHandoff: false })).toEqual({ judge: true });
    expect(prefilterTranscript({ messages: [user('open?')], isHandoff: false })).toEqual({ judge: true });
  });

  it('never skips a one-line problem statement', () => {
    // 48% of production sessions hold exactly one customer message. Many are real.
    expect(prefilterTranscript({ messages: [user('my boiler is dead')], isHandoff: false })).toEqual({ judge: true });
    expect(prefilterTranscript({ messages: [user('mijn kraan lekt')], isHandoff: false })).toEqual({ judge: true });
    expect(prefilterTranscript({ messages: [user('fuite sous evier')], isHandoff: false })).toEqual({ judge: true });
  });

  it('keeps a conversation where one line among greetings has substance', () => {
    // The rule is EVERY message must be a pleasantry — one line of content is a
    // conversation with something in it.
    const d = prefilterTranscript({ messages: [user('hi'), user('do you replace radiators'), user('thanks')], isHandoff: false });
    expect(d).toEqual({ judge: true });
  });

  it('stops guessing once the customer has written a real amount', () => {
    // Past the character limit we pay for the judge whatever the words were.
    const long = 'ok '.repeat(30); // pleasantries by token, but far too much text
    expect(prefilterTranscript({ messages: [user(long)], isHandoff: false })).toEqual({ judge: true });
  });

  it('does not treat a need-expressing word as a pleasantry', () => {
    // "help" is deliberately NOT in the lexicon: it is the shortest possible request.
    expect(prefilterTranscript({ messages: [user('help')], isHandoff: false })).toEqual({ judge: true });
    expect(prefilterTranscript({ messages: [user('urgent')], isHandoff: false })).toEqual({ judge: true });
  });

  it('ignores bot and agent text when deciding — only the customer counts', () => {
    // A chatty bot must never make an empty conversation look substantial.
    const d = prefilterTranscript({ messages: [
      bot('We repair boilers, radiators and taps across Antwerp, seven days a week.'),
      { sender: 'agent', content: 'Anything else I can help with today?' },
    ], isHandoff: false });
    expect(d).toMatchObject({ judge: false, reason: 'no_customer_text' });
  });

  it('treats whitespace-only customer messages as no text at all', () => {
    expect(prefilterTranscript({ messages: [user('   '), user('\n')], isHandoff: false })).toMatchObject({
      judge: false,
      reason: 'no_customer_text',
    });
  });
});

describe('prefilterTranscript — a handoff is never gated', () => {
  it('judges a handoff even when the customer only said hello', () => {
    // A handoff is the bot admitting it could not cope: rare, high-signal, and exactly
    // the conversation you would least want to have guessed about. Nothing would in fact
    // be lost by skipping it — there is no topic in "hi" for either layer to find — but
    // "a wrong keep costs a fraction of a cent" cuts decisively one way here.
    const greetingOnly = [user('hi'), user('thanks')];
    expect(prefilterTranscript({ messages: greetingOnly, isHandoff: false })).toMatchObject({
      judge: false,
    });
    expect(prefilterTranscript({ messages: greetingOnly, isHandoff: true })).toEqual({ judge: true });
  });

  it('judges a handoff the visitor never wrote in at all', () => {
    expect(prefilterTranscript({ messages: [bot('Let me get someone for you.')], isHandoff: true })).toEqual({
      judge: true,
    });
  });
});

describe('prefilterTranscript — the empty case does not depend on statement order', () => {
  it('reports no_customer_text rather than greeting_only for an empty conversation', () => {
    // `[].every()` is vacuously TRUE, so without an explicit length check an empty
    // conversation would be labelled a greeting exchange the moment these two rules were
    // reordered. Correctness should not rest on which line comes first.
    const d = prefilterTranscript({ messages: [bot('Welcome!')], isHandoff: false });
    expect(d).toMatchObject({ reason: 'no_customer_text' });
    expect(d).not.toMatchObject({ reason: 'greeting_only' });
  });
});
