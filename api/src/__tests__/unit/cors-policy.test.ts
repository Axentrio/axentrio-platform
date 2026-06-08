import { describe, it, expect, vi, beforeEach } from 'vitest';

// Load the cors helper against a controlled config each time.
async function load(corsCfg: { origin: string | string[]; credentials: boolean }, isDevelopment = false) {
  vi.resetModules();
  vi.doMock('../../config/environment', () => ({
    config: { cors: corsCfg, server: { isDevelopment } },
  }));
  return import('../../security/cors');
}

describe('CORS policy (#D) — wildcard never yields credentials', () => {
  beforeEach(() => vi.resetModules());

  it('explicit allowlist: reflects listed origin WITH credentials', async () => {
    const { resolveCorsDecision } = await load({ origin: ['https://app.axentrio.com'], credentials: true });
    expect(resolveCorsDecision('https://app.axentrio.com')).toEqual({
      origin: 'https://app.axentrio.com',
      credentials: true,
    });
  });

  it('explicit allowlist: unmatched origin → no ACAO, no credentials', async () => {
    const { resolveCorsDecision } = await load({ origin: ['https://app.axentrio.com'], credentials: true });
    expect(resolveCorsDecision('https://evil.example.com')).toEqual({ origin: false, credentials: false });
  });

  it('preserves the Clerk exception with credentials', async () => {
    const { resolveCorsDecision } = await load({ origin: ['https://app.axentrio.com'], credentials: true });
    expect(resolveCorsDecision('https://foo.clerk.accounts.dev')).toEqual({
      origin: 'https://foo.clerk.accounts.dev',
      credentials: true,
    });
  });

  it('wildcard config: allows any origin but NEVER credentials', async () => {
    const { resolveCorsDecision } = await load({ origin: '*', credentials: true });
    expect(resolveCorsDecision('https://anything.example.com')).toEqual({ origin: '*', credentials: false });
  });

  it('no Origin header (server-to-server): allowed without credentials', async () => {
    const { resolveCorsDecision } = await load({ origin: ['https://app.axentrio.com'], credentials: true });
    expect(resolveCorsDecision(undefined)).toEqual({ origin: true, credentials: false });
  });
});
