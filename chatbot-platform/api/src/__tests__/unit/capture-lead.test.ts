import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockEmitWebhookEvent = vi.fn();
const mockBuildEventBase = vi.fn();

vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: (...args: unknown[]) => mockEmitWebhookEvent(...args),
  buildEventBase: (...args: unknown[]) => mockBuildEventBase(...args),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { CaptureLeadTool } from '../../agent/tools/capture-lead.tool';
import type { ToolContext } from '../../agent/tool-adapter';

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockQueryBuilder = {
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  execute: vi.fn().mockResolvedValue({}),
};

const mockRepo = {
  findOne: vi.fn().mockResolvedValue(null),
};

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: 'tenant-123',
    sessionId: 'session-abc',
    runId: 'run-xyz',
    toolsCalledThisTurn: [],
    dataSource: {
      createQueryBuilder: vi.fn().mockReturnValue(mockQueryBuilder),
      getRepository: vi.fn().mockReturnValue(mockRepo),
    } as any,
    conversationHistory: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CaptureLeadTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryBuilder.execute.mockResolvedValue({});
    mockBuildEventBase.mockReturnValue({
      id: 'evt-1',
      tenantId: 'tenant-123',
      sessionId: 'session-abc',
      timestamp: new Date().toISOString(),
      session: { channel: 'widget', visitorId: 'v1', startedAt: new Date().toISOString(), messageCount: 0 },
    });
  });

  it('has correct name', () => {
    const tool = new CaptureLeadTool();
    expect(tool.name).toBe('capture_lead');
  });

  it('has hasSideEffects=true', () => {
    const tool = new CaptureLeadTool();
    expect(tool.hasSideEffects).toBe(true);
  });

  it('has description and required parameters defined', () => {
    const tool = new CaptureLeadTool();
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);
    expect((tool.parameters as any).required).toContain('name');
    expect((tool.parameters as any).required).toContain('email');
  });

  it('execute returns success with lead data', async () => {
    const tool = new CaptureLeadTool();
    const ctx = makeCtx();

    const result = await tool.execute({ name: 'Alice Smith', email: 'alice@example.com' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as any).message).toBe('Lead captured');
    expect((result.data as any).name).toBe('Alice Smith');
    expect((result.data as any).email).toBe('alice@example.com');
  });

  it('execute calls dataSource.createQueryBuilder to persist lead to session metadata', async () => {
    const tool = new CaptureLeadTool();
    const ctx = makeCtx();

    await tool.execute({ name: 'Bob Jones', email: 'bob@example.com' }, ctx);

    expect(ctx.dataSource.createQueryBuilder).toHaveBeenCalled();
    expect(mockQueryBuilder.update).toHaveBeenCalledWith('chat_sessions');
    expect(mockQueryBuilder.where).toHaveBeenCalledWith('id = :id', { id: 'session-abc' });
    expect(mockQueryBuilder.execute).toHaveBeenCalled();
  });

  it('execute calls emitWebhookEvent with a lead.created event', async () => {
    const tool = new CaptureLeadTool();
    const ctx = makeCtx();

    await tool.execute({ name: 'Alice Smith', email: 'alice@example.com' }, ctx);

    expect(mockEmitWebhookEvent).toHaveBeenCalledTimes(1);
    const emittedEvent = mockEmitWebhookEvent.mock.calls[0][0];
    expect(emittedEvent.type).toBe('lead.created');
    expect(emittedEvent.lead.name).toBe('Alice Smith');
    expect(emittedEvent.lead.email).toBe('alice@example.com');
    expect(emittedEvent.lead.source).toBe('tool');
  });

  it('execute includes phone in lead event when provided', async () => {
    const tool = new CaptureLeadTool();
    const ctx = makeCtx();

    await tool.execute({ name: 'Carol', email: 'carol@example.com', phone: '+1-555-0100' }, ctx);

    const emittedEvent = mockEmitWebhookEvent.mock.calls[0][0];
    expect(emittedEvent.lead.phone).toBe('+1-555-0100');
  });

  it('execute returns success=false with error when dataSource throws', async () => {
    const tool = new CaptureLeadTool();
    const ctx = makeCtx({
      dataSource: {
        createQueryBuilder: vi.fn().mockReturnValue({
          update: vi.fn().mockReturnThis(),
          set: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          execute: vi.fn().mockRejectedValue(new Error('DB write failed')),
        }),
        getRepository: vi.fn().mockReturnValue(mockRepo),
      } as any,
    });

    const result = await tool.execute({ name: 'Dave', email: 'dave@example.com' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('DB write failed');
  });
});
