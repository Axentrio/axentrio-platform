# Chatbot Appearances MVP — Design

**Date:** 2026-05-11
**Owner:** Ian Neo
**Status:** Spec approved, ready for implementation plan
**Predecessor:** AI Bot Knowledge Base MVP (shipped 2026-05-11)
**Successor:** writing-plans → implementation

---

## 1. Goal

Turn the placeholder `Chatbot Appearances` tab under `/ai` into a working settings page that controls how the embedded customer-facing widget looks. Ship as MVP — four editable fields (primary color, bot avatar URL, launcher position, launcher label), a live preview that also surfaces the existing greeting (read-only, with a link back to AI Bot settings), and matching runtime support in the embed widget for the visual fields.

## 2. Scope

### Recon findings (2026-05-11) — premises that did not survive contact with the codebase

1. **`Tenant.settings.theme.logoUrl` is a dead field.** Declared in entity types but no code writes to it, and `widget.js` does not read it. Removed from any fallback chain in this MVP.
2. **No reusable image upload flow.** The only "logo upload" goes through Clerk's `organization.setLogo()` — Clerk-side org logo, single slot. Bot avatar becomes a URL text input; new upload endpoint is out of MVP scope.
3. **Welcome message already exists.** `Tenant.settings.ai.guardrails.greetingMessage` is the live, user-editable greeting; `widget.js:1200-1208` already implements the exact "seed-once when no history" behavior we designed. Adding `settings.widget.welcomeMessage` would duplicate it. **Dropped from this MVP.** The Appearances preview surfaces the existing greeting read-only with a link back to AI Bot settings.

**Consequence**: MVP fields drop to four — primary color, bot avatar URL, launcher position, launcher label. Server-side avatar fallback is `widget.avatarUrl ?? null`; portal preview applies a richer fallback (`organization.imageUrl` from Clerk) for visual fidelity. Greeting plumbing is untouched.

### In scope

| Capability | Surface |
|---|---|
| Primary color | Migrated into Appearances tab |
| Bot avatar URL (optional override) | New URL text input, falls back to Clerk org logo in portal preview |
| Launcher position (bottom-right / bottom-left) | New field |
| Launcher label (optional pill text) | New field |
| Greeting message (read-only display) | Reads existing `settings.ai.guardrails.greetingMessage` + link to AI Bot settings |
| Live React preview pane | New component, updates from unsaved form state |
| Authenticated PATCH/GET API | New endpoint, mirrors AI Settings pattern |
| Public `/widget/config` extension | Adds `appearance` namespace |
| Embed widget runtime support | Five additive edits to `api/public/widget.js` |

### Out of scope (deferred)

- Pre-open attention bubble (separate product question — frequency, dismiss behavior, analytics)
- Top-corner launcher positions
- Tooltip-only launcher labels
- `WidgetTest.tsx` modifications — reused as-is via "Open full widget test" link
- Removal of old `WidgetBrandSettings` page — kept for tenant identity (name, Clerk-managed org logo, API key, install snippet)
- New server-side image upload endpoint (deferred until there's a clear product need for tenant-managed image assets)
- Server-side Clerk org logo resolution inside `/widget/config` (deferred — needs Clerk SDK plumbing on a public route)
- Multi-tenant feature flagging on `widget.js` — new fields are strictly additive and fall back to today's behavior when absent
- Automated tests for `widget.js` itself — no test infrastructure exists for it today

## 3. Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| Tab overlap with `WidgetBrandSettings` | **Consolidate.** Appearances owns customer-facing widget visuals. `WidgetBrandSettings` retains tenant identity (name, company logo, API key, install snippet). | One editable home per field; avoid duplicate UX. |
| Bot avatar field model | **URL text input only** (no file upload in MVP — see Recon finding below). `settings.widget.avatarUrl` is the override; production widget falls back to `ICONS.bot` SVG; portal preview falls back to Clerk org logo (`organization.imageUrl`) for closer visual fidelity. | No reusable server upload exists; Clerk logo upload is org-only and can't be reused for a second image. Adding a real upload endpoint is out of scope. |
| Welcome / greeting message | **Not added as a new field — reuse existing `settings.ai.guardrails.greetingMessage`.** Preview surfaces it read-only with "Edit in AI Bot" link. | Already implemented and live in `widget.js:1200-1208`; duplicating would create competing config. |
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
  logoUrl?: string;        // DEAD FIELD in current codebase — not written, not read; ignored by this MVP
  customCss?: string;      // not used by this MVP
}
```

Only `theme.primaryColor` is consumed. Do not add references to `theme.logoUrl` in this MVP's code paths.

### New — `Tenant.settings.widget`

Add to the same JSONB `settings` column:

```ts
widget?: {
  avatarUrl?: string | null;
  launcherPosition?: 'bottom-right' | 'bottom-left';
  launcherLabel?: string | null;
}
```

The greeting message stays at `settings.ai.guardrails.greetingMessage` — no new field, no change to its location.

**Migration:** none. `settings` is already a JSONB column. The TypeScript type gains an optional `widget` key. Existing tenants read as `widget: undefined`; all fallback logic handles absent values.

**DB stays sparse:** defaults are applied at read time (server-side in `/widget/config` and portal hydration), not written speculatively. The Zod schema (Section 5.1) accepts empty strings via `.or(z.literal(''))` to match the existing codebase convention (see `ai-settings.schema.ts:8`), and the controller normalizes `''` to `null` before write. After normalization, reads use truthy fallbacks:

```ts
// /widget/config server-side:
appearance.avatarUrl        = widget.avatarUrl     || null;   // no theme.logoUrl, no Clerk lookup
appearance.launcherLabel    = widget.launcherLabel || null;
appearance.launcherPosition = widget.launcherPosition || 'bottom-right';
```

The portal preview applies an additional fallback for visual fidelity only: if `formState.avatarUrl` is empty, use `useOrganization().organization?.imageUrl` (already imported in `WidgetBrandSettings`). This makes the preview match what a fresh tenant would expect ("I haven't set a custom avatar, so it shows my org logo"), even though the production widget will render `ICONS.bot` in the same condition. The preview also reads `settings.ai.guardrails.greetingMessage` (via the existing `useGetAiSettings` query) for the greeting bubble — read-only, no editing from this tab.

## 5. API

### 5.1 `PATCH /api/v1/tenants/me/widget-appearance` — new, authenticated

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
}
```

**Zod validation** (mirrors `ai-settings.schema.ts` convention: allow empty string via `.or(z.literal(''))`, controller normalizes to `null` before write — avoids `URL` validation rejecting `""`):

```ts
import { z } from 'zod';

export const updateWidgetAppearanceSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  avatarUrl: z.string().url().max(2048).optional().nullable().or(z.literal('')),
  launcherPosition: z.enum(['bottom-right', 'bottom-left']).optional(),
  launcherLabel: z.string().max(30).optional().nullable().or(z.literal('')),
});

export type UpdateWidgetAppearanceInput = z.infer<typeof updateWidgetAppearanceSchema>;
```

**Controller logic** (mirrors `chatbot-platform/api/src/knowledge/knowledge.controller.ts:187-225`):
1. Resolve tenant from auth context (`(req as any).tenantId`).
2. Validate body with `updateWidgetAppearanceSchema.parse(req.body)`.
3. Normalize empty strings → `null` for `avatarUrl`, `launcherLabel`.
4. Read tenant, deep-merge:
   - `primaryColor` → `tenant.settings.theme.primaryColor` (only if key present in body)
   - other three → `tenant.settings.widget.*` (only if keys present)
5. `tenantRepo.save(tenant)`.
6. Respond with the saved subset (Section 5.2 shape).

**Errors:** 400 on Zod, 401/403 from Clerk, 500 on DB write. Single save — no partial writes.

### 5.2 `GET /api/v1/tenants/me/widget-appearance` — new, authenticated

Same auth as PATCH. Returns the currently-saved appearance subset (used for portal hydration):

```ts
{
  primaryColor: string | null,
  avatarUrl: string | null,                            // raw widget.avatarUrl, NOT fallback-resolved
  launcherPosition: 'bottom-right' | 'bottom-left',    // defaulted on read
  launcherLabel: string | null,
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
    avatarUrl: string | null,                             // raw widget.avatarUrl ?? null (no theme.logoUrl, no Clerk lookup)
    launcherPosition: 'bottom-right' | 'bottom-left',     // server defaults to 'bottom-right'
    launcherLabel: string | null,
  }
}
```

Server-side default resolution lives next to the existing `theme` / `features` derivations. The avatar fallback to Clerk's org logo is deliberately **not** done here (would require Clerk SDK plumbing on a public, rate-limited route). When `widget.avatarUrl` is null, the production widget renders `ICONS.bot` — same as today.

## 6. Portal UI

### 6.1 Files touched

| Action | File |
|---|---|
| Replace placeholder | `chatbot-platform/portal/src/pages/AiContent.tsx:147-153` |
| New form + preview wrapper | `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesForm.tsx` |
| New preview component | `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesPreview.tsx` |
| New query hooks | `chatbot-platform/portal/src/queries/useWidgetAppearance.ts` |
| Remove color picker, add banner | `chatbot-platform/portal/src/pages/settings/WidgetBrandSettings.tsx` |

### 6.2 Layout

Two-column inside the tab:

- **Left (~55%) — form:**
  - Primary color (color picker + hex input)
  - Bot avatar URL (URL text input, helper text "Optional image URL for the chatbot avatar. If empty, the widget uses your company logo when available.", "Clear" button when a value exists)
  - Launcher position (segmented radio: Bottom right / Bottom left)
  - Launcher label (text input, max 30, helper text)
  - **Greeting (read-only display)** — surfaces `settings.ai.guardrails.greetingMessage` with helper text "Welcome message is configured in AI Bot settings." and an inline "Edit in AI Bot →" link that navigates to `/ai?tab=ai-bot` (or the existing AI Bot tab id)
  - Save button (disabled when clean)
- **Right (~45%) — preview:**
  - Closed launcher (renders at chosen corner, pill or icon-only based on label)
  - Open chat panel (header avatar, brand name, welcome bubble if non-empty, input)
  - "Open full widget test" link → `/widget-test?apiKey={tenant.apiKey}` in new tab

### 6.3 Form behavior (mirrors AI Bot MVP)

- Hydrate editable fields from `GET /api/v1/tenants/me/widget-appearance`.
- Hydrate the read-only greeting display from `useGetAiSettings()` — same hook the AI Bot Form uses.
- Dirty tracking via shallow comparison (only the four editable fields participate; the greeting is informational).
- Unsaved-change confirmation dialog on tab navigation, matching the pattern shipped in `ecdfca1`.
- On save success: invalidate tenant + widget-config react-query caches.

### 6.4 Preview component

- Pure React; no widget.js coupling.
- Takes unsaved form state as props.
- Avatar resolution for preview ONLY: `formState.avatarUrl || organization?.imageUrl || null`. The `organization` comes from Clerk's `useOrganization()` hook — same source `WidgetBrandSettings` already uses (`pages/settings/WidgetBrandSettings.tsx:72`). Null renders the same generic bot SVG used by the real widget. (Note: this differs from the production widget — the production widget does NOT consult Clerk and falls back directly to `ICONS.bot`. The preview shows a richer fallback for design intent; deliberate, documented.)
- Greeting renders as the first chat bubble using the value from `settings.ai.guardrails.greetingMessage` (read-only); empty greeting → no bubble (matches real widget behavior).
- Inline-styled with the same color/position values the form holds — no `widget.js` import.

### 6.5 `WidgetBrandSettings` post-MVP

Keeps:
- Tenant name
- Org logo upload (via Clerk's `organization.setLogo()` — unchanged)
- API key + install snippet
- Cross-link banner: "Widget appearance is now configured under AI & Content → Chatbot Appearances"

Removes from the visible UI:
- Primary color picker (moved to Appearances)

Does **not** remove or redirect the route — bookmarks and existing nav stay valid. Does **not** modify the Clerk logo upload flow.

## 7. Widget runtime (`api/public/widget.js`)

Four surgical edits, each additive and feature-gated on the new fields being present. Promise: **behavior and visual fallback are identical when `appearance` is absent or empty.** No claim of byte-identical DOM (the new code paths introduce minor structural additions even when fields are null). Greeting handling (existing `config.greetingMessage` path at `widget.js:1200-1208`) is **not** touched in this MVP.

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

### 7.4 Edit 4 — avatar rendering (helper + two sites)

Introduce a small helper used at both the header avatar and the assistant-message avatar sites:
```js
function renderBotAvatar(container, src) {
  container.replaceChildren();
  if (src) {
    const img = document.createElement('img');
    img.src = src;          // server passed raw widget.avatarUrl || null
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

**Production fallback chain in widget.js**: `widget.avatarUrl → ICONS.bot`. No Clerk lookup. The portal preview's richer fallback (`→ org logo → ICONS.bot`) is preview-only.

### 7.5 Manual smoke checklist (deploy gate)

Run against the deployed environment after commit 6 lands. Per `reference_railway_deploy`, this repo's `main` branch deploys directly to production — there is no staging. Run the smoke checklist immediately post-deploy:

1. Pre-MVP tenant (no `settings.widget`): widget renders identically to today — bottom-right circular icon launcher, no welcome message, bot SVG avatar.
2. `launcherPosition: 'bottom-left'`: launcher anchors bottom-left, panel still expands upward.
3. `launcherLabel: 'Chat with us'`: launcher renders as pill with text + icon; long labels truncate.
4. `launcherLabel: null`: launcher is the circular icon-only button.
5. `avatarUrl` set on `widget`: header and assistant-message avatars show that image.
6. `avatarUrl` null: header and assistant-message avatars show `ICONS.bot` (production widget does not consult Clerk org logo — preview does, but the embed does not).
8. Existing greeting path unchanged: a tenant whose AI Bot settings include a `greetingMessage` still sees it as the first message (regression test, not a new behavior).
9. Concurrency: two tenant sites side by side with different appearance settings — no cross-contamination.

### 7.6 Rollback playbook

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

No automated tests. Manual smoke checklist (Section 7.5) is the deploy gate.

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

None blocking — all major recon resolved.

### 10a. Resolved during recon

- **Admin middleware chain**: `ai-settings.routes.ts` uses `requireClerkAuth, autoProvision, resolveTenantContext` at the router level, then `requireRole('admin')` per-route for writes. Mirror exactly.
- **Upload reuse**: not possible — Clerk's `organization.setLogo()` is the only existing upload path and it's org-only. Avatar is a URL input.
- **Welcome message duplication**: dropped from this MVP. Greeting stays at `settings.ai.guardrails.greetingMessage`, edited via AI Bot Form, consumed by `widget.js:1200-1208`. The Appearances preview reads it via `useGetAiSettings()`.
- **`tenant.apiKey` for the "Open full widget test" link**: available via `useTenantSettings()` (already used by `WidgetBrandSettings:75`); same hook is callable from the new form.
- **Test directory layout**: API tests live under `api/src/__tests__/unit/`; vitest discovers them via the existing config.

### 10b. Documented follow-ups (out of this MVP)

- Server-side Clerk org logo resolution inside `/widget/config` so the production widget's avatar fallback matches the portal preview.
- Generic tenant asset upload endpoint (would replace the URL input with a true file picker).
- Move the greeting field UX into Appearances if user feedback suggests it belongs there (requires touching the just-shipped AI Bot Form).

---

**Next step:** invoke `superpowers:writing-plans` to convert this spec into an executable implementation plan.
