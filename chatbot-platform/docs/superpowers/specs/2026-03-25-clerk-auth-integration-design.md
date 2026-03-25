# Clerk Auth Integration — Design Spec

**Date:** 2026-03-25
**Goal:** Replace custom JWT auth with Clerk for the portal. Fix auth persistence, token refresh, and session management. Keep widget API key auth unchanged.

---

## Context

The current auth system has several issues:
- Portal login was using mock functions (hardcoded demo credentials) until recently wired to API
- Token refresh has a response format mismatch (API returns `{ token }`, portal expects `{ data: { accessToken } }`)
- Manual JWT management in localStorage leads to stale tokens and broken WebSocket connections
- No proper admin onboarding flow — relies on a hacky `/seed` endpoint
- Password storage has no hashing in the user creation endpoint

Clerk replaces all of this with a managed auth service that handles login UI, session tokens, automatic refresh, and user management.

## Architecture

### Auth Boundaries

| Surface | Auth Method | Changes |
|---------|------------|---------|
| Portal (React dashboard) | Clerk sessions | Full replacement |
| API (Express, portal-facing routes) | Clerk token verification | Replace JWT middleware |
| API (widget-facing routes) | Tenant API key | No changes |
| WebSocket (portal agents) | Clerk session token | Token source changes |
| WebSocket (widget visitors) | API key + session | No changes |

### Multi-Tenancy Model

```
Clerk Organization  ←→  Tenant (PostgreSQL)
Clerk Org Member    ←→  User + Agent (PostgreSQL)
Clerk Org Role      ←→  User.role
```

**Role mapping:**

| Clerk Org Role | App Role | Notes |
|---|---|---|
| `org:admin` | `admin` | Full access — manages team, settings, analytics |
| `org:member` (default) | `agent` | Handles chats, views own analytics |
| Custom `org:supervisor` | `supervisor` | Views all chats, can reassign, view analytics |

The `supervisor` role requires creating a custom role in Clerk dashboard (Settings → Roles). This is a one-time setup. If the custom role doesn't exist, `org:member` maps to `agent`.

Note: The API User entity uses `'admin' | 'agent' | 'viewer'` while the portal types use `'admin' | 'supervisor' | 'agent'`. The implementation must unify these to `'admin' | 'supervisor' | 'agent'` (update the User entity enum).

### Organization Selection Requirement

Clerk's `orgId` is only present in the token when the user has actively selected an organization. The portal must force organization selection:

- In `<ClerkProvider>`, set `afterSignInUrl` to an org-selection page if no org is active
- Use `<OrganizationSwitcher />` or `<OrganizationList />` to let users select/switch orgs
- If `orgId` is null on an API request, return `403: Organization required`
- Users who belong to multiple orgs can switch between them (agent for multiple clients)

## Portal Changes

### Dependencies

```
@clerk/clerk-react
```

### Environment Variables

```
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...   # Clerk publishable key
```

### ClerkProvider Setup (App.tsx)

Wrap the app in `<ClerkProvider>`. Use `<SignedIn>` / `<SignedOut>` for auth gating. Force organization selection before showing the dashboard.

```tsx
<ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
  <SignedOut>
    <SignIn />
  </SignedOut>
  <SignedIn>
    <OrganizationRequired>
      <AuthenticatedLayout />
    </OrganizationRequired>
  </SignedIn>
</ClerkProvider>
```

`<OrganizationRequired>` is a thin wrapper that checks `useOrganization()` — if no org is selected, it shows `<OrganizationList />` to pick one.

### Auth Store Replacement (authStore.ts)

The Zustand auth store is replaced by Clerk hooks. A thin wrapper hook `useAppAuth()` bridges Clerk's hooks to the app's expected interface, minimizing refactoring in existing components.

The wrapper also fetches DB-specific IDs (tenant UUID, agent ID) from a `/auth/me` endpoint on first load, since Clerk IDs (`org_xxx`, `user_xxx`) don't match the UUIDs used throughout the app.

```tsx
export function useAppAuth() {
  const { user, isLoaded: userLoaded } = useUser();
  const { isSignedIn, getToken } = useAuth();
  const { organization, membership } = useOrganization();
  const [dbIds, setDbIds] = useState<{ tenantId: string; agentId: string } | null>(null);

  // Fetch DB IDs on first auth (auto-provisioning happens server-side)
  useEffect(() => {
    if (isSignedIn && organization && !dbIds) {
      getToken().then(token =>
        fetch(`${API_BASE_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
          .then(r => r.json())
          .then(data => setDbIds({ tenantId: data.tenantId, agentId: data.agentId }))
      );
    }
  }, [isSignedIn, organization]);

  return {
    user: user ? {
      id: dbIds?.agentId || user.id,  // DB Agent ID for existing route compat
      email: user.primaryEmailAddress?.emailAddress || '',
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      role: mapClerkRole(membership?.role),
      status: 'online',
      avatarUrl: user.imageUrl,
    } : null,
    isAuthenticated: !!isSignedIn,
    isLoading: !userLoaded || (isSignedIn && !dbIds),
    tenantId: dbIds?.tenantId,
    tenantName: organization?.name,
    getToken,
    logout: () => window.Clerk?.signOut(),
    hasPermission: (perm: string) => checkPermission(membership?.role, perm),
  };
}

function mapClerkRole(clerkRole?: string): 'admin' | 'supervisor' | 'agent' {
  if (clerkRole === 'org:admin') return 'admin';
  if (clerkRole === 'org:supervisor') return 'supervisor';
  return 'agent';
}
```

### API Client (apiClient.ts)

The API client needs Clerk tokens but lives outside React. Use a token provider pattern:

```typescript
// Token provider — set from React, used by Axios
let tokenProvider: (() => Promise<string | null>) | null = null;

export function setTokenProvider(provider: () => Promise<string | null>) {
  tokenProvider = provider;
}

// Request interceptor
api.interceptors.request.use(async (config) => {
  if (tokenProvider) {
    const token = await tokenProvider();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

In the app's root component, wire it up:
```tsx
const { getToken } = useAuth();
useEffect(() => { setTokenProvider(getToken); }, [getToken]);
```

Remove the 401 response interceptor that handles token refresh — Clerk manages this automatically.

### WebSocket Connection (SocketContext.tsx)

Get the token from Clerk. Handle token expiry on reconnect by fetching a fresh token:

```tsx
const { getToken } = useAuth();

const connectSocket = useCallback(async () => {
  const token = await getToken();
  const socket = io(WS_CONFIG.url, {
    ...WS_CONFIG.options,
    auth: { token },
  });

  // On reconnect, get fresh token (Clerk tokens are short-lived ~60s)
  socket.on('reconnect_attempt', async () => {
    const freshToken = await getToken();
    socket.auth = { token: freshToken };
  });
}, [getToken]);
```

### Login Page (Login.tsx)

Replace the custom login form with Clerk's `<SignIn />` component, styled to match the dark theme:

```tsx
<SignIn
  appearance={{
    elements: {
      rootBox: 'mx-auto',
      card: 'bg-surface-2 border border-edge shadow-card',
      headerTitle: 'text-text-primary',
      formFieldInput: 'bg-surface-3 border-edge text-text-primary',
      formButtonPrimary: 'bg-primary-600 hover:bg-primary-500',
    },
  }}
/>
```

### ProtectedRoute (ProtectedRoute.tsx)

Simplify to use Clerk's auth state:

```tsx
function ProtectedRoute({ requiredRoles, children }) {
  const { isAuthenticated, isLoading, user } = useAppAuth();
  if (isLoading) return <Spinner />;
  if (!isAuthenticated) return <RedirectToSignIn />;
  if (requiredRoles && !requiredRoles.includes(user.role)) return <AccessDenied />;
  return children;
}
```

### Files to Delete

- Mock login/2FA functions in `authStore.ts` (replace with `useAppAuth` wrapper)
- `portal/src/pages/Login.tsx` (replace with Clerk `<SignIn />` in App.tsx)

## API Changes

### Dependencies

```
@clerk/express @clerk/backend
```

### Environment Variables

```
CLERK_SECRET_KEY=sk_live_...    # Required — Clerk secret key for token verification
```

Add to `environment.ts` Zod schema:
```typescript
CLERK_SECRET_KEY: z.string().min(1, 'CLERK_SECRET_KEY is required'),
```

Note: `CLERK_PUBLISHABLE_KEY` is only needed on the portal, not the API.

### Middleware Replacement

Replace `authenticateAgent` with Clerk's middleware. Use `clerkMiddleware()` globally and `getAuth()` per route — NOT `requireAuth()` which is for full-stack apps and would redirect instead of returning 401.

```typescript
import { clerkMiddleware, getAuth } from '@clerk/express';

// Global middleware (parses Clerk token on all requests)
app.use(clerkMiddleware());

// Custom auth guard for API routes (returns 401, does NOT redirect)
function requireClerkAuth(req, res, next) {
  const { userId, orgId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!orgId) return res.status(403).json({ error: 'Organization required. Select an organization in the portal.' });
  next();
}

// Usage on routes
router.get('/chats', requireClerkAuth, autoProvision, async (req, res) => {
  // req.tenantId and req.agentId are set by autoProvision
});
```

### Auto-Provisioning Middleware

A new middleware that runs after Clerk auth, before route handlers. Handles first-login sync and maps Clerk IDs to DB IDs.

On each authenticated request:

1. Extract `orgId` and `userId` from `getAuth(req)`
2. Look up Tenant by `clerkOrgId = orgId`
3. If not found → check by org metadata for email domain match (migration path), then create if truly new
4. Look up User by `clerkUserId = userId`
5. If not found → check by email match (migration path for existing users), then create if truly new
6. If User exists without Agent → create Agent (defaults: `maxConcurrentChats: 5`, `skills: []`, `languages: ['en']`, `status: 'online'`)
7. Attach DB `tenantId`, `userId`, and `agentId` to `req`

**Race condition protection:** Use `INSERT ... ON CONFLICT (clerk_org_id) DO NOTHING` (TypeORM's `upsert` or `createQueryBuilder().insert().orIgnore()`) to prevent duplicate creation when multiple requests arrive simultaneously for a new user.

**Cache:** In-memory Map keyed by `orgId:userId` with 5-minute TTL. Cache stores DB IDs to avoid repeated lookups.

**Migration path for existing users:** On first Clerk login, if no User record has the `clerkUserId`, search by email. If a matching email is found, backfill `clerkUserId` on that User record and `clerkOrgId` on its Tenant. This prevents duplicate records for users who existed before Clerk migration.

**Auto-provisioning details for new Tenants:**

```typescript
// Generate slug from org name
const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
// Handle slug collision by appending random suffix
const uniqueSlug = await ensureUniqueSlug(slug);
// Generate API key for widget auth
const apiKey = crypto.randomBytes(32).toString('hex');
```

### Entity Updates

**Tenant entity** — add `clerkOrgId`:
```typescript
@Column({ type: 'varchar', length: 255, nullable: true, unique: true, name: 'clerk_org_id' })
clerkOrgId?: string;
```

**User entity** — add `clerkUserId`, unify role enum:
```typescript
@Column({ type: 'varchar', length: 255, nullable: true, unique: true, name: 'clerk_user_id' })
clerkUserId?: string;

@Column({
  type: 'enum',
  enum: ['admin', 'supervisor', 'agent'],  // was: ['admin', 'agent', 'viewer']
  default: 'agent',
})
role!: UserRole;
```

Note: The `password` column remains but becomes unused. Mark as nullable (it already is). Can be removed in a future migration.

### `GET /auth/me` Endpoint

Update to return DB IDs needed by the portal `useAppAuth()` hook:

```typescript
router.get('/me', requireClerkAuth, autoProvision, async (req, res) => {
  res.json({
    agentId: req.agentId,
    tenantId: req.tenantId,
    role: req.userRole,
    tenantName: req.tenantName,
  });
});
```

### `req` Shape After Auto-Provisioning

The auto-provisioning middleware attaches these to the Express request:

```typescript
interface ProvisionedRequest extends Request {
  clerkUserId: string;   // Clerk user ID (user_xxx)
  clerkOrgId: string;    // Clerk org ID (org_xxx)
  tenantId: string;      // DB Tenant UUID
  userId: string;        // DB User UUID
  agentId: string;       // DB Agent UUID
  userRole: string;      // Mapped role (admin/supervisor/agent)
  tenantName: string;    // Organization name
}
```

Existing route handlers currently read `req.user?.id` (which is the Agent ID) and `req.user?.tenantId`. The auto-provisioning middleware must also set `req.user` with the same shape for backward compatibility:

```typescript
req.user = {
  id: agent.id,        // Agent UUID — used by existing routes
  email: user.email,
  role: user.role,
  tenantId: tenant.id,
  type: 'agent',
};
```

### Routes to Remove

- `POST /auth/login` — Clerk handles login
- `POST /auth/refresh` — Clerk handles token refresh
- `POST /auth/2fa/*` — Clerk handles 2FA
- `POST /seed` — no longer needed

Also clean up `api/src/routes/auth.ts` (secondary auth file, possibly dead code — `server.ts` imports `auth.routes.ts`).

### Routes to Keep (unchanged)

- `POST /auth/widget` — widget API key auth (no Clerk)
- `GET /auth/me` — updated to return DB IDs
- All chat, handoff, agent, analytics, tenant, file, notification routes

### WebSocket Auth Update

Update the socket connection middleware to verify Clerk tokens using `verifyToken` from `@clerk/backend`:

```typescript
import { verifyToken } from '@clerk/backend';

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      // Verify Clerk session token
      const verified = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      const clerkUserId = verified.sub;        // User ID from JWT subject
      const clerkOrgId = verified.org_id;      // Org ID from claims

      if (!clerkOrgId) {
        return next(new Error('Authentication error: Organization required'));
      }

      // Look up DB IDs (use same cache as auto-provisioning)
      const dbIds = await resolveClerkIds(clerkUserId, clerkOrgId);
      socket.data.userId = dbIds.agentId;
      socket.data.tenantId = dbIds.tenantId;
      socket.data.user = {
        id: dbIds.agentId,
        tenantId: dbIds.tenantId,
        role: dbIds.role,
        type: 'agent',
      };
      return next();
    } catch {
      return next(new Error('Authentication error: Invalid token'));
    }
  }
  // Fall through to widget API key auth (unchanged)
  if (socket.handshake.query?.apiKey) {
    // ... existing widget auth logic
  }
  return next(new Error('Authentication required'));
});
```

## Logout Handling

When a user signs out via `useClerk().signOut()`:
1. Before calling signOut, send `agent:leave` WebSocket event to set agent status offline
2. Clerk clears the session
3. Portal redirects to sign-in

This preserves the existing behavior of updating agent status on logout.

## What Does NOT Change

- Widget authentication (API key based)
- All database entities (except adding clerkOrgId/clerkUserId columns and updating role enum)
- Chat, message, handoff, file upload logic
- WebSocket event handling (agent:join, chat:message, etc.)
- N8n integration
- Redis, Bull queue
- The dark theme UI (only Login page changes)
- Analytics, notifications, file handling routes

## Admin Onboarding Flow

1. Platform owner goes to Clerk dashboard → creates Organization "Client A"
2. Invites `admin@clienta.com` as org admin
3. Admin receives email → signs up via Clerk
4. Admin opens portal → Clerk `<SignIn />` → selects organization → authenticated
5. First API request triggers auto-provisioning:
   - Tenant created with `clerkOrgId`, auto-generated `slug` and `apiKey`
   - User + Agent created with `clerkUserId`
6. Admin sees their empty dashboard, can start configuring

## Security Considerations

- Clerk manages password hashing, brute-force protection, and email verification
- Session tokens are short-lived (~60s, auto-refreshed by Clerk SDK)
- `CLERK_SECRET_KEY` must never be exposed to the frontend
- Widget API key auth remains unchanged — validated server-side against Tenant.apiKey
- CORS: allow Clerk domains (`*.clerk.accounts.dev` or your custom Clerk domain) in addition to the portal origin
- Clerk env vars are required (not optional) — server will not start without them

## Implementation Notes

### Files referencing `req.user?.userId` (not `req.user?.id`)

These files use `req.user?.userId` which differs from the auto-provisioning `req.user.id` shape. Update during implementation:
- `api/src/middleware/rate-limit.ts` (line 28)
- `api/src/middleware/error-handler.ts` (lines 118-119)
- `api/src/routes/auth.ts` — to be removed entirely (dead code, `server.ts` imports `auth.routes.ts`)

### Error handling in `useAppAuth()` fetch

The `/auth/me` fetch in `useAppAuth()` must include a `.catch()` handler to prevent infinite loading on network failure. On error, set an `error` state and show a retry button instead of an infinite spinner.

### `/auth/me` endpoint consolidation

Two `/auth/me` endpoints exist (`auth.routes.ts` and `auth.ts`). Only the one in `auth.routes.ts` is active (imported by `server.ts`). The response contract changes from `{ success, user: {...} }` to `{ agentId, tenantId, role, tenantName }`. The old shape is unused after Clerk migration since `useAppAuth()` replaces all callers.

### Data migration for `viewer` role

Before altering the User role enum from `['admin', 'agent', 'viewer']` to `['admin', 'supervisor', 'agent']`, run:
```sql
UPDATE users SET role = 'agent' WHERE role = 'viewer';
```
This prevents enum validation failures on existing records.
