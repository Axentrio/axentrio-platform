# Mobile apps use Expo (React Native), not a Capacitor webview wrapper

We are shipping Axentrio to the App Store and Play Store as an **admin-only companion app** for the business operators who run a bot — never a consumer app (consumers continue to reach businesses through the existing Facebook / Instagram / WhatsApp channels). The decision was which native technology to build it on, given that `portal/` is a mature React 18 + Vite SPA authenticated with Clerk.

We build a **separate Expo (React Native) app** using `@clerk/expo`, beside `api/` and `portal/`. We reuse the API, types, and data-layer logic from the portal, but **not** its UI. We rejected wrapping `portal/dist` in a Capacitor webview, and we rejected a fully-native two-codebase (Swift + Kotlin) build.

## Why not Capacitor

The generic 2026 advice ("you already have a web app → wrap it in Capacitor, ship in days") assumes a normal auth stack. Ours is Clerk, and Clerk inverts the advice:

- **Clerk is off the golden path in Capacitor.** Clerk's web SDK (`@clerk/clerk-react`) depends on cookies, a registered production Frontend-API domain, and same-origin assumptions. A Capacitor webview runs on `capacitor://localhost` (iOS) / `https://localhost` (Android) — not `app.axentrio.com` — which breaks production-key origin validation, the `__client`/`__session` cookie model (WKWebView/ITP block third-party cookies), and the ~50s FAPI token-refresh loop. Auth tends to *appear* to work in a quick demo, then fail after backgrounding, cold start, or token expiry. There is **no official Clerk Capacitor support**.
- Making it work would mean hand-building an **unsupported ticket-handoff auth bridge** (system-browser OAuth → one-time code → sign-in token → `setActive` → secure token cache) and proving it survives cold start, >60s background, app-kill, offline→online, revoked sessions, MFA, and org selection on real devices. That bridge was the single largest risk to the timeline.
- A Capacitor wrapper is also the weakest posture against **App Store Guideline 4.2** (a repackaged website can be rejected for minimum functionality), and Socket.IO does not survive iOS backgrounding, so we need a real native push path regardless.

## Why Expo specifically

- **Clerk's entire 2026 native investment is Expo.** `@clerk/expo` 3.x (Core 3, March 2026) is production-stable token-based auth (SecureStore cache, `getToken()`), and shipped native Google Sign-In that eliminates the exact browser-redirect dance that was the Capacitor risk. (The prebuilt *native UI components* — `<AuthView/>`, `<UserButton/>` — are still beta as of June 2026; we do not depend on them and build the sign-in screen with the production-stable hooks, adopting them later if they go GA.)
- **The backend barely changes.** `api/` already verifies Clerk Bearer JWTs (`clerkMiddleware`, `requireClerkAuth`, `autoProvision`). Mobile calls `getToken()` and sends `Authorization: Bearer` — the same contract the portal uses, minus cookies.
- **We don't need full dashboard parity on a phone.** An on-the-go operator needs inbox + reply, push for new leads/bookings/handoffs, and bookings/leads triage — roughly 6–10 focused screens, not the whole 40-screen portal. Once we're building a focused subset anyway, Capacitor's "reuse all the UI for free" advantage mostly evaporates, while Expo's first-class push, deep links, secure storage, and best-in-class 4.2 posture dominate.

## Why not fully-native (Swift + Kotlin)

Two separate codebases is all the cost of native with none of the code-sharing, wrong for a small React team shipping an admin companion. Reserved only for a hypothetical future native-first product, which this is not.

## Consequences

- We rebuild the mobile UI (RN components + NativeWind for shared Tailwind tokens); we reuse types, the API client, react-query hook factories, the role map, and i18n via shared workspace packages.
- Realtime splits into **Socket.IO for foreground** live inbox and **Expo push for background** — the in-memory notifications route becomes DB-backed and gains a device-token registry fed by the existing Bull queue.
- Tooling standardizes on **EAS** (Build + Submit + Update); the Railway web/api deploy is untouched.
- Full architecture, v1 scope, and roadmap live in [`docs/mobile-app-architecture.md`](../mobile-app-architecture.md).
