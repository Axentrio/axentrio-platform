# Test Chat Panel Design Spec

## Overview

Slide-over chat panel in the Knowledge Base page that lets admins have a live conversation with their configured AI bot. Uses saved settings, supports toggling knowledge base on/off, and replicates the visitor widget styling for an accurate preview.

## Trigger

- "Test Chat" button in the AI Settings tab, next to the AI Bot toggle
- Visible to admins only (role-gated via `isRole('admin')`)
- Disabled when AI Bot is toggled off (settings not saved as enabled)

## Panel Layout

- **Type**: Slide-over panel from the right edge
- **Width**: ~400px (fixed)
- **Overlay**: Semi-transparent backdrop, settings page visible underneath
- **Close**: X button in header, or click outside the panel

### Header

- Bot name (from saved `brandVoice.name`)
- Provider/model badge (e.g. "OpenAI / gpt-4o-mini")
- Toggle switch: "Use Knowledge Base" — controls whether RAG retrieval is used
  - Default **off** if no indexed documents exist
  - Default **on** if indexed documents exist
- X close button

### Chat Area

Widget-replica styling matching the visitor chat widget:
- Bot messages: left-aligned with bot avatar and name
- User messages: right-aligned bubbles
- Typing indicator (animated dots) while waiting for bot response
- Auto-scroll to latest message
- Scrollable message list

### Input

- Text input at bottom of panel
- Send button (or Enter key to send)
- Disabled while bot is responding

## Backend

### Endpoint

`POST /tenants/me/ai-settings/test`

This endpoint already exists. It needs to be extended to support:
- Conversation history (array of prior messages for multi-turn context)
- Knowledge base toggle flag
- Brand voice and guardrails from saved settings (already available server-side)

### Request Body

```typescript
{
  question: string;           // current user message
  history?: { role: 'user' | 'assistant'; content: string }[];  // prior messages
  useKnowledgeBase?: boolean; // whether to run full RAG pipeline
}
```

### Response Body

```typescript
{
  response: string;
  provider: string;
  model: string;
  confidence?: number;       // only when useKnowledgeBase is true
  chunksUsed?: number;       // only when useKnowledgeBase is true
}
```

### Behavior

- **useKnowledgeBase = false**: Calls LLM with brand voice system prompt + guardrails + conversation history. No embedding or vector search. Does not require `OPENAI_API_KEY`.
- **useKnowledgeBase = true**: Calls full `generateResponse()` RAG pipeline — embeds the question, retrieves chunks, builds context prompt, calls LLM. Requires `OPENAI_API_KEY` for embeddings.

Both modes apply:
- Brand voice (name, tone, custom instructions)
- Guardrails (topics to avoid, max response length, escalation keywords, confidence threshold, fallback message)

### Existing fields to remove from test endpoint

The `provider`, `model`, and `apiKey` fields added for Test Connection should remain on the test endpoint (they're used by the "Test Connection" button). The test chat will NOT send these — it uses saved settings.

## Conversation State

- Messages stored in React state (`useState<Message[]>([])`)
- No database persistence — closing the panel resets everything
- No chat session created in DB
- Each panel open starts a fresh conversation

## Component Structure

```
src/pages/knowledge/TestChatPanel.tsx    — slide-over panel with chat UI
```

Integrated into `AiSettingsTab.tsx` via a button that toggles panel visibility.

## Data Flow

1. Admin clicks "Test Chat" button
2. Panel slides open from right
3. Admin types a message, hits Enter
4. Frontend sends `POST /tenants/me/ai-settings/test` with message + history + toggle
5. Show typing indicator while waiting
6. Response arrives → render as bot message
7. Append both user and bot messages to local state
8. Repeat from step 3

## Error Handling

- API failure: render inline system message in chat — "Something went wrong. Check your API key and model configuration."
- No indexed documents + KB toggle on: show inline info message — "No indexed documents found. Upload documents in the Documents tab first."
- AI not enabled (settings not saved): Test Chat button is disabled with tooltip "Save AI settings first"

## Styling Notes

- Reuse existing widget chat bubble styles where possible
- Panel background: `bg-surface-0` with `border-l border-edge`
- Messages follow existing chat component patterns (ChatWindow/ChatStream)
- Typing indicator: three animated dots (existing `TypingIndicator` component if available)
- Responsive: on mobile, panel takes full width as an overlay
