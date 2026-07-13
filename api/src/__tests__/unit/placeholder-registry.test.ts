import { describe, it, expect } from 'vitest';
import { PLACEHOLDER_CATALOG, PLACEHOLDER_KEYS } from '../../contracts/prompt-placeholders';
import { RESOLVERS, buildVariableMap } from '../../llm/placeholder-registry';

describe('placeholder registry — single source of truth', () => {
  it('every catalogued key has exactly one resolver (no drift, either direction)', () => {
    expect([...PLACEHOLDER_KEYS].sort()).toEqual(Object.keys(RESOLVERS).sort());
  });

  it('FAIL-CLOSED: with an empty ai slice every key still resolves to a string — never undefined, never a literal {key}', () => {
    const ai = {} as any;
    const map = buildVariableMap(ai);
    for (const { key } of PLACEHOLDER_CATALOG) {
      expect(typeof map[key], `${key} must resolve to a string`).toBe('string');
      expect(map[key]).not.toContain(`{${key}}`);
    }
  });

  it('built-ins always win over a same-named custom template variable', () => {
    const ai = { brandVoice: { name: 'Real' }, templateVariables: { botName: 'HIJACKED' } } as any;
    expect(buildVariableMap(ai).botName).toBe('Real');
  });
});

describe('placeholder registry — SECURITY: no secret can ever reach the prompt', () => {
  // Substrings that must never appear in a placeholder KEY. The `safeToExpose: true`
  // literal type is the compile-time half; this is the runtime backstop.
  const DENYLIST = ['apikey', 'token', 'secret', 'webhook', 'password', 'credential', 'privatekey'];

  it('no catalogued placeholder key looks like a secret', () => {
    const offenders = PLACEHOLDER_CATALOG.filter((e) =>
      DENYLIST.some((bad) => e.key.toLowerCase().includes(bad)),
    ).map((e) => e.key);
    expect(offenders).toEqual([]);
  });

  it('every catalogued entry is explicitly marked safeToExpose', () => {
    expect(PLACEHOLDER_CATALOG.every((e) => e.safeToExpose === true)).toBe(true);
  });

  it('secret-shaped values on the ai slice never appear in the resolved variable map', () => {
    // A bot settings blob stuffed with every secret shape we ship. No resolver reads
    // these, so none may surface — a future resolver that did would fail here.
    const ai = {
      brandVoice: { name: 'Bot' },
      apiKey: 'sk-LEAK-1',
      tenantApiKey: 'sk-LEAK-2',
      publicKey: 'pk-LEAK-3',
      webhookUrl: 'https://leak.example/hook',
      webhookSecret: 'whsec-LEAK-4',
      integrations: { calcom: { apiKey: 'cal-LEAK-5' } },
      channelOverrides: { whatsapp: { token: 'wa-LEAK-6' } },
    } as any;

    const serialized = JSON.stringify(buildVariableMap(ai));
    for (const leak of ['sk-LEAK-1', 'sk-LEAK-2', 'pk-LEAK-3', 'leak.example', 'whsec-LEAK-4', 'cal-LEAK-5', 'wa-LEAK-6']) {
      expect(serialized, `secret "${leak}" leaked into the prompt variable map`).not.toContain(leak);
    }
  });

  it('extraInfo is NOT a placeholder — it may only render as a fenced, lowest-authority block', () => {
    expect(PLACEHOLDER_KEYS.has('extraInfo')).toBe(false);
    const ai = { extraInfo: 'RAW TENANT TEXT' } as any;
    expect(JSON.stringify(buildVariableMap(ai))).not.toContain('RAW TENANT TEXT');
  });
});
