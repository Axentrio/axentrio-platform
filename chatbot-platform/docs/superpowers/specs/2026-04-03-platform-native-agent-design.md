# Platform-Native Agent Architecture — Design Spec

**Date:** 2026-04-03
**Status:** Draft
**Scope:** Phase 1 — LLM tool-calling, agent loop, built-in tools, skills, metering, observability

---

## 1. Overview

Move the AI agentic loop from n8n into the platform. The platform becomes the brain — managing tool-calling, conversation flow, and multi-step reasoning. n8n shifts to an optional tool provider for custom integrations.

**Goals:**
- Per-tenant AI model, API key, tools, and skills configuration
- Built-in tools (KB search, booking, escalation) called as direct functions
- Custom tools (webhook, n8n) called as HTTP endpoints
- Constrained autonomy: LLM chooses tools, platform enforces preconditions and confirmation gates
- Token metering and structured observability from day one
- Backward compatibility: tenants with custom `webhookUrl` still use the n8n path

**Non-goals (Phase 1):**
- Visual flow builder
- Cross-tenant tool sharing / marketplace
- Voice channel support
- New built-in integrations beyond booking + KB

---

## 2. LLM Provider Extensions

### 2.1 Type Changes (`llm.types.ts`)

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
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

// Extended ChatMessage to support tool results in conversation
export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

```

### 2.2 OpenAI Provider Changes (`openai.provider.ts`)

- Pass `tools` array to `chat.completions.create()` mapped to OpenAI function format
- Parse `response.choices[0].message.tool_calls` into `ToolCall[]`
- Set `finishReason` from `response.choices[0].finish_reason` (`'stop'` or `'tool_calls'`)
- When tool results are fed back, include `{ role: 'tool', tool_call_id, content }` messages

### 2.3 Anthropic Provider Changes (`anthropic.provider.ts`)

- Pass `tools` array to `messages.create()` in Anthropic tool format
- Parse `tool_use` content blocks into `ToolCall[]`
- Set `finishReason` from `response.stop_reason` (`'end_turn'` → `'stop'`, `'tool_use'` → `'tool_calls'`)
- When tool results are fed back, include `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }`

### 2.4 Backward Compatibility

- `tools` is optional — existing callers (RAG service) pass no tools, get no tool_calls
- `finishReason` defaults to `'stop'` when no tools provided
- `jsonMode` and `tools` are mutually exclusive (JSON mode forces text output)

---

## 3. Tool Adapter Layer

### 3.1 Tool Adapter Interface

New file: `api/src/agent/tool-adapter.ts`

```typescript
export interface ToolAdapter {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema
  hasSideEffects: boolean;
  preconditions?: { toolsCalled?: string[] };
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  tenantId: string;
  sessionId: string;
  toolsCalledThisTurn: string[];
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
```

### 3.2 Built-in Tools

All in `api/src/agent/tools/`:

| Tool | Source Function | Side Effects | Preconditions |
|------|---------------|-------------|---------------|
| `kb_search` | `searchKnowledge()` from `rag.service.ts` | No | None |
| `check_availability` | `checkAvailability()` from `booking.service.ts` | No | None |
| `create_booking` | `createBooking()` from `booking.service.ts` | Yes | `check_availability` called |
| `list_bookings` | `listBookings()` from `booking.service.ts` | No | None |
| `reschedule_booking` | `rescheduleBooking()` from `booking.service.ts` | Yes | None |
| `cancel_booking` | `cancelBooking()` from `booking.service.ts` | Yes | None |
| `escalate_to_agent` | `handleBotHandoff()` from `message-forwarding.service.ts` | Yes | None |

Each tool is a class implementing `ToolAdapter`. The `execute()` method:
1. Validates arguments against the JSON Schema
2. Calls the underlying service function with tenant-scoped context
3. Returns structured `ToolResult`

### 3.3 Custom Tool Adapter (Webhook)

New file: `api/src/agent/tools/webhook-tool.ts`

Loads tool definitions from the `tool_definitions` table. For each:
- Constructs an HTTP POST to `handler_config.url`
- Includes auth from `handler_config.auth` (bearer token or custom header)
- Enforces `handler_config.timeout` (default 10s, max 30s)
- Validates response body size (max 10KB)
- Returns parsed JSON as `ToolResult.data`

### 3.4 Tool Registry

New file: `api/src/agent/tool-registry.ts`

```typescript
export class ToolRegistry {
  private builtinTools: Map<string, ToolAdapter>;

  constructor() {
    this.builtinTools = new Map();
    // Register all built-in tools at construction
  }

  async getToolsForTenant(tenantId: string): Promise<ToolAdapter[]> {
    // 1. Get tenant settings to see which built-ins are enabled
    // 2. Load custom tools from tool_definitions table
    // 3. Build WebhookToolAdapter for each custom tool
    // 4. Return combined list
  }
}
```

Instantiated once at server startup, shared across requests.

---

## 4. Agent Loop

### 4.1 Core Loop

New file: `api/src/agent/agent.service.ts`

```typescript
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
    const tools = await this.toolRegistry.getToolsForTenant(tenant.id);
    const systemPrompt = this.promptBuilder.build(tenant, tools);
    const provider = getProvider(tenant.settings.ai.provider, tenant.settings.ai.apiKey);
    const model = tenant.settings.ai.model;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: message },
    ];

    const trace: AgentTrace = { iterations: [], sessionId: session.id, tenantId: tenant.id };
    const toolsCalled: string[] = [];
    const maxIterations = 10;

    for (let i = 0; i < maxIterations; i++) {
      // Budget check
      if (this.metering.isOverBudget(tenant.id)) {
        return { type: 'budget_exceeded', fallbackMessage: tenant.settings.ai.guardrails.fallbackMessage };
      }

      const toolDefs = tools.length > 0
        ? tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))
        : undefined;

      const response = await provider.chat(messages, {
        model, maxTokens: 1000, temperature: 0.3, jsonMode: false, tools: toolDefs,
      });

      // Record metering
      this.metering.record(tenant.id, response.usage);

      // Record trace (latencyMs captured via Date.now() around the provider.chat call)
      const traceEntry = { llmCall: { model, ...response.usage, latencyMs }, toolCalls: [] };

      if (response.finishReason === 'stop' || !response.toolCalls?.length) {
        trace.iterations.push(traceEntry);
        this.traceLogger.save(trace);
        return { type: 'response', content: response.content };
      }

      // Process tool calls
      for (const toolCall of response.toolCalls) {
        const tool = tools.find(t => t.name === toolCall.name);
        if (!tool) {
          messages.push({ role: 'assistant', content: `Tool ${toolCall.name} not found` });
          continue;
        }

        // Precondition check
        if (tool.preconditions?.toolsCalled) {
          const missing = tool.preconditions.toolsCalled.filter(t => !toolsCalled.includes(t));
          if (missing.length > 0) {
            // Feed error back to LLM
            messages.push({
              role: 'tool' as any,
              content: JSON.stringify({ error: `Must call ${missing.join(', ')} before ${tool.name}` }),
            });
            continue;
          }
        }

        // Confirmation gate
        if (tool.hasSideEffects) {
          const confirmed = await this.requestConfirmation(session.id, toolCall, tool);
          if (!confirmed) {
            messages.push({
              role: 'tool' as any,
              content: JSON.stringify({ error: 'User declined this action' }),
            });
            continue;
          }
        }

        // Execute
        const ctx: ToolContext = { tenantId: tenant.id, sessionId: session.id, toolsCalledThisTurn: toolsCalled };
        const result = await tool.execute(toolCall.arguments, ctx);
        toolsCalled.push(tool.name);

        // Feed result back to LLM
        messages.push({
          role: 'tool' as any,
          content: JSON.stringify(result.data ?? { error: result.error }),
        });

        traceEntry.toolCalls.push({ name: tool.name, args: toolCall.arguments, result, latencyMs: 0 });
      }

      trace.iterations.push(traceEntry);
      // Append assistant message with tool calls for conversation continuity
      messages.push({ role: 'assistant', content: '', toolCalls: response.toolCalls } as any);
    }

    // Max iterations — escalate
    this.traceLogger.save(trace);
    return { type: 'max_iterations', fallbackMessage: 'Let me connect you with a human agent.' };
  }
}
```

### 4.2 Confirmation Gate (Pause/Resume)

When a tool has `hasSideEffects: true`:

1. **Serialize loop state** to Redis:
   - Key: `agent:confirm:{sessionId}:{toolCallId}`
   - Value: `{ messages, iteration, pendingToolCall, trace }`
   - TTL: 300 seconds (5 minutes)

2. **Send confirmation prompt** via Socket.IO:
   ```json
   {
     "event": "agent:confirmation_needed",
     "data": {
       "toolCallId": "tc_123",
       "toolName": "create_booking",
       "preview": { "time": "2026-04-05 10:00", "attendee": "John" },
       "message": "Should I book this appointment for April 5 at 10:00 AM?"
     }
   }
   ```

3. **Widget renders** a confirmation card with Confirm/Cancel buttons.

4. **User responds** via Socket.IO event `agent:confirmation_response`:
   ```json
   { "toolCallId": "tc_123", "confirmed": true }
   ```

5. **Platform loads state** from Redis, resumes the loop at the exact iteration.

6. **Timeout:** If no response in 5 minutes, auto-decline. Send "I'll skip that for now. Is there anything else I can help with?"

### 4.3 Agent Result Types

```typescript
type AgentResult =
  | { type: 'response'; content: string }
  | { type: 'max_iterations'; fallbackMessage: string }
  | { type: 'budget_exceeded'; fallbackMessage: string }
  | { type: 'error'; error: string; fallbackMessage: string };
```

---

## 5. Skills (Playbooks)

### 5.1 Data Structure

Stored in `tenant.settings.skills[]`:

```typescript
interface Skill {
  name: string;
  trigger: string;         // natural language for LLM context
  tools: string[];         // tool names this skill uses
  instructions: string;    // injected into system prompt
  maxSteps: number;        // max tool calls (default 5)
  enabled: boolean;
}
```

### 5.2 System Prompt Injection

The `PromptBuilder` dynamically assembles the system prompt:

```
You are {brandVoice.name}.
Tone: {brandVoice.tone}
{brandVoice.customInstructions}

## GUARDRAILS
- Never discuss: {topicsToAvoid}
- Max response: {maxResponseLength} characters
- If unsure, say so honestly

## ESCALATION
If the customer explicitly asks for a human agent or you cannot help, call the escalate_to_agent tool.

## AVAILABLE SKILLS

### Booking
When: User wants to schedule, reschedule, or cancel an appointment
Tools: check_availability, create_booking, list_bookings, reschedule_booking, cancel_booking
Rules: {skill.instructions}

## KNOWLEDGE BASE
{KB chunks injected by AgentService — calls searchKnowledge() on first user message
 to pre-fetch relevant context. KB search is also available as a tool for follow-up queries.}

## RULES
- Be concise (2-4 sentences unless more is needed)
- Match the customer's language
- Never reveal internal system details
```

### 5.3 Default Skills

When a tenant enables booking integration (`tenant.settings.integrations.calcom`), the platform auto-creates a default booking skill:

```json
{
  "name": "booking",
  "trigger": "User wants to schedule, reschedule, or cancel an appointment",
  "tools": ["check_availability", "create_booking", "list_bookings", "reschedule_booking", "cancel_booking"],
  "instructions": "Always check availability before creating. Collect name and email. Confirm all details before booking. Timezone: {tenant.businessHours.timezone}",
  "maxSteps": 8,
  "enabled": true
}
```

---

## 6. Token Metering

### 6.1 Implementation

New file: `api/src/agent/metering.service.ts`

- **Per-request:** After each LLM call, increment Redis hash:
  - Key: `tokens:{tenantId}:{YYYY-MM-DD}`
  - Fields: `prompt`, `completion`, `total`, `calls`
  - Use `HINCRBY` for atomic increments

- **Budget check:** Before each LLM call in the agent loop:
  - Read `tokens:{tenantId}:{today}` total
  - Compare against `tenant.settings.ai.dailyTokenBudget`
  - If exceeded, return budget_exceeded result

- **Flush to DB:** Hourly cron writes Redis counters to `tenant_usage` table, resets Redis keys.

### 6.2 Tenant Settings

```typescript
// New field in tenant.settings.ai
dailyTokenBudget?: number;  // null = unlimited (default for free tier: 50000, pro: 500000)
```

### 6.3 Kill Switch

If budget exceeded mid-conversation:
1. Agent loop returns immediately with fallback message
2. Session continues in 'bot' status (agent can still respond to next message if budget resets)
3. Log warning to agent trace

---

## 7. Observability

### 7.1 Agent Trace

```typescript
interface AgentTrace {
  id: string;
  sessionId: string;
  tenantId: string;
  messageId: string;
  iterations: Array<{
    llmCall: {
      model: string;
      promptTokens: number;
      completionTokens: number;
      latencyMs: number;
    };
    toolCalls: Array<{
      name: string;
      args: Record<string, unknown>;
      result: ToolResult;
      latencyMs: number;
      confirmed?: boolean;
    }>;
  }>;
  totalTokens: number;
  totalLatencyMs: number;
  finishReason: 'completed' | 'max_iterations' | 'budget_exceeded' | 'error';
  createdAt: string;
}
```

### 7.2 Storage

- `agent_traces` table (see Section 9 for schema)
- Rolling 30-day retention per tenant (cron cleanup)
- API endpoint: `GET /api/v1/tenants/me/agent-traces?sessionId=...`

---

## 8. Message Forwarding Integration

### 8.1 Updated Flow in `message-forwarding.service.ts`

```typescript
export async function forwardMessageToN8n(session, savedMessage): Promise<boolean> {
  // Guard: only forward visitor messages in bot/waiting status
  if (session.status !== 'bot' && session.status !== 'waiting') return false;

  const tenant = await tenantRepository.findOne({ where: { id: session.tenantId } });
  if (!tenant) return false;

  const aiSettings = tenant.settings?.ai;

  // ── Route 1: Custom webhook (n8n path, unchanged) ──────────────
  const tenantUrl = tenant.webhookUrl && !tenant.webhookUrl.includes('localhost')
    ? tenant.webhookUrl : undefined;

  if (tenantUrl) {
    // Existing n8n forwarding path — completely untouched
    return existingN8nForwardingLogic(session, savedMessage, tenant, tenantUrl);
  }

  // ── Route 2: Platform agent (new primary path) ─────────────────
  if (aiSettings?.enabled) {
    return platformAgentPath(session, savedMessage, tenant, aiSettings);
  }

  // ── Route 3: No AI — session stays waiting for human ───────────
  return false;
}

async function platformAgentPath(session, savedMessage, tenant, aiSettings) {
  // Pre-forwarding checks (business hours, escalation keywords) — same as existing
  // ...

  const history = await getConversationHistory(session.id);
  const messageContent = savedMessage.contentEncrypted
    ? decrypt(savedMessage.content) : savedMessage.content;

  const result = await agentService.run(messageContent, session, tenant, history);

  const botParticipant = await ensureBotParticipant(session, aiSettings);

  switch (result.type) {
    case 'response':
      await sendBotMessage(session, botParticipant.id, result.content);
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

### 8.2 Backward Compatibility

- Tenants with `webhookUrl` set → n8n path (zero changes)
- Tenants with AI enabled, no `webhookUrl` → platform agent (new)
- Tenants with neither → human-only (zero changes)
- `N8N_DEFAULT_WEBHOOK_URL` env var is no longer used as fallback for AI tenants (platform handles it natively)

---

## 9. Database Changes

### 9.1 New Table: `tool_definitions`

```sql
CREATE TABLE tool_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  handler_type VARCHAR(20) NOT NULL CHECK (handler_type IN ('webhook', 'n8n')),
  handler_config JSONB NOT NULL,
  parameters_schema JSONB NOT NULL,
  has_side_effects BOOLEAN DEFAULT false,
  preconditions JSONB,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

CREATE INDEX idx_tool_definitions_tenant ON tool_definitions(tenant_id) WHERE enabled = true;
```

### 9.2 New Table: `agent_traces`

```sql
CREATE TABLE agent_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  message_id UUID,
  trace JSONB NOT NULL,
  total_tokens INT NOT NULL,
  total_latency_ms INT NOT NULL,
  finish_reason VARCHAR(30) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_traces_tenant ON agent_traces(tenant_id, created_at DESC);
CREATE INDEX idx_agent_traces_session ON agent_traces(session_id, created_at DESC);
```

### 9.3 New Table: `tenant_usage`

```sql
CREATE TABLE tenant_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  prompt_tokens INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  llm_calls INT DEFAULT 0,
  tool_calls INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, date)
);
```

### 9.4 Tenant Settings Additions

```typescript
// In tenant.settings.ai (existing JSONB)
dailyTokenBudget?: number;

// In tenant.settings (existing JSONB)
skills?: Array<{
  name: string;
  trigger: string;
  tools: string[];
  instructions: string;
  maxSteps: number;
  enabled: boolean;
}>;
```

---

## 10. New File Structure

```
api/src/agent/
  agent.service.ts          — Core agent loop with pause/resume
  prompt-builder.ts         — Dynamic system prompt assembly
  tool-adapter.ts           — ToolAdapter interface and types
  tool-registry.ts          — Registry: loads built-in + custom tools per tenant
  metering.service.ts       — Token metering (Redis + Postgres)
  trace-logger.ts           — Agent trace recording
  confirmation.service.ts   — WebSocket confirmation gate logic
  tools/
    kb-search.tool.ts       — Knowledge base search adapter
    booking.tool.ts         — All 5 booking tool adapters
    escalation.tool.ts      — Handoff/escalation adapter
    webhook.tool.ts         — Generic webhook adapter for custom tools
```

---

## 11. Tenant Isolation & Safety

- **Per-tenant concurrency:** Max 3 concurrent agent loops per tenant (enforced via Redis semaphore)
- **Per-tool timeout:** 30 seconds max per tool execution
- **Per-turn limit:** Max 5 tool calls per conversation turn (prevents infinite loops)
- **Max iterations:** 10 per agent run
- **Token budget:** Per-tenant daily limit with kill switch
- **Webhook tool sandboxing:** Response size limit (10KB), timeout (10s default, 30s max), no redirects

---

## 12. Migration Path

1. Deploy with platform agent alongside existing n8n path
2. New tenants get platform agent by default (no `webhookUrl` set)
3. Existing tenants with `webhookUrl` continue using n8n
4. Provide migration guide: remove `webhookUrl` → configure skills in dashboard
5. Eventually deprecate `N8N_DEFAULT_WEBHOOK_URL` fallback
