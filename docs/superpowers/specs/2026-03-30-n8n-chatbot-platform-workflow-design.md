# n8n Chatbot Platform Integration Workflow — Design Spec

**Date:** 2026-03-30
**Status:** Approved

## Overview

A new n8n workflow that acts as the AI backend for the chatbot platform. It receives visitor messages via webhook from the platform's outbound service, processes them through an OpenAI agent with conversation memory, and sends the response back to the platform's inbound webhook endpoint.

This workflow is independent from the existing "AI agent for Facebook Messenger with booking cal.com" workflow and uses a separate webhook path.

## Architecture

```
Visitor → Chatbot Platform → [POST /webhook/chatbot-platform] → n8n Workflow
                                                                      ↓
                                                                Extract message + tenant config
                                                                      ↓
                                                                Send typing.start → Platform
                                                                      ↓
                                                                AI Agent (GPT-4o + Window Buffer Memory)
                                                                      ↓
                                                                Detect escalation signals
                                                                      ↓
                                                        ┌─────────────┴─────────────┐
                                                   [escalation]              [normal response]
                                                        ↓                           ↓
                                                Send handsoff.trigger     Send message.send
                                                        ↓                           ↓
                                                        └─────────────┬─────────────┘
                                                                      ↓
                                                                Send typing.stop → Platform
                                                                      ↓
                                                                Chatbot Platform → Visitor
```

## Node Breakdown

### 1. Webhook Trigger (POST)

- **Path:** `/webhook/chatbot-platform`
- **Method:** POST
- **Response mode:** "Respond to Webhook" node (async pattern)
- Receives the outbound message from the chatbot platform

### 2. Acknowledge (Respond to Webhook)

- Immediately returns `200 { "status": "received" }`
- Prevents the platform's circuit breaker from timing out while AI processes

### 3. Extract Message (Code)

Parses the incoming payload:

```json
{
  "event": "message.received",
  "tenantId": "uuid",
  "sessionId": "uuid",
  "timestamp": "ISO-8601",
  "payload": {
    "type": "text|image|file",
    "content": "user message",
    "metadata": {}
  },
  "user": { ... },
  "context": { "previousMessages": [...] }
}
```

Extracts:
- `sessionId` — used as memory key
- `tenantId` — passed through to responses
- `payload.content` — the user's message
- `payload.type` — to detect media messages
- `tenantConfig` (optional) — brand voice override if provided

For non-text payload types, converts to a text description for the AI (e.g., "User sent an image").

### 4. Send Typing Start (HTTP Request)

- POSTs to platform inbound endpoint:
  ```json
  { "action": "typing.start", "sessionId": "...", "tenantId": "..." }
  ```
- URL configurable: defaults to `http://localhost:4081/api/v1/n8n/webhook/inbound`
- Errors are caught and logged but don't block the flow

### 5. AI Agent

- **Model:** GPT-4o via OpenAI Chat Model node
- **Memory:** Window Buffer Memory, keyed by `sessionId`, context window of 20 messages
- **System prompt:** Structured with sections (see below)
- **Max iterations:** 10

### 6. Detect Escalation (Code)

Checks AI output for escalation signals:
- `[HANDOFF:reason]` tag pattern
- Keywords: "transfer to agent", "human agent", "connect you to"

Returns `{ escalate: true/false, reason: string, cleanedOutput: string }`.
If escalation detected, strips the `[HANDOFF:...]` tag from the user-facing message.

### 7. Escalation Branch (If)

Routes based on `escalate` boolean:
- **True:** Send `handsoff.trigger` action, then send the cleaned message
- **False:** Send `message.send` action with the AI response

### 8. Build Response (Code)

Formats the AI output into the platform's inbound schema:

```json
{
  "action": "message.send",
  "sessionId": "uuid",
  "tenantId": "uuid",
  "payload": {
    "type": "text",
    "content": "AI response here"
  }
}
```

### 9. Send to Platform (HTTP Request)

- POSTs to: `{PLATFORM_BASE_URL}/api/v1/n8n/webhook/inbound`
- Content-Type: application/json
- URL is configurable for local vs production

### 10. Send Typing Stop (HTTP Request)

- POSTs `{ "action": "typing.stop", "sessionId": "...", "tenantId": "..." }` after the response is sent

### 11. Send Handoff (HTTP Request) — escalation path only

- POSTs:
  ```json
  {
    "action": "handsoff.trigger",
    "sessionId": "uuid",
    "tenantId": "uuid",
    "payload": { "reason": "extracted reason" }
  }
  ```

## System Prompt

```
You are a helpful customer support assistant.

## TENANT CONTEXT
{tenantContext — injected from tenantConfig if provided, otherwise generic}

## ESCALATION RULES
If any of these are true, prefix your response with [HANDOFF:reason]:
- The customer explicitly asks for a human agent
- You cannot answer their question with confidence
- The customer is frustrated and needs personal attention
- The topic involves billing, refunds, or account security

Still provide a helpful message after the tag — the customer will see it while waiting.

## MEDIA HANDLING
If the user sends a file or image, acknowledge it naturally.
You cannot view images or files directly — let the customer know if they need
to describe what they sent.

## RULES
- Be concise and helpful (2-4 sentences)
- Match the customer's language
- Don't make up information you're not sure about
- Be warm and professional
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| Webhook path | `/webhook/chatbot-platform` | Incoming webhook from platform |
| Platform callback URL | `http://localhost:4081/api/v1/n8n/webhook/inbound` | Where to send responses |
| OpenAI model | `gpt-4o` | AI model for the agent |
| Memory window | 20 messages | Conversation history depth |
| Escalation keywords | see system prompt | Triggers handoff |

## Platform Inbound Actions Used

| Action | When | Payload |
|--------|------|---------|
| `typing.start` | Before AI processes | `{ sessionId, tenantId }` |
| `typing.stop` | After response sent | `{ sessionId, tenantId }` |
| `message.send` | Normal AI response | `{ sessionId, tenantId, payload: { type, content } }` |
| `handsoff.trigger` | Escalation detected | `{ sessionId, tenantId, payload: { reason } }` |

## Future Enhancements (not in this workflow)

- **Per-tenant system prompts:** Platform sends `tenantConfig.systemPrompt` in outbound payload; workflow uses it if present
- **Quick replies:** AI returns structured quick reply options in the response payload
- **File requests:** AI can trigger `file.request` action when it needs the user to upload something
- **Multi-model support:** Route to different LLMs based on tenant config

## Testing Plan

1. Import workflow into n8n
2. Set platform callback URL to local dev server
3. Send a test webhook payload via curl or n8n's test mode
4. Verify: platform receives `typing.start` → `message.send` → `typing.stop`
5. Verify: conversation memory works across multiple messages in same session
6. Verify: escalation keywords trigger `handsoff.trigger` instead of just `message.send`
