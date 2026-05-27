# Agent Architecture vs Competitors — Council Analysis

**Date:** 2026-04-03
**Scope:** Platform-native agent architecture evaluated against 14 competitors

---

## Council Verdict

**The platform-native agent with tool registry is the right architecture.** It matches Intercom Fin and Botpress architecturally, while our multi-tenant isolation gives us a moat none of them have. Three gaps must be closed first.

---

## 1. Three Critical Gaps

### Gap 1: LLM Providers Have No Tool-Calling Support

`llm.types.ts:18-20` — `LLMProvider.chat()` returns `{ content: string }` only. No `tool_calls`, no `tools` parameter. Both OpenAI and Anthropic SDKs support tool/function calling natively, but our providers ignore it.

**Fix:** Extend interface:
```typescript
interface LLMOptions {
  model: string;
  maxTokens: number;
  temperature: number;
  jsonMode: boolean;
  tools?: ToolDefinition[];    // NEW
}

interface LLMResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
  toolCalls?: ToolCall[];      // NEW
}
```

### Gap 2: No Tool Registry (No Database Entity)

`Tenant.settings` has no `tools` field. The booking service is hardcoded to Cal.com. There's no way to configure different tools per tenant.

**Fix:** New `ToolDefinition` entity + `tools` array in tenant settings:
```typescript
tools: [
  { type: 'builtin', name: 'kb_search' },
  { type: 'builtin', name: 'booking' },
  { type: 'webhook', name: 'order_lookup', url: '...', 
    description: 'Look up order status by order ID',
    inputSchema: { orderId: { type: 'string' } },
    auth: { type: 'bearer', token: '<encrypted>' },
    timeout: 10000,
    preconditions: [],
    requiresConfirmation: false }
]
```

### Gap 3: No Constrained Autonomy (Deterministic + Autonomous Hybrid)

The n8n booking prompt uses 2000+ chars of natural language to tell the LLM "NEVER create a booking without checking availability first." This is fragile — LLMs violate prompt instructions.

**Fix:** Tool preconditions enforced programmatically:
```typescript
{ name: 'create_booking',
  requires: { tools_called: ['check_availability'] },
  requiresConfirmation: true }
```

The agent loop checks preconditions BEFORE executing. If violated, returns an error to the LLM ("You must check availability first") without executing the tool.

---

## 2. Competitor Weaknesses We Exploit

### Tier 1 (Intercom, Botpress, Voiceflow, Ada)

| Weakness | How We Exploit |
|----------|---------------|
| **Single-tenant architecture** — every bot is a separate workspace/deployment | Our multi-tenant isolation serves 50+ tenants from one deployment. Agencies and SaaS resellers can't do this with Botpress or Voiceflow. |
| **AI markup pricing** — Intercom $0.99/resolution, Ada $1-$3.50/resolution, Botpress bills AI spend | Our BYOK model (tenant provides their own OpenAI/Anthropic key) eliminates AI markup entirely. |
| **Vendor lock-in** — Ada's proprietary "Reasoning Engine", Intercom's proprietary Fin engine | Our `provider-factory.ts` already supports multi-provider per-tenant. Adding Gemini/Mistral is a new provider, not an architecture change. |

### Tier 2 (Tidio, Gorgias, Crisp, Freshchat)

| Weakness | How We Exploit |
|----------|---------------|
| **Vertical lock-in** — Gorgias is Shopify-only, Freshchat is Freshworks-only | Our tool registry is integration-agnostic. Any webhook = a tool. |
| **Crisp's white-label is branding-only** — logo/colors, no per-tenant AI config, KB, or integrations | Our `Tenant.settings` already has deeper multi-tenancy than Crisp at any price tier. |
| **No agentic AI** — Tidio's Lyro answers questions but can't perform actions | Our tool registry + agent loop = action-taking AI (Intercom Fin level) at Crisp pricing. |

### Tier 3 (ManyChat, Chatfuel, Landbot, etc.)

| Weakness | How We Exploit |
|----------|---------------|
| **Channel-locked** — ManyChat is Instagram, Chatfuel is Messenger/WhatsApp | Our channel adapter pattern supports web + Telegram + Meta with clean extensibility. |
| **Rule-based, not AI-native** — ManyChat flows are deterministic keyword trees | Our AI is the brain; rules are lightweight pre-checks, not the core logic. |
| **No handoff system** — tawk.to, ManyChat, Landbot have basic or no handoff | Our handoff with 7 trigger reasons, priority queuing, context-passing is production-grade. |

---

## 3. The "Action-Taking AI" Pattern (Intercom Fin)

Intercom Fin, Gorgias, Ada, and HubSpot can all PERFORM actions: refunds, order changes, CRM updates, ticket creation. This is the key differentiator of 2026.

**Our tool registry handles this natively.** The pattern is:
1. Tenant configures a tool: `{ name: 'process_refund', type: 'webhook', url: 'https://their-api.com/refunds', requiresConfirmation: true }`
2. LLM detects refund intent, calls `process_refund` tool
3. Agent loop intercepts (requiresConfirmation = true), asks user to confirm
4. On confirmation, executes the webhook, feeds result back to LLM
5. LLM tells the user "Your refund of $42.50 has been processed"

**Two additions needed:**
- **Tool execution sandboxing:** timeout enforcement, response size limits, error handling
- **Tool result validation:** schema check on webhook responses before feeding back to LLM

---

## 4. Visual Flow Builder: Defer It

ManyChat, Chatfuel, Tidio, Landbot, Botpress, Voiceflow ALL have drag-and-drop builders. Building one is 3-6 months.

**The tool registry + playbook system covers 80% of this with 10% of the effort.**

**Playbook system** (instead of flow builder):
```typescript
// Tenant config
playbooks: [
  {
    name: 'booking',
    trigger: 'User wants to schedule an appointment',
    tools: ['check_availability', 'create_booking', 'list_bookings'],
    instructions: 'Always check availability before creating. Collect name and email. Timezone: Europe/Amsterdam.'
  },
  {
    name: 'order_support',
    trigger: 'User asks about their order',
    tools: ['order_lookup', 'process_refund'],
    instructions: 'Look up the order first. Only process refunds with explicit confirmation.'
  }
]
```

These get injected into the system prompt dynamically. The LLM handles the actual conversation flow. Tool preconditions enforce safety. This replaces the 2000-char hardcoded booking prompt in the n8n workflow with a configurable data structure.

**Why this beats a flow builder for our use case:**
- White-label tenants don't want to build flows — they want to configure capabilities
- LLMs handle off-script naturally; flow builders force users back on-rails
- Playbooks are API-configurable (agencies can provision programmatically)
- No visual editor to build/maintain

---

## 5. Autonomous vs. Deterministic: Constrained Autonomy

| Approach | Who Uses It | Tradeoff |
|----------|------------|----------|
| **Pure deterministic** (flow builder) | ManyChat, Chatfuel, Landbot | Predictable but rigid. Breaks when users go off-script. |
| **Pure autonomous** (LLM decides everything) | Current n8n brain with prompt-only constraints | Flexible but unreliable. LLM violates "never do X" rules. |
| **Constrained autonomy** (proposed) | Similar to Botpress "autonomous + deterministic hybrid" | LLM decides WHEN to call tools. Platform enforces HOW (preconditions, confirmations, safety). |

**Implementation in the agent loop:**
```
for each iteration (max 10):
  response = LLM.chatWithTools(messages, enabledTools)
  
  if response.toolCalls:
    for each toolCall:
      // DETERMINISTIC: enforce preconditions
      if !meetsPrerequisites(toolCall, sessionHistory):
        feedbackToLLM("Cannot call {tool}: must call {prerequisite} first")
        continue
      
      // DETERMINISTIC: enforce confirmation gates
      if tool.requiresConfirmation:
        askUserConfirmation(toolCall)
        pause until confirmed
      
      // AUTONOMOUS: LLM chose this tool, execute it
      result = executeToolCall(toolCall)
      feedResultToLLM(result)
  
  else:
    return response.content  // final answer
```

---

## 6. Architecture Summary

```
┌─────────────────────────────────────────────────────┐
│  Platform Agent Service (per-request, per-tenant)    │
│                                                      │
│  1. Load tenant config (brand voice, guardrails)     │
│  2. Load tenant playbooks (triggers, tools, rules)   │
│  3. Build system prompt dynamically                  │
│  4. Call LLM with tenant's API key + model           │
│     (OpenAI / Anthropic / future: Gemini, Mistral)   │
│  5. Agent loop:                                      │
│     - LLM returns tool_call?                         │
│       → Check preconditions (deterministic)          │
│       → Check confirmation gate (deterministic)      │
│       → Execute tool (builtin / webhook / n8n)       │
│       → Feed result back to LLM                      │
│       → Loop (max iterations)                        │
│     - LLM returns text?                              │
│       → Final response to user                       │
│                                                      │
│  Built-in Tools:          External Tools:            │
│  ├─ kb_search              ├─ webhook (any URL)      │
│  ├─ check_availability     ├─ n8n workflow            │
│  ├─ create_booking         └─ custom API             │
│  ├─ list_bookings                                    │
│  ├─ reschedule_booking    Playbooks:                 │
│  ├─ cancel_booking        ├─ booking flow            │
│  └─ escalate_to_agent     ├─ lead capture            │
│                           ├─ order support           │
│                           └─ (tenant-defined)        │
└─────────────────────────────────────────────────────┘
```

---

## 7. What Makes Us Better Than Every Competitor

| Capability | Us (proposed) | Best Competitor | Our Edge |
|-----------|---------------|-----------------|----------|
| Multi-tenant white-label | Native architecture | Crisp (branding only) | Per-tenant AI, KB, tools, integrations, theming from single deployment |
| AI model choice | Per-tenant OpenAI/Anthropic (extensible) | Botpress (multi-LLM) | BYOK eliminates AI markup. Tenant chooses their model. |
| Action-taking AI | Tool registry (any webhook) | Intercom Fin (pre-built connectors) | Integration-agnostic. Tenants connect their own systems. |
| Conversation flow | Constrained autonomy (LLM + preconditions) | Voiceflow (playbooks + flows) | No visual editor to maintain. Playbooks configurable via API. |
| Handoff | 7 reasons, priority queue, context-passing | Intercom (good) | More granular triggers, confidence-based routing |
| Knowledge base | pgvector RAG, per-tenant, multi-doc types | Botpress (auto-index) | Isolated per tenant. Hybrid vector + keyword search. |
| Pricing model | Flat + BYOK (no AI markup) | Intercom ($0.99/outcome) | Predictable costs. No surprise bills. |
| Extensibility | n8n as optional tool, any webhook as tool | Botpress (JS/TS actions) | Best of both: code-level AND no-code (n8n visual) |

---

## 8. Implementation Priority

### Phase 1: Agent Foundation (1-2 weeks)
1. Extend `LLMProvider` with tool-calling support
2. Build `AgentService` with iterative tool-calling loop
3. Convert booking service functions to built-in tool definitions
4. Wire into `message-forwarding.service.ts` as primary path for AI-enabled tenants

### Phase 2: Tool Registry + Playbooks (1-2 weeks)
5. Add `tools` and `playbooks` to `Tenant.settings`
6. Build tool execution engine (builtin, webhook, n8n adapters)
7. Implement preconditions and confirmation gates
8. Dashboard UI for tool/playbook configuration

### Phase 3: Competitive Polish (1-2 weeks)
9. Per-tenant analytics API
10. Widget theming extensions
11. Tenant onboarding API (single-call provisioning)
12. Fix remaining multi-tenancy bugs (per-tenant circuit breaker, ownership checks)
