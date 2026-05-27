import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSave, mockCreate } = vi.hoisted(() => {
  const mockSave = vi.fn().mockResolvedValue({ id: 'trace-1' });
  const mockCreate = vi.fn().mockImplementation((data: unknown) => data);
  return { mockSave, mockCreate };
});

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn().mockReturnValue({
      save: mockSave,
      create: mockCreate,
    }),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { TraceLogger, AgentTrace } from '../../agent/trace-logger';

describe('TraceLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSave.mockResolvedValue({ id: 'trace-1' });
    mockCreate.mockImplementation((data: unknown) => data);
  });

  it('saves a trace with totals computed', async () => {
    const logger = new TraceLogger();
    const trace: AgentTrace = {
      sessionId: 's1',
      tenantId: 't1',
      messageId: 'm1',
      iterations: [
        {
          llmCall: { model: 'gpt-4o', promptTokens: 100, completionTokens: 50, latencyMs: 500 },
          toolCalls: [{ name: 'kb_search', args: { query: 'test' }, result: { success: true }, latencyMs: 200 }],
        },
      ],
      finishReason: 'completed',
    };

    await logger.save(trace);

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1',
      sessionId: 's1',
      totalTokens: 150,
      totalLatencyMs: 700,
      finishReason: 'completed',
    }));
    expect(mockSave).toHaveBeenCalled();
  });

  it('masks email fields in tool args before saving', async () => {
    const logger = new TraceLogger();
    const trace: AgentTrace = {
      sessionId: 's1',
      tenantId: 't1',
      iterations: [{
        llmCall: { model: 'gpt-4o', promptTokens: 10, completionTokens: 5, latencyMs: 100 },
        toolCalls: [{
          name: 'create_booking',
          args: { attendeeEmail: 'john@example.com', attendeeName: 'John Doe' },
          result: { success: true },
          latencyMs: 300,
        }],
      }],
      finishReason: 'completed',
    };

    await logger.save(trace);

    const savedTrace = mockCreate.mock.calls[0][0].trace;
    const savedArgs = savedTrace.iterations[0].toolCalls[0].args;
    expect(savedArgs.attendeeEmail).toMatch(/j\*+@example\.com/);
  });
});
