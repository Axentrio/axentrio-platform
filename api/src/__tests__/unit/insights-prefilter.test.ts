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
    const d = prefilterTranscript([bot('Welcome! How can I help?')]);
    expect(d).toMatchObject({ judge: false, reason: 'no_customer_text' });
  });

  it('skips a pure greeting exchange', () => {
    const d = prefilterTranscript([bot('Welcome!'), user('hi'), bot('Hello!'), user('thanks')]);
    expect(d).toMatchObject({ judge: false, reason: 'greeting_only' });
  });

  it('skips greetings in Dutch and French too', () => {
    expect(prefilterTranscript([user('hallo'), user('bedankt')])).toMatchObject({ judge: false });
    expect(prefilterTranscript([user('bonjour'), user('merci')])).toMatchObject({ judge: false });
  });

  it('ignores punctuation and case when matching a pleasantry', () => {
    expect(prefilterTranscript([user('Hallo!!')])).toMatchObject({ judge: false });
    expect(prefilterTranscript([user('  THANKS.  ')])).toMatchObject({ judge: false });
  });
});

describe('prefilterTranscript — everything ambiguous goes to the judge', () => {
  it('never skips a question, however short', () => {
    // The strongest cheap signal there is, and it survives every language.
    expect(prefilterTranscript([user('prijs?')])).toEqual({ judge: true });
    expect(prefilterTranscript([user('open?')])).toEqual({ judge: true });
  });

  it('never skips a one-line problem statement', () => {
    // 48% of production sessions hold exactly one customer message. Many are real.
    expect(prefilterTranscript([user('my boiler is dead')])).toEqual({ judge: true });
    expect(prefilterTranscript([user('mijn kraan lekt')])).toEqual({ judge: true });
    expect(prefilterTranscript([user('fuite sous evier')])).toEqual({ judge: true });
  });

  it('keeps a conversation where one line among greetings has substance', () => {
    // The rule is EVERY message must be a pleasantry — one line of content is a
    // conversation with something in it.
    const d = prefilterTranscript([user('hi'), user('do you replace radiators'), user('thanks')]);
    expect(d).toEqual({ judge: true });
  });

  it('stops guessing once the customer has written a real amount', () => {
    // Past the character limit we pay for the judge whatever the words were.
    const long = 'ok '.repeat(30); // pleasantries by token, but far too much text
    expect(prefilterTranscript([user(long)])).toEqual({ judge: true });
  });

  it('does not treat a need-expressing word as a pleasantry', () => {
    // "help" is deliberately NOT in the lexicon: it is the shortest possible request.
    expect(prefilterTranscript([user('help')])).toEqual({ judge: true });
    expect(prefilterTranscript([user('urgent')])).toEqual({ judge: true });
  });

  it('ignores bot and agent text when deciding — only the customer counts', () => {
    // A chatty bot must never make an empty conversation look substantial.
    const d = prefilterTranscript([
      bot('We repair boilers, radiators and taps across Antwerp, seven days a week.'),
      { sender: 'agent', content: 'Anything else I can help with today?' },
    ]);
    expect(d).toMatchObject({ judge: false, reason: 'no_customer_text' });
  });

  it('treats whitespace-only customer messages as no text at all', () => {
    expect(prefilterTranscript([user('   '), user('\n')])).toMatchObject({
      judge: false,
      reason: 'no_customer_text',
    });
  });
});
