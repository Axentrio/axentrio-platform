# Axentrio Mobile — Status & Handoff

_Snapshot of the mobile app effort. Pairs with [`mobile-app-architecture.md`](mobile-app-architecture.md) (the plan) and [`adr/0012-mobile-expo-over-capacitor.md`](adr/0012-mobile-expo-over-capacitor.md) (the decision)._

## TL;DR
The admin companion app (`mobile/`) is **built and verified end-to-end on the iOS simulator** against a **local API** (local Postgres/Redis + the dev Clerk instance). Sign-in → email-code MFA → org → all screens work, hitting real endpoints. All work is on `main`. Prod is healthy. Remaining work is gated on **issue #22** (Apple/Play/EAS accounts), which only the team can provision.

## What's built & verified
- **App (Expo SDK 55, RN 0.83, React 19.2.0):** auth (Clerk Core 3 + email-code MFA), org gate, tab nav, **Inbox** (live socket), **Conversation** (reply over socket + handoff actions), **Bookings** (accept/decline), **Leads** (infinite list), **Alerts** (mark read), **Settings** (account + sign out), offline (react-query persistence + online-aware send).
- **Shared workspace packages:** `@axentrio/{contracts,api-client,i18n}` (typed DTOs + axios envelope client + react-query keys), npm workspaces scoped to `mobile` + `packages/*` only.
- **#24 API backend (on `main`, additive migration `1785600000000`):** DB-backed notifications, `mobile_devices` registry, `/mobile/devices` routes, Bull→Expo-Push worker, and notify-on-event wiring (handoff / new lead / booking request).
- **Verified on device (iPhone 17 Pro sim, via Maestro `mobile/.maestro/sign-in.yaml`):** sign-in → MFA (`424242`) → org auto-select → Inbox; `/auth/me` + `/sessions` return 200; auto-provisions tenant/user into the local DB; correct empty/error states. Fixed 3 real bugs found this way: missing MFA step, OrgGate infinite loop, SocketProvider infinite loop.

## How to run locally
1. `docker compose -f docker-compose.local.yml up -d` (pgvector Postgres :5432; host Redis on :6379)
2. `cd api && ./scripts/dev-local.sh` (API on local DB/Redis + dev Clerk; secrets in gitignored `api/.env.local`; uses `DB_SYNCHRONIZE=true` to build schema from entities)
3. `cd mobile && npx expo run:ios` (dev build — Expo Go won't work; config in `mobile/.env`)
4. Test creds: `mobile.qa+clerk_test@example.com` / `AxentrioMobileQA!2026`, MFA code `424242`. Dev Clerk instance `innocent-pangolin-71`.

## What's left
**Gated on #22 (team provisions accounts):**
- **#7 Push client** — `expo-notifications` register/receive/deep-link. Backend (#24) is done; needs an EAS `projectId` for tokens + APNs/FCM creds to deliver. Android push is testable with just a free Expo project + FCM; iOS push needs the Apple Developer account.
- **#12 Store readiness** — privacy/Data-Safety labels, in-app account-deletion flow, review notes, screenshots, TestFlight + Play internal.
- **#13 Production submission** — store submit + EAS Update (OTA) channels.

**Not gated (nice-to-have / cleanup):**
- Seed local test data (chat sessions / a booking / a lead) to see populated screens instead of empty states.
- Confirm prod **portal notifications/alerts** still load now that `/notifications` is DB-backed on prod (sanity-check the migration applied).
- Scope `react-doctor` (the portal's web-React linter) to ignore `mobile/` so it stops flagging RN code on every mobile commit.
- Sign-in-with-Apple on iOS only matters if Google sign-in is enabled there (we ship email-only for v1 — see ADR §3).
- Per-message push was intentionally **deferred** (foreground socket covers the inbox; avoids notification noise) — revisit if backgrounded operators need it.

## Decisions & gotchas (don't relearn the hard way)
- **Expo over Capacitor** — Clerk's supported native path is `@clerk/expo`; Capacitor is off-path. See ADR 0012.
- **Pinned React 19.2.0** via root `overrides` (shadcn pulled a dup 19.2.7 → "invalid hook call" risk).
- **Migrate-from-scratch is broken** (`RenamePlansEnumToEssentialPro`, Postgres 55P04). Local builds schema from entities via `DB_SYNCHRONIZE=true` (default off → prod uses migrations as normal). Create extensions first: `uuid-ossp`, `vector`, `pg_trgm`.
- **`api/.env` points at PROD** (Crunchy DB + `pk_live` Clerk) — never repoint it at the dev instance; local overrides live in gitignored `api/.env.local`.
- **iOS `clearState` doesn't clear the Keychain** — Clerk session persists; uninstall the app to truly reset auth.

## Issue tracker (Axentrio/axentrio-platform)
Done: #23 scaffold, #25 auth, #26+#7(socket) inbox, #5 conversation, #8 bookings, #9 leads, #10 alerts/settings, #11 offline, #24 notifications backend.
Open: #7 push client, #12 store readiness, #13 production submission — all behind #22 (credentials).
