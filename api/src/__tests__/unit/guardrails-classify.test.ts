import { describe, it, expect } from 'vitest';
import { classifyMessage, FLAG_THRESHOLD } from '../../guardrails/classify';

const cat = (text: string, channel = 'widget') => classifyMessage(text, channel).category;

describe('guardrails · classifyMessage — flags abuse', () => {
  it('flags fake platform-security phishing with a shortened verify link', () => {
    const r = classifyMessage(
      'Your Facebook page will be deleted within 24 hours. Verify your account here https://bit.ly/xyz123',
      'messenger',
    );
    expect(r.category).toBe('phishing');
    expect(r.score).toBeGreaterThanOrEqual(FLAG_THRESHOLD);
    expect(r.links).toContain('https://bit.ly/xyz123');
  });

  it('flags credential / OTP harvesting as phishing', () => {
    expect(cat('Please send me your bank login password and the OTP code')).toBe('phishing');
    expect(cat('To continue, share your recovery seed phrase')).toBe('phishing');
    expect(cat('Enter your password and CVV at the link below')).toBe('phishing');
  });

  it('flags crypto/investment scams', () => {
    expect(cat('Guaranteed returns! Double your money with our crypto investment platform')).toBe('scam');
  });

  it('flags cold B2B solicitation, not a customer lead', () => {
    expect(
      cat('Hi, I came across your business and we offer SEO and web design to boost your sales'),
    ).toBe('solicitation');
  });

  it('flags obvious spam', () => {
    expect(cat('Free iPhone giveaway! Click here to win https://bit.ly/win')).toBe('spam');
    expect(cat('Best online casino bonus, play poker and slots now')).toBe('spam');
    expect(cat('Sign up now for free spins on our slots site')).toBe('spam'); // promo before term
  });

  it('flags a suspicious link with a credential-capture path', () => {
    const r = classifyMessage('update your details at http://192.168.1.10/account/verify', 'widget');
    expect(r.category).toBe('suspicious_link');
    expect(r.score).toBeGreaterThanOrEqual(FLAG_THRESHOLD);
  });

  it('is not fooled by an uppercase URL scheme', () => {
    const r = classifyMessage('update your details at HTTP://192.168.1.10/account/verify', 'widget');
    expect(r.category).toBe('suspicious_link');
    expect(r.score).toBeGreaterThanOrEqual(FLAG_THRESHOLD);
  });

  it('classifies credential-harvest-with-link as phishing, not suspicious_link (severity tie-break)', () => {
    const r = classifyMessage('Enter your password and CVV at the link below http://192.168.1.10/account/verify', 'widget');
    expect(r.category).toBe('phishing');
    expect(r.score).toBeGreaterThanOrEqual(FLAG_THRESHOLD);
  });

  it('never returns followable instructions — only extracts links as strings', () => {
    const r = classifyMessage('see https://bit.ly/x and https://evil.example/login', 'widget');
    expect(r.links.length).toBe(2);
  });
});

describe('guardrails · classifyMessage — stays clean (false-positive guard)', () => {
  it.each([
    ['empty', ''],
    ['short reply', 'yes please'],
    ['normal booking question', 'Can I book a haircut tomorrow at 3pm?'],
    ['asks hours & prices', 'What are your opening hours and prices?'],
    ['customer shares own site', "Here's my website https://jansbakery.be for the menu"],
    ['gives an address', "I'm at 12 Main Street, 1000 Brussels — is that in your area?"],
    ['mentions password once, benign', 'I forgot my password for your portal, can you help?'],
    ['single bare shortener, no lure', 'here is the photo https://bit.ly/photo'],
    ['benign verification-code support', "I didn't receive my verification code, can you help?"],
    ['asks for the business IBAN to pay', 'What is your IBAN so I can pay the invoice?'],
    ['regulated venue mention', 'Do you host poker nights this Friday?'],
    ['asks for the cafe wifi password', 'What is your WiFi password?'],
    ['asks about password reset policy', 'What is your password reset policy?'],
    ['venue deposit + poker night', 'Do I need to pay a deposit for poker night?'],
    ['casino-themed party deposit', 'Is there a deposit for the casino-themed party?'],
  ])('stays clean: %s', (_label, text) => {
    const r = classifyMessage(text, 'widget');
    expect(r.category).toBe('clean');
    expect(r.score).toBe(0);
  });

  it('bounds CPU on very long input and still classifies', () => {
    const long = 'I would like to book an appointment please. '.repeat(5000); // ~220 KB
    const r = classifyMessage(long, 'widget');
    expect(r.category).toBe('clean');
  });

  it('still returns extracted links on a clean message (for logging)', () => {
    const r = classifyMessage("Here's my website https://jansbakery.be", 'widget');
    expect(r.category).toBe('clean');
    expect(r.links).toContain('https://jansbakery.be');
  });
});
