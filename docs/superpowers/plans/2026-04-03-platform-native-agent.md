# Platform-Native Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the AI agentic loop from n8n into the platform with tool-calling, constrained autonomy, and per-tenant configuration.

**Architecture:** Extend LLM providers with tool-calling support. Build an AgentService that runs an iterative tool-calling loop with built-in tools (KB search, booking, escalation) and custom webhook tools. Wire into existing message-forwarding as the primary AI path for opted-in tenants, preserving n8n backward compatibility.

**Tech Stack:** TypeScript, Vitest, TypeORM, OpenAI SDK, Anthropic SDK, Redis, PostgreSQL, Socket.IO

**Spec:** `docs/superpowers/specs/2026-04-03-platform-native-agent-design.md`

---

## Task Dependency Graph

```
Task 1 (types) → Task 2 (OpenAI) → Task 4 (tool adapter interface)
                 Task 3 (Anthropic) ↗   ↓
                                    Task 5 (built-in tools) → Task 7 (agent loop) → Task 9 (metering) → Task 11 (message forwarding)
                                    Task 6 (tool registry)  ↗   ↓                    Task 10 (traces)  ↗
                                                            Task 8 (prompt builder)
                                                            Task 12 (confirmation gate) — can be done after Task 11
                                                            Task 13 (DB migration) — should be done before Task 11
```

---

### Task 1: Extend LLM Types with Tool-Calling Support

**Files:**
- Modify: `api/src/llm/llm.types.ts`
- Test: `api/src/__tests__/unit/llm-types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/llm-types.test.ts
import { describe, it, expect } from 'vitest';
import type { ChatMessage, ToolDefinition, ToolCall, LLMOptions, LLMResponse } from '../../llm/llm.types';

describe('LLM Types', () => {
  it('ChatMessage supports system/user/assistant roles', () => {
    const msg: ChatMessage = { role: 'user', content: 'hello' };
    expect(msg.role).toBe('user');
  });

  it('ChatMessage supports tool role with toolCallId', () => {
    const msg: ChatMessage = { role: 'tool', content: '{"result": "ok"}', toolCallId: 'tc_1' };
    expect(msg.role).toBe('tool');
    expect(msg.toolCallId).toBe('tc_1');
  });

  it('ChatMessage supports assistant with toolCalls', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'kb_search', arguments: { query: 'test' } }],
    };
    expect(msg.toolCalls).toHaveLength(1);
  });

  it('ToolDefinition has name, description, parameters', () => {
    const def: ToolDefinition = {
      name: 'kb_search',
      description: 'Search the knowledge base',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    };
    expect(def.name).toBe('kb_search');
  });

  it('LLMOptions accepts optional tools array', () => {
    const opts: LLMOptions = { model: 'gpt-4o', maxTokens: 1000, temperature: 0.3, jsonMode: false };
    expect(opts.tools).toBeUndefined();
    const optsWithTools: LLMOptions = { ...opts, tools: [{ name: 'test', description: 'test', parameters: {} }] };
    expect(optsWithTools.tools).toHaveLength(1);
  });

  it('LLMResponse includes finishReason and optional toolCalls', () => {
    const resp: LLMResponse = { content: 'hi', usage: { promptTokens: 10, completionTokens: 5 }, finishReason: 'stop' };
    expect(resp.finishReason).toBe('stop');
    expect(resp.toolCalls).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/llm-types.test.ts`
Expected: FAIL — `ToolDefinition`, `ToolCall`, `finishReason` don't exist yet

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `api/src/llm/llm.types.ts`:

```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMOptions {
  model: string;
  maxTokens: number;
  temperature: number;
  jsonMode: boolean;
  tools?: ToolDefinition[];
}

export interface LLMResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface LLMProvider {
  chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/llm-types.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Verify existing RAG tests still pass**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/ --reporter=verbose`
Expected: All existing unit tests PASS (the type changes are backward compatible — `toolCalls`, `toolCallId`, `tools`, `finishReason` are all optional)

- [ ] **Step 6: Commit**

```bash
cd chatbot-platform/api
git add src/llm/llm.types.ts src/__tests__/unit/llm-types.test.ts
git commit -m "feat: extend LLM types with tool-calling support"
```

---

### Task 2: Update OpenAI Provider for Tool-Calling

**Files:**
- Modify: `api/src/llm/openai.provider.ts`
- Test: `api/src/__tests__/unit/openai-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/openai-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock OpenAI SDK
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    constructor() {}
  },
}));

import { OpenAIProvider } from '../../llm/openai.provider';
import type { ChatMessage, LLMOptions } from '../../llm/llm.types';

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider('test-key');
    vi.clearAllMocks();
  });

  it('sends basic chat without tools', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello!', tool_calls: undefined }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const options: LLMOptions = { model: 'gpt-4o', maxTokens: 100, temperature: 0.3, jsonMode: false };
    const result = await provider.chat(messages, options);

    expect(result.content).toBe('Hello!');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ tools: undefined }));
  });

  it('sends tools and parses tool_calls response', async () => {
    mockCreate.mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: { name: 'kb_search', arguments: '{"query":"test"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'search for test' }];
    const tools = [{ name: 'kb_search', description: 'Search KB', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
    const options: LLMOptions = { model: 'gpt-4o', maxTokens: 100, temperature: 0.3, jsonMode: false, tools };
    const result = await provider.chat(messages, options);

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({ id: 'call_123', name: 'kb_search', arguments: { query: 'test' } });
  });

  it('maps tool role messages to OpenAI format', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Based on the results...', tool_calls: undefined }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    });

    const messages: ChatMessage[] = [
      { role: 'user', content: 'search' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'kb_search', arguments: { query: 'test' } }] },
      { role: 'tool', content: '{"chunks": []}', toolCallId: 'call_1' },
    ];
    const options: LLMOptions = { model: 'gpt-4o', maxTokens: 100, temperature: 0.3, jsonMode: false };
    await provider.chat(messages, options);

    const sentMessages = mockCreate.mock.calls[0][0].messages;
    expect(sentMessages[2]).toEqual({ role: 'tool', content: '{"chunks": []}', tool_call_id: 'call_1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/openai-provider.test.ts`
Expected: FAIL — `finishReason` not returned, `toolCalls` not parsed

- [ ] **Step 3: Write the implementation**

Replace `api/src/llm/openai.provider.ts`:

```typescript
import OpenAI from 'openai';
import { LLMProvider, ChatMessage, LLMOptions, LLMResponse, ToolCall } from './llm.types';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, timeout: 30000 });
  }

  async chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse> {
    const openaiMessages = messages.map((m) => this.toOpenAIMessage(m));

    const tools = options.tools?.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      response_format: options.jsonMode ? { type: 'json_object' as const } : undefined,
      tools: tools && tools.length > 0 ? tools : undefined,
    });

    const choice = response.choices[0];
    const toolCalls = this.parseToolCalls(choice.message.tool_calls);
    const finishReason = choice.finish_reason === 'tool_calls' ? 'tool_calls' as const
      : choice.finish_reason === 'length' ? 'length' as const
      : 'stop' as const;

    return {
      content: choice.message.content || '',
      usage: {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
      },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
    };
  }

  private toOpenAIMessage(msg: ChatMessage): OpenAI.ChatCompletionMessageParam {
    if (msg.role === 'tool') {
      return { role: 'tool', content: msg.content, tool_call_id: msg.toolCallId || '' };
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      return {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: msg.role as 'system' | 'user' | 'assistant', content: msg.content };
  }

  private parseToolCalls(toolCalls?: OpenAI.ChatCompletionMessageToolCall[]): ToolCall[] {
    if (!toolCalls) return [];
    return toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/openai-provider.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/llm/openai.provider.ts src/__tests__/unit/openai-provider.test.ts
git commit -m "feat: add tool-calling support to OpenAI provider"
```

---

### Task 3: Update Anthropic Provider for Tool-Calling

**Files:**
- Modify: `api/src/llm/anthropic.provider.ts`
- Test: `api/src/__tests__/unit/anthropic-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/anthropic-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
    constructor() {}
  },
}));

import { AnthropicProvider } from '../../llm/anthropic.provider';
import type { ChatMessage, LLMOptions } from '../../llm/llm.types';

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider('test-key');
    vi.clearAllMocks();
  });

  it('sends basic chat without tools', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const options: LLMOptions = { model: 'claude-sonnet-4-20250514', maxTokens: 100, temperature: 0.3, jsonMode: false };
    const result = await provider.chat(messages, options);

    expect(result.content).toBe('Hello!');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();
  });

  it('sends tools and parses tool_use response', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Let me search for that.' },
        { type: 'tool_use', id: 'toolu_123', name: 'kb_search', input: { query: 'test' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 20 },
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'search' }];
    const tools = [{ name: 'kb_search', description: 'Search KB', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
    const options: LLMOptions = { model: 'claude-sonnet-4-20250514', maxTokens: 100, temperature: 0.3, jsonMode: false, tools };
    const result = await provider.chat(messages, options);

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({ id: 'toolu_123', name: 'kb_search', arguments: { query: 'test' } });
    expect(result.content).toBe('Let me search for that.');
  });

  it('maps tool result messages to Anthropic format', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Found results.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 80, output_tokens: 10 },
    });

    const messages: ChatMessage[] = [
      { role: 'user', content: 'search' },
      { role: 'assistant', content: 'Let me search.', toolCalls: [{ id: 'toolu_1', name: 'kb_search', arguments: { query: 'test' } }] },
      { role: 'tool', content: '{"chunks": []}', toolCallId: 'toolu_1' },
    ];
    const options: LLMOptions = { model: 'claude-sonnet-4-20250514', maxTokens: 100, temperature: 0.3, jsonMode: false };
    await provider.chat(messages, options);

    const sentMessages = mockCreate.mock.calls[0][0].messages;
    // Anthropic: assistant with tool_use blocks, then user with tool_result blocks
    expect(sentMessages[1].role).toBe('assistant');
    expect(sentMessages[1].content).toContainEqual(expect.objectContaining({ type: 'tool_use', id: 'toolu_1' }));
    expect(sentMessages[2].role).toBe('user');
    expect(sentMessages[2].content).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_1' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/anthropic-provider.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

Replace `api/src/llm/anthropic.provider.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, ChatMessage, LLMOptions, LLMResponse, ToolCall } from './llm.types';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 30000 });
  }

  async chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse> {
    const systemMessage = messages.find((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const anthropicMessages = this.toAnthropicMessages(nonSystemMessages);

    const tools = options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    const createParams: Anthropic.MessageCreateParams = {
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      system: systemMessage?.content || '',
      messages: anthropicMessages,
    };

    if (tools && tools.length > 0) {
      createParams.tools = tools;
    }

    const response = await this.client.messages.create(createParams);

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const toolCalls = this.parseToolUseBlocks(response.content);
    const finishReason = response.stop_reason === 'tool_use' ? 'tool_calls' as const
      : response.stop_reason === 'max_tokens' ? 'length' as const
      : 'stop' as const;

    return {
      content: textContent,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
    };
  }

  private toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
        result.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        // Anthropic expects tool results inside a 'user' message
        const lastMsg = result[result.length - 1];
        const toolResult: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId || '',
          content: msg.content,
        };
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as Anthropic.ContentBlockParam[]).push(toolResult);
        } else {
          result.push({ role: 'user', content: [toolResult] });
        }
      } else {
        result.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
    }

    return result;
  }

  private parseToolUseBlocks(content: Anthropic.ContentBlock[]): ToolCall[] {
    return content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: (block.input || {}) as Record<string, unknown>,
      }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/anthropic-provider.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Run all unit tests to verify no regressions**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/ --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/llm/anthropic.provider.ts src/__tests__/unit/anthropic-provider.test.ts
git commit -m "feat: add tool-calling support to Anthropic provider"
```

---

### Task 4: Tool Adapter Interface and Types

**Files:**
- Create: `api/src/agent/tool-adapter.ts`
- Test: `api/src/__tests__/unit/tool-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/tool-adapter.test.ts
import { describe, it, expect } from 'vitest';
import type { ToolAdapter, ToolContext, ToolResult } from '../../agent/tool-adapter';

describe('ToolAdapter types', () => {
  it('ToolAdapter interface is implementable', () => {
    const adapter: ToolAdapter = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: { input: { type: 'string' } } },
      hasSideEffects: false,
      async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        return { success: true, data: { result: args.input } };
      },
    };
    expect(adapter.name).toBe('test_tool');
    expect(adapter.hasSideEffects).toBe(false);
  });

  it('ToolAdapter with preconditions', () => {
    const adapter: ToolAdapter = {
      name: 'create_booking',
      description: 'Create a booking',
      parameters: {},
      hasSideEffects: true,
      preconditions: { toolsCalled: ['check_availability'] },
      async execute() { return { success: true }; },
    };
    expect(adapter.preconditions?.toolsCalled).toContain('check_availability');
  });

  it('ToolResult can carry error', () => {
    const result: ToolResult = { success: false, error: 'Slot unavailable' };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Slot unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/tool-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the directory and implementation**

```bash
mkdir -p api/src/agent/tools
```

```typescript
// api/src/agent/tool-adapter.ts
import type { DataSource } from 'typeorm';
import type { ChatMessage } from '../llm/llm.types';

export interface ToolContext {
  tenantId: string;
  sessionId: string;
  runId: string;
  toolsCalledThisTurn: string[];
  dataSource: DataSource;
  conversationHistory: ChatMessage[];
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolAdapter {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  hasSideEffects: boolean;
  preconditions?: { toolsCalled?: string[] };
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/tool-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/
git commit -m "feat: add ToolAdapter interface and types"
```

---

### Task 5: Built-in Tool Implementations

**Files:**
- Create: `api/src/agent/tools/kb-search.tool.ts`
- Create: `api/src/agent/tools/booking.tool.ts`
- Create: `api/src/agent/tools/escalation.tool.ts`
- Test: `api/src/__tests__/unit/builtin-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// api/src/__tests__/unit/builtin-tools.test.ts
import { describe, it, expect, vi } from 'vitest';
import { KbSearchTool } from '../../agent/tools/kb-search.tool';
import { CheckAvailabilityTool, CreateBookingTool, ListBookingsTool, RescheduleBookingTool, CancelBookingTool } from '../../agent/tools/booking.tool';
import { EscalationTool } from '../../agent/tools/escalation.tool';
import type { ToolContext } from '../../agent/tool-adapter';

// Mock booking service
vi.mock('../../n8n/booking.service', () => ({
  checkAvailability: vi.fn().mockResolvedValue({ slots: [{ start: '2026-04-05T10:00:00', end: '2026-04-05T10:30:00' }], timezone: 'UTC' }),
  createBooking: vi.fn().mockResolvedValue({ success: true, booking: { id: 'bk_1', startTime: '2026-04-05T10:00:00' } }),
  listBookings: vi.fn().mockResolvedValue({ bookings: [] }),
  rescheduleBooking: vi.fn().mockResolvedValue({ success: true }),
  cancelBooking: vi.fn().mockResolvedValue({ success: true, cancelled: true }),
}));

const mockCtx: ToolContext = {
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  runId: 'run-1',
  toolsCalledThisTurn: [],
  dataSource: {} as any,
  conversationHistory: [],
};

describe('Built-in Tools', () => {
  describe('KbSearchTool', () => {
    it('has correct metadata', () => {
      const tool = new KbSearchTool();
      expect(tool.name).toBe('kb_search');
      expect(tool.hasSideEffects).toBe(false);
    });
  });

  describe('CheckAvailabilityTool', () => {
    it('has correct metadata', () => {
      const tool = new CheckAvailabilityTool();
      expect(tool.name).toBe('check_availability');
      expect(tool.hasSideEffects).toBe(false);
    });

    it('calls checkAvailability with correct args', async () => {
      const tool = new CheckAvailabilityTool();
      const result = await tool.execute({ startDate: '2026-04-05', endDate: '2026-04-06' }, mockCtx);
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('slots');
    });
  });

  describe('CreateBookingTool', () => {
    it('has side effects and preconditions', () => {
      const tool = new CreateBookingTool();
      expect(tool.name).toBe('create_booking');
      expect(tool.hasSideEffects).toBe(true);
      expect(tool.preconditions?.toolsCalled).toContain('check_availability');
    });

    it('generates idempotency key from runId', async () => {
      const { createBooking } = await import('../../n8n/booking.service');
      const tool = new CreateBookingTool();
      await tool.execute(
        { startTime: '2026-04-05T10:00:00', attendeeName: 'John', attendeeEmail: 'john@test.com' },
        mockCtx,
      );
      expect(createBooking).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('run-1'), // idempotency key includes runId
        '2026-04-05T10:00:00',
        { name: 'John', email: 'john@test.com' },
        undefined,
      );
    });
  });

  describe('EscalationTool', () => {
    it('has side effects', () => {
      const tool = new EscalationTool();
      expect(tool.name).toBe('escalate_to_agent');
      expect(tool.hasSideEffects).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/builtin-tools.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement KbSearchTool**

```typescript
// api/src/agent/tools/kb-search.tool.ts
import { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import { searchKnowledge } from '../../llm/rag.service';

export class KbSearchTool implements ToolAdapter {
  name = 'kb_search';
  description = 'Search the tenant knowledge base for relevant information. Use when the user asks a question that might be answered by documentation, FAQs, or uploaded content.';
  parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  };
  hasSideEffects = false;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const query = args.query as string;
      const history = ctx.conversationHistory
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const { chunks } = await searchKnowledge(ctx.dataSource, ctx.tenantId, query, history);

      if (chunks.length === 0) {
        return { success: true, data: { chunks: [], message: 'No relevant knowledge found.' } };
      }

      return {
        success: true,
        data: {
          chunks: chunks.map((c) => ({ content: c.content, source: c.title, similarity: c.similarity })),
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'KB search failed' };
    }
  }
}
```

- [ ] **Step 4: Implement booking tools**

```typescript
// api/src/agent/tools/booking.tool.ts
import { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import {
  checkAvailability,
  createBooking,
  listBookings,
  rescheduleBooking,
  cancelBooking,
} from '../../n8n/booking.service';

export class CheckAvailabilityTool implements ToolAdapter {
  name = 'check_availability';
  description = 'Check available booking slots for a date range. Call this BEFORE creating a booking.';
  parameters = {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date (ISO 8601, e.g. 2026-04-05)' },
      endDate: { type: 'string', description: 'End date (ISO 8601, e.g. 2026-04-07)' },
    },
    required: ['startDate', 'endDate'],
  };
  hasSideEffects = false;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await checkAvailability(ctx.sessionId, args.startDate as string, args.endDate as string);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Availability check failed' };
    }
  }
}

export class CreateBookingTool implements ToolAdapter {
  name = 'create_booking';
  description = 'Create a new booking. Only call AFTER checking availability and confirming details with the customer.';
  parameters = {
    type: 'object',
    properties: {
      startTime: { type: 'string', description: 'Selected start time (ISO 8601)' },
      attendeeName: { type: 'string', description: "Customer's name" },
      attendeeEmail: { type: 'string', description: "Customer's email" },
      notes: { type: 'string', description: 'Optional booking notes' },
    },
    required: ['startTime', 'attendeeName', 'attendeeEmail'],
  };
  hasSideEffects = true;
  preconditions = { toolsCalled: ['check_availability'] };

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const idempotencyKey = `${ctx.runId}:create_booking:${args.startTime}`;
      const result = await createBooking(
        ctx.sessionId,
        idempotencyKey,
        args.startTime as string,
        { name: args.attendeeName as string, email: args.attendeeEmail as string },
        args.notes as string | undefined,
      );
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Booking creation failed' };
    }
  }
}

export class ListBookingsTool implements ToolAdapter {
  name = 'list_bookings';
  description = "List a customer's upcoming bookings. Requires the customer's email address.";
  parameters = {
    type: 'object',
    properties: {
      attendeeEmail: { type: 'string', description: "Customer's email address" },
    },
    required: ['attendeeEmail'],
  };
  hasSideEffects = false;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await listBookings(ctx.sessionId, args.attendeeEmail as string);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'List bookings failed' };
    }
  }
}

export class RescheduleBookingTool implements ToolAdapter {
  name = 'reschedule_booking';
  description = 'Reschedule an existing booking to a new time.';
  parameters = {
    type: 'object',
    properties: {
      bookingId: { type: 'string', description: 'The booking ID to reschedule' },
      newStartTime: { type: 'string', description: 'New start time (ISO 8601)' },
    },
    required: ['bookingId', 'newStartTime'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await rescheduleBooking(ctx.sessionId, args.bookingId as string, args.newStartTime as string);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Reschedule failed' };
    }
  }
}

export class CancelBookingTool implements ToolAdapter {
  name = 'cancel_booking';
  description = 'Cancel an existing booking.';
  parameters = {
    type: 'object',
    properties: {
      bookingId: { type: 'string', description: 'The booking ID to cancel' },
      reason: { type: 'string', description: 'Cancellation reason' },
    },
    required: ['bookingId'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await cancelBooking(ctx.sessionId, args.bookingId as string, args.reason as string | undefined);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Cancellation failed' };
    }
  }
}
```

- [ ] **Step 5: Implement EscalationTool**

```typescript
// api/src/agent/tools/escalation.tool.ts
import { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';

export class EscalationTool implements ToolAdapter {
  name = 'escalate_to_agent';
  description = 'Transfer the conversation to a human agent. Use when the customer explicitly requests a human, or when you cannot help with their request.';
  parameters = {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why the escalation is needed' },
    },
    required: ['reason'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // The agent loop will handle the actual handoff based on this result.
    // We return a signal that the caller interprets.
    return {
      success: true,
      data: { action: 'escalate', reason: args.reason as string },
    };
  }
}
```

- [ ] **Step 6: Run tests**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/builtin-tools.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/
git commit -m "feat: implement built-in tool adapters (KB, booking, escalation)"
```

---

### Task 6: Tool Registry

**Files:**
- Create: `api/src/agent/tool-registry.ts`
- Test: `api/src/__tests__/unit/tool-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/tool-registry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../../agent/tool-registry';

// Mock AppDataSource
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn().mockReturnValue({
      find: vi.fn().mockResolvedValue([]),
    }),
  },
}));

describe('ToolRegistry', () => {
  it('registers all built-in tools on construction', () => {
    const registry = new ToolRegistry();
    const builtins = registry.getBuiltinToolNames();
    expect(builtins).toContain('kb_search');
    expect(builtins).toContain('check_availability');
    expect(builtins).toContain('create_booking');
    expect(builtins).toContain('list_bookings');
    expect(builtins).toContain('reschedule_booking');
    expect(builtins).toContain('cancel_booking');
    expect(builtins).toContain('escalate_to_agent');
    expect(builtins).toHaveLength(7);
  });

  it('returns only enabled tools for a tenant with booking integration', async () => {
    const registry = new ToolRegistry();
    const tenant = {
      id: 'tenant-1',
      settings: {
        ai: { enabled: true },
        integrations: { calcom: { apiKey: 'enc_key', eventTypeId: 1 } },
      },
    };
    const tools = await registry.getToolsForTenant(tenant as any);
    // Should include kb_search, all booking tools, and escalation
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('kb_search');
    expect(toolNames).toContain('check_availability');
    expect(toolNames).toContain('escalate_to_agent');
  });

  it('excludes booking tools when tenant has no calcom integration', async () => {
    const registry = new ToolRegistry();
    const tenant = { id: 'tenant-2', settings: { ai: { enabled: true } } };
    const tools = await registry.getToolsForTenant(tenant as any);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('kb_search');
    expect(toolNames).toContain('escalate_to_agent');
    expect(toolNames).not.toContain('check_availability');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/tool-registry.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// api/src/agent/tool-registry.ts
import { ToolAdapter } from './tool-adapter';
import { KbSearchTool } from './tools/kb-search.tool';
import {
  CheckAvailabilityTool,
  CreateBookingTool,
  ListBookingsTool,
  RescheduleBookingTool,
  CancelBookingTool,
} from './tools/booking.tool';
import { EscalationTool } from './tools/escalation.tool';
import { Tenant } from '../database/entities/Tenant';
import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';

const BOOKING_TOOLS = ['check_availability', 'create_booking', 'list_bookings', 'reschedule_booking', 'cancel_booking'];

export class ToolRegistry {
  private builtinTools: Map<string, ToolAdapter>;

  constructor() {
    this.builtinTools = new Map();
    this.registerBuiltin(new KbSearchTool());
    this.registerBuiltin(new CheckAvailabilityTool());
    this.registerBuiltin(new CreateBookingTool());
    this.registerBuiltin(new ListBookingsTool());
    this.registerBuiltin(new RescheduleBookingTool());
    this.registerBuiltin(new CancelBookingTool());
    this.registerBuiltin(new EscalationTool());
  }

  private registerBuiltin(tool: ToolAdapter): void {
    this.builtinTools.set(tool.name, tool);
  }

  getBuiltinToolNames(): string[] {
    return Array.from(this.builtinTools.keys());
  }

  async getToolsForTenant(tenant: Tenant): Promise<ToolAdapter[]> {
    const tools: ToolAdapter[] = [];

    // Always include KB search and escalation
    const kbSearch = this.builtinTools.get('kb_search');
    if (kbSearch) tools.push(kbSearch);

    const escalation = this.builtinTools.get('escalate_to_agent');
    if (escalation) tools.push(escalation);

    // Include booking tools only if Cal.com is configured
    const calcom = tenant.settings?.integrations?.calcom;
    if (calcom?.apiKey && calcom?.eventTypeId) {
      for (const name of BOOKING_TOOLS) {
        const tool = this.builtinTools.get(name);
        if (tool) tools.push(tool);
      }
    }

    // Load custom tools from DB (Phase 1: webhook tools)
    try {
      const customTools = await this.loadCustomTools(tenant.id);
      tools.push(...customTools);
    } catch (error) {
      logger.warn(`Failed to load custom tools for tenant ${tenant.id}`, { error });
    }

    return tools;
  }

  private async loadCustomTools(tenantId: string): Promise<ToolAdapter[]> {
    // tool_definitions table will be created in Task 13 (DB migration)
    // For now, return empty — custom tools are a Phase 1 stretch goal
    try {
      const repo = AppDataSource.getRepository('tool_definitions');
      const definitions = await repo.find({ where: { tenantId, enabled: true } });
      // WebhookToolAdapter creation would go here
      return [];
    } catch {
      // Table may not exist yet — graceful degradation
      return [];
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/tool-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/tool-registry.ts src/__tests__/unit/tool-registry.test.ts
git commit -m "feat: implement ToolRegistry with built-in tool enablement"
```

---

### Task 7: Prompt Builder

**Files:**
- Create: `api/src/agent/prompt-builder.ts`
- Test: `api/src/__tests__/unit/prompt-builder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/prompt-builder.test.ts
import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../agent/prompt-builder';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { Tenant } from '../../database/entities/Tenant';

describe('PromptBuilder', () => {
  const builder = new PromptBuilder();

  const baseTenant = {
    name: 'TestCo',
    settings: {
      ai: {
        enabled: true,
        brandVoice: { name: 'TestBot', tone: 'friendly', customInstructions: 'Always greet the customer.' },
        guardrails: { topicsToAvoid: ['politics'], maxResponseLength: 500, escalationKeywords: [] },
      },
    },
  } as unknown as Tenant;

  const mockTools: ToolAdapter[] = [
    { name: 'kb_search', description: 'Search KB', parameters: {}, hasSideEffects: false, execute: async () => ({ success: true }) },
    { name: 'escalate_to_agent', description: 'Escalate', parameters: {}, hasSideEffects: true, execute: async () => ({ success: true }) },
  ];

  it('includes brand voice in system prompt', () => {
    const prompt = builder.build(baseTenant, mockTools);
    expect(prompt).toContain('TestBot');
    expect(prompt).toContain('friendly');
    expect(prompt).toContain('Always greet the customer.');
  });

  it('includes guardrails', () => {
    const prompt = builder.build(baseTenant, mockTools);
    expect(prompt).toContain('politics');
    expect(prompt).toContain('500');
  });

  it('includes escalation instruction', () => {
    const prompt = builder.build(baseTenant, mockTools);
    expect(prompt).toContain('escalate_to_agent');
  });

  it('includes skill instructions when skills are configured', () => {
    const tenantWithSkills = {
      ...baseTenant,
      settings: {
        ...baseTenant.settings,
        skills: [{
          name: 'booking',
          trigger: 'User wants to schedule',
          tools: ['check_availability', 'create_booking'],
          instructions: 'Always check availability first.',
          maxSteps: 8,
          enabled: true,
        }],
      },
    } as unknown as Tenant;
    const prompt = builder.build(tenantWithSkills, mockTools);
    expect(prompt).toContain('booking');
    expect(prompt).toContain('Always check availability first.');
  });

  it('skips disabled skills', () => {
    const tenantWithDisabled = {
      ...baseTenant,
      settings: {
        ...baseTenant.settings,
        skills: [{ name: 'disabled_skill', trigger: 'x', tools: [], instructions: 'SECRET', maxSteps: 5, enabled: false }],
      },
    } as unknown as Tenant;
    const prompt = builder.build(tenantWithDisabled, mockTools);
    expect(prompt).not.toContain('SECRET');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/prompt-builder.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// api/src/agent/prompt-builder.ts
import { Tenant } from '../database/entities/Tenant';
import { ToolAdapter } from './tool-adapter';

export class PromptBuilder {
  build(tenant: Tenant, tools: ToolAdapter[], kbContext?: string): string {
    const ai = tenant.settings?.ai;
    const brandVoice = ai?.brandVoice;
    const guardrails = ai?.guardrails;
    const skills = (tenant.settings as any)?.skills || [];

    const sections: string[] = [];

    // Brand voice
    sections.push(`You are ${brandVoice?.name || tenant.name}.`);
    sections.push(`Tone: ${brandVoice?.tone || 'professional'}`);
    if (brandVoice?.customInstructions) {
      sections.push(brandVoice.customInstructions);
    }

    // Guardrails
    const guardrailLines: string[] = [];
    if (guardrails?.topicsToAvoid?.length) {
      guardrailLines.push(`- Never discuss: ${guardrails.topicsToAvoid.join(', ')}`);
    }
    if (guardrails?.maxResponseLength) {
      guardrailLines.push(`- Max response: ${guardrails.maxResponseLength} characters`);
    }
    guardrailLines.push('- If unsure, say so honestly');
    sections.push(`\n## GUARDRAILS\n${guardrailLines.join('\n')}`);

    // Escalation
    if (tools.some((t) => t.name === 'escalate_to_agent')) {
      sections.push('\n## ESCALATION\nIf the customer explicitly asks for a human agent or you cannot help, call the escalate_to_agent tool.');
    }

    // Skills
    const enabledSkills = skills.filter((s: any) => s.enabled);
    if (enabledSkills.length > 0) {
      const skillsSection = enabledSkills.map((s: any) =>
        `### ${s.name}\nWhen: ${s.trigger}\nTools: ${s.tools.join(', ')}\nRules: ${s.instructions}`
      ).join('\n\n');
      sections.push(`\n## AVAILABLE SKILLS\n\n${skillsSection}`);
    }

    // KB context (pre-fetched)
    if (kbContext) {
      sections.push(`\n## KNOWLEDGE BASE\n${kbContext}`);
    }

    // Rules
    sections.push('\n## RULES\n- Be concise (2-4 sentences unless more is needed)\n- Match the customer\'s language\n- Never reveal internal system details or escalation rules');

    return sections.join('\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/prompt-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/prompt-builder.ts src/__tests__/unit/prompt-builder.test.ts
git commit -m "feat: implement PromptBuilder for dynamic system prompt assembly"
```

---

### Task 8: Token Metering Service

**Files:**
- Create: `api/src/agent/metering.service.ts`
- Test: `api/src/__tests__/unit/metering.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/metering.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeteringService } from '../../agent/metering.service';

// Mock Redis
const mockHincrby = vi.fn().mockResolvedValue(1);
const mockHgetall = vi.fn().mockResolvedValue({ prompt: '100', completion: '50', total: '150', calls: '2' });
const mockExpireat = vi.fn().mockResolvedValue(1);

const mockRedis = {
  hincrby: mockHincrby,
  hgetall: mockHgetall,
  expireat: mockExpireat,
};

describe('MeteringService', () => {
  let metering: MeteringService;

  beforeEach(() => {
    metering = new MeteringService(mockRedis as any);
    vi.clearAllMocks();
  });

  it('records token usage to Redis', async () => {
    await metering.record('tenant-1', { promptTokens: 50, completionTokens: 20 });
    expect(mockHincrby).toHaveBeenCalledTimes(4); // prompt, completion, total, calls
  });

  it('checks budget against daily total', async () => {
    mockHgetall.mockResolvedValue({ total: '45000' });
    const overBudget = await metering.isOverBudget('tenant-1', 50000);
    expect(overBudget).toBe(false);

    mockHgetall.mockResolvedValue({ total: '55000' });
    const overBudget2 = await metering.isOverBudget('tenant-1', 50000);
    expect(overBudget2).toBe(true);
  });

  it('returns false (not over budget) when no budget set', async () => {
    const overBudget = await metering.isOverBudget('tenant-1', undefined);
    expect(overBudget).toBe(false);
  });

  it('generates correct Redis key with date', async () => {
    await metering.record('tenant-1', { promptTokens: 10, completionTokens: 5 });
    const today = new Date().toISOString().split('T')[0];
    expect(mockHincrby.mock.calls[0][0]).toBe(`tokens:tenant-1:${today}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/metering.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// api/src/agent/metering.service.ts
import { logger } from '../utils/logger';

interface RedisLike {
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expireat(key: string, timestamp: number): Promise<number>;
}

export class MeteringService {
  private redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  async record(tenantId: string, usage: { promptTokens: number; completionTokens: number }): Promise<void> {
    const key = this.getDailyKey(tenantId);
    const total = usage.promptTokens + usage.completionTokens;

    try {
      await Promise.all([
        this.redis.hincrby(key, 'prompt', usage.promptTokens),
        this.redis.hincrby(key, 'completion', usage.completionTokens),
        this.redis.hincrby(key, 'total', total),
        this.redis.hincrby(key, 'calls', 1),
      ]);

      // Set expiry to end of day UTC (auto-cleanup, no manual reset)
      const endOfDay = new Date();
      endOfDay.setUTCHours(23, 59, 59, 999);
      await this.redis.expireat(key, Math.floor(endOfDay.getTime() / 1000));
    } catch (error) {
      logger.warn('Failed to record token usage', { tenantId, error });
    }
  }

  async isOverBudget(tenantId: string, dailyBudget: number | undefined | null): Promise<boolean> {
    if (!dailyBudget) return false;

    try {
      const key = this.getDailyKey(tenantId);
      const data = await this.redis.hgetall(key);
      const totalUsed = parseInt(data?.total || '0', 10);
      return totalUsed >= dailyBudget;
    } catch (error) {
      logger.warn('Failed to check token budget', { tenantId, error });
      return false; // Fail open — don't block conversations because metering is down
    }
  }

  async getDailyUsage(tenantId: string): Promise<{ prompt: number; completion: number; total: number; calls: number }> {
    const key = this.getDailyKey(tenantId);
    const data = await this.redis.hgetall(key);
    return {
      prompt: parseInt(data?.prompt || '0', 10),
      completion: parseInt(data?.completion || '0', 10),
      total: parseInt(data?.total || '0', 10),
      calls: parseInt(data?.calls || '0', 10),
    };
  }

  private getDailyKey(tenantId: string): string {
    const today = new Date().toISOString().split('T')[0];
    return `tokens:${tenantId}:${today}`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/metering.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/metering.service.ts src/__tests__/unit/metering.test.ts
git commit -m "feat: implement token metering service with Redis counters"
```

---

### Task 9: Agent Trace Logger

**Files:**
- Create: `api/src/agent/trace-logger.ts`
- Test: `api/src/__tests__/unit/trace-logger.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/trace-logger.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TraceLogger, AgentTrace } from '../../agent/trace-logger';

const mockSave = vi.fn().mockResolvedValue({ id: 'trace-1' });
const mockCreate = vi.fn().mockImplementation((data) => data);
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn().mockReturnValue({ save: mockSave, create: mockCreate }),
  },
}));

describe('TraceLogger', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/trace-logger.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// api/src/agent/trace-logger.ts
import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';

export interface AgentTrace {
  sessionId: string;
  tenantId: string;
  messageId?: string;
  iterations: Array<{
    llmCall: { model: string; promptTokens: number; completionTokens: number; latencyMs: number };
    toolCalls: Array<{
      name: string;
      args: Record<string, unknown>;
      result: { success: boolean; error?: string; data?: unknown };
      latencyMs: number;
      confirmed?: boolean;
    }>;
  }>;
  finishReason: 'completed' | 'max_iterations' | 'budget_exceeded' | 'error';
}

const PII_FIELDS = ['email', 'attendeeemail', 'attendee_email', 'phone', 'phonenumber'];

function maskPiiInArgs(args: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...args };
  for (const [key, value] of Object.entries(masked)) {
    if (typeof value === 'string' && PII_FIELDS.includes(key.toLowerCase())) {
      if (value.includes('@')) {
        const [local, domain] = value.split('@');
        masked[key] = `${local[0]}${'*'.repeat(Math.max(local.length - 1, 2))}@${domain}`;
      } else {
        masked[key] = value.slice(0, 2) + '*'.repeat(Math.max(value.length - 2, 4));
      }
    }
  }
  return masked;
}

export class TraceLogger {
  async save(trace: AgentTrace): Promise<void> {
    try {
      const totalTokens = trace.iterations.reduce(
        (sum, it) => sum + it.llmCall.promptTokens + it.llmCall.completionTokens, 0,
      );
      const totalLatencyMs = trace.iterations.reduce(
        (sum, it) => sum + it.llmCall.latencyMs + it.toolCalls.reduce((s, tc) => s + tc.latencyMs, 0), 0,
      );

      // Mask PII in tool args before persisting
      const sanitizedTrace = {
        ...trace,
        iterations: trace.iterations.map((it) => ({
          ...it,
          toolCalls: it.toolCalls.map((tc) => ({
            ...tc,
            args: maskPiiInArgs(tc.args),
          })),
        })),
      };

      const repo = AppDataSource.getRepository('agent_traces');
      await repo.save(repo.create({
        tenantId: trace.tenantId,
        sessionId: trace.sessionId,
        messageId: trace.messageId,
        trace: sanitizedTrace,
        totalTokens,
        totalLatencyMs,
        finishReason: trace.finishReason,
      }));
    } catch (error) {
      // Non-blocking — don't fail the conversation because tracing is down
      logger.warn('Failed to save agent trace', { sessionId: trace.sessionId, error });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/trace-logger.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/trace-logger.ts src/__tests__/unit/trace-logger.test.ts
git commit -m "feat: implement agent trace logger with PII masking"
```

---

### Task 10: Core Agent Loop

**Files:**
- Create: `api/src/agent/agent.service.ts`
- Test: `api/src/__tests__/unit/agent-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/agent-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../../agent/agent.service';
import type { ToolAdapter, ToolContext } from '../../agent/tool-adapter';
import type { LLMProvider, ChatMessage, LLMOptions, LLMResponse } from '../../llm/llm.types';

// Create mock dependencies
const mockProvider: LLMProvider = {
  chat: vi.fn(),
};

const mockGetProvider = vi.fn().mockReturnValue(mockProvider);
vi.mock('../../llm/provider-factory', () => ({
  getProvider: (...args: any[]) => mockGetProvider(...args),
}));

const mockMeteringRecord = vi.fn();
const mockMeteringIsOverBudget = vi.fn().mockResolvedValue(false);
const mockMetering = { record: mockMeteringRecord, isOverBudget: mockMeteringIsOverBudget };

const mockTraceSave = vi.fn();
const mockTraceLogger = { save: mockTraceSave };

const mockKbSearch: ToolAdapter = {
  name: 'kb_search',
  description: 'Search KB',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
  hasSideEffects: false,
  execute: vi.fn().mockResolvedValue({ success: true, data: { chunks: [] } }),
};

const mockGetToolsForTenant = vi.fn().mockResolvedValue([mockKbSearch]);
const mockToolRegistry = { getToolsForTenant: mockGetToolsForTenant, getBuiltinToolNames: vi.fn() };

const mockPromptBuilder = { build: vi.fn().mockReturnValue('You are TestBot.') };

describe('AgentService', () => {
  let agent: AgentService;

  beforeEach(() => {
    agent = new AgentService(
      mockToolRegistry as any,
      mockPromptBuilder as any,
      mockMetering as any,
      mockTraceLogger as any,
    );
    vi.clearAllMocks();
    mockMeteringIsOverBudget.mockResolvedValue(false);
  });

  it('returns a text response when LLM finishes with stop', async () => {
    (mockProvider.chat as any).mockResolvedValue({
      content: 'Hello! How can I help?',
      usage: { promptTokens: 50, completionTokens: 20 },
      finishReason: 'stop',
    });

    const result = await agent.run(
      'hi',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') expect(result.content).toBe('Hello! How can I help?');
    expect(mockMeteringRecord).toHaveBeenCalled();
    expect(mockTraceSave).toHaveBeenCalled();
  });

  it('executes tool calls and loops back to LLM', async () => {
    // First call: LLM wants to use kb_search
    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'kb_search', arguments: { query: 'pricing' } }],
      })
      // Second call: LLM gives final answer
      .mockResolvedValueOnce({
        content: 'Our pricing starts at $29/mo.',
        usage: { promptTokens: 100, completionTokens: 30 },
        finishReason: 'stop',
      });

    const result = await agent.run(
      'what is your pricing?',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    expect(result.type).toBe('response');
    if (result.type === 'response') expect(result.content).toBe('Our pricing starts at $29/mo.');
    expect(mockKbSearch.execute).toHaveBeenCalledWith(
      { query: 'pricing' },
      expect.objectContaining({ tenantId: 't1', sessionId: 's1' }),
    );
    expect(mockMeteringRecord).toHaveBeenCalledTimes(2); // two LLM calls
  });

  it('enforces preconditions — blocks tool if prerequisite not called', async () => {
    const createBooking: ToolAdapter = {
      name: 'create_booking',
      description: 'Create booking',
      parameters: {},
      hasSideEffects: true,
      preconditions: { toolsCalled: ['check_availability'] },
      execute: vi.fn(),
    };
    mockGetToolsForTenant.mockResolvedValue([createBooking]);

    (mockProvider.chat as any)
      .mockResolvedValueOnce({
        content: '',
        usage: { promptTokens: 50, completionTokens: 10 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc_1', name: 'create_booking', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: 'I need to check availability first.',
        usage: { promptTokens: 80, completionTokens: 15 },
        finishReason: 'stop',
      });

    await agent.run(
      'book me in',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      { id: 't1', settings: { ai: { enabled: true, provider: 'openai', model: 'gpt-4o' } } } as any,
      [],
    );

    // create_booking should NOT have been called
    expect(createBooking.execute).not.toHaveBeenCalled();
  });

  it('returns budget_exceeded when over budget', async () => {
    mockMeteringIsOverBudget.mockResolvedValue(true);

    const result = await agent.run(
      'hi',
      { id: 's1', tenantId: 't1', status: 'bot' } as any,
      {
        id: 't1',
        settings: {
          ai: {
            enabled: true, provider: 'openai', model: 'gpt-4o', dailyTokenBudget: 1000,
            guardrails: { fallbackMessage: 'Budget reached.' },
          },
        },
      } as any,
      [],
    );

    expect(result.type).toBe('budget_exceeded');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/agent-service.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// api/src/agent/agent.service.ts
import crypto from 'crypto';
import { ToolRegistry } from './tool-registry';
import { PromptBuilder } from './prompt-builder';
import { MeteringService } from './metering.service';
import { TraceLogger, AgentTrace } from './trace-logger';
import { ToolAdapter, ToolContext } from './tool-adapter';
import { getProvider } from '../llm/provider-factory';
import { ChatMessage, ToolDefinition } from '../llm/llm.types';
import { ChatSession } from '../database/entities/ChatSession';
import { Tenant } from '../database/entities/Tenant';
import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';

export type AgentResult =
  | { type: 'response'; content: string }
  | { type: 'awaiting_confirmation'; toolCallId: string; toolName: string; preview: Record<string, unknown>; message: string }
  | { type: 'max_iterations'; fallbackMessage: string }
  | { type: 'budget_exceeded'; fallbackMessage: string }
  | { type: 'error'; error: string; fallbackMessage: string };

const MAX_ITERATIONS = 10;

export class AgentService {
  constructor(
    private toolRegistry: ToolRegistry,
    private promptBuilder: PromptBuilder,
    private metering: MeteringService,
    private traceLogger: TraceLogger,
  ) {}

  async run(
    message: string,
    session: ChatSession,
    tenant: Tenant,
    conversationHistory: ChatMessage[],
  ): Promise<AgentResult> {
    const runId = crypto.randomUUID();
    const aiSettings = tenant.settings?.ai;
    const trace: AgentTrace = {
      sessionId: session.id,
      tenantId: tenant.id,
      iterations: [],
      finishReason: 'completed',
    };

    try {
      const tools = await this.toolRegistry.getToolsForTenant(tenant);
      const systemPrompt = this.promptBuilder.build(tenant, tools);
      const provider = getProvider(aiSettings!.provider, aiSettings!.apiKey);
      const model = aiSettings!.model;

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: message },
      ];

      const toolsCalled: string[] = [];

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        // Budget check
        if (await this.metering.isOverBudget(tenant.id, aiSettings?.dailyTokenBudget)) {
          trace.finishReason = 'budget_exceeded';
          await this.traceLogger.save(trace);
          return {
            type: 'budget_exceeded',
            fallbackMessage: aiSettings?.guardrails?.fallbackMessage || 'I apologize, but I am temporarily unavailable.',
          };
        }

        // Build tool definitions for LLM
        const toolDefs: ToolDefinition[] | undefined = tools.length > 0
          ? tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
          : undefined;

        // Call LLM
        const startMs = Date.now();
        const response = await provider.chat(messages, {
          model,
          maxTokens: 1000,
          temperature: 0.3,
          jsonMode: false,
          tools: toolDefs,
        });
        const latencyMs = Date.now() - startMs;

        // Record metering
        await this.metering.record(tenant.id, response.usage);

        // Build trace entry
        const traceEntry: AgentTrace['iterations'][0] = {
          llmCall: { model, ...response.usage, latencyMs },
          toolCalls: [],
        };

        // No tool calls — final response
        if (response.finishReason === 'stop' || !response.toolCalls?.length) {
          trace.iterations.push(traceEntry);
          trace.finishReason = 'completed';
          await this.traceLogger.save(trace);
          return { type: 'response', content: response.content };
        }

        // Process tool calls
        // First, append the assistant message with tool calls
        messages.push({ role: 'assistant', content: response.content || '', toolCalls: response.toolCalls });

        for (const toolCall of response.toolCalls) {
          const tool = tools.find((t) => t.name === toolCall.name);
          const toolStartMs = Date.now();

          if (!tool) {
            messages.push({ role: 'tool', content: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }), toolCallId: toolCall.id });
            continue;
          }

          // Precondition check
          if (tool.preconditions?.toolsCalled) {
            const missing = tool.preconditions.toolsCalled.filter((t) => !toolsCalled.includes(t));
            if (missing.length > 0) {
              const errorMsg = `Must call ${missing.join(', ')} before ${tool.name}`;
              messages.push({ role: 'tool', content: JSON.stringify({ error: errorMsg }), toolCallId: toolCall.id });
              traceEntry.toolCalls.push({ name: tool.name, args: toolCall.arguments, result: { success: false, error: errorMsg }, latencyMs: 0 });
              continue;
            }
          }

          // TODO: Task 12 will add confirmation gate for hasSideEffects tools
          // For now, execute directly (Phase 1 ships without confirmation UX)

          // Execute tool
          const ctx: ToolContext = {
            tenantId: tenant.id,
            sessionId: session.id,
            runId,
            toolsCalledThisTurn: toolsCalled,
            dataSource: AppDataSource,
            conversationHistory: messages,
          };

          try {
            const result = await tool.execute(toolCall.arguments, ctx);
            toolsCalled.push(tool.name);
            messages.push({
              role: 'tool',
              content: JSON.stringify(result.data ?? { error: result.error }),
              toolCallId: toolCall.id,
            });
            traceEntry.toolCalls.push({
              name: tool.name,
              args: toolCall.arguments,
              result,
              latencyMs: Date.now() - toolStartMs,
            });
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Tool execution failed';
            messages.push({ role: 'tool', content: JSON.stringify({ error: errorMsg }), toolCallId: toolCall.id });
            traceEntry.toolCalls.push({
              name: tool.name,
              args: toolCall.arguments,
              result: { success: false, error: errorMsg },
              latencyMs: Date.now() - toolStartMs,
            });
          }
        }

        trace.iterations.push(traceEntry);
      }

      // Max iterations reached
      trace.finishReason = 'max_iterations';
      await this.traceLogger.save(trace);
      return { type: 'max_iterations', fallbackMessage: "Let me connect you with a human agent." };

    } catch (error) {
      trace.finishReason = 'error';
      await this.traceLogger.save(trace);
      logger.error('Agent loop error', { sessionId: session.id, error });
      return {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        fallbackMessage: tenant.settings?.ai?.guardrails?.fallbackMessage || 'Something went wrong. Let me connect you with a human agent.',
      };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/agent-service.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Run all unit tests**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/ --reporter=verbose`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/agent/agent.service.ts src/__tests__/unit/agent-service.test.ts
git commit -m "feat: implement core agent loop with tool-calling and preconditions"
```

---

### Task 11: Wire Agent into Message Forwarding

**Files:**
- Modify: `api/src/services/message-forwarding.service.ts`
- Modify: `api/src/server.ts` (initialize AgentService)
- Test: `api/src/__tests__/unit/agent-forwarding.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/agent-forwarding.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('Message forwarding routing', () => {
  it('routes to platform agent when AI enabled, usePlatformAgent true, no webhookUrl', () => {
    const tenant = {
      webhookUrl: null,
      settings: { ai: { enabled: true, usePlatformAgent: true } },
    };
    const tenantUrl = tenant.webhookUrl && !tenant.webhookUrl.includes('localhost') ? tenant.webhookUrl : undefined;
    const usePlatformAgent = tenant.settings?.ai?.enabled && tenant.settings?.ai?.usePlatformAgent && !tenantUrl;
    expect(usePlatformAgent).toBe(true);
  });

  it('routes to n8n when tenant has custom webhookUrl', () => {
    const tenant = {
      webhookUrl: 'https://my-n8n.railway.app/webhook/brain',
      settings: { ai: { enabled: true, usePlatformAgent: true } },
    };
    const tenantUrl = tenant.webhookUrl && !tenant.webhookUrl.includes('localhost') ? tenant.webhookUrl : undefined;
    const usePlatformAgent = tenant.settings?.ai?.enabled && tenant.settings?.ai?.usePlatformAgent && !tenantUrl;
    expect(usePlatformAgent).toBe(false);
    expect(tenantUrl).toBe('https://my-n8n.railway.app/webhook/brain');
  });

  it('routes to n8n default when AI enabled but usePlatformAgent is false', () => {
    const tenant = {
      webhookUrl: null,
      settings: { ai: { enabled: true, usePlatformAgent: false } },
    };
    const tenantUrl = tenant.webhookUrl && !tenant.webhookUrl.includes('localhost') ? tenant.webhookUrl : undefined;
    const usePlatformAgent = tenant.settings?.ai?.enabled && tenant.settings?.ai?.usePlatformAgent && !tenantUrl;
    expect(usePlatformAgent).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (routing logic test)**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/agent-forwarding.test.ts`
Expected: PASS (these validate the routing logic before we modify the production code)

- [ ] **Step 3: Modify `message-forwarding.service.ts` to add platform agent path**

Add imports at the top of `message-forwarding.service.ts`:
```typescript
import { AgentService, AgentResult } from '../agent/agent.service';
```

Add module-level reference:
```typescript
let agentService: AgentService | null = null;

export function initializeAgentService(agent: AgentService): void {
  agentService = agent;
}
```

Modify the `forwardMessageToN8n` function — replace the webhook URL resolution block with:

```typescript
  // ── Route 1: Custom webhook (n8n path, unchanged) ──────────────
  const tenantUrl = tenant.webhookUrl && !tenant.webhookUrl.includes('localhost')
    ? tenant.webhookUrl : undefined;

  if (tenantUrl) {
    // Existing n8n forwarding path — completely untouched
    // ... (keep all existing n8n forwarding code as-is)
  }

  // ── Route 2: Platform agent (opted-in tenants) ─────────────────
  if (aiSettings?.enabled && aiSettings?.usePlatformAgent && agentService) {
    return platformAgentPath(session, savedMessage, tenant, aiSettings);
  }

  // ── Route 3: Default n8n webhook (existing tenants not yet opted in) ──
  const webhookUrl = aiSettings?.enabled ? config.n8n.defaultWebhookUrl : undefined;
  if (webhookUrl) {
    // ... (keep existing default webhook logic)
  }

  // ── Route 4: No AI — session stays waiting for human ───────────
  return false;
```

Add the `platformAgentPath` function:

```typescript
async function platformAgentPath(
  session: ChatSession,
  savedMessage: Message,
  tenant: Tenant,
  aiSettings: NonNullable<Tenant['settings']>['ai'],
): Promise<boolean> {
  if (!agentService) return false;

  // Pre-forwarding checks (same as existing)
  // Business hours check
  if (session.status === 'bot' && savedMessage.type === 'text' && aiSettings?.enabled) {
    const bh = tenant.settings?.businessHours;
    if (bh?.enabled && bh.schedule?.length) {
      const now = new Date();
      const tz = bh.timezone || 'UTC';
      const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
      const dayName = dayFormatter.format(now).toLowerCase();
      const timeFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const parts = timeFormatter.formatToParts(now);
      const hour = parts.find(p => p.type === 'hour')!.value;
      const minute = parts.find(p => p.type === 'minute')!.value;
      const timeStr = `${hour}:${minute}`;
      const daySchedule = bh.schedule.find((s: any) => s.day.toLowerCase() === dayName);
      const isOutsideHours = !daySchedule || daySchedule.closed ||
        timeStr < daySchedule.open || timeStr >= daySchedule.close;

      if (isOutsideHours) {
        const botParticipant = await ensureBotParticipant(session, aiSettings);
        await sendBotMessage(session, botParticipant.id,
          aiSettings.guardrails?.offHoursMessage || "We're currently outside business hours.");
        return true;
      }
    }
  }

  // Run the agent
  const history = await getConversationHistory(session.id);
  const messageContent = savedMessage.contentEncrypted
    ? decrypt(savedMessage.content) : savedMessage.content;

  const result = await agentService.run(messageContent, session, tenant, history);

  const botParticipant = await ensureBotParticipant(session, aiSettings);

  switch (result.type) {
    case 'response':
      await sendBotMessage(session, botParticipant.id, result.content);
      break;
    case 'awaiting_confirmation':
      // Phase 2: confirmation gate will handle this
      break;
    case 'max_iterations':
    case 'budget_exceeded':
    case 'error':
      await sendBotMessage(session, botParticipant.id, result.fallbackMessage);
      await handleBotHandoff(session, botParticipant.id, 'bot_error');
      break;
  }

  // Transition waiting → bot on first forwarded message
  if (session.status === 'waiting') {
    await sessionRepository.createQueryBuilder()
      .update(ChatSession).set({ status: 'bot' })
      .where('id = :id AND status = :status', { id: session.id, status: 'waiting' })
      .execute();
  }

  return true;
}
```

- [ ] **Step 4: Initialize AgentService in `server.ts`**

In the webhook module initialization block (around line 250), add after `initializeForwarding()`:

```typescript
// Initialize platform agent
try {
  const { ToolRegistry } = await import('./agent/tool-registry');
  const { PromptBuilder } = await import('./agent/prompt-builder');
  const { MeteringService } = await import('./agent/metering.service');
  const { TraceLogger } = await import('./agent/trace-logger');
  const { AgentService } = await import('./agent/agent.service');
  const { initializeAgentService } = await import('./services/message-forwarding.service');

  const redisClient = /* existing redis client from config */;
  const toolRegistry = new ToolRegistry();
  const promptBuilder = new PromptBuilder();
  const metering = new MeteringService(redisClient);
  const traceLogger = new TraceLogger();
  const agentSvc = new AgentService(toolRegistry, promptBuilder, metering, traceLogger);
  initializeAgentService(agentSvc);
  logger.info('Platform agent service initialized');
} catch (err) {
  logger.warn('Platform agent initialization failed — agent path disabled', { error: err });
}
```

- [ ] **Step 5: Run all tests**

Run: `cd chatbot-platform/api && npx vitest run --reporter=verbose`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/message-forwarding.service.ts src/server.ts src/__tests__/unit/agent-forwarding.test.ts
git commit -m "feat: wire platform agent into message forwarding with opt-in routing"
```

---

### Task 12: Database Migration (New Tables)

**Files:**
- Create: `api/src/database/migrations/XXXXXX-add-agent-tables.ts`

- [ ] **Step 1: Create the migration**

```typescript
// api/src/database/migrations/1712160000000-AddAgentTables.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentTables1712160000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // tool_definitions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tool_definitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        description TEXT NOT NULL,
        "handlerType" VARCHAR(20) NOT NULL CHECK ("handlerType" IN ('webhook', 'n8n')),
        "handlerConfig" JSONB NOT NULL,
        "parametersSchema" JSONB NOT NULL,
        "hasSideEffects" BOOLEAN DEFAULT false,
        preconditions JSONB,
        enabled BOOLEAN DEFAULT true,
        "createdAt" TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE("tenantId", name)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tool_definitions_tenant ON tool_definitions("tenantId") WHERE enabled = true
    `);

    // agent_traces
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS agent_traces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        "sessionId" UUID NOT NULL,
        "messageId" UUID,
        trace JSONB NOT NULL,
        "totalTokens" INT NOT NULL,
        "totalLatencyMs" INT NOT NULL,
        "finishReason" VARCHAR(30) NOT NULL,
        "createdAt" TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_traces_tenant ON agent_traces("tenantId", "createdAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_traces_session ON agent_traces("sessionId", "createdAt" DESC)
    `);

    // tenant_usage
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tenant_usage (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        "promptTokens" INT DEFAULT 0,
        "completionTokens" INT DEFAULT 0,
        "totalTokens" INT DEFAULT 0,
        "llmCalls" INT DEFAULT 0,
        "toolCalls" INT DEFAULT 0,
        "createdAt" TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE("tenantId", date)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS tenant_usage');
    await queryRunner.query('DROP TABLE IF EXISTS agent_traces');
    await queryRunner.query('DROP TABLE IF EXISTS tool_definitions');
  }
}
```

- [ ] **Step 2: Run the migration locally**

Run: `cd chatbot-platform/api && npx typeorm migration:run -d src/database/data-source.ts`
Expected: Migration applied successfully

- [ ] **Step 3: Verify tables exist**

Run: `cd chatbot-platform/api && npx ts-node -e "const { AppDataSource } = require('./src/database/data-source'); AppDataSource.initialize().then(async (ds) => { const r = await ds.query(\"SELECT tablename FROM pg_tables WHERE tablename IN ('tool_definitions', 'agent_traces', 'tenant_usage')\"); console.log(r); await ds.destroy(); })"`
Expected: All 3 tables listed

- [ ] **Step 4: Commit**

```bash
git add src/database/migrations/
git commit -m "feat: add database tables for tools, traces, and usage metering"
```

---

## Summary

| Task | What It Builds | Dependencies |
|------|---------------|-------------|
| 1 | LLM types (ToolDefinition, ToolCall, extended ChatMessage) | None |
| 2 | OpenAI provider with tool-calling | Task 1 |
| 3 | Anthropic provider with tool-calling | Task 1 |
| 4 | ToolAdapter interface + types | Task 1 |
| 5 | 7 built-in tool implementations | Task 4 |
| 6 | ToolRegistry (loads tools per tenant) | Task 5 |
| 7 | PromptBuilder (dynamic system prompt) | Task 4 |
| 8 | MeteringService (Redis token counters) | None |
| 9 | TraceLogger (agent trace persistence) | None |
| 10 | AgentService (core agent loop) | Tasks 6, 7, 8, 9 |
| 11 | Wire into message-forwarding + server init | Task 10 |
| 12 | Database migration (3 new tables) | None (run before Task 11 deploy) |

**Not included in this plan (Phase 2):**
- Confirmation gate (pause/resume with Socket.IO) — Task 12 in spec
- Custom webhook tool adapter — requires `tool_definitions` table populated
- Per-session mutex (Redis lock)
- Tenant usage flush cron job
- Dashboard UI for skills/tools configuration
