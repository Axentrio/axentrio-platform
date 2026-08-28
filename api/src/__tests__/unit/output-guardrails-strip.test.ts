import { describe, it, expect, vi } from 'vitest';

vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ save: vi.fn(), create: (row: unknown) => row }) },
}));

vi.mock('../../guardrails/inbound-guardrails.service', () => ({
  isGuardrailsEnforcing: vi.fn(),
}));

vi.mock('../../guardrails/output-validation', () => ({
  validateOutput: () => {
    throw new Error('validation exploded');
  },
}));

import { applyOutputGuardrails } from '../../guardrails/output-guardrails.service';
import type { ChatSession } from '../../database/entities/ChatSession';

const STARRED = 'De dienst *Prijs test vast* kost *€75 inclusief btw* en duurt 30 minuten.';
const CLEAN = 'De dienst Prijs test vast kost €75 inclusief btw en duurt 30 minuten.';

describe('applyOutputGuardrails — strip survives a validation error', () => {
  it('returns cleaned text when validateOutput throws', async () => {
    const r = await applyOutputGuardrails({
      tenantId: 't1',
      session: { id: 's1', tenantId: 't1' } as ChatSession,
      channel: 'whatsapp',
      content: STARRED,
      fallbackMessage: 'Hold on *please*',
      generationPath: 'coalescer',
    });
    expect(r.blocked).toBe(false);
    expect(r.content).toBe(CLEAN);
    expect(r.content).not.toContain('*');
  });
});
