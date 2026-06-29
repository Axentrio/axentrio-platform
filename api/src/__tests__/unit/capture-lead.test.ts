import { describe, it, expect, vi, beforeEach } from 'vitest';

// The tool now delegates to the lead-capture service (the single write path
// across all channels). These tests pin the tool's contract: validation, the
// args it hands the service, and how it maps the service result back to the
// model. The upsert mechanics themselves live in lead-capture-service.test.ts
// + the DB-backed integration test.
const upsertLead = vi.fn();
vi.mock('../../leads/lead-capture.service', () => ({
  upsertLead: (...args: unknown[]) => upsertLead(...args),
}));

import { CaptureLeadTool } from '../../agent/tools/capture-lead.tool';
import type { ToolContext } from '../../agent/tool-adapter';

const sessionRepo = {
  findOne: vi.fn().mockResolvedValue({ id: 'session-abc', botId: 'bot-1', channel: 'widget' }),
};

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: 'tenant-123',
    sessionId: 'session-abc',
    runId: 'run-xyz',
    toolsCalledThisTurn: [],
    dataSource: { getRepository: () => sessionRepo } as never,
    conversationHistory: [],
    ...overrides,
  };
}

describe('CaptureLeadTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertLead.mockResolvedValue({ leadId: 'lead-1', inserted: true });
  });

  it('is named capture_lead with side effects', () => {
    const tool = new CaptureLeadTool();
    expect(tool.name).toBe('capture_lead');
    expect(tool.hasSideEffects).toBe(true);
  });

  it('requires neither name nor email up front (email OR phone is enough)', () => {
    const tool = new CaptureLeadTool();
    expect((tool.parameters as { required: string[] }).required).toEqual([]);
  });

  it('rejects when the visitor gave neither email nor phone', async () => {
    const tool = new CaptureLeadTool();
    const res = await tool.execute({ name: 'Anon' }, makeCtx());
    expect(res.success).toBe(false);
    expect(upsertLead).not.toHaveBeenCalled();
  });

  it('captures on email alone — no name needed', async () => {
    const tool = new CaptureLeadTool();
    const res = await tool.execute({ email: 'alice@example.com' }, makeCtx());
    expect(res.success).toBe(true);
    // R31: the internal leadId is NOT exposed to the model; just a confirmation.
    expect((res.data as { leadId?: string; message?: string }).leadId).toBeUndefined();
    expect((res.data as { message?: string }).message).toBe('Lead captured');
    expect(upsertLead).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-123', sessionId: 'session-abc', source: 'tool', channel: 'widget', email: 'alice@example.com', name: null }),
    );
  });

  it('captures on phone alone', async () => {
    const tool = new CaptureLeadTool();
    const res = await tool.execute({ phone: '+32 475 11 22 33' }, makeCtx());
    expect(res.success).toBe(true);
    expect(upsertLead).toHaveBeenCalledWith(expect.objectContaining({ phone: '+32 475 11 22 33', email: null }));
  });

  it('passes the request summary through as notes (so the team sees WHY to reach out)', async () => {
    const tool = new CaptureLeadTool();
    await tool.execute(
      { email: 'alice@example.com', summary: 'Leak under the kitchen sink, Kerkstraat 12 Antwerp' },
      makeCtx(),
    );
    expect(upsertLead).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'Leak under the kitchen sink, Kerkstraat 12 Antwerp' }),
    );
  });

  it('passes notes:null when no summary is given (contact-only capture)', async () => {
    const tool = new CaptureLeadTool();
    await tool.execute({ email: 'alice@example.com' }, makeCtx());
    expect(upsertLead).toHaveBeenCalledWith(expect.objectContaining({ notes: null }));
  });

  it('passes the session channel through (so a channel widget-tool call dedups correctly)', async () => {
    sessionRepo.findOne.mockResolvedValueOnce({ id: 'session-abc', botId: 'bot-1', channel: 'whatsapp' });
    const tool = new CaptureLeadTool();
    await tool.execute({ email: 'x@y.com' }, makeCtx());
    expect(upsertLead).toHaveBeenCalledWith(expect.objectContaining({ channel: 'whatsapp' }));
  });

  it('passes externalUserId (the channel handle) on a channel session so the summary converges onto the channel-identity lead', async () => {
    sessionRepo.findOne.mockResolvedValueOnce({ id: 'session-abc', botId: 'bot-1', channel: 'whatsapp', visitorId: '32470111222' });
    const tool = new CaptureLeadTool();
    await tool.execute({ phone: '+32 470 11 12 22', summary: 'Leak under the sink' }, makeCtx());
    expect(upsertLead).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', externalUserId: '32470111222' }),
    );
  });

  it('captures on a channel with a summary ALONE (no typed email/phone) — the channel handle is the contact', async () => {
    sessionRepo.findOne.mockResolvedValueOnce({ id: 'session-abc', botId: 'bot-1', channel: 'whatsapp', visitorId: '32470111222' });
    const tool = new CaptureLeadTool();
    const res = await tool.execute({ summary: 'Kitchen sink leaking, Kerkstraat 1' }, makeCtx());
    expect(res.success).toBe(true);
    expect(upsertLead).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', externalUserId: '32470111222', notes: 'Kitchen sink leaking, Kerkstraat 1', email: null, phone: null }),
    );
  });

  it('on a channel with neither contact nor summary, nudges (no no-op capture)', async () => {
    sessionRepo.findOne.mockResolvedValueOnce({ id: 'session-abc', botId: 'bot-1', channel: 'whatsapp', visitorId: '32470111222' });
    const tool = new CaptureLeadTool();
    const res = await tool.execute({ name: 'Ian' }, makeCtx());
    expect(res.success).toBe(false);
    expect(upsertLead).not.toHaveBeenCalled();
  });

  it('still rejects an anonymous WIDGET capture with no email/phone (no durable identifier)', async () => {
    // default sessionRepo mock returns channel:'widget' (no visitorId → externalUserId null)
    const tool = new CaptureLeadTool();
    const res = await tool.execute({ summary: 'Just browsing' }, makeCtx());
    expect(res.success).toBe(false);
    expect(upsertLead).not.toHaveBeenCalled();
  });

  it('passes externalUserId null on the widget (keys on email/phone, not a channel handle)', async () => {
    // default sessionRepo mock returns channel:'widget'
    const tool = new CaptureLeadTool();
    await tool.execute({ email: 'a@b.com' }, makeCtx());
    expect(upsertLead).toHaveBeenCalledWith(expect.objectContaining({ channel: 'widget', externalUserId: null }));
  });

  it('reports a friendly "noted" (not an error) when the service no-ops (gated/no key)', async () => {
    upsertLead.mockResolvedValueOnce(null);
    const tool = new CaptureLeadTool();
    const res = await tool.execute({ email: 'a@b.com' }, makeCtx());
    expect(res.success).toBe(true); // never surface gating as a tool error to the model
  });

  it('surfaces a thrown service error as success=false', async () => {
    upsertLead.mockRejectedValueOnce(new Error('boom'));
    const tool = new CaptureLeadTool();
    const res = await tool.execute({ email: 'a@b.com' }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toBe('boom');
  });
});
