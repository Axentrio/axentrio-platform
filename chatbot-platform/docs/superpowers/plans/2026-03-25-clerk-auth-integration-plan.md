# Clerk Auth Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace custom JWT auth with Clerk for portal auth, fix session persistence, and enable proper multi-tenant admin onboarding.

**Architecture:** Clerk handles all portal authentication (login, sessions, token refresh). The API verifies Clerk tokens via `@clerk/express` middleware. An auto-provisioning middleware maps Clerk org/user IDs to DB tenant/user/agent records on first login. Widget API key auth is unchanged.

**Tech Stack:** Clerk (`@clerk/clerk-react`, `@clerk/express`, `@clerk/backend`), React 18, Express, TypeORM, PostgreSQL

**Spec:** `docs/superpowers/specs/2026-03-25-clerk-auth-integration-design.md`

**Plan structure:** 3 phases, each producing a testable checkpoint.
- Phase 1 (Tasks 1–6): API — deps, entities, middleware, routes. Checkpoint: `tsc` compiles, server boots with Clerk middleware.
- Phase 2 (Tasks 7–12): Portal — deps, hooks, providers, components. Checkpoint: portal builds, Clerk sign-in works.
- Phase 3 (Tasks 13–14): Deployment + cleanup. Checkpoint: end-to-end auth flow on Railway.

---

## Phase 1: API Changes

### Task 1: Install API Dependencies + Environment Config

**Files:**
- Modify: `api/package.json`
- Modify: `api/src/config/environment.ts`

- [ ] **Step 1: Install Clerk packages**

```bash
cd chatbot-platform/api
npm install @clerk/express @clerk/backend
```

- [ ] **Step 2: Add CLERK_SECRET_KEY to Zod schema in `environment.ts`**

In the `envSchema` object, add after the existing JWT section:

```typescript
// Clerk
CLERK_SECRET_KEY: z.string().min(1).default('clerk-dev-key-set-in-production'),
```

Use `.default()` for dev so the server doesn't crash without Clerk configured locally. The production check section should validate it's a real key:

```typescript
if (env.NODE_ENV === 'production') {
  if (env.CLERK_SECRET_KEY === 'clerk-dev-key-set-in-production') {
    throw new Error('CLERK_SECRET_KEY must be set in production');
  }
}
```

Add a `clerk` section to the config object:

```typescript
clerk: {
  secretKey: env.CLERK_SECRET_KEY,
},
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add package.json src/config/environment.ts
git commit -m "deps: add @clerk/express, @clerk/backend, add CLERK_SECRET_KEY to config"
```

---

### Task 2: Update Database Entities

**Files:**
- Modify: `api/src/database/entities/Tenant.ts`
- Modify: `api/src/database/entities/User.ts`

**Context:** Add `clerkOrgId` to Tenant and `clerkUserId` to User. Update the User role enum from `['admin', 'agent', 'viewer']` to `['admin', 'supervisor', 'agent']`. Since DB_SYNC is enabled on Railway, TypeORM will auto-apply schema changes.

- [ ] **Step 0 (safety): Migrate any `viewer` role records**

If the DB has any existing users with `role = 'viewer'`, the enum change will fail. Run this before changing the entity:

```sql
UPDATE users SET role = 'agent' WHERE role = 'viewer';
```

On Railway: `psql "$DATABASE_PUBLIC_URL" -c "UPDATE users SET role = 'agent' WHERE role = 'viewer';"`

- [ ] **Step 1: Add `clerkOrgId` to Tenant entity**

After the `apiKey` column, add:

```typescript
@Column({ type: 'varchar', length: 255, nullable: true, unique: true, name: 'clerk_org_id' })
clerkOrgId?: string;
```

- [ ] **Step 2: Add `clerkUserId` to User entity and update role enum**

After the `email` column, add:

```typescript
@Column({ type: 'varchar', length: 255, nullable: true, unique: true, name: 'clerk_user_id' })
clerkUserId?: string;
```

Update the role enum:

```typescript
export type UserRole = 'admin' | 'supervisor' | 'agent';

@Column({
  type: 'enum',
  enum: ['admin', 'supervisor', 'agent'],
  default: 'agent',
})
role!: UserRole;
```

Also update the helper methods — replace `isViewer` or any `viewer` references with `supervisor` equivalents. Check `canAccessAdminPanel()` — it should return true for admin and supervisor.

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/database/entities/Tenant.ts src/database/entities/User.ts
git commit -m "entities: add clerkOrgId/clerkUserId columns, update role enum to admin|supervisor|agent"
```

---

### Task 3: Create Clerk Auth + Auto-Provisioning Middleware

**Files:**
- Create: `api/src/middleware/clerk.middleware.ts`

**Context:** This is the core of the Clerk integration on the API side. Two middleware functions: `requireClerkAuth` (checks auth, returns 401/403) and `autoProvision` (maps Clerk IDs to DB IDs, creates records on first login).

- [ ] **Step 1: Create `clerk.middleware.ts`**

```typescript
/**
 * Clerk Authentication & Auto-Provisioning Middleware
 * Replaces custom JWT auth for portal-facing routes.
 * Widget routes continue using API key auth (unchanged).
 */
import { Request, Response, NextFunction } from 'express';
import { getAuth } from '@clerk/express';
import { clerkClient } from '@clerk/express';
import crypto from 'crypto';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { Agent } from '../database/entities/Agent';
import { logger } from '../utils/logger';

// --- Types ---

export interface ProvisionedRequest extends Request {
  clerkUserId?: string;
  clerkOrgId?: string;
  tenantId?: string;
  userId?: string;
  agentId?: string;
  userRole?: string;
  tenantName?: string;
  user?: {
    id: string;
    email: string;
    role: string;
    tenantId: string;
    type: 'agent' | 'widget';
  };
}

// --- In-memory cache ---

interface CachedIds {
  tenantId: string;
  userId: string;
  agentId: string;
  userRole: string;
  tenantName: string;
  email: string;
  cachedAt: number;
}

const idCache = new Map<string, CachedIds>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(orgId: string, userId: string): CachedIds | null {
  const key = `${orgId}:${userId}`;
  const cached = idCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;
  if (cached) idCache.delete(key);
  return null;
}

function setCache(orgId: string, userId: string, ids: Omit<CachedIds, 'cachedAt'>) {
  idCache.set(`${orgId}:${userId}`, { ...ids, cachedAt: Date.now() });
}

// --- Middleware: requireClerkAuth ---

export function requireClerkAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!auth.orgId) {
    res.status(403).json({ error: 'Organization required. Select an organization in the portal.' });
    return;
  }
  next();
}

// --- Middleware: autoProvision ---

export async function autoProvision(req: ProvisionedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = getAuth(req);
    const clerkUserId = auth.userId!;
    const clerkOrgId = auth.orgId!;

    // Check cache first
    const cached = getCached(clerkOrgId, clerkUserId);
    if (cached) {
      attachToRequest(req, clerkUserId, clerkOrgId, cached);
      return next();
    }

    const tenantRepo = AppDataSource.getRepository(Tenant);
    const userRepo = AppDataSource.getRepository(User);
    const agentRepo = AppDataSource.getRepository(Agent);

    // --- Resolve Tenant ---
    let tenant = await tenantRepo.findOne({ where: { clerkOrgId } });

    if (!tenant) {
      // Migration path: try to match existing tenant (if any)
      // For fresh installs, create new tenant
      let orgName = 'Organization';
      try {
        const org = await clerkClient.organizations.getOrganization({ organizationId: clerkOrgId });
        orgName = org.name;
      } catch {
        logger.warn('Could not fetch Clerk org name', { clerkOrgId });
      }

      const slug = await ensureUniqueSlug(orgName, tenantRepo);
      const apiKey = crypto.randomBytes(32).toString('hex');

      // Upsert to handle race conditions
      await tenantRepo
        .createQueryBuilder()
        .insert()
        .into(Tenant)
        .values({
          name: orgName,
          slug,
          apiKey,
          clerkOrgId,
          tier: 'pro',
          status: 'active',
        })
        .orIgnore() // ON CONFLICT DO NOTHING
        .execute();

      tenant = await tenantRepo.findOne({ where: { clerkOrgId } });
      if (!tenant) {
        res.status(500).json({ error: 'Failed to provision tenant' });
        return;
      }
      logger.info('Auto-provisioned tenant', { tenantId: tenant.id, orgName });
    }

    // --- Resolve User ---
    let user = await userRepo.findOne({ where: { clerkUserId } });

    if (!user) {
      // Migration path: match by email
      let email = 'unknown@user.local';
      let name = 'User';
      try {
        const clerkUser = await clerkClient.users.getUser(clerkUserId);
        email = clerkUser.emailAddresses?.[0]?.emailAddress || email;
        name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || name;
      } catch {
        logger.warn('Could not fetch Clerk user info', { clerkUserId });
      }

      // Check for existing user by email (migration)
      const existingByEmail = await userRepo.findOne({ where: { email, tenantId: tenant.id } });
      if (existingByEmail) {
        existingByEmail.clerkUserId = clerkUserId;
        await userRepo.save(existingByEmail);
        user = existingByEmail;
        logger.info('Linked existing user to Clerk', { userId: user.id, email });
      } else {
        // Determine role from Clerk org membership
        let role: 'admin' | 'supervisor' | 'agent' = 'agent';
        try {
          const memberships = await clerkClient.organizations.getOrganizationMembershipList({
            organizationId: clerkOrgId,
          });
          const membership = memberships.data?.find((m: any) => m.publicUserData?.userId === clerkUserId);
          if (membership?.role === 'org:admin') role = 'admin';
          else if (membership?.role === 'org:supervisor') role = 'supervisor';
        } catch {
          logger.warn('Could not fetch Clerk membership role', { clerkUserId, clerkOrgId });
        }

        // Upsert user
        await userRepo
          .createQueryBuilder()
          .insert()
          .into(User)
          .values({
            tenantId: tenant.id,
            clerkUserId,
            email,
            name,
            role,
            isActive: true,
          })
          .orIgnore()
          .execute();

        user = await userRepo.findOne({ where: { clerkUserId } });
        if (!user) {
          res.status(500).json({ error: 'Failed to provision user' });
          return;
        }
        logger.info('Auto-provisioned user', { userId: user.id, email, role });
      }
    }

    // --- Resolve Agent ---
    let agent = await agentRepo.findOne({ where: { userId: user.id } });

    if (!agent) {
      await agentRepo
        .createQueryBuilder()
        .insert()
        .into(Agent)
        .values({
          tenantId: tenant.id,
          userId: user.id,
          status: 'online',
          maxConcurrentChats: 5,
          skills: [],
          languages: ['en'],
        })
        .orIgnore()
        .execute();

      agent = await agentRepo.findOne({ where: { userId: user.id } });
      if (!agent) {
        res.status(500).json({ error: 'Failed to provision agent' });
        return;
      }
      logger.info('Auto-provisioned agent', { agentId: agent.id, userId: user.id });
    }

    // Cache and attach
    const ids = {
      tenantId: tenant.id,
      userId: user.id,
      agentId: agent.id,
      userRole: user.role,
      tenantName: tenant.name,
      email: user.email,
    };
    setCache(clerkOrgId, clerkUserId, ids);
    attachToRequest(req, clerkUserId, clerkOrgId, ids);
    next();
  } catch (error) {
    logger.error('Auto-provisioning error', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
}

// --- Helpers ---

function attachToRequest(req: ProvisionedRequest, clerkUserId: string, clerkOrgId: string, ids: Omit<CachedIds, 'cachedAt'>) {
  req.clerkUserId = clerkUserId;
  req.clerkOrgId = clerkOrgId;
  req.tenantId = ids.tenantId;
  req.userId = ids.userId;
  req.agentId = ids.agentId;
  req.userRole = ids.userRole;
  req.tenantName = ids.tenantName;

  // Backward compat for existing route handlers
  req.user = {
    id: ids.agentId,
    email: ids.email,
    role: ids.userRole,
    tenantId: ids.tenantId,
    type: 'agent',
  };
}

async function ensureUniqueSlug(name: string, tenantRepo: any): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'org';
  let slug = base;
  let attempt = 0;
  while (true) {
    const existing = await tenantRepo.findOne({ where: { slug } });
    if (!existing) return slug;
    attempt++;
    slug = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    if (attempt > 5) throw new Error('Failed to generate unique slug');
  }
}

// --- Exported for WebSocket auth ---

export async function resolveClerkIds(clerkUserId: string, clerkOrgId: string): Promise<CachedIds | null> {
  const cached = getCached(clerkOrgId, clerkUserId);
  if (cached) return cached;

  const tenantRepo = AppDataSource.getRepository(Tenant);
  const userRepo = AppDataSource.getRepository(User);
  const agentRepo = AppDataSource.getRepository(Agent);

  const tenant = await tenantRepo.findOne({ where: { clerkOrgId } });
  if (!tenant) return null;

  const user = await userRepo.findOne({ where: { clerkUserId } });
  if (!user) return null;

  const agent = await agentRepo.findOne({ where: { userId: user.id } });
  if (!agent) return null;

  const ids = {
    tenantId: tenant.id,
    userId: user.id,
    agentId: agent.id,
    userRole: user.role,
    tenantName: tenant.name,
    email: user.email,
  };
  setCache(clerkOrgId, clerkUserId, ids);
  return { ...ids, cachedAt: Date.now() };
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/middleware/clerk.middleware.ts
git commit -m "feat: add Clerk auth middleware with auto-provisioning and ID caching"
```

---

### Task 4: Update Server + Auth Routes

**Files:**
- Modify: `api/src/server.ts`
- Modify: `api/src/routes/auth.routes.ts`
- Delete: `api/src/routes/auth.ts`

**Context:** Wire `clerkMiddleware()` into the Express app globally. Rewrite auth.routes.ts to keep only widget auth and the new `/me` endpoint. Remove the seed endpoint, login, refresh, 2FA routes. Delete the dead `auth.ts` file.

- [ ] **Step 1: Update `server.ts`**

Add Clerk middleware import and apply globally before routes:

```typescript
import { clerkMiddleware } from '@clerk/express';
```

Add `app.use(clerkMiddleware())` after rate limiting, before routes. Remove the entire `/seed` endpoint block.

Update the CORS configuration to allow Clerk domains. In the `cors()` options, ensure the origin allows Clerk's auth domains:

```typescript
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      ...(Array.isArray(config.cors.origin) ? config.cors.origin : [config.cors.origin]),
    ].filter(Boolean);
    // Allow requests with no origin (mobile, curl) and Clerk domains
    if (!origin || allowed.includes('*') || allowed.includes(origin) || origin?.includes('.clerk.accounts.dev')) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for now, lock down later
    }
  },
  credentials: config.cors.credentials,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-Session-ID'],
}));
```

- [ ] **Step 2: Rewrite `auth.routes.ts`**

Keep:
- `POST /widget` — unchanged (API key auth, no Clerk)
- `GET /me` — rewritten to use Clerk auth + auto-provisioning

Remove:
- `POST /login`
- `POST /refresh`
- `POST /logout` (logout is now client-side via Clerk)
- `POST /2fa/setup`, `/2fa/verify`, `/2fa/disable`
- `GET /verify`

The new `/me` route:

```typescript
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';

router.get('/me', requireClerkAuth, autoProvision, async (req: ProvisionedRequest, res: Response): Promise<void> => {
  res.json({
    agentId: req.agentId,
    tenantId: req.tenantId,
    role: req.userRole,
    tenantName: req.tenantName,
    email: req.user?.email,
  });
});
```

- [ ] **Step 3: Delete `api/src/routes/auth.ts`**

```bash
rm src/routes/auth.ts
```

- [ ] **Step 4: Update route imports in all route files**

Any route file that imports `authenticateAgent` from `../middleware/auth.middleware` should be updated to import `requireClerkAuth` and `autoProvision` from `../middleware/clerk.middleware` instead. Files to update:

- `routes/chat.routes.ts`
- `routes/handsoff.routes.ts`
- `routes/agents.routes.ts`
- `routes/users.routes.ts`
- `routes/files.routes.ts`
- `routes/analytics.routes.ts`
- `routes/notifications.routes.ts`
- `routes/tenants.ts`

In each file, replace:
```typescript
import { authenticateAgent, AuthenticatedRequest } from '../middleware/auth.middleware';
```
with:
```typescript
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
```

And replace middleware usage on each route from `authenticateAgent` to `requireClerkAuth, autoProvision`. Replace `AuthenticatedRequest` with `ProvisionedRequest` in handler type annotations.

- [ ] **Step 5: Fix `req.user?.userId` references**

In `api/src/middleware/rate-limit.ts`, replace `req.user?.userId` with `req.user?.id`.
In `api/src/middleware/error-handler.ts`, replace `req.user?.userId` with `req.user?.id`.

- [ ] **Step 6: Verify compilation**

```bash
npx tsc --noEmit
```

Fix any remaining import/type errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: wire Clerk middleware into server, rewrite auth routes, update all route auth imports"
```

---

### Task 5: Update WebSocket Auth

**Files:**
- Modify: `api/src/websocket/socket.handler.ts`

**Context:** The socket auth middleware needs to verify Clerk tokens for portal agents using `verifyToken` from `@clerk/backend`. Widget API key auth remains unchanged.

- [ ] **Step 1: Update socket auth middleware**

Add import at top:
```typescript
import { verifyToken } from '@clerk/backend';
import { config } from '../config/environment';
import { resolveClerkIds } from '../middleware/clerk.middleware';
```

Replace the existing JWT-based portal auth in the `io.use()` middleware with:

```typescript
// Mode 1: Portal agent (Clerk token)
if (socket.handshake.auth?.token) {
  try {
    const verified = await verifyToken(socket.handshake.auth.token, {
      secretKey: config.clerk.secretKey,
    });
    const clerkUserId = verified.sub;
    const clerkOrgId = verified.org_id;

    if (!clerkOrgId) {
      return next(new Error('Authentication error: Organization required'));
    }

    const dbIds = await resolveClerkIds(clerkUserId, clerkOrgId);
    if (!dbIds) {
      return next(new Error('Authentication error: User not provisioned'));
    }

    socket.data.user = {
      id: dbIds.agentId,
      tenantId: dbIds.tenantId,
      role: dbIds.userRole,
      type: 'agent',
    };
    socket.data.tenantId = dbIds.tenantId;
    return next();
  } catch {
    return next(new Error('Authentication error: Invalid token'));
  }
}
```

Keep the widget API key auth branch unchanged.

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/websocket/socket.handler.ts
git commit -m "websocket: verify Clerk tokens for portal agents, keep widget API key auth"
```

---

### Task 6: Phase 1 Checkpoint — Verify API Compiles and Boots

- [ ] **Step 1: Full TypeScript check**

```bash
cd chatbot-platform/api
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 2: Build**

```bash
npm run build
```
Expected: `dist/` produced with no errors.

- [ ] **Step 3: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix: resolve any remaining type errors from Clerk migration"
```

---

## Phase 2: Portal Changes

### Task 7: Install Portal Dependencies + Config

**Files:**
- Modify: `portal/package.json`
- Modify: `portal/vite.config.ts`
- Modify: `portal/tsconfig.json`

- [ ] **Step 1: Install Clerk React SDK**

```bash
cd chatbot-platform/portal
npm install @clerk/clerk-react
```

- [ ] **Step 2: Add `VITE_CLERK_PUBLISHABLE_KEY` to `.env.example`**

Add to `portal/.env.example`:
```
# Clerk (required)
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...   # Get from Clerk dashboard → API Keys
```

Also add to `api/.env.example`:
```
# Clerk (required for production)
CLERK_SECRET_KEY=sk_test_...             # Get from Clerk dashboard → API Keys
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "deps: add @clerk/clerk-react, update .env.example with Clerk keys"
```

---

### Task 8: Create `useAppAuth` Hook + Token Provider

**Files:**
- Create: `portal/src/auth/useAppAuth.ts`
- Modify: `portal/src/services/apiClient.ts`

**Context:** The `useAppAuth` hook wraps Clerk's hooks into the interface the rest of the app expects. The token provider pattern bridges React's hook context to the Axios interceptor.

- [ ] **Step 1: Create `useAppAuth.ts`**

Create at `portal/src/auth/useAppAuth.ts` with the full implementation from the spec. Include:
- `useAppAuth()` hook that wraps `useUser()`, `useAuth()`, `useOrganization()`
- `mapClerkRole()` helper
- `checkPermission()` helper (port from existing authStore's `hasPermission`)
- Fetch DB IDs from `/auth/me` on first auth
- Error handling with retry state for the `/auth/me` fetch
- Export `useAppAuth`, `useUser` (re-export from Clerk), `useIsAuthenticated`

- [ ] **Step 2: Update `apiClient.ts` with token provider pattern**

Read the current file. Replace the localStorage token read in the request interceptor with the token provider pattern:

```typescript
let tokenProvider: (() => Promise<string | null>) | null = null;

export function setTokenProvider(provider: () => Promise<string | null>) {
  tokenProvider = provider;
}
```

Update the request interceptor to call `tokenProvider()`. Remove the 401 response interceptor that handles refresh (Clerk does this).

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/auth/useAppAuth.ts src/services/apiClient.ts
git commit -m "feat: add useAppAuth Clerk wrapper hook, token provider for API client"
```

---

### Task 9: Create OrganizationRequired Component

**Files:**
- Create: `portal/src/auth/OrganizationRequired.tsx`

**Context:** A wrapper that checks if the user has an active organization selected. If not, shows `<OrganizationList />` from Clerk to pick one.

- [ ] **Step 1: Create component**

```tsx
import React from 'react';
import { useOrganization, OrganizationList } from '@clerk/clerk-react';

export const OrganizationRequired: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { organization, isLoaded } = useOrganization();

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-1">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  if (!organization) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-surface-1">
        <h2 className="text-xl font-semibold text-text-primary mb-6">Select an Organization</h2>
        <OrganizationList
          appearance={{
            elements: {
              rootBox: 'mx-auto',
              card: 'bg-surface-2 border border-edge shadow-card',
              headerTitle: 'text-text-primary',
            },
          }}
        />
      </div>
    );
  }

  return <>{children}</>;
};
```

- [ ] **Step 2: Commit**

```bash
git add src/auth/OrganizationRequired.tsx
git commit -m "feat: add OrganizationRequired component for forced org selection"
```

---

### Task 10: Update App.tsx with ClerkProvider

**Files:**
- Modify: `portal/src/App.tsx`

**Context:** Wrap the entire app in `<ClerkProvider>`. Replace the auth-gated routing with Clerk's `<SignedIn>`/`<SignedOut>`. Wire the token provider. Add `<OrganizationRequired>` wrapper.

- [ ] **Step 1: Read current App.tsx and rewrite**

The new structure should be:

```tsx
import { ClerkProvider, SignedIn, SignedOut, SignIn, useAuth } from '@clerk/clerk-react';
import { OrganizationRequired } from '@auth/OrganizationRequired';
import { setTokenProvider } from '@services/apiClient';
```

Wrap everything in `<ClerkProvider>`:
- `<SignedOut>` → render `<SignIn />` styled with dark theme
- `<SignedIn>` → `<TokenProviderSetup>` → `<OrganizationRequired>` → existing `<AuthenticatedLayout>` with routes

`<TokenProviderSetup>` is a small component that wires `useAuth().getToken` to the API client:

```tsx
const TokenProviderSetup: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { getToken } = useAuth();
  useEffect(() => { setTokenProvider(getToken); }, [getToken]);
  return <>{children}</>;
};
```

Remove: import of Login page, the `/login` route, the `SocketProvider` wrapping if it depends on old auth store.

Update `SocketProvider` to be inside `SignedIn` + `OrganizationRequired`.

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wrap app in ClerkProvider, replace auth routing with Clerk SignIn/SignedIn"
```

---

### Task 11: Update Components to Use `useAppAuth`

**Files:**
- Modify: `portal/src/auth/ProtectedRoute.tsx`
- Modify: `portal/src/components/Sidebar.tsx`
- Modify: `portal/src/websocket/SocketContext.tsx`
- Modify: Any other files importing `useAuthStore`

**Context:** Replace all `useAuthStore()` calls with `useAppAuth()` across the portal. The `useAppAuth` hook provides the same interface so changes are mostly import swaps.

- [ ] **Step 1: Update ProtectedRoute.tsx**

Replace `useAuthStore` import/usage with `useAppAuth`. Simplify the auth check — Clerk handles token validation, we just check role.

- [ ] **Step 2: Update Sidebar.tsx**

Replace `useAuthStore` with `useAppAuth`. Update the logout button to use `useClerk().signOut()` — send `agent:leave` WebSocket event before signing out.

Add `<OrganizationSwitcher />` from `@clerk/clerk-react` in the sidebar for users in multiple orgs (optional, nice UX).

- [ ] **Step 3: Update SocketContext.tsx**

Replace `useAuthStore` with `useAuth()` from Clerk. Get token via `getToken()`. Add `reconnect_attempt` handler for fresh token on reconnect.

- [ ] **Step 4: Find and replace all other `useAuthStore` references**

Search for `useAuthStore` across all portal files. Common locations:
- `pages/Settings.tsx`
- `pages/Dashboard.tsx`
- `services/apiClient.ts` (already updated)
- Any component that reads `user` or `isAuthenticated`

Replace each with `useAppAuth()` or the specific Clerk hook needed.

- [ ] **Step 5: Delete Login.tsx**

```bash
rm src/pages/Login.tsx
```

It's replaced by Clerk's `<SignIn />` in App.tsx.

- [ ] **Step 6: Clean up authStore.ts**

Remove the entire Zustand store. Replace the file with just the re-exports from `useAppAuth`:

```typescript
// Backward compat — redirects to useAppAuth
export { useAppAuth as useAuthStore } from './useAppAuth';
export { useAppAuth } from './useAppAuth';
```

Or better: delete `authStore.ts` and update all imports to use `useAppAuth` directly. Choose whichever causes fewer changes.

- [ ] **Step 7: Verify build**

```bash
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: replace useAuthStore with useAppAuth across all components, delete Login.tsx"
```

---

### Task 12: Phase 2 Checkpoint — Verify Portal Builds

- [ ] **Step 1: Full build**

```bash
cd chatbot-platform/portal
npm run build
```
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 2: Verify no remaining `useAuthStore` references (except re-export shim if used)**

```bash
grep -r "useAuthStore" src/ --include="*.ts" --include="*.tsx" | grep -v "useAppAuth"
```
Expected: No results (or only the shim file).

- [ ] **Step 3: Verify no remaining `mock` references**

```bash
grep -r "mockLogin\|mockVerify\|mock_access_token" src/ --include="*.ts" --include="*.tsx"
```
Expected: No results.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve remaining portal build issues"
```

---

## Phase 3: Deployment + Testing

### Task 13: Deploy to Railway

**Files:**
- No code changes — Railway env vars and deployment

- [ ] **Step 1: Set Clerk env vars on API service**

```bash
railway service chatbot-api
railway variables --set "CLERK_SECRET_KEY=sk_live_YOUR_KEY_HERE" --skip-deploys
```

(Get the secret key from Clerk dashboard → API Keys)

- [ ] **Step 2: Deploy API**

```bash
railway service chatbot-api
railway up --detach
```

Wait for build + health check to pass.

- [ ] **Step 3: Set Clerk env vars on portal service**

```bash
railway service chatbot-portal
railway variables --set "VITE_CLERK_PUBLISHABLE_KEY=pk_live_YOUR_KEY_HERE" --skip-deploys
```

(Get the publishable key from Clerk dashboard → API Keys)

- [ ] **Step 4: Deploy portal**

```bash
railway service chatbot-portal
railway up --detach
```

Wait for build to complete.

- [ ] **Step 5: Configure Clerk dashboard**

In Clerk dashboard:
1. Set **Allowed origins** to include `https://chatbot-portal-production.up.railway.app`
2. Enable **Organizations** feature
3. (Optional) Create custom `org:supervisor` role under Settings → Roles
4. Create first Organization (e.g., "Demo Company")
5. Invite yourself as org admin

---

### Task 14: End-to-End Verification

- [ ] **Step 1: Verify API health**

```bash
curl https://chatbot-api-production-37df.up.railway.app/health
```
Expected: `{"status":"healthy"}`

- [ ] **Step 2: Open portal and sign in via Clerk**

Visit `https://chatbot-portal-production.up.railway.app`
Expected: Clerk sign-in page appears (dark themed)

Sign in with your Clerk account → select organization → dashboard loads.

- [ ] **Step 3: Verify auto-provisioning**

After first sign-in, check the database:
```bash
railway service Postgres
psql "$DATABASE_PUBLIC_URL" -c "SELECT id, name, clerk_org_id FROM tenants;"
psql "$DATABASE_PUBLIC_URL" -c "SELECT id, email, clerk_user_id, role FROM users;"
psql "$DATABASE_PUBLIC_URL" -c "SELECT id, user_id, status FROM agents;"
```
Expected: Records created with Clerk IDs populated.

- [ ] **Step 4: Verify WebSocket connects**

Open browser console on the portal. Should see `Socket connected: <id>` without auth errors.

- [ ] **Step 5: Verify widget auth still works**

```bash
curl -X POST https://chatbot-api-production-37df.up.railway.app/api/v1/auth/widget \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"<tenant-api-key>"}'
```
Expected: Returns a widget token (widget auth unchanged).

- [ ] **Step 6: Clean up — disable DB_SYNC**

```bash
railway service chatbot-api
railway variables --set "DB_SYNC=false"
```

---

## Post-Deployment Cleanup

After verifying everything works:

- [ ] Remove the `POST /seed` endpoint from server.ts (if not already removed in Task 4)
- [ ] Remove old JWT-related functions from `auth.middleware.ts` that are no longer called (`generateAgentToken`, `generateRefreshToken`, `refreshTokenRotation`, `verifyToken`) — keep `generateWidgetToken` and `authenticateWidget` for widget auth
- [ ] Remove `@clerk/express` `CLERK_PUBLISHABLE_KEY` from API env if it was accidentally set
- [ ] Consider: remove `password` column from User entity in a follow-up task
