# Feature Brief: n8n Webhook Onboarding Flow

## Problem

A customer signs up, gets their API key, but has no idea how to connect their AI bot. The current flow requires:
1. Knowing what n8n is
2. Creating a workflow manually
3. Figuring out the webhook URL format
4. Configuring the response format to match HandsOff's inbound API
5. Setting up credentials (Anthropic/OpenAI) in n8n

Nobody will do this without hand-holding. This is the #1 blocker to self-serve adoption.

## Goal

A customer should go from "I just signed up" to "my AI bot is responding to visitors" in under 10 minutes, without reading docs.

## Proposed Flow

### Step 1: Tenant Settings → Webhook Setup Section

Add a dedicated "Bot Connection" section to the tenant config page (or a new `/setup` page). Two paths:

**Path A: "I have an n8n workflow"**
- Paste your n8n webhook URL
- We test it with a ping and show success/failure
- Copy the inbound webhook URL for the "Send to HandsOff" node
- Show the expected request/response format

**Path B: "I don't have one — set it up for me"**
- We provide a pre-built n8n workflow template (JSON export)
- One-click download or copy
- Step-by-step guide: "Import this in n8n → Add your AI API key → Activate"
- Or: we host a shared n8n instance and auto-provision a workflow per tenant (more complex, phase 2)

### Step 2: Connection Test

Once the webhook URL is saved:
- "Test Connection" button sends a test message to their webhook
- Shows the raw request/response for debugging
- Green checkmark when the round-trip works (message sent → AI response received in widget)

### Step 3: Widget Embed

After bot connection is verified:
- Show the embed snippet (already exists in widget test page)
- "Preview in browser" button → opens widget test page with their API key
- Copy-paste instructions for common platforms (HTML, React, WordPress)

## Data Model Changes

None required. The tenant already has `webhookUrl` and `webhookSecret` fields.

## API Changes

- `POST /api/v1/tenants/me/test-webhook` — sends a test message to the configured webhook URL and returns the result (already partially exists as webhook test endpoint)

## UI Changes

### Tenant Settings Page (or new Setup Wizard)
- New "Bot Connection" card/section
- Webhook URL input with test button (exists in IntegrationTab but needs polish)
- Connection status indicator (connected/disconnected/error)
- n8n template download button
- Inbound webhook URL display with copy button

### Widget Embed Section
- Embed snippet with copy button (exists in widget test page, needs to be in settings too)
- Platform-specific instructions (HTML, React)

## n8n Template

Pre-built workflow JSON that includes:
- Webhook trigger node (POST, path configurable)
- Respond Immediately node (returns `{"success": true}`)
- Extract Message code node
- HTTP Request to Claude/OpenAI API (customer adds their own key)
- Extract Response code node
- Send to HandsOff HTTP Request node (customer pastes their inbound URL)

The template we built locally during this session is the starting point — just needs the URLs parameterized.

## Open Questions

1. **Should we support non-n8n webhooks?** The inbound API is generic — any server that POSTs `{action: "message.send", sessionId, payload: {type, content}}` works. Should the UI reflect this?
2. **Hosted n8n per tenant?** Auto-provisioning workflows would be the ultimate UX but adds infrastructure complexity. Phase 2?
3. **Multiple bot providers?** Should we support connecting OpenAI, Anthropic, or custom APIs directly without n8n? That would bypass n8n entirely for simple use cases.

## Priority

High — this is the primary blocker to first customer acquisition. Without this, every customer needs manual onboarding support.

## Estimate

- Path A (paste URL + test): Small — mostly UI work, the backend already supports it
- Path B (template + guide): Medium — need to create/maintain the template, write the guide
- Setup wizard (guided multi-step): Medium-Large — new page, state management, better UX
