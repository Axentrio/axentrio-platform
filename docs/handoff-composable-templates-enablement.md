# Handoff: Composable Templates (Modules & Skills) — redesign + production enablement

_Last updated: 2026-07-01. Hand this to a fresh session for full context._

## Goal

1. Redesign the admin **Bot Template** edit-prompt page and improve the detail-page UX.
2. Deploy it to production.
3. Turn on the **Modules & Skills** (Composable Templates) feature in production.

All three are **done and live**.

---

## 1. UI redesign (merged via PR #43)

Guided-authoring editor + detail-page polish for admin bot templates.

**Files changed (main ones):**
- `portal/src/pages/admin/AdminBotTemplateDetail.tsx` — full-page takeover editor restructured into numbered sections (Prompt / Capabilities / Guardrails / Version notes / Test); framed prompt textarea w/ live char count + placeholder chips; module selection as selectable cards; guardrails split into panels; right pane rewritten as a live-preview "monitor" rail. Detail page header + Composition card polished.
- `portal/src/i18n/locales/en.json` — new keys: `unsaved`, `promptSection`, `modulesSection`, `notesSection`, `charCount` (uses `{{n}}`, not `{{count}}`, to avoid i18next pluralization), `insertLabel`.

**Design system used (do not drift from it):** Tailwind tokens `surface-0..4`, `edge`, `primary` scale, `text-primary/secondary/muted`; fonts Plus Jakarta Sans + JetBrains Mono; `glass` + `line-clamp-*` utilities.

**Merge note:** `feat/composable-templates-phase1` was merged with `origin/main` using `git merge -X ours` because `main` had merged PR #39 (Dynamic Prompt Builder) in parallel. The feature branch is an **additive superset** of that work — no main-only fixes were lost. Full API + portal typecheck/tests/build were validated before committing. Then merged to `main` via **PR #43** (commit `0f8b93f`).

---

## 2. Production enablement of Modules & Skills (this session)

The feature is gated by one flag with two halves:
- **Portal (build-time):** `VITE_FEATURE_COMPOSABLE_TEMPLATES` → drives `COMPOSABLE_TEMPLATES_ENABLED` in `portal/src/config/featureFlags.ts`. Gates the Bot Studio tabs (`AdminStudio.tsx` returns plain `<AdminBotTemplates />` when off).
- **API (runtime):** `COMPOSABLE_TEMPLATES_ENABLED` → makes the runtime actually consume authored module prose + pinned module refs.

### Railway env vars set (project `axentrio-platform`, env `production`)
| Service | Variable | Value | Type |
|---|---|---|---|
| `chatbot-api` | `COMPOSABLE_TEMPLATES_ENABLED` | `true` | runtime |
| `chatbot-portal` | `VITE_FEATURE_COMPOSABLE_TEMPLATES` | `true` | **build-time (Vite)** |

### The non-obvious fix (important!)
Setting the portal var alone did **nothing**. The portal builds from `portal/Dockerfile`, and Docker build stages do **not** inherit Railway service variables unless declared as `ARG`. The Dockerfile only forwarded `VITE_API_URL`, `VITE_WS_URL`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_SENTRY_DSN`, so `VITE_FEATURE_COMPOSABLE_TEMPLATES` was silently dropped during `npm run build`.

**Fix (commit `a6c7ddb`)** — added to the builder stage of `portal/Dockerfile`:
```dockerfile
ARG VITE_FEATURE_COMPOSABLE_TEMPLATES
ENV VITE_FEATURE_COMPOSABLE_TEMPLATES=${VITE_FEATURE_COMPOSABLE_TEMPLATES}
```
Railway auto-passes service variables as Docker build args once the `ARG` is declared (same mechanism the existing `VITE_*` args rely on).

Shipped via **PR #44** (branch `chore/portal-composable-build-arg`), squash-merged to `main` (merge commit `323f077d`).

### Deploy result
Push to `main` triggered CI run `28521742354`: `api-test`, `portal-build`, `deploy-api`, `deploy-portal` all **SUCCESS**. Final Railway deployments:
- portal `08b151b8` — SUCCESS
- api `dd01a696` — SUCCESS

---

## Current state
- Modules & Skills is **ON in production** for both portal and API.
- Local repo is back on branch `feat/composable-templates-phase1`.
- GitHub CLI active account restored to `ianneo97`.

## How to verify
Hard-refresh the admin app (clear cached JS) → open **Bot Studio** → the **Modules** and **Skills** tabs should be visible. The API consumes authored module prose at runtime.

## Remaining / optional
- **`SKILL_STATE_ENABLED` (API, runtime)** — Phase-3b tool-gating that physically drops not-ready skill tools (prevents phantom bookings). **Not enabled.** To turn on: set `SKILL_STATE_ENABLED=true` on `chatbot-api` (runtime var, no rebuild needed, auto-redeploys).
- Merged branch `chore/portal-composable-build-arg` can be deleted.

## Gotchas for the next session
- **Build-time vs runtime flags:** any new `VITE_*` var must also be added as an `ARG`/`ENV` in `portal/Dockerfile` or it won't reach the build. Flipping a build-time var requires a **portal rebuild**, not just a restart.
- **Deploy path:** pushing/merging to `main` triggers `.github/workflows/ci.yml` → `deploy-api` + `deploy-portal` via `railway up`. A `pull_request`-triggered run will show deploy jobs as **skipped**; the deploy only runs on the **push** to `main`.
- **Git push access:** only the `Axentrio` GitHub account has write access; `ianneo97` does not. Switch with `gh auth switch --user Axentrio` to push, then restore to `ianneo97`.
- **User preference:** merge changes **directly to `main`** (skip opening a PR) going forward.
- **Railway CLI:** authed as `Axentrio`; project `axentrio-platform`; services `chatbot-portal`, `chatbot-api`, `n8n`, `Redis`. Use `--service <name> --environment production` explicitly.
- **Live app is behind Clerk auth** — browser automation on `app.axentrio.com` will hit the login wall unless authenticated.
