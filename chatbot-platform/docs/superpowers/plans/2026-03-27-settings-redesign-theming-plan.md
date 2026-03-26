# Settings Redesign + Functional Theming Implementation Plan

> For agentic workers: execute this in phases and keep checkbox state current. Do not start the API-sync phase until the `/users/preferences` contract is confirmed from the backend.

## Review Summary

The previous version of this plan was directionally correct, but it had several problems that would cause churn during implementation:

- It treated API preference sync as already-defined work even though the frontend currently has no typed query/mutation layer for `/users/preferences` and `AppAuthProvider` still fabricates default preferences locally.
- It missed existing dark-only surfaces outside the Settings page, especially Clerk appearance in [`portal/src/App.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/App.tsx) and Sonner in [`portal/src/components/ui/sonner.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/components/ui/sonner.tsx).
- It over-specified line-by-line file rewrites and full file bodies, which makes the plan brittle as soon as nearby code moves.
- It included unnecessary uncertainty about the sidebar active state. The existing `NavLink` for `/settings` should remain active for child routes in React Router v6, so no sidebar change is required unless manual testing proves otherwise.
- It split work into too many micro-commits. That is process noise, not implementation guidance.

This revised plan keeps the feature scope, but makes the sequencing safer and aligns it to the current portal codebase.

## Goal

Redesign the Settings experience around nested settings routes with a vertical sidebar and ship working light, dark, and system theming with accent color customization.

## Scope

In scope:

- Functional theme switching: `light`, `dark`, `system`
- Light-theme token set for the shared app shell and settings experience
- Accent color selection with tenant branding override
- Settings route redesign to nested pages
- Local persistence via `localStorage`
- Theme-aware Clerk and toast styling

Out of scope for the first implementation pass:

- Full light-mode QA for every page in the product
- User-controlled density, typography, or layout preferences
- Full backend preference reconciliation before the API contract is verified

## Current Codebase Facts

- The current Settings screen lives in [`portal/src/pages/Settings.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/pages/Settings.tsx) and is a single tabbed page.
- Theme tokens in [`portal/src/styles/index.css`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/styles/index.css) are dark-only today.
- [`portal/tailwind.config.js`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/tailwind.config.js) does not enable `darkMode: 'class'`.
- [`portal/src/hooks/useTenantTheme.ts`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/hooks/useTenantTheme.ts) already generates and applies tenant primary-color palettes.
- Clerk appearance in [`portal/src/App.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/App.tsx) is hardcoded to dark colors.
- Sonner is hardcoded to `theme="dark"` in [`portal/src/components/ui/sonner.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/components/ui/sonner.tsx).
- The frontend knows about `/users/preferences` in [`portal/src/config/api.config.ts`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/config/api.config.ts), but nothing currently reads or writes it.

## Implementation Decisions

- `ThemeProvider` is the runtime owner of theme mode, resolved theme, user accent, and org accent override.
- The provider should persist to `localStorage` immediately.
- API persistence is a separate gated phase. Do not wire speculative request payloads into the first pass.
- Tenant branding continues to win over user accent selection.
- The old settings page should not be removed until nested routes compile and render correctly.

## File Plan

New files:

- `portal/src/contexts/ThemeContext.tsx`
- `portal/src/pages/settings/SettingsLayout.tsx`
- `portal/src/pages/settings/ProfileSettings.tsx`
- `portal/src/pages/settings/NotificationSettings.tsx`
- `portal/src/pages/settings/AppearanceSettings.tsx`
- `portal/src/pages/settings/IntegrationSettings.tsx`

Modified files:

- `portal/index.html`
- `portal/tailwind.config.js`
- `portal/src/styles/index.css`
- `portal/src/config/constants.ts`
- `portal/src/hooks/useTenantTheme.ts`
- `portal/src/App.tsx`
- `portal/src/components/ui/sonner.tsx`

Removed after route migration succeeds:

- `portal/src/pages/Settings.tsx`

## Phase 1: Theme Foundations

- [ ] Add `ACCENT` to `STORAGE_KEYS` in [`portal/src/config/constants.ts`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/config/constants.ts).
- [ ] Enable `darkMode: 'class'` in [`portal/tailwind.config.js`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/tailwind.config.js).
- [ ] Convert `surface`, `edge`, and `text` colors in Tailwind to CSS-variable-backed values instead of hardcoded dark hex values.
- [ ] Restructure [`portal/src/styles/index.css`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/styles/index.css) so `:root` contains light defaults and `.dark` contains dark overrides.
- [ ] Keep the existing token names (`--color-surface-*`, `--color-edge`, `--color-text-*`) so existing components inherit the new theme with minimal churn.
- [ ] Update `body`, scrollbar, and `.glass` styles so they remain visually correct in both themes.
- [ ] Add a pre-hydration script to [`portal/index.html`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/index.html) that:
  - reads `handsoff_theme`
  - resolves `system` using `matchMedia`
  - toggles the `.dark` class before React mounts
  - reapplies cached accent variables if present

Acceptance criteria:

- Shared app-shell tokens can render in both light and dark modes.
- Refresh does not flash the wrong theme before React starts.

## Phase 2: Theme Runtime

- [ ] Create [`portal/src/contexts/ThemeContext.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/contexts/ThemeContext.tsx) with:
  - `theme: 'light' | 'dark' | 'system'`
  - `resolvedTheme: 'light' | 'dark'`
  - `accent`
  - `accentSource: 'user' | 'org'`
  - `setTheme`
  - `setAccent`
  - `setOrgAccent`
- [ ] Apply and remove the `.dark` class from `<html>` inside the provider based on `resolvedTheme`.
- [ ] Listen for `prefers-color-scheme` changes when mode is `system`.
- [ ] Persist `theme` and user accent to `localStorage`.
- [ ] Export palette helpers from [`portal/src/hooks/useTenantTheme.ts`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/hooks/useTenantTheme.ts) if the appearance UI needs them.
- [ ] Update `useTenantTheme` so it notifies `ThemeProvider` when tenant branding is active via `setOrgAccent`.
- [ ] Keep the existing tenant palette generation behavior intact.

Important guardrail:

- Do not put speculative API writes inside `ThemeProvider`. The provider should be stable even if backend preference sync is postponed.

## Phase 3: App-Wide Integration

- [ ] Wrap the main app tree in `ThemeProvider` inside [`portal/src/App.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/App.tsx).
- [ ] Wrap the `/widget-test` early-return tree in `ThemeProvider` too so theme tokens behave consistently there.
- [ ] Extract Clerk configuration into a small internal component or helper that can read `resolvedTheme` from `useTheme`.
- [ ] Make Clerk appearance switch between light and dark tokens instead of staying hardcoded dark.
- [ ] Update [`portal/src/components/ui/sonner.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/components/ui/sonner.tsx) to derive its `theme` prop from the current resolved theme.

Acceptance criteria:

- Sign-in and authenticated flows both respect light and dark mode.
- Toasts no longer stay permanently dark in light mode.

## Phase 4: Settings Route Redesign

- [ ] Create [`portal/src/pages/settings/SettingsLayout.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/pages/settings/SettingsLayout.tsx) with:
  - header copy
  - desktop vertical sidebar
  - mobile horizontal nav
  - `<Outlet />` for child content
- [ ] Add nested routes in [`portal/src/App.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/App.tsx):
  - `/settings`
  - `/settings/profile`
  - `/settings/notifications`
  - `/settings/appearance`
  - `/settings/integrations`
- [ ] Redirect `/settings` to `/settings/profile`.
- [ ] Leave the main sidebar item pointed at `/settings`; do not change [`portal/src/components/Sidebar.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/components/Sidebar.tsx) unless manual testing shows active-state regressions.

## Phase 5: Extract Settings Sections

- [ ] Create [`portal/src/pages/settings/ProfileSettings.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/pages/settings/ProfileSettings.tsx) from the existing profile/password content.
- [ ] Preserve the existing `/users/profile` save path already used by the current Settings screen.
- [ ] Create [`portal/src/pages/settings/NotificationSettings.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/pages/settings/NotificationSettings.tsx) from the current notification UI.
- [ ] Create [`portal/src/pages/settings/IntegrationSettings.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/pages/settings/IntegrationSettings.tsx) as a thin wrapper around the existing `IntegrationTab`.
- [ ] Only remove [`portal/src/pages/Settings.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/pages/Settings.tsx) after the nested pages compile and the route swap is complete.

## Phase 6: Appearance Settings

- [ ] Create [`portal/src/pages/settings/AppearanceSettings.tsx`](/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy%20Chatbot%20op%20Railway/chatbot-platform/portal/src/pages/settings/AppearanceSettings.tsx).
- [ ] Implement three immediate-apply theme options: light, dark, and system.
- [ ] Use mini preview cards rather than icon-only buttons.
- [ ] Provide eight preset accent swatches plus a custom hex input.
- [ ] Disable accent editing when `accentSource === 'org'`.
- [ ] Show clear copy when org branding is overriding user accent.
- [ ] Apply accent changes immediately through `ThemeProvider`.

Acceptance criteria:

- Theme changes are instant and persist on refresh.
- Accent changes are instant when org branding is not active.
- Org branding correctly disables user accent overrides.

## Phase 7: Optional API Preference Sync

This phase is explicitly blocked until the backend contract is verified.

- [ ] Confirm the request and response shape for `PATCH /users/preferences`.
- [ ] Confirm whether `GET /users/preferences` exists and whether it is already included in `/auth/me`.
- [ ] Add typed frontend helpers for the verified contract.
- [ ] Reconcile server preferences with local cache after auth is available.
- [ ] Decide precedence rules when server data conflicts with stale `localStorage`.

If the backend contract is not confirmed during implementation:

- Keep the shipped feature on local persistence only.
- Record API sync as follow-up work instead of guessing payloads.

## Phase 8: Verification

- [ ] Run `cd portal && npx tsc --noEmit`.
- [ ] Run `cd portal && npm run build`.
- [ ] Manually verify:
  - `/settings` redirects to `/settings/profile`
  - settings navigation works on desktop and mobile
  - light mode renders correctly in the app shell and settings pages
  - dark mode still matches the current visual baseline
  - system mode follows OS preference
  - accent updates are visible in shared primary-color surfaces
  - Clerk screens and toast UI follow the active theme
  - refresh preserves the chosen theme without flash

## Suggested Commit Strategy

Use 2-4 commits max:

- `feat(portal): add theme foundation and provider`
- `feat(portal): redesign settings routes and pages`
- `feat(portal): wire theme-aware Clerk and toast surfaces`
- optional follow-up: `feat(portal): sync user preferences with API`

## Done Definition

This plan is complete when:

- The Settings page is route-based instead of tab-based.
- Light, dark, and system theming all work end-to-end.
- Accent customization works locally and respects tenant branding priority.
- Shared auth and notification surfaces no longer stay dark-only.
- API preference sync is either implemented against a confirmed contract or explicitly deferred.
