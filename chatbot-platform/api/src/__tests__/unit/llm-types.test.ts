// api/src/__tests__/unit/llm-types.test.ts
import { describe, it, expect } from 'vitest';
import type { ChatMessage, ToolDefinition, LLMOptions, LLMResponse } from '../../llm/llm.types';

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
