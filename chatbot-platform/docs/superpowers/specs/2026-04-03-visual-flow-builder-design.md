# Visual Flow Builder Design Spec

**Date:** 2026-04-03
**Status:** Draft
**Scope:** React Flow-based visual workflow editor for tenant conversation flows

---

## 1. Overview

A drag-and-drop visual editor where tenants design conversation flows. Flows define: triggers, conditions, tool actions, and message responses. The editor compiles flows into the existing skills + tools config that the AgentService executes.

**The key insight:** The visual flow is a **configuration layer**, not an execution engine. The LLM agent still runs the conversation. The flow defines constraints and structure — which tools are available, what conditions trigger which actions, and what messages to send at each step.

```
Visual Flow (what the user sees)     →     Compiled Config (what the agent uses)
─────────────────────────────────           ────────────────────────────────────
[Trigger] → [Condition] → [Action]    →    skill: { trigger, tools, instructions }
                       → [Message]     →    + system prompt additions
```

**Non-goals (Phase 1):**
- Flow execution engine (LLM handles this)
- Branching runtime (no if/else in code — LLM decides)
- Custom code nodes
- Version control / draft-publish pipeline
- Flow analytics / step-level metrics

---

## 2. Technology

**React Flow (xyflow)** — MIT licensed, 20k+ GitHub stars, used by Stripe, Typeform, and many flow builders.

- Canvas with zoom/pan
- Custom node types (React components)
- Edge connections with validation
- Minimap, controls, background grid
- Serialize/deserialize to JSON

```bash
npm install @xyflow/react
```

---

## 3. Node Types

### 3.1 Trigger Node (entry point, one per flow)

```
┌─ 🎯 Trigger ──────────────────────┐
│                                     │
│  When: [User wants to book      ▼] │
│                                     │
│  Channel: [All channels         ▼] │
│                                     │
└─────────────────────────── [out] ──┘
```

Config: `{ type: 'trigger', trigger: string, channel?: string }`

### 3.2 Message Node (bot sends a message)

```
┌─ 💬 Send Message ──────────────────┐
│                                     │
│  [Hi! I'd love to help you book.   ]│
│  [When would you like to come in?  ]│
│                                     │
│  Quick Replies:                     │
│  [This week] [Next week] [Custom]  │
│                                     │
└── [in] ────────────────── [out] ───┘
```

Config: `{ type: 'message', content: string, quickReplies?: string[] }`

### 3.3 Tool Node (execute a platform tool)

```
┌─ 🔧 Check Availability ───────────┐
│                                     │
│  Tool: [check_availability      ▼] │
│                                     │
│  On Success: ─── [success] ──→     │
│  On Failure: ─── [failure] ──→     │
│                                     │
└── [in] ────────────────────────────┘
```

Config: `{ type: 'tool', toolName: string }`
Two output handles: success and failure.

### 3.4 Condition Node (LLM-evaluated branch)

```
┌─ ❓ Condition ─────────────────────┐
│                                     │
│  Check: [User provided email?   ▼] │
│                                     │
│  YES ─── [yes] ──→                 │
│  NO  ─── [no]  ──→                │
│                                     │
└── [in] ────────────────────────────┘
```

Config: `{ type: 'condition', condition: string }`
The condition is natural language — the LLM evaluates it, not code. Two output handles: yes/no.

### 3.5 Collect Input Node (gather info from user)

```
┌─ 📝 Collect Info ──────────────────┐
│                                     │
│  Ask for: [Name and email       ▼] │
│  Prompt: [Could you share your     ]│
│          [name and email?          ]│
│                                     │
│  Store as: name, email              │
│                                     │
└── [in] ────────────────── [out] ───┘
```

Config: `{ type: 'collect', fields: string[], prompt: string }`

### 3.6 Handoff Node (transfer to human)

```
┌─ 🤝 Handoff ──────────────────────┐
│                                     │
│  Reason: [Customer requested    ▼] │
│  Message: [Connecting you to      ]│
│           [our team...            ]│
│                                     │
└── [in] ────────────────────────────┘
```

Config: `{ type: 'handoff', reason: string, message: string }`
No output handle — terminal node.

---

## 4. Flow Data Model

### 4.1 Flow Definition (stored in DB)

```typescript
interface FlowDefinition {
  id: string;
  tenantId: string;
  name: string;                    // "Booking Flow", "Lead Capture"
  description?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface FlowNode {
  id: string;
  type: 'trigger' | 'message' | 'tool' | 'condition' | 'collect' | 'handoff';
  position: { x: number; y: number };
  data: Record<string, unknown>;   // node-type-specific config
}

interface FlowEdge {
  id: string;
  source: string;                  // node ID
  sourceHandle?: string;           // 'success' | 'failure' | 'yes' | 'no' | null
  target: string;                  // node ID
}
```

### 4.2 Storage

New table: `flows`
```sql
CREATE TABLE flows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  definition JSONB NOT NULL,       -- { nodes: [], edges: [] }
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);
```

### 4.3 Flow → Agent Config Compilation

When a flow is saved, it compiles to the existing skills + instructions format:

```typescript
function compileFlow(flow: FlowDefinition): CompiledSkill {
  const trigger = flow.nodes.find(n => n.type === 'trigger');
  const tools = flow.nodes.filter(n => n.type === 'tool').map(n => n.data.toolName);
  
  // Walk the graph to build instructions
  const instructions = buildInstructionsFromGraph(flow.nodes, flow.edges);
  
  return {
    name: flow.name,
    trigger: trigger?.data.trigger as string,
    tools: [...new Set(tools)],
    instructions,
    maxSteps: Math.max(tools.length * 2, 5),
    enabled: flow.enabled,
    _flowId: flow.id,  // link back to visual flow
  };
}
```

The compiled skill goes into `tenant.settings.skills[]` — the AgentService reads it exactly as before. The flow builder is just a visual way to generate that config.

---

## 5. API Endpoints

```
GET    /api/v1/tenants/me/flows              → list all flows
POST   /api/v1/tenants/me/flows              → create a flow
GET    /api/v1/tenants/me/flows/:id          → get a flow
PUT    /api/v1/tenants/me/flows/:id          → update a flow (save from editor)
DELETE /api/v1/tenants/me/flows/:id          → delete a flow
POST   /api/v1/tenants/me/flows/:id/enable   → enable/disable
POST   /api/v1/tenants/me/flows/:id/compile  → compile to skill config (for preview)
```

---

## 6. Portal Pages

### 6.1 Flow List Page (`/settings/flows`)

Lists all flows with:
- Name, description, enabled toggle
- Node count, last edited
- "Create Flow" button
- Click to open editor

### 6.2 Flow Editor Page (`/flows/:id/edit`)

Full-screen canvas with:
- React Flow canvas (center)
- Node palette (left sidebar) — drag nodes onto canvas
- Node config panel (right sidebar) — edit selected node's properties
- Top bar: flow name, Save button, Enable/Disable toggle, Back button
- Bottom bar: zoom controls, minimap toggle

### 6.3 Pre-built Templates

"Create Flow" offers templates:
- **Appointment Booking** — trigger → collect info → check availability → create booking → confirmation message
- **Lead Capture** — trigger → ask questions → collect info → capture lead → thank you message
- **FAQ + Escalation** — trigger → KB search → condition (found answer?) → message / handoff
- **Blank Flow** — just a trigger node

---

## 7. How Flows Interact with the Agent

The flow builder doesn't replace the agent — it **constrains** it.

```
Without flow:
  LLM has all tools, decides everything autonomously.
  Works but unpredictable for complex multi-step processes.

With flow:
  LLM sees: "Follow this flow: first collect name+email, 
  then check availability, then create booking. Only use these
  tools in this order."
  LLM still handles conversation naturally, but the structure
  is defined by the flow.
```

The compiled flow becomes system prompt instructions:

```
## FLOW: Appointment Booking

STEP 1: Greet the customer and ask when they'd like to visit.
STEP 2: Collect their name and email address.
STEP 3: Call check_availability for their preferred date.
STEP 4: Present available slots and let them choose.
STEP 5: Call create_booking with their selection.
STEP 6: Confirm the booking with a summary.

Follow these steps in order. You may answer off-topic questions
between steps, but always return to the next step.
```

This is the same "constrained autonomy" pattern — the visual flow generates the constraints, the LLM provides the conversational intelligence.

---

## 8. Implementation Phases

### Phase 1 (2 weeks): Core Editor
- React Flow canvas with 4 node types (trigger, message, tool, handoff)
- Node palette + config panel
- Save/load to DB via API
- Flow → skill compilation
- 2 pre-built templates (booking, lead capture)

### Phase 2 (1-2 weeks): Polish
- Condition node + collect input node
- Edge validation (can't connect incompatible nodes)
- All 4 templates
- Flow enable/disable
- Undo/redo

### Phase 3 (future): Advanced
- Version control (draft/published)
- Flow analytics (step completion rates)
- Custom code nodes
- Flow duplication across tenants

---

## 9. New Files

### Backend
| File | Purpose |
|------|---------|
| `api/src/routes/flows.routes.ts` | Flows CRUD + compile endpoints |
| `api/src/services/flow-compiler.ts` | Compiles flow graph → skill config |
| `api/src/database/migrations/XXXX-CreateFlowsTable.ts` | DB migration |

### Frontend
| File | Purpose |
|------|---------|
| `portal/src/pages/settings/FlowsSettings.tsx` | Flow list page |
| `portal/src/pages/flows/FlowEditor.tsx` | Full-screen flow editor |
| `portal/src/components/flows/NodePalette.tsx` | Draggable node sidebar |
| `portal/src/components/flows/ConfigPanel.tsx` | Selected node config |
| `portal/src/components/flows/nodes/TriggerNode.tsx` | Custom trigger node |
| `portal/src/components/flows/nodes/MessageNode.tsx` | Custom message node |
| `portal/src/components/flows/nodes/ToolNode.tsx` | Custom tool action node |
| `portal/src/components/flows/nodes/HandoffNode.tsx` | Custom handoff node |
| `portal/src/components/flows/nodes/ConditionNode.tsx` | Custom condition node |
| `portal/src/components/flows/nodes/CollectNode.tsx` | Custom collect info node |
| `portal/src/components/flows/FlowTemplates.tsx` | Template picker modal |
| `portal/src/queries/useFlowQueries.ts` | React Query hooks |
