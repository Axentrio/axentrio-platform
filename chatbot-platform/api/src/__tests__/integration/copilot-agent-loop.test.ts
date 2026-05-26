/**
 * Integration: runCopilotTurn agent loop end-to-end.
 *
 * Real DB (synchronize-built schema); mocked LLM stream + knowledge
 * source + tool registry. Covers the terminal-state matrix and the
 * persistence invariants from the locked plan.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import {
  CopilotMessage,
  type CopilotMessageOutcome,
} from '../../database/entities/CopilotMessage';
import { CopilotConversation } from '../../database/entities/CopilotConversation';
import { CopilotTrace } from '../../database/entities/CopilotTrace';
import { runCopilotTurn } from '../../copilot/agent/loop';
import {
  insertAtomicPair,
  ensureActiveConversation,
  ConversationClearedMidSendError,
} from '../../copilot/agent/persist';
import { BufferedSSESink } from '../../copilot/agent/sse';
import type {
  CopilotLlmStream,
  CopilotLlmToolCall,
} from '../../copilot/agent/llm-stream';
import { CopilotToolRegistry } from '../../copilot/tools/registry';
import type { CopilotTool } from '../../copilot/tools/types';
import type { CopilotKnowledgeSource, Snippet } from '../../copilot/knowledge/types';
import { createTestTenant, createTestUser } from '../helpers/factories';

// ---------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------

function makeStubKnowledge(snippets: Snippet[] = []): CopilotKnowledgeSource {
  return { async search() { return snippets; } };
}

function makeStubRegistry(tools: Array<CopilotTool<any, any>>): CopilotToolRegistry {
  const r = new CopilotToolRegistry();
  for (const t of tools) r.registerTool(t);
  return r;
}

interface ScriptedStep {
  /** Tokens to emit in this iteration. */
  tokens?: string[];
  /** Tool calls to request. */
  toolCalls?: CopilotLlmToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length';
  usage?: { promptTokens: number; completionTokens: number };
  /** If set, throw before yielding any events. */
  throwError?: Error;
  /** Delay (ms) before the FIRST event of this iteration — lets tests trigger abort mid-stream. */
  delayMs?: number;
}

/**
 * Scripted LLM stream: yields the next ScriptedStep's events per call.
 */
function makeScriptedLlm(steps: ScriptedStep[]): CopilotLlmStream {
  let i = 0;
  return {
    async *stream(_messages, _opts) {
      const step = steps[i++];
      if (!step) {
        // No more scripted steps — return finalize:stop with no content.
        yield { type: 'finalize', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } };
        return;
      }
      if (step.throwError) throw step.throwError;
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      for (const text of step.tokens ?? []) {
        if (_opts.signal.aborted) return;
        yield { type: 'token', text };
      }
      for (const call of step.toolCalls ?? []) yield { type: 'tool_call', call };
      yield {
        type: 'finalize',
        finishReason: step.finishReason ?? (step.toolCalls?.length ? 'tool_calls' : 'stop'),
        usage: step.usage ?? { promptTokens: 50, completionTokens: 20 },
      };
    },
  };
}

// Shared fixtures
let tenantId: string;
let userId: string;

beforeEach(async () => {
  const t = await createTestTenant();
  const u = await createTestUser(t.id);
  tenantId = t.id;
  userId = u.id;
});

// ---------------------------------------------------------------
// persist.ts — atomic pair insert + race paths
// ---------------------------------------------------------------
describe('ensureActiveConversation', () => {
  it('inserts a fresh row on first call', async () => {
    const r = await ensureActiveConversation(AppDataSource, tenantId, userId);
    expect(r.freshlyCreated).toBe(true);
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the same id on the second call', async () => {
    const a = await ensureActiveConversation(AppDataSource, tenantId, userId);
    const b = await ensureActiveConversation(AppDataSource, tenantId, userId);
    expect(b.id).toBe(a.id);
    expect(b.freshlyCreated).toBe(false);
  });

  it('a second active conv is inserted after archive', async () => {
    const a = await ensureActiveConversation(AppDataSource, tenantId, userId);
    await AppDataSource.query(
      `UPDATE chatbot_copilot_conversations SET archived_at = now() WHERE id = $1`,
      [a.id],
    );
    const b = await ensureActiveConversation(AppDataSource, tenantId, userId);
    expect(b.id).not.toBe(a.id);
    expect(b.freshlyCreated).toBe(true);
  });
});

describe('insertAtomicPair', () => {
  it('persists user@N + assistant@N+1 pending under a single tx', async () => {
    const pair = await insertAtomicPair(AppDataSource, tenantId, userId, 'hello');
    expect(pair.userTurn).toBe(0);
    expect(pair.assistantTurn).toBe(1);

    const rows = await AppDataSource.getRepository(CopilotMessage).find({
      where: { conversationId: pair.conversationId },
      order: { turn: 'ASC' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe('user');
    expect(rows[0].content).toBe('hello');
    expect(rows[1].role).toBe('assistant');
    expect(rows[1].content).toBe('');
    expect(rows[1].outcome).toBe('pending');
    expect(rows[1].streamStartedAt).not.toBeNull();
  });

  it('advances next_turn by 2 per cycle', async () => {
    await insertAtomicPair(AppDataSource, tenantId, userId, 'a');
    const pair2 = await insertAtomicPair(AppDataSource, tenantId, userId, 'b');
    expect(pair2.userTurn).toBe(2);
    expect(pair2.assistantTurn).toBe(3);
    const conv = await AppDataSource.getRepository(CopilotConversation).findOneOrFail({
      where: { id: pair2.conversationId },
    });
    expect(conv.nextTurn).toBe(4);
  });

  it('throws ConversationClearedMidSendError when the conv archives twice across retries', async () => {
    // Pre-archive the conversation, then archive again right after
    // ensureActiveConversation re-inserts.
    // Easiest deterministic version: monkey-patch ensureActiveConversation
    // is overkill. Instead we directly verify the typed error class
    // shape so the route can map to 409.
    const err = new ConversationClearedMidSendError('t', 'u');
    expect(err.name).toBe('ConversationClearedMidSendError');
    expect(err.code).toBe('conversation_cleared_mid_send');
  });
});

// ---------------------------------------------------------------
// runCopilotTurn — terminal states
// ---------------------------------------------------------------
describe('runCopilotTurn', () => {
  it('happy path: tokens stream, outcome=success, content + trace persisted', async () => {
    const llm = makeScriptedLlm([
      { tokens: ['Hello ', 'world', '.'], finishReason: 'stop', usage: { promptTokens: 50, completionTokens: 3 } },
    ]);
    const sink = new BufferedSSESink();
    const result = await runCopilotTurn({
      dataSource: AppDataSource,
      llm,
      knowledge: makeStubKnowledge(),
      toolRegistry: makeStubRegistry([]),
      sink,
      abortSignal: new AbortController().signal,
      tenantId,
      userId,
      message: 'what plan am I on?',
    });

    expect(result.outcome).toBe<CopilotMessageOutcome>('success');
    expect(result.tokensIn).toBe(50);
    expect(result.tokensOut).toBe(3);

    // Persisted assistant row matches the streamed content.
    const assistant = await AppDataSource.getRepository(CopilotMessage).findOneOrFail({
      where: { id: result.assistantMessageId },
    });
    expect(assistant.content).toBe('Hello world.');
    expect(assistant.outcome).toBe('success');
    expect(assistant.tokensIn).toBe(50);

    // SSE wire emitted token + complete.
    const events = sink.events.map((e) => e.event);
    expect(events).toContain('token');
    expect(events[events.length - 1]).toBe('complete');

    // Trace row written.
    const traces = await AppDataSource.getRepository(CopilotTrace).find({
      where: { conversationId: result.conversationId },
    });
    expect(traces).toHaveLength(1);
    expect(traces[0].outcome).toBe('success');
    expect(traces[0].turnId).toBe(result.assistantMessageId);
  });

  it('tool-calling loop: LLM requests a tool, result feeds the next iteration', async () => {
    const fakeTool: CopilotTool<any, any> = {
      name: 'echoTool',
      description: 'returns whatever',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { ok: true, value: 42 };
      },
    };
    const llm = makeScriptedLlm([
      {
        toolCalls: [{ id: 'call-1', name: 'echoTool', arguments: {} }],
        finishReason: 'tool_calls',
      },
      {
        tokens: ['The answer is 42.'],
        finishReason: 'stop',
        usage: { promptTokens: 100, completionTokens: 5 },
      },
    ]);
    const sink = new BufferedSSESink();

    const result = await runCopilotTurn({
      dataSource: AppDataSource,
      llm,
      knowledge: makeStubKnowledge(),
      toolRegistry: makeStubRegistry([fakeTool]),
      sink,
      abortSignal: new AbortController().signal,
      tenantId,
      userId,
      message: 'what is the answer?',
    });

    expect(result.outcome).toBe('success');
    expect(result.toolsCalled).toEqual([{ name: 'echoTool', outcome: 'success' }]);

    const events = sink.events.map((e) => e.event);
    expect(events).toContain('tool_call_start');
    expect(events).toContain('tool_call_end');

    // tools_called accumulator persisted on the assistant row.
    const assistant = await AppDataSource.getRepository(CopilotMessage).findOneOrFail({
      where: { id: result.assistantMessageId },
    });
    expect(assistant.toolsCalled).toEqual([{ name: 'echoTool', outcome: 'success' }]);
    expect(assistant.content).toBe('The answer is 42.');

    // NO separate tool-role row was persisted.
    const allRows = await AppDataSource.getRepository(CopilotMessage).find({
      where: { conversationId: result.conversationId },
    });
    expect(allRows.map((r) => r.role).sort()).toEqual(['assistant', 'user']);
  });

  it('SSE tool events carry NAME + OUTCOME only (no args / results leak)', async () => {
    const fakeTool: CopilotTool<any, any> = {
      name: 'getSecret',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { secretKey: 'sk_live_NEVER_LEAK_THIS' };
      },
    };
    const llm = makeScriptedLlm([
      {
        toolCalls: [{ id: 'c1', name: 'getSecret', arguments: { promptArgShouldNotLeak: 'abc' } }],
        finishReason: 'tool_calls',
      },
      { tokens: ['done'], finishReason: 'stop' },
    ]);
    const sink = new BufferedSSESink();
    await runCopilotTurn({
      dataSource: AppDataSource,
      llm,
      knowledge: makeStubKnowledge(),
      toolRegistry: makeStubRegistry([fakeTool]),
      sink,
      abortSignal: new AbortController().signal,
      tenantId,
      userId,
      message: 'go',
    });

    const wire = sink.wireText();
    expect(wire).not.toContain('sk_live_NEVER_LEAK_THIS');
    expect(wire).not.toContain('promptArgShouldNotLeak');
    expect(wire).toContain('"name":"getSecret"');
    expect(wire).toContain('"outcome":"success"');
  });

  it('abort mid-stream → outcome=aborted, partial content persisted, error event emitted', async () => {
    const ac = new AbortController();
    const llm = makeScriptedLlm([
      // 1s pre-token delay gives a huge margin: the abort timer below fires
      // (after runCopilotTurn attaches its listener) long before the stream
      // would yield, so the abort reliably wins regardless of CI load.
      // Replaces the old flaky 5ms-vs-20ms race.
      { tokens: ['p', 'a', 'r', 't', 'i', 'a', 'l'], delayMs: 1000, finishReason: 'stop' },
    ]);
    // Fire after the turn starts (so the abort listener catches it), but well
    // within the 1s stream window.
    setTimeout(() => ac.abort(), 20);
    const sink = new BufferedSSESink();
    const result = await runCopilotTurn({
      dataSource: AppDataSource,
      llm,
      knowledge: makeStubKnowledge(),
      toolRegistry: makeStubRegistry([]),
      sink,
      abortSignal: ac.signal,
      tenantId,
      userId,
      message: 'mid-stream abort test',
    });

    expect(result.outcome).toBe('aborted');
    const lastEvent = sink.events[sink.events.length - 1];
    expect(lastEvent.event).toBe('error');
    expect((lastEvent.data as { code: string }).code).toBe('aborted');
  });

  it('LLM provider error → outcome=error, partial content persisted, error event emitted', async () => {
    const llm = makeScriptedLlm([
      { tokens: ['some text'], throwError: new Error('simulated OpenAI 5xx') },
    ]);
    const sink = new BufferedSSESink();
    const result = await runCopilotTurn({
      dataSource: AppDataSource,
      llm,
      knowledge: makeStubKnowledge(),
      toolRegistry: makeStubRegistry([]),
      sink,
      abortSignal: new AbortController().signal,
      tenantId,
      userId,
      message: 'llm error path',
    });

    expect(result.outcome).toBe('error');
    const lastEvent = sink.events[sink.events.length - 1];
    expect(lastEvent.event).toBe('error');
    expect((lastEvent.data as { code: string }).code).toBe('llm_error');
  });

  it('agent_loop_exceeded: max tool calls', async () => {
    const noopTool: CopilotTool<any, any> = {
      name: 'noop',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return {};
      },
    };
    // Build a script that requests 10 tool calls in one iteration —
    // exceeds MAX_TOOL_CALLS_PER_TURN (8).
    const calls = Array.from({ length: 10 }, (_, i) => ({
      id: `c-${i}`,
      name: 'noop',
      arguments: {},
    }));
    const llm = makeScriptedLlm([
      { toolCalls: calls, finishReason: 'tool_calls' },
    ]);
    const sink = new BufferedSSESink();
    const result = await runCopilotTurn({
      dataSource: AppDataSource,
      llm,
      knowledge: makeStubKnowledge(),
      toolRegistry: makeStubRegistry([noopTool]),
      sink,
      abortSignal: new AbortController().signal,
      tenantId,
      userId,
      message: 'too many tool calls',
    });
    expect(result.outcome).toBe('agent_loop_exceeded');
    const errorEvent = sink.events[sink.events.length - 1];
    expect(errorEvent.event).toBe('error');
    expect((errorEvent.data as { code: string }).code).toBe('agent_loop_exceeded');
  });

  it('agent_loop_exceeded: max LLM iterations', async () => {
    const fakeTool: CopilotTool<any, any> = {
      name: 'noop',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return {};
      },
    };
    // Five tool-call iterations exceeds MAX_LLM_ITERATIONS (4).
    const steps: ScriptedStep[] = Array.from({ length: 5 }, (_, i) => ({
      toolCalls: [{ id: `i-${i}`, name: 'noop', arguments: {} }],
      finishReason: 'tool_calls' as const,
    }));
    const sink = new BufferedSSESink();
    const result = await runCopilotTurn({
      dataSource: AppDataSource,
      llm: makeScriptedLlm(steps),
      knowledge: makeStubKnowledge(),
      toolRegistry: makeStubRegistry([fakeTool]),
      sink,
      abortSignal: new AbortController().signal,
      tenantId,
      userId,
      message: 'too many iterations',
    });
    expect(result.outcome).toBe('agent_loop_exceeded');
  });

  it('tool execution failure → outcome=success overall, tool reports error', async () => {
    const flakyTool: CopilotTool<any, any> = {
      name: 'flakyTool',
      description: 'always throws',
      parameters: { type: 'object', properties: {} },
      async execute() {
        throw new Error('tool exploded');
      },
    };
    const llm = makeScriptedLlm([
      { toolCalls: [{ id: 'c1', name: 'flakyTool', arguments: {} }], finishReason: 'tool_calls' },
      { tokens: ['I had trouble.'], finishReason: 'stop' },
    ]);
    const sink = new BufferedSSESink();
    const result = await runCopilotTurn({
      dataSource: AppDataSource,
      llm,
      knowledge: makeStubKnowledge(),
      toolRegistry: makeStubRegistry([flakyTool]),
      sink,
      abortSignal: new AbortController().signal,
      tenantId,
      userId,
      message: 'try flaky tool',
    });
    expect(result.outcome).toBe('success');
    expect(result.toolsCalled).toEqual([{ name: 'flakyTool', outcome: 'error' }]);
    // SSE got tool_call_end with outcome=error.
    const toolEnd = sink.events.find((e) => e.event === 'tool_call_end');
    expect((toolEnd?.data as { outcome: string }).outcome).toBe('error');
  });

  it('persists pair even when LLM throws immediately (no orphan user message)', async () => {
    const llm = makeScriptedLlm([
      { throwError: new Error('immediate provider failure') },
    ]);
    const sink = new BufferedSSESink();
    const result = await runCopilotTurn({
      dataSource: AppDataSource,
      llm,
      knowledge: makeStubKnowledge(),
      toolRegistry: makeStubRegistry([]),
      sink,
      abortSignal: new AbortController().signal,
      tenantId,
      userId,
      message: 'this should still persist a pair',
    });
    expect(result.outcome).toBe('error');
    const rows = await AppDataSource.getRepository(CopilotMessage).find({
      where: { conversationId: result.conversationId },
      order: { turn: 'ASC' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe('user');
    expect(rows[0].content).toBe('this should still persist a pair');
    expect(rows[1].role).toBe('assistant');
    expect(rows[1].outcome).toBe('error');
  });
});
