# Multi-Tenant Self-Service Design Spec

**Date:** 2026-04-03
**Status:** Draft
**Scope:** API endpoints + portal dashboard for tenant self-service configuration of skills, webhooks, tools, and onboarding

---

## 1. Overview

Enable tenants to configure their AI chatbot through the portal dashboard without developer intervention. Build API endpoints for skills, event webhooks, and onboarding status. Add two new portal pages (Skills, Event Webhooks) and an onboarding checklist banner on the dashboard.

**Goals:**
- Tenants self-configure: skills, event webhooks, AI settings toggle
- Smart defaults on signup: brand voice from org name, platform agent auto-enabled
- Onboarding checklist guides setup without blocking
- All config via existing `tenant.settings` JSONB (no new migrations)

**Non-goals:**
- Visual flow builder / drag-and-drop
- Custom tool CRUD via dashboard (Phase 2)
- Billing / usage dashboard
- Multi-tenant agency management (managing sub-tenants)

---

## 2. API Endpoints

All endpoints are tenant-scoped, require Clerk auth + admin role.

### 2.1 Onboarding Status

```
GET /api/v1/tenants/me/onboarding-status
```

Response:
```json
{
  "complete": false,
  "completedCount": 2,
  "totalCount": 5,
  "steps": {
    "aiEnabled": true,
    "brandVoiceConfigured": true,
    "knowledgeBaseHasDocs": false,
    "calcomConnected": false,
    "eventWebhooksConfigured": false
  }
}
```

Logic:
- `aiEnabled`: `tenant.settings.ai.enabled === true && tenant.settings.ai.usePlatformAgent === true`
- `brandVoiceConfigured`: `tenant.settings.ai.brandVoice.name` is set and not the default
- `knowledgeBaseHasDocs`: `COUNT(*) > 0 FROM knowledge_documents WHERE tenantId = ? AND status = 'indexed'`
- `calcomConnected`: `tenant.settings.integrations.calcom.apiKey` exists and is encrypted
- `eventWebhooksConfigured`: `tenant.settings.eventWebhooks` has at least one enabled entry

### 2.2 Skills CRUD

```
GET    /api/v1/tenants/me/skills           → list all skills
POST   /api/v1/tenants/me/skills           → create a skill
PUT    /api/v1/tenants/me/skills/:name     → update a skill
DELETE /api/v1/tenants/me/skills/:name     → delete a skill
```

Skill schema (validated on POST/PUT):
```json
{
  "name": "booking",
  "trigger": "User wants to schedule an appointment",
  "tools": ["check_availability", "create_booking", "list_bookings"],
  "instructions": "Check availability first. Collect name and email.",
  "maxSteps": 8,
  "enabled": true
}
```

Validation:
- `name`: required, 1-50 chars, alphanumeric + underscore, unique per tenant
- `trigger`: required, 1-500 chars
- `tools`: required, array of strings, each must be a registered tool name
- `instructions`: required, 1-2000 chars
- `maxSteps`: optional, 1-20, default 5
- `enabled`: optional, default true
- Max 20 skills per tenant

Storage: reads/writes `tenant.settings.skills[]` via `jsonb_set`.

### 2.3 Event Webhooks CRUD

```
GET    /api/v1/tenants/me/event-webhooks           → list all webhooks
POST   /api/v1/tenants/me/event-webhooks           → create a webhook
PUT    /api/v1/tenants/me/event-webhooks/:index     → update a webhook
DELETE /api/v1/tenants/me/event-webhooks/:index     → delete a webhook
POST   /api/v1/tenants/me/event-webhooks/test       → send test event
```

Webhook config schema:
```json
{
  "url": "https://hooks.zapier.com/hooks/catch/123/abc",
  "events": ["lead.created", "appointment.booked"],
  "secret": "auto-generated-on-create",
  "enabled": true,
  "label": "Zapier — CRM Sync"
}
```

Validation:
- `url`: required, valid HTTPS URL (HTTP allowed in development only)
- `events`: required, array of valid event types (`lead.created`, `appointment.booked`, `conversation.ended`)
- `label`: optional, 1-100 chars
- `enabled`: optional, default true
- `secret`: auto-generated on create (`crypto.randomBytes(32).toString('hex')`), returned once on creation, masked on subsequent reads
- Max 10 webhooks per tenant

Test endpoint: sends a sample event of each subscribed type to the URL. Returns success/failure per URL.

Storage: reads/writes `tenant.settings.eventWebhooks[]` via `jsonb_set`.

### 2.4 AI Settings Extension

Extend existing `PATCH /api/v1/tenants/me/ai-settings` to accept:
```json
{
  "usePlatformAgent": true
}
```

This field is already in the settings JSONB. The API endpoint just needs to pass it through (currently it may be filtered out).

---

## 3. Smart Defaults on Signup

When a tenant is auto-provisioned via Clerk (existing `autoProvision` middleware):

1. Set `settings.ai.enabled = true`
2. Set `settings.ai.usePlatformAgent = true`
3. Set `settings.ai.provider = 'openai'`
4. Set `settings.ai.model = 'gpt-4o-mini'`
5. Set `settings.ai.brandVoice.name` = Clerk org name (if available) + " Assistant"
6. Set `settings.ai.brandVoice.tone = 'friendly'`
7. Set `settings.ai.guardrails.greetingMessage` = `"Welcome! How can I help you today?"`
8. Set `settings.ai.guardrails.fallbackMessage` = `"Let me connect you with our team."`

This means the bot works immediately after signup — no configuration required. The greeting message fires, and the agent can answer basic questions using the system prompt.

**File to modify:** `api/src/middleware/clerk.middleware.ts` — the `autoProvision` function that creates new tenants.

---

## 4. Portal Dashboard — Onboarding Checklist

### 4.1 Component: `OnboardingChecklist`

Renders on the Dashboard page when `onboardingStatus.complete === false`.

- Fetches `GET /tenants/me/onboarding-status` via react-query
- Shows progress badge ("2 of 5")
- Lists 5 steps with completed/pending states
- Each pending step links to the relevant settings page:
  - AI enabled → `/knowledge` (AiSettingsTab)
  - Brand voice → `/knowledge` (AiSettingsTab)
  - KB docs → `/knowledge` (DocumentsTab)
  - Cal.com → `/settings/integrations`
  - Event webhooks → `/settings/webhooks` (new page)
- "Dismiss" button sets `tenant.settings.onboardingDismissed = true`
- Does not render when dismissed or all steps complete

### 4.2 Location

Added to `pages/Dashboard.tsx` above the existing stats cards. Uses the existing `OnboardingBanner` component pattern (already exists at `components/dashboard/OnboardingBanner.tsx` — extend or replace it).

---

## 5. Portal — Skills Settings Page

### 5.1 Route: `/settings/skills`

Added to `SettingsLayout.tsx` alongside existing settings pages.

### 5.2 Components

**SkillsList** — lists all skills with:
- Icon, name, status badge (Active/Disabled)
- Tools used (chip badges)
- Trigger + instructions preview (collapsed)
- Edit / Delete actions

**SkillForm** — modal or inline form for create/edit:
- Name (text input)
- Trigger (text area — "When should this skill activate?")
- Tools (multi-select from available tools — fetched from a new `GET /tenants/me/available-tools` endpoint)
- Instructions (text area — "Rules for the AI to follow")
- Max steps (slider, 1-20)
- Enabled (toggle)

**Auto-generated skills:** When Cal.com is connected, auto-create a booking skill if one doesn't exist. Show it as "Auto-configured" with edit option.

### 5.3 React Query Hooks

```typescript
// queries/useSkillsQueries.ts
useGetSkills()          → GET /tenants/me/skills
useCreateSkill()        → POST /tenants/me/skills
useUpdateSkill(name)    → PUT /tenants/me/skills/:name
useDeleteSkill(name)    → DELETE /tenants/me/skills/:name
```

---

## 6. Portal — Event Webhooks Settings Page

### 6.1 Route: `/settings/webhooks`

Added to `SettingsLayout.tsx`.

### 6.2 Components

**WebhooksList** — lists configured webhooks with:
- Label, URL (truncated), status badge
- Event type badges (color-coded: lead=blue, booking=amber, conversation=green)
- Edit / Delete / Test actions

**WebhookForm** — modal for create/edit:
- Label (optional text input)
- URL (text input, validated as HTTPS)
- Events (checkbox group: lead.created, appointment.booked, conversation.ended)
- Secret (shown once on creation, masked on edit with "Regenerate" button)
- Enabled (toggle)

**TestResult** — inline feedback after clicking "Send Test Event":
- Shows success/failure per webhook
- Displays HTTP status code and response time

### 6.3 React Query Hooks

```typescript
// queries/useWebhookQueries.ts
useGetEventWebhooks()        → GET /tenants/me/event-webhooks
useCreateEventWebhook()      → POST /tenants/me/event-webhooks
useUpdateEventWebhook(index) → PUT /tenants/me/event-webhooks/:index
useDeleteEventWebhook(index) → DELETE /tenants/me/event-webhooks/:index
useTestEventWebhook()        → POST /tenants/me/event-webhooks/test
```

---

## 7. Available Tools Endpoint

```
GET /api/v1/tenants/me/available-tools
```

Returns the list of tools available to this tenant (based on their integrations):

```json
{
  "tools": [
    { "name": "kb_search", "description": "Search knowledge base", "category": "always", "hasSideEffects": false },
    { "name": "capture_lead", "description": "Capture visitor contact info", "category": "always", "hasSideEffects": true },
    { "name": "escalate_to_agent", "description": "Transfer to human", "category": "always", "hasSideEffects": true },
    { "name": "check_availability", "description": "Check calendar slots", "category": "booking", "hasSideEffects": false },
    { "name": "create_booking", "description": "Create appointment", "category": "booking", "hasSideEffects": true },
    { "name": "list_bookings", "description": "List customer bookings", "category": "booking", "hasSideEffects": false },
    { "name": "reschedule_booking", "description": "Reschedule appointment", "category": "booking", "hasSideEffects": true },
    { "name": "cancel_booking", "description": "Cancel appointment", "category": "booking", "hasSideEffects": true }
  ]
}
```

Booking tools only appear when Cal.com is configured. Used by the Skills form to populate the tools multi-select.

---

## 8. Files to Create / Modify

### Backend (API)

| Action | File |
|--------|------|
| Create | `api/src/routes/skills.routes.ts` — Skills CRUD endpoints |
| Create | `api/src/routes/event-webhooks.routes.ts` — Webhook CRUD + test endpoints |
| Modify | `api/src/routes/tenants.ts` — Add onboarding-status + available-tools endpoints |
| Modify | `api/src/knowledge/ai-settings.routes.ts` — Accept `usePlatformAgent` field |
| Modify | `api/src/middleware/clerk.middleware.ts` — Smart defaults on auto-provision |
| Modify | `api/src/server.ts` — Mount new route files |

### Frontend (Portal)

| Action | File |
|--------|------|
| Create | `portal/src/pages/settings/SkillsSettings.tsx` — Skills page |
| Create | `portal/src/pages/settings/WebhooksSettings.tsx` — Webhooks page |
| Create | `portal/src/components/settings/SkillForm.tsx` — Skill create/edit form |
| Create | `portal/src/components/settings/WebhookForm.tsx` — Webhook create/edit form |
| Create | `portal/src/queries/useSkillsQueries.ts` — React Query hooks |
| Create | `portal/src/queries/useWebhookQueries.ts` — React Query hooks |
| Modify | `portal/src/pages/settings/SettingsLayout.tsx` — Add Skills + Webhooks nav |
| Modify | `portal/src/pages/Dashboard.tsx` — Add onboarding checklist |
| Modify | `portal/src/components/dashboard/OnboardingBanner.tsx` — Extend with checklist |

---

## 9. Validation & Security

- All endpoints require Clerk auth + admin role (existing middleware)
- Webhook URLs validated: HTTPS required in production, block private IPs (SSRF)
- Skill names validated: alphanumeric + underscore, no SQL injection
- Tool names validated against `ToolRegistry.getBuiltinToolNames()`
- Rate limit: 10 writes/minute per tenant on settings endpoints
- Webhook secrets never returned in full after creation (masked: `whsec_***...last4`)
