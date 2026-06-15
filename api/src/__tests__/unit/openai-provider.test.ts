// api/src/__tests__/unit/openai-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, LLMOptions } from '../../llm/llm.types';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  function OpenAI() {
    return {
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    };
  }
  return { default: OpenAI };
});

// Import after mock is set up
import { OpenAIProvider } from '../../llm/openai.provider';

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  const baseOptions: LLMOptions = {
    model: 'gpt-4o',
    maxTokens: 1000,
    temperature: 0.3,
    jsonMode: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider('test-api-key');
  });

  it('sends basic chat without tools and returns finishReason stop with no toolCalls', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await provider.chat(messages, baseOptions);

    expect(result.content).toBe('Hello!');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toBeUndefined();
  });

  it('sends tools and parses tool_calls response into ToolCall[]', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc123',
                type: 'function',
                function: {
                  name: 'kb_search',
                  arguments: JSON.stringify({ query: 'pricing plans' }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    });

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
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({
      id: 'call_abc123',
      name: 'kb_search',
      arguments: { query: 'pricing plans' },
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'kb_search',
        description: 'Search the knowledge base',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    });
  });

  it('maps a multimodal user message (text + image) to OpenAI content parts with a data URL', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'I see it.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 6 },
    });

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', mimeType: 'image/jpeg', data: 'BASE64DATA' },
        ],
      },
    ];

    await provider.chat(messages, baseOptions);

    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BASE64DATA' } },
    ]);
  });

  it('maps tool role messages to OpenAI format with tool_call_id', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: { role: 'assistant', content: 'Based on the search results, pricing starts at $29/mo.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 15 },
    });

    const messages: ChatMessage[] = [
      { role: 'user', content: 'What are your pricing plans?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_abc123', name: 'kb_search', arguments: { query: 'pricing plans' } }],
      },
      {
        role: 'tool',
        content: '{"results": ["Starter: $29/mo", "Pro: $99/mo"]}',
        toolCallId: 'call_abc123',
      },
    ];

    await provider.chat(messages, baseOptions);

    const callArgs = mockCreate.mock.calls[0][0];
    const sentMessages = callArgs.messages;

    // tool message must have tool_call_id
    const toolMsg = sentMessages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('call_abc123');
    expect(toolMsg.content).toBe('{"results": ["Starter: $29/mo", "Pro: $99/mo"]}');

    // assistant message with toolCalls must have tool_calls array
    const assistantMsg = sentMessages.find(
      (m: { role: string; tool_calls?: unknown[] }) => m.role === 'assistant' && m.tool_calls,
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0]).toEqual({
      id: 'call_abc123',
      type: 'function',
      function: {
        name: 'kb_search',
        arguments: JSON.stringify({ query: 'pricing plans' }),
      },
    });
  });
});
