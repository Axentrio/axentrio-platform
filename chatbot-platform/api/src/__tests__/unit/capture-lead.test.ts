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

const mockQuery = vi.fn().mockResolvedValue([]);

// Mock ChatSession repository — for the agent-context session lookup.
const mockSessionRepo = {
  findOne: vi.fn().mockResolvedValue({
    id: 'session-abc',
    botId: 'bot-1',
    channel: 'widget',
    visitorId: 'v1',
    startedAt: new Date(),
    messageCount: 0,
  }),
};

// Mock Lead repository — M6 primary write path.
const mockLeadRepo = {
  create: vi.fn((data: Record<string, unknown>) => data),
  save: vi.fn((data: Record<string, unknown>) =>
    Promise.resolve({
      ...data,
      id: 'lead-test-id',
      createdAt: new Date('2026-05-26T00:00:00.000Z'),
    }),
  ),
};

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  // Dispatch repositories by entity name so the tool's two
  // getRepository calls (ChatSession + Lead) each get the right mock.
  const getRepository = vi.fn((entity: { name?: string }) => {
    const name = entity?.name ?? '';
    if (name === 'ChatSession') return mockSessionRepo;
    if (name === 'Lead') return mockLeadRepo;
    return { findOne: vi.fn(), save: vi.fn(), create: vi.fn() };
  });
  return {
    tenantId: 'tenant-123',
    sessionId: 'session-abc',
    runId: 'run-xyz',
    toolsCalledThisTurn: [],
    dataSource: {
      query: mockQuery,
      getRepository,
    } as any,
    conversationHistory: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CaptureLeadTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([]);
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

  it('execute writes a Lead row to chatbot_leads (M6 primary)', async () => {
    const tool = new CaptureLeadTool();
    const ctx = makeCtx();

    await tool.execute({ name: 'Bob Jones', email: 'bob@example.com' }, ctx);

    expect(mockLeadRepo.save).toHaveBeenCalledTimes(1);
    const saved = mockLeadRepo.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      tenantId: 'tenant-123',
      sessionId: 'session-abc',
      botId: 'bot-1',
      name: 'Bob Jones',
      email: 'bob@example.com',
      source: 'tool',
    });
  });

  it('execute also mirrors to session.metadata.lead (legacy n8n compat)', async () => {
    const tool = new CaptureLeadTool();
    const ctx = makeCtx();

    await tool.execute({ name: 'Bob Jones', email: 'bob@example.com' }, ctx);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('UPDATE chat_sessions');
    expect(sql).toContain('jsonb_set');
    expect(params[1]).toBe('session-abc');
    // Mirror payload includes the new Lead row id so consumers can
    // walk from the legacy field to the first-class table if they need.
    const payload = JSON.parse(params[0]);
    expect(payload.leadId).toBe('lead-test-id');
    expect(payload.email).toBe('bob@example.com');
  });

  it('execute returns the new Lead id in the tool result', async () => {
    const tool = new CaptureLeadTool();
    const ctx = makeCtx();

    const result = await tool.execute({ name: 'X', email: 'x@example.com' }, ctx);

    expect((result.data as { leadId?: string }).leadId).toBe('lead-test-id');
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

  it('execute returns success=false with error when the Lead write fails', async () => {
    const tool = new CaptureLeadTool();
    const failingLeadRepo = {
      create: vi.fn((d: Record<string, unknown>) => d),
      save: vi.fn().mockRejectedValue(new Error('DB write failed')),
    };
    const ctx = makeCtx({
      dataSource: {
        query: mockQuery,
        getRepository: vi.fn((entity: { name?: string }) => {
          if (entity?.name === 'ChatSession') return mockSessionRepo;
          if (entity?.name === 'Lead') return failingLeadRepo;
          return { findOne: vi.fn() };
        }),
      } as any,
    });

    const result = await tool.execute({ name: 'Dave', email: 'dave@example.com' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('DB write failed');
  });
});
