# Axentrio Mobile App — Architecture & Tooling Plan

Plan for shipping Axentrio to the **App Store** and **Play Store**. Decision record for the core technology choice: [`docs/adr/0012-mobile-expo-over-capacitor.md`](adr/0012-mobile-expo-over-capacitor.md).

> Status: planning. No mobile code exists yet. This document is the architecture an engineer executes against.

## 1. What we are building

A **focused, admin-only companion app** for the business operators who run an Axentrio bot. It is **not** full parity with the web dashboard, and it is **not** a consumer app — consumers continue to reach businesses via the existing Facebook / Instagram / WhatsApp channels.

- **Audience:** business operators (admin / supervisor / agent roles), on the go.
- **Job to be done:** answer live conversations, get alerted to new leads / bookings / handoffs, triage bookings and leads from a phone.
- **The web portal stays the full control plane** — Bot Editor, knowledge management, deep analytics, billing, channel setup, team management all remain web-only.

**Technology:** a separate **Expo (React Native)** app authenticated with **`@clerk/expo`**, talking to the existing Express API over Clerk Bearer JWTs. See the ADR for why Expo over Capacitor / fully-native.

## 2. v1 scope (ruthlessly minimal)

| Screen | v1 behavior | API / realtime surface |
|---|---|---|
| **Auth + org picker** | Existing-operator sign-in only (no mobile org creation). Multi-org switch. | `@clerk/expo`, `GET /auth/me`, `useOrganizationList()` + `setActive({ organization })` |
| **Inbox** | Active / handoff conversations; filters; unread + last message. | `GET /chats/sessions`; socket `message:new`, `handoff:requested`, `handoff:assigned` |
| **Conversation** | Read history, join session, send reply, typing, accept handoff, close / return-to-bot. Drafts persist locally. | `GET /chats/:id`, `GET /chats/:id/history`; socket `session:join`, `message:send`, `typing:indicator`, `handoff:accept`; HTTP fallback `POST /handoffs/accept`, `POST /chats/:id/close`, `POST /handoffs/return` |
| **Alerts** | Durable notification inbox; mark read; deep-link to chat / lead / booking. | DB-backed `GET/PATCH /notifications` (replaces in-memory route); push registration endpoints |
| **Bookings** | Upcoming / past / requests. v1 actions: accept / decline request-created bookings. Confirmed booking is read-only + contact / open-calendar. | `GET /scheduler/bookings?scope=upcoming\|past\|requests`, `POST /scheduler/bookings/:id/accept`, `POST /scheduler/bookings/:id/decline` |
| **Leads** | Infinite list; lead detail; tap through to captured conversation when `sessionId` exists. | `GET /leads?cursor=...`, `GET /chats/:id` |
| **Account / settings-lite** | Profile, notification prefs, org switch, sign out, account-deletion request. | `GET/PATCH /users/profile`, `PATCH /users/preferences`, push-token unregister |

**Explicitly out of v1:** Bot Editor, knowledge management, deep analytics, billing / upgrade CTAs, full settings, channel setup, automations, team management, imports/exports, service-catalog editing, reschedule/cancel booking UI.

## 3. Auth wiring

The auth foundation is **production-stable** (`@clerk/expo` 3.x / Core 3, March 2026). Only Clerk's prebuilt *native UI components* (`<AuthView/>`, `<UserButton/>`) are still beta as of June 2026 — we **do not depend on them**; we build the sign-in screen with the stable hooks and can adopt them later if they reach GA.

- **Provider:** `ClerkProvider` with `tokenCache` backed by `expo-secure-store`. Token-based session, not cookies. Requires Expo SDK 53+ (pin exact versions).
- **Per-request token:** mobile calls `getToken()` and sets `Authorization: Bearer <token>` on the Axios client. Socket.IO uses an async `auth` callback that fetches a fresh `getToken()` on **every** reconnect (same pattern as the portal).
- **Backend changes: minimal.** `api/` already verifies Clerk Bearer JWTs (`clerkMiddleware`, `requireClerkAuth`, `autoProvision`). No cookie/FAPI changes needed for native.
- **Org selection is required** because the backend keys on `org_id`. If no active org, show an org picker → `setActive({ organization })` → refetch `/auth/me`. Clear React Query + socket state on org switch.
- **Role gating:** the server remains the authority. Use the DB role from `/auth/me` for UI gating only. Scheduler mutations are admin-only; reads are admin/supervisor/agent. If leads must be hidden from agents, enforce it with **backend** role middleware — client-side hiding is not enough.
- **Sign-out:** best-effort unregister the device push token → Clerk `signOut()` → clear query persistence + drafts. Treat any `401` as session-invalid and return to auth.
- **`authorizedParties` / origins:** native API calls do **not** need CORS origins (keep CORS for the portal domains). If you later enforce `authorizedParties` in `clerkMiddleware`, verify the mobile JWT `azp` claim first. Production Clerk setup does require registering native app credentials and SSO redirect allowlisting.

**Apple 4.8 — resolved for v1: email-only auth on mobile.** The portal uses Clerk's prebuilt `<SignIn>` (`portal/src/App.tsx`); OAuth providers are a Clerk Dashboard setting, not in code, so the codebase doesn't reveal whether Google/Facebook is enabled on web. To avoid the 4.8 requirement entirely, **v1 mobile shows email-based auth only (email/password + email OTP) with no third-party social buttons on iOS** — Clerk scopes enabled strategies per application, so the mobile instance simply omits social. If Google is wanted on iOS later, add **Google + Sign in with Apple together**, never Google alone. (Confirm the web instance's enabled providers in the Clerk Dashboard when configuring the mobile instance.)

## 4. Realtime + push

Split by app state:

- **Foreground → Socket.IO.** Connect while foreground; auto-join `agents:<tenantId>`; join individual sessions only on the conversation screen. Drives live inbox updates and composer acks.
- **Background → Expo push.** Socket.IO does not survive iOS backgrounding. Use **`expo-notifications` + the Expo Push Service** for v1 (simplest credential story with EAS). Also capture the raw native token so a later migration to direct APNs/FCM is possible.

**New backend pieces:**

- `POST /api/v1/mobile/devices` — register `{ expoPushToken, nativeToken?, platform, deviceId, appVersion, buildNumber, runtimeVersion, locale, timezone, permissionStatus, environment }`.
- Tables:
  - `mobile_devices` — `id, tenantId, agentId, clerkUserId, <token fields>, platform/app metadata, lastSeenAt, revokedAt`.
  - `notifications` — `id, tenantId, recipientAgentId, type, title, body, data, readAt, dedupeKey, timestamps` (DB-backed replacement for the current in-memory `/notifications`).
  - `notification_deliveries` — `notification, device, ticket, receipt, error`.
- **Wiring:** hook into existing event sources — `message:new`, handoff creation, `lead.created`, `appointment.booked`, `booking.request_created`. Reuse the existing **Bull `notifications` queue**, but make it durable: create notification rows idempotently (use `dedupeKey`), enqueue delivery, fan out to valid devices, process Expo receipts, retire invalid tokens.
- **Payloads stay generic** ("New handoff request", "New booking request") with IDs in `data` — **no customer PII in push bodies**.
- **Platform realities:** iOS needs the push entitlement + a permission prompt (ask contextually, not on first launch); Android 13+ needs the runtime notification permission and notification channels. Test on physical devices / TestFlight / Play internal, never just the simulator.

## 5. Code reuse & monorepo layout

```text
api/                  # unchanged (Express + Socket.IO + Bull + Clerk JWT)
portal/               # unchanged (Vite web dashboard — the full control plane)
mobile/               # NEW Expo app
packages/contracts/   # shared TS DTOs / Zod contracts
packages/api-client/  # shared Axios client + react-query hook factories + query keys
packages/i18n/        # shared translation JSON
```

- **Workspaces:** npm workspaces (repo is already on `package-lock.json`; pnpm is optional, not required for v1).
- **Reuse:** response-envelope Axios client, query keys, TanStack Query hook factories, shared DTOs/contracts, date/status helpers, role-permission map, i18n JSON.
- **Do NOT reuse:** shadcn / Radix DOM components, React Router screens, browser notifications/audio, Recharts, Tailwind DOM classes.
- **RN UI approach:** **NativeWind** to reuse color/spacing **design tokens** (not portal components) + a small RN component layer (buttons, lists, chips, sheets, forms). `expo-router` for navigation, `FlashList` for long lists, native bottom sheets for actions, `lucide-react-native` for icons.

## 6. Tooling / CI-CD

All-in on **EAS** — do **not** introduce Fastlane for v1.

- **EAS Build + EAS Submit + EAS Update (OTA).**
- **Build profiles** (`eas.json`):
  - `development` — dev client, local/staging API, Clerk dev.
  - `preview` — internal / TestFlight / Play internal, staging API.
  - `production` — store builds, Railway prod API, Clerk prod.
- **Signing:** EAS-managed credentials. Configure Apple App Store Connect API key, Google Play service account, APNs key, FCM v1 credentials.
- **Config:** `app.config.ts` owns bundle IDs, scheme, Clerk plugin, notifications plugin, EAS project ID, env-specific API URLs. Only `EXPO_PUBLIC_*` values ship in the app; secrets live in EAS, never in the bundle.
- **Distribution:** TestFlight + Play internal testing first, then closed/open testing, then staged production rollout.
- **OTA policy (EAS Update):** allowed for JS, copy, styling, assets, low-risk bug fixes. **Store review still required** for: native modules, Expo SDK bumps, config-plugin changes, permission/entitlement changes, icon/splash, runtime-version changes, and any risky auth/push change.
- **Coexistence:** the Railway web/api deploy is untouched. Ship the API push / notifications / device-registration changes **before** the store build that depends on them.

## 7. Offline (minimal degradation)

- Persist the React Query cache for inbox / bookings / leads / notifications.
- Persist message drafts locally.
- **Do not** queue-and-send live replies while offline in v1 — disable send until connected (avoids duplicate / stale customer messages).
- Retry push-token registration and preference sync when connectivity returns.

## 8. App Store / Play compliance

- **No in-app purchasing.** Stripe billing stays on web; hide all pricing / upgrade / checkout / "manage plan" CTAs on mobile. Apple **3.1.3(f)** supports a free companion app to a paid web tool when there is no in-app purchase or purchase CTA.
- **Apple 4.2 (minimum functionality):** strong posture — this is genuinely native and useful (push, native auth, live inbox + replies, bookings/leads triage), not a wrapper.
- **Apple 4.8:** Sign in with Apple required on iOS if Google sign-in is offered (see §3).
- **Account deletion:** provide a discoverable in-app "Request account deletion" path + a web deletion URL for the Play Console. For org-owned B2B accounts, route to an auditable backend / support flow.
- **Privacy / Data Safety labels:** disclose Clerk, Expo push, Sentry, push tokens / device identifiers, contact info, user content (chats / leads / bookings), diagnostics, and retention/deletion.
- **Review notes:** demo org credentials; explain admin-only B2B use, no consumer app, no purchase flow; exact push-test steps.

## 9. Roadmap

1. Scaffold `mobile/` + workspaces; **pin Expo + Clerk versions**; produce dev builds.
2. Auth + org switch + `/auth/me`; Axios + Socket.IO Bearer wiring.
3. Durable notifications + device-token endpoint + Bull delivery processor + Expo push credentials.
4. Inbox + conversation reply + handoff.
5. Bookings + leads + alerts + settings-lite.
6. Physical-device QA → TestFlight / Play internal → privacy labels + review notes.
7. Production store release; then OTA-only for compatible JS fixes.

## 10. Riskiest unknowns to de-risk first

- `@clerk/expo` 3.x **native UI components are beta** — pin versions, verify APIs, don't hard-depend on them.
- Production Apple / Google **native credential setup** (APNs key, FCM v1, provisioning, ASC API key) takes longer than "install a plugin."
- **Push idempotency** across the existing event paths (use `dedupeKey`, collapse noisy message events).
- **Store review of a login-walled admin-only app** (mitigate with demo creds + clear review notes).
- **Account-deletion semantics** for org-owned B2B users.
- **Socket.IO multi-replica — resolved: safe today.** `api/railway.toml` pins `numReplicas = 1`, and the Redis adapter is wired in `api/src/websocket/socket.handler.ts` (attaches when Redis is reachable; Redis is already hard infra via Bull). Foreground sockets + `agents:<tenantId>` broadcasts are correct as-is. Latent risk only if `numReplicas` is raised past 1 without Redis confirmed — there is no fail-fast guard, so add one (boot-time: fail if `numReplicas > 1` and Redis unavailable) before scaling horizontally.
- Silent timeline killers: Apple Developer enrollment latency (D-U-N-S / business identity), TestFlight/Play-internal setup, macOS-free EAS cloud builds (so no local macOS runner needed — a point in EAS's favor).

---

*Derived from three planning rounds (Capacitor plan → adversarial pressure-test → Expo plan) cross-checked against Clerk, Expo, EAS, and 2026 Apple/Google policy docs.*
