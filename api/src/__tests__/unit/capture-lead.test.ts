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
    expect((res.data as { leadId?: string }).leadId).toBe('lead-1');
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

  it('passes the session channel through (so a channel widget-tool call dedups correctly)', async () => {
    sessionRepo.findOne.mockResolvedValueOnce({ id: 'session-abc', botId: 'bot-1', channel: 'whatsapp' });
    const tool = new CaptureLeadTool();
    await tool.execute({ email: 'x@y.com' }, makeCtx());
    expect(upsertLead).toHaveBeenCalledWith(expect.objectContaining({ channel: 'whatsapp' }));
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
