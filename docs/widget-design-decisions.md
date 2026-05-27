# Widget Design Decisions

A running note of decisions made while working on the embeddable chat widget. Each section captures **what we chose, why, and what the alternatives were** so future-you (or a new contributor) can understand the shape of the code without having to re-derive the tradeoffs.

Last updated: 2026-04-09 (Item D consolidation).

---

## Context: single canonical widget.js

The widget ships as a single `widget.js` file that customer sites embed via `<script src="…/widget.js">`. There is exactly **one** source of truth in the repo:

| Path | Role |
|---|---|
| `chatbot-platform/api/public/widget.js` | **The** widget source. Hand-edited. Served at `GET /widget.js` by the API. Copied into the Docker image via `api/Dockerfile` (`COPY api/ .` + `COPY /app/public ./public`). Resolved by `chatbot-platform/api/src/server.ts` with a single-path lookup: `path.resolve(__dirname, '../public/widget.js')`. |

**Before Item D** there were three copies of this file (the production one, a dev-fallback copy in `chatbot-platform/widget/`, and a legacy copy at the repo root). The fallback and legacy copies drifted over time — one used Socket.IO, the others used raw `ws`; `STORAGE_KEY_PREFIX` diverged across them; the root copy had no loader pointing at it at all. Every widget feature had to be hand-ported across three files, which was the root cause of the `cb_session_v2_` / `cb_session_v3_` typo fixed early on this branch and the architecture split visible throughout the Items B and C design decisions below.

Item D deleted both dead copies and simplified `server.ts` to a single-path resolver (commit referenced below). No build step was introduced; the file is still hand-edited in place. If a future need arises for minification or a build pipeline, it can be added on top of this single canonical source without having to also resolve drift first.

---

## Item A — Smoke verification and the production bugs it surfaced

### Decision: smoke tests as a one-shot Playwright MCP run, not a committed e2e suite

- **Why:** The immediate goal was "does the code we just pushed actually work?", not "set up a permanent e2e harness". Playwright e2e infrastructure (config, browsers, CI wiring) is substantial and can be done as a separate project when justified. A one-shot run against the locally served widget + local API gave us fast, high-signal answers without introducing a new toolchain.
- **Alternative considered:** Install `@playwright/test`, add `chatbot-platform/tests/e2e/widget/`, commit 4 spec files. Not picked because we don't yet need the tests to run in CI.

### Decision: duplicate `ValidationError` class in the middleware barrel is collapsed to a re-export

- **Root cause:** `chatbot-platform/api/src/middleware/index.ts` defined its own `ValidationError extends Error` alongside the real `ValidationError extends ApiError` in `middleware/error-handler.ts`. Routes importing from `'../middleware'` got the broken one, so `err instanceof ApiError` returned false in the global error handler and every validation failure became a generic `500 INTERNAL_ERROR "An unexpected error occurred"`.
- **Decision:** Delete the rogue classes (`ValidationError`, `UnauthorizedError`, `NotFoundError`, `ForbiddenError`) from `middleware/index.ts` and re-export the canonical ones from `./error-handler` so there is **one** class identity per name in the whole codebase.
- **Alternative considered:** Change the 5 affected route files to import directly from `'../middleware/error-handler'`. Rejected because it leaves the footgun in place — any future code that imports from the barrel would hit the same bug.
- **Blast radius:** 5 route files (`widget`, `tenants`, `session-management`, `skills`, `automations`) now correctly surface `422 VALIDATION_ERROR` with real messages. No call sites needed changes.
- **Commit:** `9288315 fix(api): collapse duplicate error classes in middleware barrel`.

### Decision: `requestIdMiddleware` hoisted to run before widget routes

- **Root cause:** `app.use(requestIdMiddleware)` was mounted at `server.ts:129`, **after** `app.use('/api/v1/widget', …, widgetRoutes)` at line 119. Express applies middleware in registration order, so widget routes never ran through the request-id middleware. Every widget response had an empty `x-request-id` header and `req.requestId === undefined` in handlers, making Railway log correlation useless for widget-related bugs.
- **Decision:** Move `requestIdMiddleware` to run immediately after the raw-body webhook handlers (Clerk, Meta) and before the widget static serve and `/api/v1/widget` mount. Remove the duplicate old mount.
- **Alternative considered:** Mount request-id *twice* (once early, once late). Rejected because calling the middleware twice would regenerate the UUID and overwrite the first one — the client-facing `x-request-id` would not match internal logs.
- **Commit:** `67dec45 fix(api): hoist requestIdMiddleware before widget routes`.

### Decision: `test-widget.html` reads its API key from localStorage, not a hardcoded attribute

- **Context:** The hardcoded `data-api-key="e4c062d1..."` in `test-widget.html` pointed at a tenant that no longer exists in the DB, so the test page silently produced a 500 from `/widget/init` on every load. Additionally, committing a live API key to a test file was a security footgun.
- **Decision:** Replace the hardcoded script tag with a small loader that reads `apiKey`, `apiUrl`, and optionally `widgetSrc` from `localStorage` (keys `cb_test_api_key`, `cb_test_api_url`, `cb_test_widget_src`). If the key is missing, the page renders an in-line setup hint instead of silently failing.
- **Defaults preserve the original behaviour:** widget file is served from the local `http.server` at `/chatbot-platform/api/public/widget.js` (so devs test local widget changes), backend defaults to Railway production.
- **Alternative considered:** Pick a real tenant's key (Axentrio) and hardcode it. Rejected because committing live credentials is a leak risk.
- **Commit:** `ce7ef5c chore(test-widget): read tenant API key from localStorage`.

---

## Item B — `destroy()` / unmount pass

### Decision: `destroy()` is a full lifecycle teardown with an idempotency guard

- **Why:** The previous `destroy()` in `api/public/widget.js` only disconnected the socket and removed the host DOM. Two window listeners (`resize` and `beforeunload`) added as inline arrow functions in `attachEventListeners()` had no handler refs, so they leaked for the lifetime of the page. On SPAs that mount/unmount the widget (route change, modal close), the whole widget instance graph stayed reachable forever.
- **Decision:** `destroy()` now does, in order:
  1. Idempotency guard (`this._destroyed = true`, double-calls are no-ops)
  2. Clear `heartbeatInterval` (where present) and `typingTimeout`
  3. Disconnect socket/ws
  4. `removeEventListener` the window `resize` and `beforeunload` handlers (requires storing them as `this._onWindowResize` and `this._onBeforeUnload` named refs — the refactor that made this fix possible)
  5. `saveSession()` + `emit('destroy')` before DOM teardown
  6. Remove the host DOM element
  7. Clear `pendingMessages` and `messages` so the old instance can be GC'd
- **Cached session is preserved.** `destroy()` does **not** clear the scoped `cb_session_v3_<hash>` localStorage key. Rationale: `destroy()` is an *unmount* primitive, not a logout. A subsequent page load on the same site should restore the transcript. If you want logout semantics, clear localStorage explicitly or add a `destroy({ clearSession: true })` signature (noted below as future work).

### Decision: `destroy()` is exposed on `window.ChatbotWidgetAPI`

- **Why:** External CTAs that use the public API should be able to tear down the widget symmetrically with `.open()`/`.close()`. An iframe-embedded widget has no other way to unmount from the parent — removing the iframe element from the DOM would also work but is less ergonomic.
- **Behaviour:** The public `destroy()` resets the module-level `widgetInstance` to `null`, clears the `pendingApiCalls` queue, then calls `inst.destroy()` on the instance. After this: `ChatbotWidgetAPI.isReady()` returns `false`; subsequent calls like `ChatbotWidgetAPI.open()` queue via `enqueueOrRun` and will fire against a **new** widget instance (if one is later created).
- **Alternative considered:** Keep `destroy()` as an instance-only method not exposed on the public API. Rejected because the whole point of the public API is that callers can drive the widget without reaching into its internals.
- **Commit:** `64cef27 feat(widget): destroy()/unmount cleanup with window listener removal`.

---

## Item C — `postMessage` bridge for iframe-separated CTAs

### Decision: default origin allowlist is **same-origin only**, extra origins are explicit opt-in

- **Why:** `postMessage` is the HTML5 cross-window messaging API — any page on the internet can iframe your customer's site and send messages to your widget. The security story lives or dies on the origin check. Defaulting to "accept everything" is how chat widgets ship vulnerable by default; defaulting to "same-origin only" is how Intercom/Drift/HubSpot ship theirs.
- **Decision:** The widget accepts `postMessage` only when `event.origin === window.location.origin`, **plus** any origins explicitly listed in `data-postmessage-origins="https://a.com,https://b.com"` on the script tag. Comma-separated, not JSON (friendlier data-attribute authoring).
- **Alternatives considered:**
  - *Same-origin + `window.parent` origin if in iframe:* more convenient for the common "widget in iframe, CTA in parent" case without config, but means any site that iframes the widget gets implicit control. Looser than we're comfortable with.
  - *Wildcard with a console warning:* footgun. Never a good default.

### Decision: message shape is `{source: 'chatbot-widget', type, payload}`, unknown types silently ignored

- **Why:** `postMessage` traffic is noisy — React DevTools, analytics libraries, browser extensions all send messages. The `source` marker is a namespace so we don't react to any of it. The `type` whitelist (`open|close|toggle|sendMessage|destroy|ping`) prevents accidental "just call any method" foot-extending if the API grows.
- **Silent failures.** Bad origin, bad source marker, unknown type, and malformed payload all produce *zero* side effects — no console log, no response. Rationale: a hostile page probing for bridge existence should learn nothing. The only response the bridge emits unprompted is the one-shot `ready` broadcast on widget creation.

### Decision: `destroy` is reachable via `postMessage`, same as the other methods

- **Why:** Symmetric with the same-window API — if you can `open` you can `destroy`. Origin allowlist still gates it. Useful for SPA route changes where the widget is iframe-embedded and the parent wants to tear it down.
- **Alternative considered:** Exclude `destroy` from the postMessage whitelist and keep it same-window only. Rejected because the customer could always remove the iframe element, which has the same effect; excluding it just forces the less ergonomic workaround.

### Decision: the bridge is module-level and installed once, NOT tied to widget instance lifecycle

- **Why:** The bridge is the public API's wire protocol for cross-window callers. It should work the same way whether a widget instance currently exists or not. After `destroy()`, postMessage calls still arrive at the listener, pass through the allowlist check, and end up queued in `pendingApiCalls` via the existing `enqueueOrRun` path — ready to fire against the **next** widget instance.
- **Alternative considered:** Install the listener in the constructor and remove it in `destroy()`. Rejected because it would leave postMessage calls during the "between instances" window silently dropped, which is confusing. A permanently installed listener is also cheap (one function attached to `window` forever).

### Decision: one-shot `ready` broadcast to `window.parent`, not a full event stream

- **Why:** Parents often need to know "is the widget up yet?" so they can enable their CTA button without polling. One broadcast on mount solves that with minimal surface area. A full event stream (`opened`, `closed`, `destroyed`, `message_received`, …) is tempting but opens up decisions about event schema, parent-side subscription management, and backward compatibility — all things we don't need yet.
- **Future direction:** If an event stream is needed later, add it as v2 with an explicit opt-in (`data-postmessage-events="true"`) so existing integrations don't get surprise traffic.
- **Commit:** `d240d99 feat(widget): postMessage bridge for iframe-separated CTAs`.

---

## Item D — Consolidate the three widget.js files into one

### Decision: deletion-based consolidation, no build step

- **Why:** The three files were `chatbot-platform/api/public/widget.js` (the real, production-served one), `chatbot-platform/widget/widget.js` (an unused dev fallback), and `widget.js` at the repo root (legacy cruft). The fallback was referenced by a two-path `widgetPath` lookup in `server.ts` that only activated if the production file was missing — which it never was. The root copy had zero loaders; it was dead code from the initial commit. Both unused copies were only reachable by code archaeology.
- **Alternative considered:** Keep `chatbot-platform/widget/widget.js` as the "source" location (feels more natural than editing a file under `api/public/`) and introduce a postbuild npm script that copies it into `api/public/` at build time. Rejected because:
  1. The dev fallback's architecture had already drifted to raw `ws` while `api/public/` moved to Socket.IO. Picking it as the source would force a re-port of every Socket.IO feature, Items B/C included.
  2. It adds a new build step — another thing to get wrong, another thing for Docker to handle. The current Dockerfile ships `api/public/` as-is, which is simple and already working.
  3. It doesn't eliminate drift, it just relocates the canonical copy. Same maintenance pattern.
- **Also considered:** Deleting the two stale Railway configs (`chatbot-platform/infra/Dockerfile`, `chatbot-platform/railway.json`) at the same time. Rejected because without Railway dashboard access I can't 100% confirm they aren't referenced by a separate service. Separate cleanup if desired.

### Decision: the canonical file remains at `chatbot-platform/api/public/widget.js`

- **Why:** It's already where the Dockerfile ships from and where `server.ts` serves from. Moving it would force Dockerfile edits for zero functional benefit. "Public" in the path reflects that the file is a public asset served to browsers — not a misuse of the directory.
- **Consequence:** Future edits to widget behaviour go to this one file. No mirror commits.

### Decision: `server.ts` resolver collapsed to a single path

- **Before:**
  ```ts
  const widgetPath = [
    path.resolve(__dirname, '../public/widget.js'),
    path.resolve(__dirname, '../../widget/widget.js'),
  ].find(p => { try { require('fs').accessSync(p); return true; } catch { return false; } })
    || path.resolve(__dirname, '../public/widget.js');
  ```
- **After:**
  ```ts
  const widgetPath = path.resolve(__dirname, '../public/widget.js');
  ```
- **Why:** The two-path resolver existed to handle a scenario (production file missing) that the Docker build made impossible in prod and that the local dev layout also made impossible. The fallback was essentially a legacy belt-and-suspenders. Removing it deletes code and eliminates a potential source of confusion ("which file does the server actually read?").
- **Verified:** `curl http://localhost:4081/widget.js` against the local dev server returns 200 with the expected content (including the postMessage bridge constants from commit `d240d99`) through the simplified resolver.

### Decision: no minification, no Terser, no `src/` → `dist/` split

- **Why:** These are nice-to-haves, not requirements. The widget file is ~52 KB unminified, which is already acceptable for a chat widget that's cached for an hour. Introducing Terser means adding a dev dependency, a build script, a watch pipeline for dev mode, and a stale-build problem. None of that is worth it until the file is demonstrably too large or hard to ship.
- **Future direction:** If the file grows past ~100 KB or a customer complains about first-paint cost, revisit and add Terser at that point. The single-source file layout makes that migration easy — just wrap the current file in a `src/` → `dist/` build and point the Dockerfile at the output.

### Commit and verification

- **Commit:** `chore(widget): consolidate to single canonical source file` on `feat/capabilities-rename-and-coderabbit`, cherry-picked to `main`.
- **Verification:**
  - `node --check chatbot-platform/api/public/widget.js` passes.
  - `tsc --noEmit` on the API passes.
  - `curl -I http://localhost:4081/widget.js` returns 200 + `content-type: application/javascript` + `x-request-id` header.
  - Served content contains the latest feature code (`POSTMESSAGE_SOURCE`, `installPostMessageBridge`, `_onWindowResize`) — confirms the resolver is reading the live file.
- **Rollback:** `git revert <consolidation commit>` restores the two deleted files and the two-path resolver. Cheap insurance.

---

## Future considerations (not yet decided)

- **`destroy({ clearSession: true })` signature.** Useful if `destroy` is reused as a "logout" primitive. Currently unused — add if a customer asks.
- **Event stream over postMessage.** `chatbot:opened`, `chatbot:closed`, `chatbot:message_sent`, etc. Opt-in via data attribute, broadcast with allowlist enforcement. See Item C decision notes.
- **Stale API key hygiene.** `test-widget.html` still references the production Railway API in its default URL. If the test tenant rotates keys, devs need to regenerate their localStorage seed. Consider a dedicated "dev sandbox" tenant documented in the setup README.
- **Playwright e2e infrastructure.** If these smoke tests start being re-run on every PR, the one-shot approach stops paying off — worth introducing `@playwright/test` at that point. Not needed today.
- **Subtle `_initSession` bug in `api/public/widget.js`** (line 1029-1046). The restore branch does not copy `session.messages` into `this.messages`. It happens to work today because `loadSession()` runs synchronously in the constructor first, but that's incidental. Add `this.messages = session.messages || []` inside the `if (session.sessionId && session.tenantId)` block as defense-in-depth.

---

## How commits reach production

Throughout Items A-C the flow has been:
1. Edit on `feat/capabilities-rename-and-coderabbit`
2. Commit with a narrow, descriptive message
3. Checkout `main`
4. Cherry-pick each commit (SHA-preserving, one at a time)
5. `npx tsc --noEmit` sanity check
6. `git push origin main`
7. Checkout `feat/capabilities-rename-and-coderabbit`

This keeps the feature branch linear and main up-to-date without merge commits. It will need to change the day this repo adopts PRs for widget work, but for now it matches how the rest of the `widget/*` commits on main were authored.
