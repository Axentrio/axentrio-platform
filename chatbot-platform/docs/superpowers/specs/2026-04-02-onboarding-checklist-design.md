# Onboarding Checklist — Design Spec

## Goal

A persistent banner on the dashboard that guides new tenants through the 2 steps needed to get a working AI chatbot. Auto-detects completion. Disappears once both steps are done.

## Steps

| Step | Label | Description | Link | Complete when |
|------|-------|-------------|------|---------------|
| 1 | Set up AI | Configure your AI provider and API key | /ai | `tenant.settings.ai.enabled === true` AND `tenant.settings.ai.apiKey` is set |
| 2 | Go live | Embed the widget on your website | /settings/widget | At least 1 `ChatSession` exists with `source: 'widget'` for this tenant |

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

### Design tokens

Follow existing portal patterns:
- Card: `rounded-xl border border-edge bg-surface-3 p-6`
- Checkmark: `text-green-500`
- Empty circle: `border-2 border-edge rounded-full`
- Link: `text-primary-400 hover:text-primary-300`
- Header: `text-sm font-semibold text-primary`

## Backend

### New endpoint: `GET /api/v1/tenants/me/onboarding-status`

**Route:** Add to existing `tenants.ts` routes (Clerk auth + tenant context already applied).

**Response:**
```json
{
  "aiConfigured": true,
  "widgetUsed": false,
  "complete": false
}
```

**Logic:**
- `aiConfigured`: `!!tenant.settings?.ai?.enabled && !!tenant.settings?.ai?.apiKey`
- `widgetUsed`: `EXISTS (SELECT 1 FROM chat_sessions WHERE tenant_id = ? AND source = 'widget' LIMIT 1)` — use EXISTS for performance, not COUNT
- `complete`: both true

**Caching:** Once `widgetUsed` flips to true, it never goes back. Consider caching this flag on the tenant record (`settings.onboarding.widgetUsed`) after the first detection to avoid the query on subsequent loads. Update the flag opportunistically — check DB only if the cached flag is false.

### No new entities or migrations

All data already exists in `tenants.settings` and `chat_sessions`.

## Frontend

### New component: `portal/src/components/dashboard/OnboardingBanner.tsx`

- Fetches `GET /tenants/me/onboarding-status` via `useOnboardingStatus()` hook
- Renders the banner card with step states
- Returns `null` if `complete === true` or if query is loading
- Each incomplete step's "Set up" link uses `react-router-dom`'s `useNavigate`

### New query hook: add to `portal/src/queries/useTenantQueries.ts`

```
useOnboardingStatus() — GET /tenants/me/onboarding-status
  queryKey: [...queryKeys.tenants.me(), 'onboarding']
  staleTime: 30000 (don't refetch too aggressively)
```

### Integration point: `portal/src/pages/Analytics.tsx` (or equivalent dashboard page)

Add `<OnboardingBanner />` at the top of the page content, before the existing analytics cards.

## Edge Cases

- **Tenant with no AI configured and no sessions:** Shows both steps incomplete (0/2)
- **Tenant with AI configured but never embedded widget:** Shows 1/2, prompts to embed
- **Tenant who embedded widget before configuring AI:** Shows AI step incomplete — widget sessions may exist from before AI was set up. Both steps are independent.
- **Super admin viewing tenant:** Banner should use the current tenant context, not the admin's personal state
- **New tenant auto-provisioned:** Both steps incomplete on first login

## What this does NOT include

- No wizard/multi-step page
- No dismissal button (disappears when complete)
- No Cal.com setup step (discovered in Settings → Integrations)
- No knowledge base step (optional feature)
- No team invite step
- No email reminders
- No confetti animation on completion (tempting, but no)
