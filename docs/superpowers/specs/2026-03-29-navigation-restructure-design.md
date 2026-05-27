# Navigation & Information Architecture Restructure

**Date:** 2026-03-29
**Status:** Draft
**Goal:** Reduce sidebar from 9+ items to 5 intent-based groups, aligning with industry patterns (Intercom, Tidio, ManyChat) and eliminating disconnected workflows.

---

## Problem Statement

The current portal navigation is organized by feature (one page per feature), not by user intent. This creates:

1. **9 sidebar items** (12 for super admins) — exceeds the recommended maximum of 5 for primary navigation
2. **Disconnected workflows** — setting up a bot requires bouncing between Knowledge Base, Canned Responses, and Tenants pages
3. **Duplicate data views** — Dashboard and Analytics both show overlapping metrics (active chats, response time, CSAT)
4. **Inconsistent depth** — Team has 4 well-grouped tabs, but equivalent features like Knowledge Base + Canned Responses are separate top-level pages

## Design Principles

- **Group by user intent, not by feature** — "I want to handle conversations" not "I want to see the monitor"
- **Progressive disclosure** — start with the high-level view, drill into details via tabs/filters
- **Match industry patterns** — Intercom, Tidio, and ManyChat all use 3-5 top-level nav items
- **Preserve all functionality** — this is a restructure, not a feature cut

---

## Proposed Navigation Structure

### Sidebar (5 items + super admin section)

```
1. Inbox                 (replaces: Live Monitor, Queue, ChatTakeover)
2. AI & Content          (replaces: Knowledge Base, Canned Responses)
3. Analytics             (replaces: Dashboard, Analytics)
4. Team                  (unchanged)
5. Settings              (replaces: Settings, Tenants)

Super Admin
├── All Tenants
├── All Users
└── Platform Analytics
```

### Role Visibility

| Item | Agent | Supervisor | Admin | Super Admin |
|------|-------|------------|-------|-------------|
| Inbox | Yes | Yes | Yes | Yes |
| AI & Content | Yes (read) | Yes | Yes | Yes |
| Analytics | No | Yes | Yes | Yes |
| Team | No | Yes | Yes | Yes |
| Settings | Yes | Yes | Yes | Yes |
| Super Admin section | No | No | No | Yes |

---

## Section 1: Inbox

### What it replaces
- `/monitor` (Live Monitor)
- `/queue` (Queue)
- `/takeover/:chatId` (Chat Takeover — full page)

### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Inbox                                    [tenant filter] │
├──────────────────────┬──────────────────────────────────┤
│ Filter tabs:         │                                  │
│ All | Bot | Handoff  │    Chat panel                    │
│     | Agent          │    (currently ChatTakeover)      │
│                      │                                  │
│ ┌──────────────────┐ │    Renders when a chat is        │
│ │ Chat item        │ │    selected from the list.       │
│ │ name / tenant    │ │                                  │
│ │ status / time    │ │    Shows: message thread,        │
│ ├──────────────────┤ │    takeover/transfer/close       │
│ │ Chat item        │ │    actions, chat metadata.       │
│ │ ...              │ │                                  │
│ └──────────────────┘ │                                  │
│                      │                                  │
│ Sort: newest / wait  │                                  │
│ Priority filter      │                                  │
├──────────────────────┴──────────────────────────────────┤
│ [Notification sound plays on new handoffs — preserved]  │
└─────────────────────────────────────────────────────────┘
```

### Behavior

- **Route:** `/inbox` (single route, no sub-routes)
- **Filter tabs** replace the current Monitor/Queue page split:
  - **All** — every active chat across all statuses
  - **Bot** — chats currently handled by the bot (was in Live Monitor)
  - **Handoff** — pending handoff requests with accept/decline (was Queue page). Badge count on this tab shows `pendingCount`.
  - **Agent** — chats taken over by human agents (was in Live Monitor)
- **Chat panel (right side):** Replaces the full-page `/takeover/:chatId`. When a chat is selected, the right panel renders the `ChatWindow` component with all current takeover actions (takeover, transfer, close). On mobile (< 768px), the list takes full width; selecting a chat pushes a full-screen chat view with a back button to return to the list.
- **Tenant filter:** Dropdown in the header scopes the list to a specific tenant. Defaults to "All tenants".
- **Priority & sort controls:** Preserved from current Queue page — priority filter dropdown, sort by newest or longest wait time.
- **Socket connection:** The Inbox page wraps in `SocketProvider` (same as current Monitor/Queue/ChatTakeover).
- **Notification sound:** `useNotificationSound()` hook from Queue is preserved, triggers on new handoff items.

### Data sources (preserved, not rewritten)

| Current hook | Used in Inbox for |
|---|---|
| `useChatsQuery()` | All/Bot/Agent filter tabs |
| `useHandoffsQuery('pending')` | Handoff filter tab + badge count |
| `useAcceptHandoff()` | Accept button on handoff items |
| `useRejectHandoff()` | Decline button on handoff items |
| `useTenantSettings()` | Tenant-scoped filtering |
| Socket events (via ChatStream) | Real-time chat list updates |
| `agentOptions.list()` | Transfer modal agent list |

### What changes vs. what stays

| Aspect | Change |
|---|---|
| `ChatStream` component | Reused inside Inbox list, receives filter prop |
| `ChatWindow` component | Reused in right panel instead of full page |
| Handoff cards (from Queue) | Rendered in the Handoff tab with same accept/decline UI |
| Transfer modal | Reused as-is, triggered from chat panel |
| Chat preview modal (from Monitor) | Removed — replaced by the always-visible right panel |
| `/takeover/:chatId` route | Removed as a standalone route. Inbox panel handles it. Deep-link: `/inbox?chat={chatId}` |

### Migration notes

- The `/monitor`, `/queue`, and `/takeover/:chatId` routes should redirect to `/inbox` (with appropriate query params for chat selection) for any bookmarks or in-app links.
- The Dashboard's "Pending Handoffs" section links should point to `/inbox?filter=handoff`.
- The Dashboard's "Active Chats" section links should point to `/inbox`.

---

## Section 2: AI & Content

### What it replaces
- `/knowledge` (Knowledge Base page)
- `/canned-responses` (Canned Responses page)
- AI Settings slide-over panel (currently inside Knowledge Base)

### Layout

```
┌─────────────────────────────────────────────────────────┐
│ AI & Content                    [Tenant: X ▾] [Test AI] │
├─────────────────────────────────────────────────────────┤
│ Tabs: Knowledge Base | Canned Responses | AI Settings   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ [Active tab content renders here]                       │
│                                                         │
│ Knowledge Base tab:                                     │
│   - Stats strip (indexed/processing/failed)             │
│   - Document list with filters                          │
│   - Add document button                                 │
│                                                         │
│ Canned Responses tab:                                   │
│   - Search + category/scope filters                     │
│   - Response table                                      │
│   - Create/edit modal                                   │
│                                                         │
│ AI Settings tab:                                        │
│   - Provider, model, API key                            │
│   - Brand voice config                                  │
│   - Guardrails config                                   │
│   - Reset button (admin only)                           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Behavior

- **Route:** `/ai` with tab state via query param (`/ai?tab=knowledge`, `/ai?tab=canned`, `/ai?tab=settings`)
- **Tenant scoping:** The tenant context switcher (for super admins) or the current org tenant scopes all three tabs. A tenant selector dropdown is shown in the header for admins managing multiple tenants.
- **Knowledge Base tab:** Renders the existing `DocumentsTab` component and stats strip directly (not as a slide-over). All current document CRUD functionality preserved.
- **Canned Responses tab:** Renders the existing `CannedResponses` page content. All filtering, CRUD, and scope logic preserved.
- **AI Settings tab:** Promotes the current slide-over `AiSettingsTab` to a full tab. This makes AI configuration a first-class destination instead of a hidden panel. All fields preserved: provider, model, API key, brand voice (name, tone, custom instructions), guardrails (greeting, confidence threshold, max response length, escalation keywords, topics to avoid, fallback message, off-hours message).
- **Test AI button:** Opens the `TestChatPanel` as a right-side slide-over (preserved from current behavior). Available from any tab, not just AI Settings. Disabled when AI is not enabled.

### Role access

| Role | Knowledge Base | Canned Responses | AI Settings |
|---|---|---|---|
| Agent | Read documents | Read shared + own personal | No access |
| Supervisor | Read + upload documents | Read + manage shared | Read only |
| Admin | Full CRUD + reset | Full CRUD + shared scope | Full CRUD + reset |
| Super Admin | Full CRUD | Full CRUD | Full CRUD |

### Data sources (preserved)

| Current hook | Used in AI & Content for |
|---|---|
| `useKnowledgeStats()` | Knowledge Base tab stats strip |
| `useKnowledgeDocuments()` | Knowledge Base tab document list |
| `useCreateDocument()`, `useUpdateDocument()`, `useDeleteDocument()` | Knowledge Base tab CRUD |
| `useGetAiSettings()`, `useUpdateAiSettings()` | AI Settings tab |
| `useTestAiSettings()` | Test AI panel |
| `useCannedResponses()` | Canned Responses tab |
| `useCreateCannedResponse()`, `useUpdateCannedResponse()`, `useDeleteCannedResponse()` | Canned Responses tab CRUD |

### Migration notes

- `/knowledge` redirects to `/ai?tab=knowledge`
- `/canned-responses` redirects to `/ai?tab=canned`

---

## Section 3: Analytics (merged with Dashboard)

### What it replaces
- `/` (Dashboard)
- `/analytics` (Analytics)

### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Analytics                         [24h | 7d | 30d | 90d]│
├─────────────────────────────────────────────────────────┤
│ Metric cards row:                                       │
│ [Active Chats] [Pending Handoffs] [Online Agents]       │
│ [Avg Response Time] [CSAT Score] [Bot Resolution]       │
├─────────────────────────────────────────────────────────┤
│ Tabs: Overview | Agents                                 │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Overview tab:                                           │
│   - Chat Volume area chart (bot/human/handoff)          │
│   - Response Time line chart (actual vs target)         │
│   - Resolution Distribution donut                       │
│   - CSAT Distribution bar chart                         │
│                                                         │
│ Agents tab:                                             │
│   - Agent performance table                             │
│   - (name, chats handled, avg response time, CSAT)      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Behavior

- **Route:** `/analytics` (replaces both `/` and `/analytics`)
- **Default landing page:** `/analytics` becomes the default route after login. The root `/` redirects to `/analytics`.
- **Metric cards row:** Combines the best of both current pages:
  - From Dashboard: Active Chats, Pending Handoffs (clickable → navigates to `/inbox?filter=handoff`), Online Agents
  - From Analytics: Avg Response Time, CSAT Score, Bot Resolution Rate
  - All cards are real-time via `useDashboardMetrics()` and socket updates
- **Overview tab:** Current Analytics charts (chat volume, response time, resolution, CSAT). Date range selector scopes all charts.
- **Agents tab:** Current Analytics agent performance table.
- **Pending Handoffs preview removed:** The Dashboard's "Pending Handoffs" card list is removed — this data now lives in the Inbox. The metric card shows the count and links to Inbox.
- **Active Chats preview removed:** Same rationale — lives in Inbox now. Metric card links to Inbox.

### Role access

| Role | Access |
|---|---|
| Agent | Metric cards only (top row). No charts or agent table. |
| Supervisor | Full access |
| Admin | Full access |
| Super Admin | Full access |

The current Dashboard is visible to all roles. To preserve agents having a landing page with key metrics, agents see a simplified Analytics view with just the metric cards row and a prominent link to Inbox.

**Default landing page by role:**
- Agent → `/inbox` (conversations are their primary workflow)
- Supervisor/Admin/Super Admin → `/analytics` (overview first, then drill into Inbox)

### Data sources (merged)

| Current hook | Source page | Used for |
|---|---|---|
| `useDashboardMetrics()` | Dashboard | Metric cards (real-time) |
| `useHandoffsQuery('pending')` | Dashboard | Pending handoff count card |
| `useAnalyticsTimeseries()` | Analytics | Overview tab charts |
| `useAnalyticsChatMetrics()` | Analytics | Overview tab metrics |
| `useAnalyticsAgents()` | Analytics | Agents tab table |

### Migration notes

- `/` redirects to `/analytics`
- Dashboard page (`Dashboard.tsx`) is retired
- Current Analytics page content is preserved and enhanced with Dashboard metric cards

---

## Section 4: Team (unchanged)

- **Route:** `/team`
- **Tabs:** Members, Agents, Shifts, Performance — all preserved as-is
- **Access:** Supervisor, Admin, Super Admin
- No changes needed. This section is already well-structured.

---

## Section 5: Settings (absorbs Tenants)

### What it replaces
- `/settings/*` (current settings sub-routes)
- `/tenants` (Tenant/white-label config)

### Layout

```
┌───────────────────┬─────────────────────────────────────┐
│ Settings          │                                     │
│                   │ [Active section content]             │
│ Account           │                                     │
│   Profile         │                                     │
│   Notifications   │                                     │
│   Appearance      │                                     │
│                   │                                     │
│ Workspace         │                                     │
│   Widget & Brand  │  (new — from Tenants page)          │
│   Integrations    │  (webhooks, API key — from Tenants) │
│                   │                                     │
└───────────────────┴─────────────────────────────────────┘
```

### Behavior

- **Routes:**
  - `/settings/profile` — unchanged
  - `/settings/notifications` — unchanged
  - `/settings/appearance` — unchanged
  - `/settings/widget` — new, absorbs Tenants page branding config (logo, brand color, name)
  - `/settings/integrations` — expanded to include webhook URL and API key management from Tenants page, plus existing integration content
- **Tenant scoping:** For super admins, the tenant context switcher scopes the Workspace group to the selected tenant.

### What moves from Tenants page

| Tenants page feature | New location |
|---|---|
| Logo/avatar upload | Settings > Widget & Brand |
| Brand color picker | Settings > Widget & Brand |
| Tenant name display | Settings > Widget & Brand |
| Webhook URL config | Settings > Integrations |
| API key display/copy/regenerate | Settings > Integrations |
| Session stats (current/max) | Settings > Widget & Brand (info display) |

### Role access

| Section | Agent | Supervisor | Admin | Super Admin |
|---|---|---|---|---|
| Profile | Yes | Yes | Yes | Yes |
| Notifications | Yes | Yes | Yes | Yes |
| Appearance | Yes | Yes | Yes | Yes |
| Widget & Brand | No | No | Yes | Yes |
| Integrations | No | No | Yes | Yes |

### Data sources (preserved)

| Current hook | Used for |
|---|---|
| `useTenantSettings()` | Widget & Brand, Integrations |
| `useUpdateTenant()` | Widget & Brand form save |
| `useRotateApiKey()` | Integrations API key regenerate |
| Existing settings hooks | Profile, Notifications, Appearance — unchanged |

### Migration notes

- `/tenants` redirects to `/settings/widget`

---

## Sidebar Component Changes

### Updated menu items

```typescript
const menuItems: MenuItem[] = [
  { path: '/inbox', label: 'Inbox', icon: MessageSquare, roles: ['super_admin', 'admin', 'supervisor', 'agent'], badge: pendingHandoffs },
  { path: '/ai', label: 'AI & Content', icon: BookOpen, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/analytics', label: 'Analytics', icon: BarChart3, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/team', label: 'Team', icon: Users, roles: ['super_admin', 'admin', 'supervisor'] },
  { path: '/settings', label: 'Settings', icon: Settings, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
];
```

### Changes summary
- `LayoutDashboard` (Dashboard) — removed, merged into Analytics
- `MessageSquare` (Live Monitor) — repurposed for Inbox
- `Headphones` (Queue) — removed, merged into Inbox. Badge moves to Inbox item.
- `BookOpen` (Knowledge Base) — repurposed for AI & Content
- `Zap` (Canned Responses) — removed, merged into AI & Content
- `Building2` (Tenants) — removed, merged into Settings
- Super Admin section — unchanged

---

## Route Redirects

All old routes must redirect to their new locations for bookmark and in-app link compatibility:

| Old route | Redirects to |
|---|---|
| `/` | `/analytics` |
| `/monitor` | `/inbox` |
| `/queue` | `/inbox?filter=handoff` |
| `/takeover/:chatId` | `/inbox?chat=:chatId` |
| `/knowledge` | `/ai?tab=knowledge` |
| `/canned-responses` | `/ai?tab=canned` |
| `/tenants` | `/settings/widget` |

---

## What is NOT changing

- **Super Admin section** — All Tenants, All Users, Platform Analytics stay as-is
- **Team page** — 4 tabs, well-structured, no changes
- **Auth flow** — Clerk authentication, protected routes, role guards
- **API layer** — no backend changes, all existing hooks/queries preserved
- **Socket/real-time** — same SocketProvider, same events
- **ChatWindow component** — reused in Inbox panel instead of full page
- **All CRUD operations** — documents, canned responses, settings, tenant config

---

## Implementation Considerations

### Phasing

This can be implemented incrementally:

1. **Phase 1: Inbox** — highest impact, merges 3 pages into 1. Build the split-pane layout, move filter/list logic, add redirects.
2. **Phase 2: AI & Content** — merges 2 pages + promotes AI Settings. Mostly tab wrapper + moving existing components.
3. **Phase 3: Analytics merge** — combine Dashboard metrics with Analytics charts. Retire Dashboard page.
4. **Phase 4: Settings expansion** — move Tenants config into Settings. Add Widget & Brand sub-route.
5. **Phase 5: Sidebar update + redirects** — update sidebar items, add route redirects, remove old pages.

### Component reuse

The key principle: existing page components (`ChatStream`, `ChatWindow`, `DocumentsTab`, `AiSettingsTab`, `CannedResponses` content, `TenantModal` content) are reused inside new wrapper layouts. This is primarily a layout/routing restructure, not a rewrite of business logic.

### Testing considerations

- Verify all old routes redirect correctly
- Verify role-based access on each new section and tab
- Verify socket connections work in Inbox (single SocketProvider for the page)
- Verify tenant scoping works across AI & Content tabs
- Verify handoff notification sound in Inbox Handoff tab
- Verify deep-links work: `/inbox?chat={id}`, `/ai?tab=settings`, etc.
