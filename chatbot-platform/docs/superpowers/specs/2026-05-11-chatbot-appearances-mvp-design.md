# Chatbot Appearances MVP — Design

**Date:** 2026-05-11
**Owner:** Ian Neo
**Status:** Spec approved, ready for implementation plan
**Predecessor:** AI Bot Knowledge Base MVP (shipped 2026-05-11)
**Successor:** writing-plans → implementation

---

## 1. Goal

Turn the placeholder `Chatbot Appearances` tab under `/ai` into a working settings page that controls how the embedded customer-facing widget looks and behaves at first contact. Ship as MVP — five fields, a live preview, and matching runtime support in the existing embed widget.

## 2. Scope

### In scope

| Capability | Surface |
|---|---|
| Primary color | Migrated into Appearances tab |
| Bot avatar (optional override) | New field, falls back to company logo |
| Launcher position (bottom-right / bottom-left) | New field |
| Launcher label (optional pill text) | New field |
| Welcome message (first-message-only) | New field |
| Live React preview pane | New component, updates from unsaved form state |
| Authenticated PATCH/GET API | New endpoint, mirrors AI Settings pattern |
| Public `/widget/config` extension | Adds `appearance` namespace |
| Embed widget runtime support | Five additive edits to `api/public/widget.js` |

### Out of scope (deferred)

- Pre-open attention bubble (separate product question — frequency, dismiss behavior, analytics)
- Top-corner launcher positions
- Tooltip-only launcher labels
- `WidgetTest.tsx` modifications — reused as-is via "Open full widget test" link
- Removal of old `WidgetBrandSettings` page — kept for tenant identity (name, logo, API key, install snippet)
- Multi-tenant feature flagging on `widget.js` — new fields are strictly additive and fall back to today's behavior when absent
- Automated tests for `widget.js` itself — no test infrastructure exists for it today

## 3. Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| Tab overlap with `WidgetBrandSettings` | **Consolidate.** Appearances owns customer-facing widget visuals. `WidgetBrandSettings` retains tenant identity (name, company logo, API key, install snippet). | One editable home per field; avoid duplicate UX. |
| Bot avatar field model | **One uploader with optional override.** `settings.widget.avatarUrl` falls back to `settings.theme.logoUrl` then bot SVG. | Single uploader in UI; advanced override available. |
| Welcome message behavior | **First message only.** Seeded into the open panel when no prior history exists. No pre-open bubble. | MVP signal-to-noise; bubble is a separate engagement product. |
| Launcher position values | **`bottom-right` (default) and `bottom-left`.** No top corners. No offset. | Covers ~99% of deployments; minimal `widget.js` layout logic. |
| Launcher label behavior | **Optional pill text.** Empty → today's icon-only circle. Set → rounded pill with icon + text. | Modern chatbot pattern; doesn't compete with deferred attention-bubble work. |
| Preview pane | **Static React mock.** Updates from unsaved form state; no widget.js coupling. "Open full widget test" link for production-fidelity validation. | Instant visual feedback matters more here than byte-perfect rendering. |
| API endpoint shape | **One authenticated cross-namespace PATCH/GET.** Writes both `theme.primaryColor` and `widget.*` atomically. | Single save click → single network call. No partial-failure footgun. |
| Widget.js scope | **Bundled in this MVP, additive only.** | "Preview works but production doesn't" would feel broken. |
| Schema namespace | **New `settings.widget` namespace + reuse `settings.theme.primaryColor`.** | `theme` stays visual primitives; `widget` is runtime behavior. |
| Permission gate | **Match AI settings exactly** (`requireRole('admin')` or whatever `ai-settings.routes.ts` uses — confirm at implementation). | Don't accidentally broaden permission model. |

## 4. Data model

### Existing — `Tenant.settings.theme` (unchanged)

Location: `chatbot-platform/api/src/database/entities/Tenant.ts:61-131`

```ts
theme?: {
  primaryColor?: string;   // primary source of truth for widget color
  logoUrl?: string;        // company logo, fallback for bot avatar
  customCss?: string;      // not used by this MVP
}
```

### New — `Tenant.settings.widget`

Add to the same JSONB `settings` column:

```ts
widget?: {
  avatarUrl?: string | null;
  launcherPosition?: 'bottom-right' | 'bottom-left';
  launcherLabel?: string | null;
  welcomeMessage?: string | null;
}
```

**Migration:** none. `settings` is already a JSONB column. The TypeScript type gains an optional `widget` key. Existing tenants read as `widget: undefined`; all fallback logic handles absent values.

**DB stays sparse:** defaults are applied at read time (server-side in `/widget/config` and portal hydration), not written speculatively. The Zod schema (Section 5.1) uses `preprocess` to coerce empty strings to `null` **before** field validation runs — otherwise `avatarUrl: ""` would fail URL validation before normalization could rescue it. After preprocess, reads can use truthy fallbacks safely:

```ts
appearance.avatarUrl      = widget.avatarUrl   || theme.logoUrl || null;
appearance.launcherLabel  = widget.launcherLabel  || null;
appearance.welcomeMessage = widget.welcomeMessage || null;
```

## 5. API

### 5.1 `PATCH /api/v1/widget/appearance` — new, authenticated

- **Auth:** Clerk session middleware + admin role check matching `chatbot-platform/api/src/knowledge/ai-settings.routes.ts` (verify exact middleware chain at implementation; do not broaden).
- **New files:**
  - `chatbot-platform/api/src/widget/widget-appearance.routes.ts`
  - `chatbot-platform/api/src/widget/widget-appearance.controller.ts`
  - `chatbot-platform/api/src/schemas/widget-appearance.schema.ts`
- **Modified files:**
  - Route registration site (likely `chatbot-platform/api/src/server.ts` or `chatbot-platform/api/src/app.ts`, wherever existing routes such as `ai-settings.routes.ts` are mounted) — verify exact file at implementation, register the new routes module under `/api/v1/widget/appearance`.

**Request body** (all fields optional; only provided keys are written):
```ts
{
  primaryColor?: string;
  avatarUrl?: string | null;
  launcherPosition?: 'bottom-right' | 'bottom-left';
  launcherLabel?: string | null;
  welcomeMessage?: string | null;
}
```

**Zod validation** (empty-string normalization runs via `preprocess` so it happens **before** field validation — critical for `avatarUrl: ""` which would otherwise fail URL validation):
- `primaryColor`: optional, `/^#[0-9a-fA-F]{6}$/`
- `avatarUrl`: optional, `z.preprocess(v => v === '' ? null : v, …)` → nullable URL, max 2KB when non-null
- `launcherPosition`: optional, enum
- `launcherLabel`: optional, `z.preprocess(v => v === '' ? null : v, …)` → nullable string, max length 30
- `welcomeMessage`: optional, `z.preprocess(v => v === '' ? null : v, …)` → nullable string, max length 280

**Controller logic** (mirrors `chatbot-platform/api/src/knowledge/knowledge.controller.ts:187-225`):
1. Resolve tenant from auth context.
2. Validate body with Zod (preprocess has already normalized empty strings to `null` by the time field validators run).
3. Read tenant, deep-merge:
   - `primaryColor` → `tenant.settings.theme.primaryColor` (only if key present in body)
   - other four → `tenant.settings.widget.*` (only if keys present)
4. `tenantRepo.save(tenant)`.
5. Respond with the saved subset (Section 5.2 shape).

**Errors:** 400 on Zod, 401/403 from Clerk, 500 on DB write. Single save — no partial writes.

### 5.2 `GET /api/v1/widget/appearance` — new, authenticated

Same auth as PATCH. Returns the currently-saved appearance subset (used for portal hydration):

```ts
{
  primaryColor: string | null,
  avatarUrl: string | null,                            // raw widget.avatarUrl, NOT fallback-resolved
  launcherPosition: 'bottom-right' | 'bottom-left',    // defaulted on read
  launcherLabel: string | null,
  welcomeMessage: string | null,
}
```

Note: the GET does **not** apply avatar fallback (returns the raw `widget.avatarUrl` so the form can show "use company logo" state distinctly from "uploaded custom avatar"). The public `/widget/config` GET (Section 5.3) does apply the fallback.

### 5.3 `GET /api/v1/widget/config?apiKey=...` — extended, public

File touched: `chatbot-platform/api/src/routes/widget.ts:81-121`.

**Additive extension** (existing fields unchanged):
```ts
{
  tenantId, name,
  theme: { primaryColor, backgroundColor, textColor },   // unchanged
  features: { ... },                                      // unchanged
  businessHours: { ... },                                 // unchanged

  // NEW
  appearance: {
    avatarUrl: string | null,                             // server resolves: widget.avatarUrl || theme.logoUrl || null
    launcherPosition: 'bottom-right' | 'bottom-left',     // server defaults to 'bottom-right'
    launcherLabel: string | null,
    welcomeMessage: string | null,
  }
}
```

Server-side default resolution lives next to the existing `theme` / `features` derivations.

## 6. Portal UI

### 6.1 Files touched

| Action | File |
|---|---|
| Replace placeholder | `chatbot-platform/portal/src/pages/AiContent.tsx:147-153` |
| New form + preview wrapper | `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesForm.tsx` |
| New preview component | `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesPreview.tsx` |
| New query hooks | `chatbot-platform/portal/src/queries/useWidgetAppearance.ts` |
| Remove color picker, add banner | `chatbot-platform/portal/src/pages/settings/WidgetBrandSettings.tsx` |
| Extract minimal upload helper | from `WidgetBrandSettings`, only if obviously reusable — no broad upload abstraction |

### 6.2 Layout

Two-column inside the tab:

- **Left (~55%) — form:**
  - Primary color (color picker + hex input)
  - Bot avatar (single uploader, helper text "Defaults to your company logo when no custom avatar is set.", "Remove custom avatar" action only when an override exists)
  - Launcher position (segmented radio: Bottom right / Bottom left)
  - Launcher label (text input, max 30, helper text)
  - Welcome message (textarea, max 280, placeholder `Hi! How can I help you today?`)
  - Save button (disabled when clean)
- **Right (~45%) — preview:**
  - Closed launcher (renders at chosen corner, pill or icon-only based on label)
  - Open chat panel (header avatar, brand name, welcome bubble if non-empty, input)
  - "Open full widget test" link → `/widget-test?apiKey={tenant.apiKey}` in new tab

### 6.3 Form behavior (mirrors AI Bot MVP)

- Hydrate from `GET /api/v1/widget/appearance`.
- Welcome message field shows `Hi! How can I help you today?` as input placeholder (not the value) — persisted only when the user types and saves.
- Dirty tracking via shallow comparison.
- Unsaved-change confirmation dialog on tab navigation, matching the pattern shipped in `ecdfca1`.
- On save success: invalidate tenant + widget-config react-query caches.

### 6.4 Preview component

- Pure React; no widget.js coupling.
- Takes unsaved form state as props.
- Avatar resolution mirrors server-side logic: `formState.avatarUrl || tenant.settings.theme?.logoUrl || null`. Null renders the same generic bot SVG used by the real widget.
- Welcome message renders as the first chat bubble; empty input → no bubble (matches real widget behavior).
- Inline-styled with the same color/position values the form holds — no `widget.js` import.

### 6.5 `WidgetBrandSettings` post-MVP

Keeps:
- Tenant name
- Company logo (`settings.theme.logoUrl`) — still editable here
- API key + install snippet
- Cross-link banner: "Widget appearance is now configured under AI & Content → Chatbot Appearances"

Removes from the visible UI:
- Primary color picker (moved to Appearances)

Does **not** remove or redirect the route — bookmarks and existing nav stay valid.

## 7. Widget runtime (`api/public/widget.js`)

Five surgical edits, each additive and feature-gated on the new fields being present. Promise: **behavior and visual fallback are identical when `appearance` is absent or empty.** No claim of byte-identical DOM (the new code paths introduce minor structural additions even when fields are null).

### 7.1 Edit 1 — read appearance from config

After config fetch resolves:
```js
this.appearance = config.appearance || {};
```
Backward-compat both ways: stale widget against fresh API ignores new field; fresh widget against stale API gets `{}`, all fallbacks engage.

### 7.2 Edit 2 — launcher position

Around the existing `position: fixed` launcher block (~widget.js:1002 region):
```js
const corner = this.appearance.launcherPosition === 'bottom-left'
  ? { left:  '24px', right: 'auto' }
  : { right: '24px', left:  'auto' };
// merge into launcher element style
```
Panel still opens upward — no panel-direction logic changes.

### 7.3 Edit 3 — launcher label (pill vs icon-only)

At the launcher render site:
```js
const label = this.appearance.launcherLabel;
if (label) {
  launcher.classList.add('cb-launcher--pill');
  launcher.querySelector('.cb-launcher__text').textContent = label;
} else {
  launcher.classList.remove('cb-launcher--pill');
}
```
Add CSS rule:
```css
.cb-launcher--pill {
  border-radius: 999px;
  padding: 0 16px;
  width: auto;
}
.cb-launcher__text {
  text-overflow: ellipsis;
  max-width: 200px;
  overflow: hidden;
  white-space: nowrap;
}
```

### 7.4 Edit 4 — welcome message seed

In the panel-open / chat-init code path, **after** any stored/session history restore completes:
```js
const welcome = this.appearance.welcomeMessage;
if (welcome && this.messages.length === 0) {
  this.messages.push({ role: 'assistant', content: welcome, timestamp: Date.now() });
  this.renderMessages();
}
```
The `messages.length === 0` guard ensures seed-once semantics — but is only correct *after* history restore has populated `this.messages`. Implementation must verify the sequence; if restore is async, seed must run in the restore-completion callback.

### 7.5 Edit 5 — avatar rendering (helper + two sites)

Introduce a small helper used at both the header avatar and the assistant-message avatar sites:
```js
function renderBotAvatar(container, src) {
  container.replaceChildren();
  if (src) {
    const img = document.createElement('img');
    img.src = src;          // server already resolved widget.avatarUrl || theme.logoUrl || null
    img.alt = '';
    img.loading = 'lazy';
    container.appendChild(img);
  } else {
    container.innerHTML = ICONS.bot;   // existing SVG fallback
  }
}
```
Called at: widget header avatar slot and the assistant-message avatar slot. Same configured avatar drives both — bot identity is consistent in the open panel.

`document.createElement('img')` + `img.src = …` is preferred over `innerHTML` string concatenation to avoid HTML-escaping bugs on the URL.

### 7.6 Manual smoke checklist (deploy gate)

Run against the deployed environment after commit 6 lands. Per `reference_railway_deploy`, this repo's `main` branch deploys directly to production — there is no staging. Run the smoke checklist immediately post-deploy:

1. Pre-MVP tenant (no `settings.widget`): widget renders identically to today — bottom-right circular icon launcher, no welcome message, bot SVG avatar.
2. `launcherPosition: 'bottom-left'`: launcher anchors bottom-left, panel still expands upward.
3. `launcherLabel: 'Chat with us'`: launcher renders as pill with text + icon; long labels truncate.
4. `launcherLabel: null`: launcher is the circular icon-only button.
5. `avatarUrl` set on `widget`: header and assistant-message avatars show that image.
6. `avatarUrl` null, `theme.logoUrl` set: header and assistant-message avatars show the company logo.
7. `avatarUrl` and `logoUrl` both null: avatars show `ICONS.bot`.
8. `welcomeMessage: 'Hello!'`, fresh session: first message in panel is "Hello!".
9. `welcomeMessage` set, returning session with prior messages restored: welcome is NOT re-injected.
10. Concurrency: two tenant sites side by side with different appearance settings — no cross-contamination.

### 7.7 Rollback playbook

- **Widget regression after commit 6:** revert commit 6 first. Widget reverts to today's behavior; admins can still configure settings via Appearances (preview keeps working) but the embed stops applying them.
- **Avoid reverting commit 3 alone** while portal commits 4–5 remain — the Appearances preview and form will continue functioning, but the real widget loses runtime hooks, and the cross-link "Open full widget test" would mislead users into thinking production reflects their settings.
- **Portal regression:** revert commits 4 and/or 5 (portal-only); widget runtime unaffected.
- **API contract complaint:** revert commits 1–3 in reverse order; portal commits 4–5 must be reverted alongside since they consume the API.

## 8. Testing

### 8.1 API (vitest, follows recent AI-settings test patterns)

- `chatbot-platform/api/src/__tests__/unit/widget-appearance.schema.test.ts` — Zod validation: bad hex, oversized label, invalid position enum, URL validation, max lengths, empty-string-to-null normalization.
- `chatbot-platform/api/src/__tests__/unit/widget-appearance.controller.test.ts` — cross-namespace merge correctness, partial PATCH only writes provided keys, unauthorized → 403, GET returns saved subset with defaults.
- `chatbot-platform/api/src/__tests__/unit/widget-config.test.ts` (new or extension of existing) — `/widget/config` includes `appearance` block, server-side defaults applied, avatar fallback resolves correctly across the three scenarios.

### 8.2 Portal (vitest + RTL, follows `AiBotForm.test.tsx`)

- `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesForm.test.tsx` — hydration, dirty tracking, save invokes PATCH, unsaved-change dialog fires on tab navigation.
- `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesPreview.test.tsx` — launcher renders at correct corner, pill vs icon-only based on label, welcome bubble appears only when non-empty, avatar fallback chain.
- Update `WidgetBrandSettings` test (if one exists) to assert the color picker is no longer rendered and the cross-link banner is present.

### 8.3 Widget runtime

No automated tests. Manual smoke checklist (Section 7.6) is the deploy gate.

## 9. Commit boundary

Six scoped commits, each independently revertable, in dependency order:

1. **`feat(api): add widget appearance schema and entity types`** — `Tenant.settings.widget` TS type extension, Zod schema file. Inert; no behavior change.
2. **`feat(api): add widget appearance PATCH/GET route`** — new controller, routes file, Clerk admin middleware. Endpoint exists; nothing reads it yet.
3. **`feat(api): extend widget config with appearance namespace`** — server-side defaults, `appearance` block in `/widget/config` response. Real widgets still ignore the new field — safe deploy gate.
4. **`feat(portal): add chatbot appearances form and preview`** — replace `ComingSoonPanel`, new form + preview + query hooks. Admins can edit and save. Real widgets unchanged.
5. **`refactor(portal): move primary color from widget-brand-settings to appearances`** — strip color picker out of `WidgetBrandSettings`, add cross-link banner. Keep tenant name, company logo, API key, install snippet.
6. **`feat(widget): honor appearance config in embed widget`** — five `widget.js` edits + `.cb-launcher--pill` CSS + `renderBotAvatar` helper. **Manual smoke checklist gate before announcing the feature is live.**

**Cadence:** all six commits in one series. The natural pause point is between commit 5 (admins can save) and commit 6 (embed widget applies them). Use that gap to populate a test tenant's appearance settings via the new UI, then deploy commit 6 and run the smoke checklist.

**Why portal-before-widget:** admins can configure non-default appearance values via UI before the runtime starts consuming them, so smoke testing in step 6 doesn't require manual DB writes to set up the test cases.

## 10. Open questions for implementation

None blocking. Four small things to verify when writing the plan:

1. **Exact middleware chain for admin gate in `ai-settings.routes.ts`** — mirror it on the new route. Do not broaden permission model.
2. **Existing upload flow in `WidgetBrandSettings`** — read it, extract the smallest reusable helper if duplication is obvious, otherwise inline. Same storage/upload endpoint either way.
3. **Sequencing of history restore vs welcome seed in `widget.js`** — confirm restore is synchronous or wrap the seed in the restore-completion callback. The `messages.length === 0` guard is only correct after restore completes.
4. **Source of `tenant.apiKey` for the "Open full widget test" link** — verify the portal already has the tenant's `apiKey` available in the same context as the Appearances form (e.g., via `useTenantSettings()`). The existing `WidgetTest.tsx` page expects `?apiKey=…`; confirm the value is reachable without an extra fetch.

---

**Next step:** invoke `superpowers:writing-plans` to convert this spec into an executable implementation plan.
