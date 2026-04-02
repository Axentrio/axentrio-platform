# Onboarding Checklist — Design Spec

## Goal

A persistent banner on the dashboard that guides new tenants through the 2 steps needed to get a working AI chatbot. Auto-detects completion. Disappears once both steps are done.

## Steps

| Step | Label | Description | Link | Complete when |
|------|-------|-------------|------|---------------|
| 1 | Set up AI | Configure your AI provider and API key | /ai | `tenant.settings.ai.enabled === true` AND `tenant.settings.ai.apiKey` is set (returned as `hasApiKey` in API) |
| 2 | Go live | Embed the chat widget on your website | /settings/widget | At least 1 `ChatSession` exists with `source: 'widget'` for this tenant |

## UI

### Banner layout

Rendered at the top of the Analytics page (the landing page after login), above existing content.

```
┌──────────────────────────────────────────────────────┐
│  Get started with HandsOff              1/2 complete │
│                                                      │
│  ✅  Set up AI                                       │
│  ○   Go live — Embed the chat widget    Set up →     │
└──────────────────────────────────────────────────────┘
```

- Completed steps: green checkmark, muted text, no link
- Incomplete steps: empty circle, description text, "Set up" link navigates to the relevant page
- Progress: "0/2 complete", "1/2 complete"
- When both complete: component returns `null` (not rendered)

### Widget & Brand page — Embed snippet card

The Widget & Brand page (`/settings/widget`) currently has logo, display name, brand color, and preview — but no embed instructions. Add a new card at the bottom:

```
┌──────────────────────────────────────────────────────┐
│  Embed Widget                                        │
│  Add this snippet to your website's HTML             │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ <script src="https://chatbot-api-production-   │  │
│  │   37df.up.railway.app/widget.js"               │  │
│  │   data-api-key="a58e7f73..."></script>          │  │
│  └────────────────────────────────────────────────┘  │
│                                        [Copy] button │
└──────────────────────────────────────────────────────┘
```

- Pre-fills the tenant's actual API key
- Copy button copies the full snippet to clipboard
- Toast: "Copied to clipboard"

### Design tokens

Follow existing portal patterns:
- Card: `rounded-xl border border-edge bg-surface-3 p-6`
- Checkmark: `text-green-500`
- Empty circle: `border-2 border-edge rounded-full`
- Link: `text-primary-400 hover:text-primary-300`
- Header: `text-sm font-semibold text-primary`
- Code block: `bg-black/20 rounded-lg p-3 font-mono text-xs`

## Backend

### Modify existing endpoint: `GET /api/v1/tenants/me`

Add an `onboarding` field to the response:

```json
{
  "id": "...",
  "name": "...",
  "settings": { ... },
  "onboarding": {
    "widgetUsed": true
  }
}
```

**Logic for `widgetUsed`:**
```sql
EXISTS (SELECT 1 FROM chat_sessions WHERE tenant_id = $1 AND source = 'widget' LIMIT 1)
```

This is fast (indexed on `tenant_id`) and runs once per page load. No caching needed.

**`aiConfigured` is NOT returned from the backend** — the frontend derives it from existing `settings.ai.enabled` and `settings.ai.hasApiKey` fields already in the response.

### No new endpoints, entities, or migrations

All data already exists. Only change is adding the `onboarding` object to the existing `GET /tenants/me` response.

## Frontend

### New component: `portal/src/components/dashboard/OnboardingBanner.tsx`

- Uses existing `useTenantSettings()` hook (already fetched on every page)
- Derives `aiConfigured` from `tenant.settings.ai.enabled && tenant.settings.ai.hasApiKey`
- Reads `widgetUsed` from `tenant.onboarding.widgetUsed`
- Returns `null` if both are true
- Each incomplete step's "Set up" link uses `react-router-dom`'s `Link`

### Embed snippet card: add to `portal/src/pages/settings/WidgetBrandSettings.tsx`

- New card section at the bottom of the page
- Reads API key from tenant data (already available via `useTenantSettings`)
- Copy button uses `navigator.clipboard.writeText()` + toast

### Integration point

Add `<OnboardingBanner />` at the top of the Analytics page content, before the existing stats cards.

## Edge Cases

- **Tenant with no AI and no sessions:** Shows 0/2 — both steps incomplete
- **Tenant with AI but no widget sessions:** Shows 1/2 — prompts to embed
- **Tenant who embedded before configuring AI:** Shows 1/2 — AI step incomplete. Both steps are independent.
- **Super admin viewing tenant:** Banner uses the current tenant context from `useTenantSettings()`
- **Widget URL:** Hardcode the production widget.js URL. In the future this could come from an env var or tenant config.

## What this does NOT include

- No wizard/multi-step page
- No dismissal button (disappears when complete)
- No Cal.com setup step (discovered in Settings → Integrations)
- No knowledge base step
- No team invite step
- No email reminders
- No new API endpoint (uses existing GET /tenants/me)
