/**
 * The owner's canned wording, said in the customer's language.
 *
 * A tenant writes `fallbackMessage` once, in their own language, and it is then posted to
 * everybody. Observed in production: an English customer asked about a Sunday and was answered
 * `Laat me je verbinden met ons team`. The off-hours message has gone through `localizeMessage`
 * for exactly this reason since the off-hours mistranslation fix; the three agent-failure exits
 * were simply missed.
 *
 * A SOURCE-LEVEL invariant rather than three behavioural tests, because the failure being guarded
 * is a fourth exit added later that posts the string raw. A test that mocks three call sites
 * cannot notice the fourth, and this file is a long service with several such exits.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = join(__dirname, '..', '..', 'services', 'message-forwarding.service.ts');

describe('a canned message is never posted in the wrong language', () => {
  it('never sends the fallback without localising it first', () => {
    const src = readFileSync(SERVICE, 'utf8');

    // Every place the agent's own fallback is handed to the customer.
    const sends = [...src.matchAll(/sendBotMessage\([^)]*?result\.fallbackMessage[^)]*\)/g)].map((m) => m[0]);
    expect(sends.length).toBeGreaterThanOrEqual(3);

    for (const send of sends) {
      expect(send).toContain('inCustomerLanguage');
    }
  });

  it('localises against the CUSTOMER text, never a fixed string', () => {
    // Translating the fallback into the language of the fallback would be a no-op that reads like
    // a fix. It has to be told what the customer actually wrote.
    const src = readFileSync(SERVICE, 'utf8');
    const helper = src.slice(src.indexOf('const inCustomerLanguage ='), src.indexOf(';', src.indexOf('const inCustomerLanguage =')));

    expect(helper).toContain('localizeMessage');
    expect(helper).toContain('customerText');
  });

  it('keeps the off-hours path localised too, which is where this lesson came from', () => {
    const src = readFileSync(SERVICE, 'utf8');
    const autoSends = [...src.matchAll(/const\s+autoMsg\s*=\s*await\s+([A-Za-z]+)\(/g)].map((m) => m[1]);

    expect(autoSends.length).toBeGreaterThanOrEqual(2);
    for (const fn of autoSends) expect(fn).toBe('localizeMessage');
  });
});
