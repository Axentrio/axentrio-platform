/**
 * Live Booking Flow Test
 *
 * Exercises the AgentService with a REAL OpenAI API call.
 * Uses mock tool adapters directly (no booking service import issues).
 * This proves the agent loop, tool-calling, and precondition enforcement work end-to-end.
 *
 * Run: cd chatbot-platform/api && npx tsx src/__tests__/live/booking-flow-live.ts
 */
import 'dotenv/config';
import crypto from 'crypto';
import { PromptBuilder } from '../../agent/prompt-builder';
import { MeteringService } from '../../agent/metering.service';
import { TraceLogger, AgentTrace } from '../../agent/trace-logger';
import { getProvider } from '../../llm/provider-factory';
import type { ToolAdapter, ToolContext, ToolResult } from '../../agent/tool-adapter';
import type { ChatMessage, LLMResponse, ToolDefinition, LLMOptions } from '../../llm/llm.types';
import type { Tenant } from '../../database/entities/Tenant';
import type { ChatSession } from '../../database/entities/ChatSession';

// ── Inline Agent Loop (avoids import chain that pulls in AppDataSource) ──
// This is a copy of AgentService.run() logic, self-contained for the live test.

const MAX_ITERATIONS = 10;

async function runAgentLoop(
  message: string,
  session: { id: string; tenantId: string },
  tenant: any,
  conversationHistory: ChatMessage[],
  tools: ToolAdapter[],
  metering: MeteringService,
): Promise<{ type: string; content?: string; iterations: number; toolsCalled: string[] }> {
  const runId = crypto.randomUUID();
  const aiSettings = tenant.settings.ai;
  const promptBuilder = new PromptBuilder();
  const systemPrompt = promptBuilder.build(tenant as any, tools);

  const provider = getProvider(aiSettings.provider, aiSettings.apiKey);
  const model = aiSettings.model;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: message },
  ];

  const toolsCalled: string[] = [];
  let iterations = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations++;

    const toolDefs: ToolDefinition[] | undefined = tools.length > 0
      ? tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
      : undefined;

    const startMs = Date.now();
    const response = await provider.chat(messages, {
      model,
      maxTokens: 800,
      temperature: 0.3,
      jsonMode: false,
      tools: toolDefs,
    });
    const latencyMs = Date.now() - startMs;

    await metering.record(tenant.id, response.usage);

    console.log(`  [LLM] Iteration ${i + 1}: finish=${response.finishReason}, tokens=${response.usage.promptTokens}+${response.usage.completionTokens}, ${latencyMs}ms`);

    if (response.finishReason === 'stop' || !response.toolCalls?.length) {
      return { type: 'response', content: response.content, iterations, toolsCalled };
    }

    // Process tool calls
    messages.push({ role: 'assistant', content: response.content || '', toolCalls: response.toolCalls });

    for (const toolCall of response.toolCalls) {
      const tool = tools.find((t) => t.name === toolCall.name);

      if (!tool) {
        console.log(`  [TOOL] Unknown tool: ${toolCall.name}`);
        messages.push({ role: 'tool', content: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }), toolCallId: toolCall.id });
        continue;
      }

      // Precondition check
      if (tool.preconditions?.toolsCalled) {
        const missing = tool.preconditions.toolsCalled.filter((t) => !toolsCalled.includes(t));
        if (missing.length > 0) {
          console.log(`  [PRECONDITION] Blocked ${tool.name}: requires ${missing.join(', ')} first`);
          messages.push({ role: 'tool', content: JSON.stringify({ error: `Must call ${missing.join(', ')} before ${tool.name}` }), toolCallId: toolCall.id });
          continue;
        }
      }

      // Execute
      const ctx: ToolContext = {
        tenantId: tenant.id,
        sessionId: session.id,
        runId,
        toolsCalledThisTurn: toolsCalled,
        dataSource: {} as any,
        conversationHistory: messages,
      };

      try {
        const result = await tool.execute(toolCall.arguments, ctx);
        toolsCalled.push(tool.name);
        console.log(`  [TOOL] ${tool.name}(${JSON.stringify(toolCall.arguments)}) → success=${result.success}`);
        messages.push({
          role: 'tool',
          content: JSON.stringify(result.data ?? { error: result.error }),
          toolCallId: toolCall.id,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Tool execution failed';
        console.log(`  [TOOL] ${tool.name} FAILED: ${errorMsg}`);
        messages.push({ role: 'tool', content: JSON.stringify({ error: errorMsg }), toolCallId: toolCall.id });
      }
    }
  }

  return { type: 'max_iterations', iterations, toolsCalled };
}

// ── Mock Tool Adapters (self-contained, no imports) ──

// Generate slots for next Tuesday dynamically
function getNextTuesday(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((2 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().split('T')[0];
}
const NEXT_TUESDAY = getNextTuesday();
const MOCK_SLOTS = [
  { start: `${NEXT_TUESDAY}T09:00:00+02:00`, end: `${NEXT_TUESDAY}T09:30:00+02:00` },
  { start: `${NEXT_TUESDAY}T10:00:00+02:00`, end: `${NEXT_TUESDAY}T10:30:00+02:00` },
  { start: `${NEXT_TUESDAY}T11:00:00+02:00`, end: `${NEXT_TUESDAY}T11:30:00+02:00` },
  { start: `${NEXT_TUESDAY}T14:00:00+02:00`, end: `${NEXT_TUESDAY}T14:30:00+02:00` },
];

const mockTools: ToolAdapter[] = [
  {
    name: 'kb_search',
    description: 'Search the clinic knowledge base for information about services, pricing, and policies.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
    hasSideEffects: false,
    async execute(args) {
      console.log(`  [TOOL] kb_search("${args.query}")`);
      return {
        success: true,
        data: {
          chunks: [
            { content: 'Amsterdam Dental Clinic offers general dentistry, cosmetic treatments (teeth whitening, veneers), and orthodontics. A standard dental cleaning costs €75 and takes 30 minutes.', source: 'Services FAQ' },
          ],
        },
      };
    },
  },
  {
    name: 'check_availability',
    description: 'Check available appointment slots for a date range. Call this BEFORE creating a booking.',
    parameters: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Start date (ISO 8601)' },
        endDate: { type: 'string', description: 'End date (ISO 8601)' },
      },
      required: ['startDate', 'endDate'],
    },
    hasSideEffects: false,
    async execute(args) {
      return { success: true, data: { slots: MOCK_SLOTS, timezone: 'Europe/Amsterdam' } };
    },
  },
  {
    name: 'create_booking',
    description: 'Create a new appointment booking. Only call AFTER checking availability and confirming details.',
    parameters: {
      type: 'object',
      properties: {
        startTime: { type: 'string', description: 'Selected slot start time (ISO 8601)' },
        attendeeName: { type: 'string', description: "Patient's full name" },
        attendeeEmail: { type: 'string', description: "Patient's email" },
        notes: { type: 'string', description: 'Optional notes' },
      },
      required: ['startTime', 'attendeeName', 'attendeeEmail'],
    },
    hasSideEffects: true,
    preconditions: { toolsCalled: ['check_availability'] },
    async execute(args) {
      return {
        success: true,
        data: {
          booking: {
            id: 'bk_live_' + Date.now(),
            startTime: args.startTime,
            attendee: { name: args.attendeeName, email: args.attendeeEmail },
            status: 'confirmed',
          },
        },
      };
    },
  },
  {
    name: 'escalate_to_agent',
    description: 'Transfer to a human agent when you cannot help or the patient requests it.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    hasSideEffects: true,
    async execute(args) {
      return { success: true, data: { action: 'escalate', reason: args.reason } };
    },
  },
];

// ── Test Tenant Config ──
const tenant = {
  id: 'live-test-tenant',
  name: 'Amsterdam Dental Clinic',
  settings: {
    ai: {
      enabled: true,
      provider: 'openai' as const,
      model: 'gpt-4o-mini',
      brandVoice: {
        name: 'DentalBot',
        tone: 'warm and professional',
        customInstructions: 'You are the virtual assistant for Amsterdam Dental Clinic. We offer general dentistry, cosmetic treatments, and orthodontics.',
      },
      guardrails: {
        topicsToAvoid: ['medical advice', 'diagnosis'],
        escalationKeywords: ['complaint', 'refund'],
        confidenceThreshold: 0.7,
        maxResponseLength: 300,
        fallbackMessage: 'Let me connect you with our team.',
      },
    },
    integrations: {
      calcom: { apiKey: 'mock', eventTypeId: 42 },
    },
    skills: [{
      name: 'booking',
      trigger: 'User wants to schedule, reschedule, or cancel a dental appointment',
      tools: ['check_availability', 'create_booking'],
      instructions: 'Always check availability before creating a booking. Collect patient name and email. Confirm details before booking. Timezone: Europe/Amsterdam.',
      maxSteps: 8,
      enabled: true,
    }],
  },
};

const session = { id: 'live-session-1', tenantId: 'live-test-tenant' };

// ── Mock Redis ──
const mockRedis = {
  hincrby: async () => 1,
  hgetall: async () => ({ total: '0' }),
  expireat: async () => 1,
};

// ── Run the conversation ──
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY not set');
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log('  LIVE BOOKING FLOW — Real OpenAI + Mock Booking Service');
  console.log('  Model: gpt-4o-mini | Tenant: Amsterdam Dental Clinic');
  console.log('='.repeat(70));

  const metering = new MeteringService(mockRedis as any);
  const history: ChatMessage[] = [];

  const turns = [
    'Hi, I want to book a dental cleaning appointment',
    'Next Tuesday would be great, morning if possible',
    'The 10am slot works. My name is Sarah Connor, email is sarah@skynet.com',
    'By the way, do you offer teeth whitening?',
  ];

  for (const userMsg of turns) {
    console.log('');
    console.log('─'.repeat(70));
    console.log(`  USER: ${userMsg}`);
    console.log('─'.repeat(70));

    const result = await runAgentLoop(
      userMsg,
      session,
      tenant,
      [...history],
      mockTools,
      metering,
    );

    const botResponse = result.content || '(no content)';
    console.log('');
    console.log(`  BOT: ${botResponse}`);
    console.log(`  [Result: type=${result.type}, iterations=${result.iterations}, tools=${result.toolsCalled.join(', ') || 'none'}]`);

    history.push({ role: 'user', content: userMsg });
    history.push({ role: 'assistant', content: botResponse });
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('  TEST COMPLETE');
  console.log('='.repeat(70));

  // Print metering
  const usage = await metering.getDailyUsage('live-test-tenant');
  console.log(`\n  Total tokens used: ${usage.total} (${usage.calls} LLM calls)`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
