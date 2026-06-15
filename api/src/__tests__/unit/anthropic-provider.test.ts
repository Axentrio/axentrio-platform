// api/src/__tests__/unit/anthropic-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @anthropic-ai/sdk before imports ────────────────────────────────────

const mockMessagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockMessagesCreate };
      constructor(_opts: unknown) {}
    },
  };
});

import { AnthropicProvider } from '../../llm/anthropic.provider';
import type { ChatMessage, LLMOptions } from '../../llm/llm.types';

const baseOptions: LLMOptions = {
  model: 'claude-3-5-haiku-20241022',
  maxTokens: 1024,
  temperature: 0.3,
  jsonMode: false,
};

beforeEach(() => {
  mockMessagesCreate.mockReset();
});

describe('AnthropicProvider', () => {
  it('basic chat without tools returns finishReason stop', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello there!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const provider = new AnthropicProvider('test-api-key');
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await provider.chat(messages, baseOptions);

    expect(result.content).toBe('Hello there!');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
  });

  it('sends tools and parses tool_use content blocks into ToolCall[]', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_abc123',
          name: 'kb_search',
          input: { query: 'pricing plans' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 15 },
    });

    const provider = new AnthropicProvider('test-api-key');
    const messages: ChatMessage[] = [{ role: 'user', content: 'What are your pricing plans?' }];
    const options: LLMOptions = {
      ...baseOptions,
      tools: [
        {
          name: 'kb_search',
          description: 'Search the knowledge base',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
    };

    const result = await provider.chat(messages, options);

    expect(result.finishReason).toBe('tool_calls');
    expect(result.content).toBe('');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({
      id: 'toolu_abc123',
      name: 'kb_search',
      arguments: { query: 'pricing plans' },
    });

    // Verify tools were sent in Anthropic format
    const callArg = mockMessagesCreate.mock.calls[0][0];
    expect(callArg.tools).toEqual([
      {
        name: 'kb_search',
        description: 'Search the knowledge base',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ]);
  });

  it('maps a multimodal user message (text + image) to Anthropic content blocks', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'I can see the photo.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 40, output_tokens: 8 },
    });

    const provider = new AnthropicProvider('test-api-key');
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', mimeType: 'image/png', data: 'BASE64DATA' },
        ],
      },
    ];

    await provider.chat(messages, baseOptions);

    const callArg = mockMessagesCreate.mock.calls[0][0];
    const userMsg = callArg.messages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BASE64DATA' } },
    ]);
  });

  it('maps tool result messages to Anthropic user message with tool_result blocks', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Based on the search results, pricing starts at $29/mo.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 30, output_tokens: 20 },
    });

    const provider = new AnthropicProvider('test-api-key');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'What are your pricing plans?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'toolu_abc123', name: 'kb_search', arguments: { query: 'pricing plans' } }],
      },
      {
        role: 'tool',
        content: JSON.stringify([{ title: 'Pricing', content: 'Starts at $29/mo' }]),
        toolCallId: 'toolu_abc123',
      },
    ];

    const result = await provider.chat(messages, baseOptions);

    expect(result.finishReason).toBe('stop');
    expect(result.content).toContain('$29/mo');

    const callArg = mockMessagesCreate.mock.calls[0][0];
    const sentMessages = callArg.messages;

    // Assistant message should have tool_use content block
    const assistantMsg = sentMessages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toEqual([
      {
        type: 'tool_use',
        id: 'toolu_abc123',
        name: 'kb_search',
        input: { query: 'pricing plans' },
      },
    ]);

    // Tool result should be inside a user message with tool_result block
    const toolUserMsg = sentMessages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content) &&
        m.content.some((b: any) => b.type === 'tool_result'),
    );
    expect(toolUserMsg).toBeDefined();
    expect(toolUserMsg.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_abc123',
        content: JSON.stringify([{ title: 'Pricing', content: 'Starts at $29/mo' }]),
      },
    ]);
  });
});
