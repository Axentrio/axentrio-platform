import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { GuardrailOutputLog } from '../../database/entities/GuardrailOutputLog';
import { applyOutputGuardrails } from '../../guardrails/output-guardrails.service';
import { createTestTenant, createTestSession } from '../helpers/factories';

const FALLBACK = "We're connecting you to an agent. Please hold on.";
const BAD_REPLY = 'Sure — please share your bank login password so I can verify your account.';
const GOOD_REPLY = 'A haircut costs €30. Would you like to book for tomorrow afternoon?';

async function setup(enforce: boolean) {
  const tenant = await createTestTenant({ settings: enforce ? { guardrails: { enforce: true } } : {} });
  const session = await createTestSession(tenant.id, { status: 'bot' });
  const reloaded = await AppDataSource.getRepository(ChatSession).findOneOrFail({ where: { id: session.id } });
  return { tenant, session: reloaded };
}

const logRepo = () => AppDataSource.getRepository(GuardrailOutputLog);

describe('guardrails · applyOutputGuardrails (integration)', () => {
  it('ENFORCE: replaces a flagged reply with the fallback and logs (enforced=true)', async () => {
    const { tenant, session } = await setup(true);
    const r = await applyOutputGuardrails({
      tenantId: tenant.id, session, channel: 'widget',
      content: BAD_REPLY, fallbackMessage: FALLBACK, generationPath: 'coalescer',
    });
    expect(r.blocked).toBe(true);
    expect(r.content).toBe(FALLBACK);

    const logs = await logRepo().find({ where: { conversationId: session.id } });
    expect(logs.length).toBe(1);
    expect(logs[0].enforced).toBe(true);
    expect(logs[0].generationPath).toBe('coalescer');
    expect(logs[0].families).toContain('credential_solicitation');
  });

  it('SHADOW: keeps the original reply but still logs (enforced=false)', async () => {
    const { tenant, session } = await setup(false);
    const r = await applyOutputGuardrails({
      tenantId: tenant.id, session, channel: 'whatsapp',
      content: BAD_REPLY, fallbackMessage: FALLBACK, generationPath: 'n8n',
    });
    expect(r.blocked).toBe(false);
    expect(r.content).toBe(BAD_REPLY);

    const logs = await logRepo().find({ where: { conversationId: session.id } });
    expect(logs.length).toBe(1);
    expect(logs[0].enforced).toBe(false);
    expect(logs[0].generationPath).toBe('n8n');
  });

  it('clean reply: passes through, nothing logged (even in enforce)', async () => {
    const { tenant, session } = await setup(true);
    const r = await applyOutputGuardrails({
      tenantId: tenant.id, session, channel: 'widget',
      content: GOOD_REPLY, fallbackMessage: FALLBACK, generationPath: 'rag',
    });
    expect(r.blocked).toBe(false);
    expect(r.content).toBe(GOOD_REPLY);

    const logs = await logRepo().find({ where: { conversationId: session.id } });
    expect(logs.length).toBe(0);
  });
});
