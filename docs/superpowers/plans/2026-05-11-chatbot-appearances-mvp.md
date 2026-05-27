# Chatbot Appearances MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the placeholder `Chatbot Appearances` tab at `/ai?tab=appearances` into a real settings page that controls primary color, bot avatar URL, launcher position, and launcher label for the embedded customer-facing widget, including matching runtime support in `widget.js`.

**Architecture:** New `settings.widget` JSONB namespace alongside the existing `settings.theme` and `settings.ai`. One authenticated PATCH/GET endpoint mounted under the existing `/tenants/me` group writes both `theme.primaryColor` and `widget.*` atomically. The public `/widget/config` route is extended with an `appearance` block. The portal gets a new form + live React preview pane in the existing AI tab structure. The greeting message is NOT a new field — it stays at `settings.ai.guardrails.greetingMessage` (already shipped) and the preview surfaces it read-only with a link back to AI Bot settings.

**Tech Stack:** TypeScript, Express, TypeORM, Zod, Vitest, React, react-query, TanStack Query, Clerk auth, shadcn/ui, Tailwind, Radix.

**Spec:** [`2026-05-11-chatbot-appearances-mvp-design.md`](../specs/2026-05-11-chatbot-appearances-mvp-design.md)

**Route path note:** The spec wrote `/api/v1/widget/appearance` as an example. The codebase convention (`api/src/server.ts:206-211`) mounts tenant-scoped routes under `/api/v1/tenants/me`. To match the existing AI settings route (`/api/v1/tenants/me/ai-settings`), this plan uses **`/api/v1/tenants/me/widget-appearance`** for the authenticated PATCH/GET endpoint. The public `/widget/config` endpoint is unaffected — it stays at `/api/v1/widget/config`.

---

## Commit A — `feat(api): add widget appearance schema and entity types`

Inert backend type/contract additions. No behavior change, no new route yet.

### Task 1: Add `widget` namespace to Tenant.settings type

**Files:**
- Modify: `chatbot-platform/api/src/database/entities/Tenant.ts:61-131`

- [ ] **Step 1: Open the entity file and locate the existing `settings!:` declaration block.**

The current declaration starts at line 61 with `@Column({ type: 'jsonb', default: {} })` followed by `settings!: { … }` containing `theme?`, `features?`, `businessHours?`, `ai?`, `integrations?`, `skills?`, `automations?`.

- [ ] **Step 2: Add a new optional `widget?` sub-object inside the `settings` type.**

Insert immediately AFTER the `theme?: { … }` block (so the new field reads cleanly next to its sibling `theme`):

```ts
widget?: {
  avatarUrl?: string | null;
  launcherPosition?: 'bottom-right' | 'bottom-left';
  launcherLabel?: string | null;
};
```

- [ ] **Step 3: Run the TypeScript compiler in dry-run mode to confirm the type addition compiles.**

Run from `chatbot-platform/api/`:
```bash
npx tsc --noEmit
```
Expected: no errors related to `Tenant.ts` (existing unrelated errors, if any, are out of scope).

### Task 2: Create the Zod schema file with unit tests

**Files:**
- Create: `chatbot-platform/api/src/schemas/widget-appearance.schema.ts`
- Create: `chatbot-platform/api/src/__tests__/unit/widget-appearance.schema.test.ts`

- [ ] **Step 1: Write the failing schema test first.**

Create `chatbot-platform/api/src/__tests__/unit/widget-appearance.schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { updateWidgetAppearanceSchema } from '../../schemas/widget-appearance.schema';

describe('updateWidgetAppearanceSchema', () => {
  it('accepts a fully populated valid payload', () => {
    const result = updateWidgetAppearanceSchema.safeParse({
      primaryColor: '#6366f1',
      avatarUrl: 'https://example.com/avatar.png',
      launcherPosition: 'bottom-left',
      launcherLabel: 'Chat with us',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object (all fields optional)', () => {
    const result = updateWidgetAppearanceSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts empty strings for nullable fields (controller normalizes to null later)', () => {
    const result = updateWidgetAppearanceSchema.safeParse({
      avatarUrl: '',
      launcherLabel: '',
    });
    expect(result.success).toBe(true);
  });

  it('accepts null for nullable fields', () => {
    const result = updateWidgetAppearanceSchema.safeParse({
      avatarUrl: null,
      launcherLabel: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects malformed primaryColor (must be 6-digit hex)', () => {
    const result = updateWidgetAppearanceSchema.safeParse({ primaryColor: 'red' });
    expect(result.success).toBe(false);
  });

  it('rejects non-URL avatarUrl values', () => {
    const result = updateWidgetAppearanceSchema.safeParse({ avatarUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('rejects launcherPosition values outside the enum', () => {
    const result = updateWidgetAppearanceSchema.safeParse({ launcherPosition: 'top-right' });
    expect(result.success).toBe(false);
  });

  it('rejects launcherLabel longer than 30 characters', () => {
    const result = updateWidgetAppearanceSchema.safeParse({
      launcherLabel: 'x'.repeat(31),
    });
    expect(result.success).toBe(false);
  });

  it('rejects avatarUrl longer than 2048 characters', () => {
    const result = updateWidgetAppearanceSchema.safeParse({
      avatarUrl: 'https://example.com/' + 'a'.repeat(2050),
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails (schema file does not exist yet).**

Run from `chatbot-platform/api/`:
```bash
npx vitest run src/__tests__/unit/widget-appearance.schema.test.ts
```
Expected: FAIL with module-not-found error on `widget-appearance.schema`.

- [ ] **Step 3: Create the schema file.**

Create `chatbot-platform/api/src/schemas/widget-appearance.schema.ts`:

```ts
import { z } from 'zod';

export const updateWidgetAppearanceSchema = z.object({
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'primaryColor must be a 6-digit hex like #6366f1')
    .optional(),
  avatarUrl: z
    .string()
    .url()
    .max(2048)
    .optional()
    .nullable()
    .or(z.literal('')),
  launcherPosition: z.enum(['bottom-right', 'bottom-left']).optional(),
  launcherLabel: z
    .string()
    .max(30)
    .optional()
    .nullable()
    .or(z.literal('')),
});

export type UpdateWidgetAppearanceInput = z.infer<typeof updateWidgetAppearanceSchema>;
```

- [ ] **Step 4: Run the test and confirm it passes.**

```bash
npx vitest run src/__tests__/unit/widget-appearance.schema.test.ts
```
Expected: all 9 tests pass.

- [ ] **Step 5: Commit Commit A.**

```bash
cd "/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy Chatbot op Railway"
git add chatbot-platform/api/src/database/entities/Tenant.ts \
        chatbot-platform/api/src/schemas/widget-appearance.schema.ts \
        chatbot-platform/api/src/__tests__/unit/widget-appearance.schema.test.ts
git commit -m "feat(api): add widget appearance schema and entity types

Tenant.settings now declares a widget namespace (avatarUrl, launcherPosition,
launcherLabel) alongside the existing theme namespace. New Zod schema validates
PATCH payloads and accepts empty-string for nullable fields (controller will
normalize to null before write).

No runtime behavior change — types and schema only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Commit B — `feat(api): add widget appearance PATCH/GET route`

The endpoint exists but nothing reads or writes through it yet.

### Task 3: Write failing controller tests for GET and PATCH

**Files:**
- Create: `chatbot-platform/api/src/__tests__/unit/widget-appearance.controller.test.ts`

- [ ] **Step 1: Author the test file with both GET and PATCH cases.**

Create `chatbot-platform/api/src/__tests__/unit/widget-appearance.controller.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import {
  getWidgetAppearance,
  updateWidgetAppearance,
} from '../../widget/widget-appearance.controller';

const mockFind = vi.fn();
const mockSave = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({
      findOneOrFail: mockFind,
      save: mockSave,
    }),
  },
}));

const makeReq = (body: Record<string, unknown> = {}) =>
  ({ body, tenantId: 'tenant-123' } as unknown as Request & { tenantId: string });

const makeRes = () => {
  const res = {} as Response;
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  mockFind.mockReset();
  mockSave.mockReset();
});

describe('getWidgetAppearance', () => {
  it('returns the saved widget+theme subset with defaults applied', async () => {
    mockFind.mockResolvedValueOnce({
      id: 'tenant-123',
      settings: {
        theme: { primaryColor: '#abcdef' },
        widget: {
          avatarUrl: 'https://example.com/a.png',
          launcherPosition: 'bottom-left',
          launcherLabel: 'Hi',
        },
      },
    });
    const req = makeReq();
    const res = makeRes();
    await getWidgetAppearance(req, res);
    expect(res.json).toHaveBeenCalledWith({
      primaryColor: '#abcdef',
      avatarUrl: 'https://example.com/a.png',
      launcherPosition: 'bottom-left',
      launcherLabel: 'Hi',
    });
  });

  it('returns null primaryColor/avatarUrl/launcherLabel and default position when nothing is saved', async () => {
    mockFind.mockResolvedValueOnce({ id: 'tenant-123', settings: {} });
    const req = makeReq();
    const res = makeRes();
    await getWidgetAppearance(req, res);
    expect(res.json).toHaveBeenCalledWith({
      primaryColor: null,
      avatarUrl: null,
      launcherPosition: 'bottom-right',
      launcherLabel: null,
    });
  });
});

describe('updateWidgetAppearance', () => {
  it('merges primaryColor into theme and other fields into widget; normalizes empty strings to null', async () => {
    const tenant = {
      id: 'tenant-123',
      settings: { theme: { primaryColor: '#000000' }, widget: {} },
    };
    mockFind.mockResolvedValueOnce(tenant);
    mockSave.mockResolvedValueOnce(tenant);

    const req = makeReq({
      primaryColor: '#6366f1',
      avatarUrl: '',
      launcherPosition: 'bottom-left',
      launcherLabel: 'Chat',
    });
    const res = makeRes();
    await updateWidgetAppearance(req, res);

    expect(mockSave).toHaveBeenCalled();
    const saved = mockSave.mock.calls[0][0];
    expect(saved.settings.theme.primaryColor).toBe('#6366f1');
    expect(saved.settings.widget.avatarUrl).toBeNull();
    expect(saved.settings.widget.launcherPosition).toBe('bottom-left');
    expect(saved.settings.widget.launcherLabel).toBe('Chat');

    expect(res.json).toHaveBeenCalledWith({
      primaryColor: '#6366f1',
      avatarUrl: null,
      launcherPosition: 'bottom-left',
      launcherLabel: 'Chat',
    });
  });

  it('only writes fields present in the body (partial PATCH)', async () => {
    const tenant = {
      id: 'tenant-123',
      settings: {
        theme: { primaryColor: '#111111' },
        widget: { launcherPosition: 'bottom-left', launcherLabel: 'old' },
      },
    };
    mockFind.mockResolvedValueOnce(tenant);
    mockSave.mockResolvedValueOnce(tenant);

    const req = makeReq({ primaryColor: '#222222' });
    const res = makeRes();
    await updateWidgetAppearance(req, res);

    const saved = mockSave.mock.calls[0][0];
    expect(saved.settings.theme.primaryColor).toBe('#222222');
    expect(saved.settings.widget.launcherPosition).toBe('bottom-left');
    expect(saved.settings.widget.launcherLabel).toBe('old');
  });

  it('rejects invalid bodies via Zod', async () => {
    const req = makeReq({ primaryColor: 'not-a-hex' });
    const res = makeRes();
    await expect(updateWidgetAppearance(req, res)).rejects.toThrow();
    expect(mockSave).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests and confirm they fail (controller file does not exist yet).**

```bash
cd chatbot-platform/api
npx vitest run src/__tests__/unit/widget-appearance.controller.test.ts
```
Expected: FAIL with module-not-found error on `../../widget/widget-appearance.controller`.

### Task 4: Implement the controller

**Files:**
- Create: `chatbot-platform/api/src/widget/widget-appearance.controller.ts`

- [ ] **Step 1: Create the controller file with both handlers.**

Create `chatbot-platform/api/src/widget/widget-appearance.controller.ts`:

```ts
import type { Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { updateWidgetAppearanceSchema } from '../schemas/widget-appearance.schema';

type AppearanceResponse = {
  primaryColor: string | null;
  avatarUrl: string | null;
  launcherPosition: 'bottom-right' | 'bottom-left';
  launcherLabel: string | null;
};

function toResponse(tenant: Tenant): AppearanceResponse {
  const theme = (tenant.settings?.theme ?? {}) as { primaryColor?: string };
  const widget = (tenant.settings?.widget ?? {}) as {
    avatarUrl?: string | null;
    launcherPosition?: 'bottom-right' | 'bottom-left';
    launcherLabel?: string | null;
  };
  return {
    primaryColor: theme.primaryColor ?? null,
    avatarUrl: widget.avatarUrl ?? null,
    launcherPosition: widget.launcherPosition ?? 'bottom-right',
    launcherLabel: widget.launcherLabel ?? null,
  };
}

export async function getWidgetAppearance(req: Request, res: Response) {
  const tenantId = (req as any).tenantId as string;
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });
  res.json(toResponse(tenant));
}

export async function updateWidgetAppearance(req: Request, res: Response) {
  const tenantId = (req as any).tenantId as string;
  const data = updateWidgetAppearanceSchema.parse(req.body);

  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const existingTheme = (tenant.settings?.theme ?? {}) as Record<string, unknown>;
  const existingWidget = (tenant.settings?.widget ?? {}) as Record<string, unknown>;

  const nextTheme = { ...existingTheme };
  const nextWidget = { ...existingWidget };

  if (Object.prototype.hasOwnProperty.call(data, 'primaryColor') && data.primaryColor !== undefined) {
    nextTheme.primaryColor = data.primaryColor;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'avatarUrl')) {
    nextWidget.avatarUrl = data.avatarUrl === '' ? null : data.avatarUrl ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'launcherPosition') && data.launcherPosition !== undefined) {
    nextWidget.launcherPosition = data.launcherPosition;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'launcherLabel')) {
    nextWidget.launcherLabel = data.launcherLabel === '' ? null : data.launcherLabel ?? null;
  }

  tenant.settings = {
    ...(tenant.settings ?? {}),
    theme: nextTheme,
    widget: nextWidget,
  } as Tenant['settings'];

  await tenantRepo.save(tenant);

  res.json(toResponse(tenant));
}
```

- [ ] **Step 2: Run tests and confirm they pass.**

```bash
cd chatbot-platform/api
npx vitest run src/__tests__/unit/widget-appearance.controller.test.ts
```
Expected: all 5 tests pass.

### Task 5: Create the routes file and mount it

**Files:**
- Create: `chatbot-platform/api/src/widget/widget-appearance.routes.ts`
- Modify: `chatbot-platform/api/src/server.ts:41` (add import) and `:206-211` (add `apiRouter.use(...)` line)

- [ ] **Step 1: Create the routes file mirroring `ai-settings.routes.ts`.**

Create `chatbot-platform/api/src/widget/widget-appearance.routes.ts`:

```ts
import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import {
  getWidgetAppearance,
  updateWidgetAppearance,
} from './widget-appearance.controller';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

router.get(
  '/widget-appearance',
  requireRole('admin', 'supervisor'),
  asyncHandler(getWidgetAppearance),
);

router.patch(
  '/widget-appearance',
  requireRole('admin'),
  asyncHandler(updateWidgetAppearance),
);

export default router;
```

- [ ] **Step 2: Add the import to `server.ts`.**

In `chatbot-platform/api/src/server.ts`, just below the `import aiSettingsRoutes from './knowledge/ai-settings.routes';` line (around line 41), add:

```ts
import widgetAppearanceRoutes from './widget/widget-appearance.routes';
```

- [ ] **Step 3: Mount the routes in the `apiRouter` group.**

In `chatbot-platform/api/src/server.ts`, locate the existing `apiRouter.use('/tenants/me', aiSettingsRoutes);` (around line 206). Immediately AFTER that line, add:

```ts
apiRouter.use('/tenants/me', widgetAppearanceRoutes);
```

This makes the new routes available at `/api/v1/tenants/me/widget-appearance`.

- [ ] **Step 4: Run the API typecheck to confirm imports resolve.**

```bash
cd chatbot-platform/api
npx tsc --noEmit
```
Expected: no errors related to the new files.

- [ ] **Step 5: Commit Commit B.**

```bash
cd "/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy Chatbot op Railway"
git add chatbot-platform/api/src/widget/widget-appearance.controller.ts \
        chatbot-platform/api/src/widget/widget-appearance.routes.ts \
        chatbot-platform/api/src/__tests__/unit/widget-appearance.controller.test.ts \
        chatbot-platform/api/src/server.ts
git commit -m "feat(api): add widget appearance PATCH/GET route

New endpoint at /api/v1/tenants/me/widget-appearance writes
settings.theme.primaryColor and settings.widget.{avatarUrl,launcherPosition,
launcherLabel} atomically. Mirrors the ai-settings routes/middleware chain
(Clerk auth + autoProvision + resolveTenantContext, requireRole admin for
writes). Empty strings normalize to null in the controller before save.

Nothing consumes this endpoint yet — safe to deploy alone.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Commit C — `feat(api): extend widget config with appearance namespace`

Adds the `appearance` block to the public `/widget/config` response. Real widgets STILL ignore it (no widget.js changes yet), so this is the safe deploy gate.

### Task 6: Test the extended `/widget/config` response

**Files:**
- Create: `chatbot-platform/api/src/__tests__/unit/widget-config-appearance.test.ts`

- [ ] **Step 1: Write the failing integration-style test.**

Create `chatbot-platform/api/src/__tests__/unit/widget-config-appearance.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// We test the response-building logic directly. Mock validateApiKey to return a tenant.
const mockValidateApiKey = vi.fn();
vi.mock('../../services/apiKey.service', () => ({
  validateApiKey: mockValidateApiKey,
}));

import widgetRouter from '../../routes/widget';

// Helper: extract the GET /config handler from the router stack
function findConfigHandler() {
  const layer = (widgetRouter as any).stack.find(
    (l: any) => l.route?.path === '/config' && l.route?.methods?.get,
  );
  if (!layer) throw new Error('Could not locate GET /config handler');
  // The last middleware in the stack is the route handler we want
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle;
}

const handler = findConfigHandler();

const makeReq = (apiKey: string) =>
  ({ query: { apiKey } } as unknown as Request);

const makeRes = () => {
  const calls: any[] = [];
  const res = {} as Response;
  (res as any).status = vi.fn().mockReturnValue(res);
  (res as any).json = vi.fn().mockImplementation((body) => {
    calls.push(body);
    return res;
  });
  return { res, calls };
};

beforeEach(() => {
  mockValidateApiKey.mockReset();
});

describe('GET /widget/config — appearance block', () => {
  it('includes appearance with defaults when widget settings absent', async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      tenant: { id: 't1', name: 'Tenant', settings: {} },
    });
    const { res, calls } = makeRes();
    await handler(makeReq('k'), res, () => {});
    const body = calls[0]?.data ?? calls[0];
    expect(body.appearance).toEqual({
      avatarUrl: null,
      launcherPosition: 'bottom-right',
      launcherLabel: null,
    });
  });

  it('reflects saved widget settings', async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      tenant: {
        id: 't1',
        name: 'Tenant',
        settings: {
          widget: {
            avatarUrl: 'https://example.com/a.png',
            launcherPosition: 'bottom-left',
            launcherLabel: 'Chat',
          },
        },
      },
    });
    const { res, calls } = makeRes();
    await handler(makeReq('k'), res, () => {});
    const body = calls[0]?.data ?? calls[0];
    expect(body.appearance).toEqual({
      avatarUrl: 'https://example.com/a.png',
      launcherPosition: 'bottom-left',
      launcherLabel: 'Chat',
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails because `appearance` is missing.**

```bash
cd chatbot-platform/api
npx vitest run src/__tests__/unit/widget-config-appearance.test.ts
```
Expected: FAIL — `body.appearance` is undefined.

### Task 7: Add the `appearance` block to the widget config handler

**Files:**
- Modify: `chatbot-platform/api/src/routes/widget.ts:81-121`

- [ ] **Step 1: Open `chatbot-platform/api/src/routes/widget.ts`.**

Locate the `GET /config` handler. The current `sendSuccess(res, { … })` block builds an object with `tenantId, name, theme, features, businessHours`.

- [ ] **Step 2: Add the `appearance` derivation immediately before the `sendSuccess` call.**

Inside the handler, AFTER `const tenant = result.tenant;` and BEFORE `sendSuccess(res, { … })`, add:

```ts
const widgetSettings = (tenant.settings?.widget ?? {}) as {
  avatarUrl?: string | null;
  launcherPosition?: 'bottom-right' | 'bottom-left';
  launcherLabel?: string | null;
};
const appearance = {
  avatarUrl: widgetSettings.avatarUrl || null,
  launcherPosition: widgetSettings.launcherPosition || 'bottom-right',
  launcherLabel: widgetSettings.launcherLabel || null,
};
```

- [ ] **Step 3: Add `appearance` to the `sendSuccess` payload.**

Inside the existing `sendSuccess(res, { … })` object, after the `businessHours: …` field, add a trailing comma to that line if needed and append:

```ts
appearance,
```

The full block then reads (the new line is the last one):

```ts
sendSuccess(res, {
  tenantId: tenant.id,
  name: tenant.name,
  theme: tenant.settings?.theme || {
    primaryColor: '#007bff',
    backgroundColor: '#ffffff',
    textColor: '#333333',
  },
  features: {
    fileUploadEnabled: tenant.settings?.features?.fileUploadEnabled ?? false,
    handoffEnabled: tenant.settings?.features?.handoffEnabled ?? true,
    aiEnabled: tenant.settings?.ai?.enabled ?? false,
  },
  businessHours: tenant.settings?.businessHours || {
    enabled: false,
    timezone: 'UTC',
  },
  appearance,
});
```

- [ ] **Step 4: Run the test and confirm it passes.**

```bash
cd chatbot-platform/api
npx vitest run src/__tests__/unit/widget-config-appearance.test.ts
```
Expected: both tests pass.

- [ ] **Step 5: Commit Commit C.**

```bash
cd "/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy Chatbot op Railway"
git add chatbot-platform/api/src/routes/widget.ts \
        chatbot-platform/api/src/__tests__/unit/widget-config-appearance.test.ts
git commit -m "feat(api): extend widget config with appearance namespace

GET /widget/config now returns an appearance block with avatarUrl,
launcherPosition (defaulted to bottom-right server-side), and launcherLabel.
Existing fields (theme, features, businessHours) are unchanged — additive only.

Production widgets ignore appearance until widget.js is updated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Commit D — `feat(portal): add chatbot appearances form and preview`

Admins can now configure non-default settings. Real widget runtime is still unchanged.

### Task 8: Create the query hooks file

**Files:**
- Create: `chatbot-platform/portal/src/queries/useWidgetAppearance.ts`

- [ ] **Step 1: Create the hooks file mirroring `useGetAiSettings` / `useUpdateAiSettings`.**

Create `chatbot-platform/portal/src/queries/useWidgetAppearance.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/services/apiClient';
import { queryKeys } from '@/queries/queryKeys';

export type WidgetAppearance = {
  primaryColor: string | null;
  avatarUrl: string | null;
  launcherPosition: 'bottom-right' | 'bottom-left';
  launcherLabel: string | null;
};

export type UpdateWidgetAppearancePayload = Partial<WidgetAppearance>;

const widgetAppearanceKey = [...queryKeys.tenants.me(), 'widget-appearance'] as const;

export function useGetWidgetAppearance(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: widgetAppearanceKey,
    queryFn: () => api.get<WidgetAppearance>('/tenants/me/widget-appearance'),
    enabled: options?.enabled ?? true,
  });
}

export function useUpdateWidgetAppearance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateWidgetAppearancePayload) =>
      api.patch<WidgetAppearance>('/tenants/me/widget-appearance', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      queryClient.invalidateQueries({ queryKey: widgetAppearanceKey });
      toast.success('Appearance saved');
    },
    onError: () => toast.error('Failed to save appearance'),
  });
}
```

- [ ] **Step 2: Verify the import paths resolve.**

```bash
cd chatbot-platform/portal
npx tsc --noEmit
```
Expected: no errors related to this file. If `queryKeys.tenants.me()` doesn't exist with that exact shape, inspect `portal/src/queries/queryKeys.ts` and use the same key composition `useGetAiSettings` uses (e.g., `[...queryKeys.tenants.me(), 'ai-settings']`). Substitute the matching pattern if the key helper differs.

### Task 9: Build the preview component with tests

**Files:**
- Create: `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesPreview.tsx`
- Create: `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesPreview.test.tsx`

- [ ] **Step 1: Write the failing preview test.**

Create `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesPreview.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatbotAppearancesPreview from './ChatbotAppearancesPreview';

vi.mock('@clerk/clerk-react', () => ({
  useOrganization: () => ({ organization: { imageUrl: 'https://clerk.example/org.png' } }),
}));

describe('ChatbotAppearancesPreview', () => {
  const baseProps = {
    primaryColor: '#6366f1',
    avatarUrl: null as string | null,
    launcherPosition: 'bottom-right' as const,
    launcherLabel: null as string | null,
    greetingMessage: '' as string,
  };

  it('renders icon-only circular launcher when launcherLabel is empty', () => {
    render(<ChatbotAppearancesPreview {...baseProps} />);
    const launcher = screen.getByTestId('preview-launcher');
    expect(launcher).not.toHaveClass('preview-launcher--pill');
  });

  it('renders pill launcher when launcherLabel is set', () => {
    render(<ChatbotAppearancesPreview {...baseProps} launcherLabel="Chat with us" />);
    const launcher = screen.getByTestId('preview-launcher');
    expect(launcher).toHaveClass('preview-launcher--pill');
    expect(launcher).toHaveTextContent('Chat with us');
  });

  it('anchors launcher to bottom-left when launcherPosition is bottom-left', () => {
    render(<ChatbotAppearancesPreview {...baseProps} launcherPosition="bottom-left" />);
    const launcher = screen.getByTestId('preview-launcher');
    expect(launcher).toHaveAttribute('data-position', 'bottom-left');
  });

  it('shows the Clerk org logo as avatar fallback when avatarUrl is null', () => {
    render(<ChatbotAppearancesPreview {...baseProps} />);
    const avatar = screen.getByTestId('preview-avatar');
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe('https://clerk.example/org.png');
  });

  it('uses avatarUrl when provided', () => {
    render(<ChatbotAppearancesPreview {...baseProps} avatarUrl="https://cdn.example/bot.png" />);
    const avatar = screen.getByTestId('preview-avatar');
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/bot.png');
  });

  it('renders greeting bubble when greetingMessage is non-empty', () => {
    render(<ChatbotAppearancesPreview {...baseProps} greetingMessage="Hello!" />);
    expect(screen.getByTestId('preview-greeting')).toHaveTextContent('Hello!');
  });

  it('does not render greeting bubble when greetingMessage is empty', () => {
    render(<ChatbotAppearancesPreview {...baseProps} />);
    expect(screen.queryByTestId('preview-greeting')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails (component does not exist).**

```bash
cd chatbot-platform/portal
npx vitest run src/pages/knowledge/ChatbotAppearancesPreview.test.tsx
```
Expected: FAIL with module-not-found.

- [ ] **Step 3: Create the component.**

Create `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesPreview.tsx`:

```tsx
import React from 'react';
import { useOrganization } from '@clerk/clerk-react';
import { Bot } from 'lucide-react';

export type ChatbotAppearancesPreviewProps = {
  primaryColor: string | null;
  avatarUrl: string | null;
  launcherPosition: 'bottom-right' | 'bottom-left';
  launcherLabel: string | null;
  greetingMessage: string;
};

const ChatbotAppearancesPreview: React.FC<ChatbotAppearancesPreviewProps> = ({
  primaryColor,
  avatarUrl,
  launcherPosition,
  launcherLabel,
  greetingMessage,
}) => {
  const { organization } = useOrganization();
  const effectivePrimary = primaryColor || '#6366f1';
  const effectiveAvatar = avatarUrl || organization?.imageUrl || null;
  const isPill = Boolean(launcherLabel);

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-6">
      <div className="relative h-96 overflow-hidden rounded-lg bg-background shadow-inner">
        {/* Open panel mock */}
        <div className="absolute inset-x-4 top-4 bottom-20 rounded-lg border border-border bg-card shadow-sm flex flex-col">
          <div
            className="flex items-center gap-3 rounded-t-lg px-4 py-3 text-white"
            style={{ backgroundColor: effectivePrimary }}
          >
            <div
              data-testid="preview-avatar"
              className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-white/20"
            >
              {effectiveAvatar ? (
                <img src={effectiveAvatar} alt="" className="h-full w-full object-cover" />
              ) : (
                <Bot className="h-4 w-4" />
              )}
            </div>
            <div className="text-sm font-medium">{organization?.name ?? 'Your Brand'}</div>
          </div>
          <div className="flex-1 px-4 py-3 space-y-2">
            {greetingMessage ? (
              <div
                data-testid="preview-greeting"
                className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
              >
                {greetingMessage}
              </div>
            ) : null}
          </div>
          <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            Type a message…
          </div>
        </div>

        {/* Closed launcher mock */}
        <button
          data-testid="preview-launcher"
          data-position={launcherPosition}
          className={[
            'absolute bottom-4 flex items-center gap-2 text-white shadow-lg transition',
            isPill ? 'preview-launcher--pill rounded-full px-4 py-2' : 'h-12 w-12 justify-center rounded-full',
            launcherPosition === 'bottom-left' ? 'left-4' : 'right-4',
          ].join(' ')}
          style={{ backgroundColor: effectivePrimary }}
          type="button"
        >
          <Bot className="h-5 w-5" />
          {isPill ? <span className="text-sm font-medium">{launcherLabel}</span> : null}
        </button>
      </div>
    </div>
  );
};

export default ChatbotAppearancesPreview;
```

- [ ] **Step 4: Run the preview tests and confirm all 7 pass.**

```bash
cd chatbot-platform/portal
npx vitest run src/pages/knowledge/ChatbotAppearancesPreview.test.tsx
```
Expected: all 7 tests pass.

### Task 10: Build the form component with tests

**Files:**
- Create: `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesForm.tsx`
- Create: `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesForm.test.tsx`

- [ ] **Step 1: Write the failing form test.**

Create `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesForm.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatbotAppearancesForm from './ChatbotAppearancesForm';

const { mockMutate } = vi.hoisted(() => ({ mockMutate: vi.fn() }));

vi.mock('@clerk/clerk-react', () => ({
  useOrganization: () => ({ organization: { imageUrl: 'https://clerk.example/org.png', name: 'Acme' } }),
}));

vi.mock('@/queries/useWidgetAppearance', () => ({
  useGetWidgetAppearance: () => ({
    data: {
      primaryColor: '#6366f1',
      avatarUrl: null,
      launcherPosition: 'bottom-right',
      launcherLabel: null,
    },
    isLoading: false,
  }),
  useUpdateWidgetAppearance: () => ({ mutate: mockMutate, isPending: false }),
}));

vi.mock('@/queries/useKnowledgeQueries', () => ({
  useGetAiSettings: () => ({
    data: { guardrails: { greetingMessage: 'Hello — how can we help you today?' } },
    isLoading: false,
  }),
}));

vi.mock('@/queries/useTenantQueries', () => ({
  useTenantSettings: () => ({ data: { apiKey: 'fake-api-key' } }),
}));

beforeEach(() => {
  mockMutate.mockReset();
});

describe('ChatbotAppearancesForm', () => {
  it('hydrates fields from the API response', () => {
    render(<ChatbotAppearancesForm />);
    expect(screen.getByLabelText(/primary color/i)).toHaveValue('#6366f1');
    expect((screen.getByLabelText(/bot avatar url/i) as HTMLInputElement).value).toBe('');
  });

  it('renders the read-only greeting from AI settings', () => {
    render(<ChatbotAppearancesForm />);
    expect(screen.getByText(/Hello — how can we help you today\?/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /edit in ai bot/i })).toHaveAttribute(
      'href',
      '/ai?tab=bot',
    );
  });

  it('disables Save when the form is clean and enables it when dirty', async () => {
    const user = userEvent.setup();
    render(<ChatbotAppearancesForm />);
    const save = screen.getByRole('button', { name: /save/i });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/launcher label/i), 'Chat');
    expect(save).toBeEnabled();
  });

  it('calls the update mutation with only changed fields when Save is clicked', async () => {
    const user = userEvent.setup();
    render(<ChatbotAppearancesForm />);
    await user.type(screen.getByLabelText(/launcher label/i), 'Chat');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
    const arg = mockMutate.mock.calls[0][0];
    expect(arg).toEqual(expect.objectContaining({ launcherLabel: 'Chat' }));
  });

  it('renders an "Open full widget test" link with the tenant apiKey', () => {
    render(<ChatbotAppearancesForm />);
    expect(screen.getByRole('link', { name: /open full widget test/i })).toHaveAttribute(
      'href',
      expect.stringContaining('apiKey=fake-api-key'),
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

```bash
cd chatbot-platform/portal
npx vitest run src/pages/knowledge/ChatbotAppearancesForm.test.tsx
```
Expected: FAIL with module-not-found.

- [ ] **Step 3: Create the form component.**

Create `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesForm.tsx`:

```tsx
import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import {
  useGetWidgetAppearance,
  useUpdateWidgetAppearance,
} from '@/queries/useWidgetAppearance';
import { useGetAiSettings } from '@/queries/useKnowledgeQueries';
import { useTenantSettings } from '@/queries/useTenantQueries';
import ChatbotAppearancesPreview from './ChatbotAppearancesPreview';

type FormState = {
  primaryColor: string;
  avatarUrl: string;
  launcherPosition: 'bottom-right' | 'bottom-left';
  launcherLabel: string;
};

const ChatbotAppearancesForm: React.FC = () => {
  const { data: appearance, isLoading } = useGetWidgetAppearance();
  const { data: aiSettings } = useGetAiSettings();
  const { data: tenant } = useTenantSettings() as { data: { apiKey?: string } | undefined };
  const update = useUpdateWidgetAppearance();

  const [form, setForm] = useState<FormState>({
    primaryColor: '#6366f1',
    avatarUrl: '',
    launcherPosition: 'bottom-right',
    launcherLabel: '',
  });
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);

  useEffect(() => {
    if (!appearance) return;
    const hydrated: FormState = {
      primaryColor: appearance.primaryColor ?? '#6366f1',
      avatarUrl: appearance.avatarUrl ?? '',
      launcherPosition: appearance.launcherPosition,
      launcherLabel: appearance.launcherLabel ?? '',
    };
    setForm(hydrated);
    setSavedSnapshot(JSON.stringify(hydrated));
  }, [appearance]);

  const greeting = (aiSettings as { guardrails?: { greetingMessage?: string } } | undefined)
    ?.guardrails?.greetingMessage ?? '';

  const currentSnapshot = JSON.stringify(form);
  const isDirty = savedSnapshot !== null && currentSnapshot !== savedSnapshot;

  const widgetTestHref = useMemo(() => {
    const key = tenant?.apiKey;
    return key ? `/widget-test?apiKey=${encodeURIComponent(key)}` : '#';
  }, [tenant?.apiKey]);

  const handleSave = () => {
    const payload = {
      primaryColor: form.primaryColor,
      avatarUrl: form.avatarUrl === '' ? null : form.avatarUrl,
      launcherPosition: form.launcherPosition,
      launcherLabel: form.launcherLabel === '' ? null : form.launcherLabel,
    };
    update.mutate(payload, {
      onSuccess: () => setSavedSnapshot(currentSnapshot),
    });
  };

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_minmax(280px,420px)]">
      <div className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="primaryColor">Primary color</Label>
          <Input
            id="primaryColor"
            type="color"
            value={form.primaryColor}
            onChange={(e) => setForm((f) => ({ ...f, primaryColor: e.target.value }))}
            className="h-10 w-20 p-1"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="avatarUrl">Bot avatar URL</Label>
          <Input
            id="avatarUrl"
            type="url"
            placeholder="https://example.com/avatar.png"
            value={form.avatarUrl}
            onChange={(e) => setForm((f) => ({ ...f, avatarUrl: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">
            Optional image URL for the chatbot avatar. If empty, the widget uses your company logo when available.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Launcher position</Label>
          <div className="flex gap-2">
            {(['bottom-right', 'bottom-left'] as const).map((pos) => (
              <Button
                key={pos}
                type="button"
                variant={form.launcherPosition === pos ? 'default' : 'outline'}
                onClick={() => setForm((f) => ({ ...f, launcherPosition: pos }))}
              >
                {pos === 'bottom-right' ? 'Bottom right' : 'Bottom left'}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="launcherLabel">Launcher label</Label>
          <Input
            id="launcherLabel"
            maxLength={30}
            placeholder="Chat with us"
            value={form.launcherLabel}
            onChange={(e) => setForm((f) => ({ ...f, launcherLabel: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">
            Optional text shown next to the chat icon, such as "Chat with us".
          </p>
        </div>

        <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-3">
          <Label>Welcome message</Label>
          <p className="text-sm text-foreground">{greeting || <span className="text-muted-foreground italic">No greeting set.</span>}</p>
          <p className="text-xs text-muted-foreground">
            Welcome message is configured in AI Bot settings.{' '}
            <a href="/ai?tab=bot" className="underline">
              Edit in AI Bot
            </a>
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={!isDirty || update.isPending}>
            <Save className="mr-2 h-4 w-4" />
            Save
          </Button>
          <a
            href={widgetTestHref}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center text-sm underline text-muted-foreground"
          >
            Open full widget test
            <ExternalLink className="ml-1 h-3 w-3" />
          </a>
        </div>
      </div>

      <ChatbotAppearancesPreview
        primaryColor={form.primaryColor}
        avatarUrl={form.avatarUrl || null}
        launcherPosition={form.launcherPosition}
        launcherLabel={form.launcherLabel || null}
        greetingMessage={greeting}
      />
    </div>
  );
};

export default ChatbotAppearancesForm;
```

- [ ] **Step 4: Run the form tests and confirm all 5 pass.**

```bash
cd chatbot-platform/portal
npx vitest run src/pages/knowledge/ChatbotAppearancesForm.test.tsx
```
Expected: all 5 tests pass.

### Task 11: Replace the placeholder in `AiContent.tsx`

**Files:**
- Modify: `chatbot-platform/portal/src/pages/AiContent.tsx:147-153`

- [ ] **Step 1: Add an import for the new form.**

Near the top of `AiContent.tsx` (next to the other knowledge-page imports), add:

```tsx
import ChatbotAppearancesForm from './knowledge/ChatbotAppearancesForm';
```

- [ ] **Step 2: Replace the placeholder block.**

Find the existing block at lines 147-153:

```tsx
{activeTab === 'appearances' && (
  <ComingSoonPanel
    icon={Palette}
    title="Chatbot Appearances"
    description="Customize widget colors, position, avatar, and launcher styling. Coming soon."
  />
)}
```

Replace it with:

```tsx
{activeTab === 'appearances' && <ChatbotAppearancesForm />}
```

- [ ] **Step 3: Verify the portal still typechecks.**

```bash
cd chatbot-platform/portal
npx tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 4: Manually verify locally (optional but recommended).**

Run the portal dev server:
```bash
cd chatbot-platform/portal
npm run dev
```
Navigate to `/ai?tab=appearances`. Confirm: form renders, preview pane shows mock launcher, greeting helper text appears, Save button starts disabled, link points to `/ai?tab=bot`.

- [ ] **Step 5: Commit Commit D.**

```bash
cd "/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy Chatbot op Railway"
git add chatbot-platform/portal/src/queries/useWidgetAppearance.ts \
        chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesPreview.tsx \
        chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesPreview.test.tsx \
        chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesForm.tsx \
        chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesForm.test.tsx \
        chatbot-platform/portal/src/pages/AiContent.tsx
git commit -m "feat(portal): add chatbot appearances form and preview

Replaces the placeholder under /ai?tab=appearances with a real settings form
for primary color, bot avatar URL, launcher position, and launcher label.
Live React preview pane mirrors form state. Greeting message surfaces
read-only from existing AI bot settings with a link back to /ai?tab=bot.

Admins can save settings now; real widget runtime still reflects them only
after Commit F.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Commit E — `refactor(portal): move primary color from widget-brand-settings to appearances`

### Task 12: Strip the color picker from `WidgetBrandSettings` and add a cross-link banner

**Files:**
- Modify: `chatbot-platform/portal/src/pages/settings/WidgetBrandSettings.tsx`

- [ ] **Step 1: Open `WidgetBrandSettings.tsx`.**

Locate (a) the `brandColor` / `setBrandColor` state and color-picker JSX, (b) the `showColorPicker` state, and (c) any color block inside `handleSave` (the lines `if (brandColor !== tenant?.primaryColor) { payload.settings = { theme: { primaryColor: brandColor } }; }`).

- [ ] **Step 2: Remove the color state and JSX.**

Delete:
- `const [brandColor, setBrandColor] = useState('#6366f1');`
- `const [showColorPicker, setShowColorPicker] = useState(false);`
- The `setBrandColor(tenant.primaryColor)` line inside the hydration `useEffect`
- The color block inside `handleSave` (the `if (brandColor !== tenant?.primaryColor)` line and its body)
- The color-picker JSX section (the `Card` or block that renders the swatches/picker)
- The `brandColor !== tenant.primaryColor` clause from the `isDirty` calculation

If a `ColorPicker` import becomes unused, remove that import too.

- [ ] **Step 3: Add a cross-link banner above the remaining form.**

Below the existing page header but ABOVE the tenant-name form, add:

```tsx
<div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
  Widget appearance (color, avatar, launcher) is now configured under{' '}
  <a href="/ai?tab=appearances" className="underline">
    AI & Content → Chatbot Appearances
  </a>
  .
</div>
```

- [ ] **Step 4: Verify typecheck.**

```bash
cd chatbot-platform/portal
npx tsc --noEmit
```
Expected: no new errors. If any references to the removed state remain (e.g., a test or another component), the compiler will flag them — remove or update those references.

- [ ] **Step 5: If a `WidgetBrandSettings.test.tsx` exists, update it.**

```bash
find chatbot-platform/portal/src -name "WidgetBrandSettings.test.tsx"
```

If it exists and references the color picker, remove the affected assertions and add one new assertion that the cross-link banner is present:

```tsx
expect(screen.getByRole('link', { name: /chatbot appearances/i })).toHaveAttribute(
  'href',
  '/ai?tab=appearances',
);
```

If no test file exists, skip this step.

- [ ] **Step 6: Commit Commit E.**

```bash
cd "/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy Chatbot op Railway"
git add chatbot-platform/portal/src/pages/settings/WidgetBrandSettings.tsx
# Also add the test file if updated:
# git add chatbot-platform/portal/src/pages/settings/WidgetBrandSettings.test.tsx

git commit -m "refactor(portal): move primary color from widget brand settings to appearances

The color picker now lives under AI & Content → Chatbot Appearances.
WidgetBrandSettings keeps tenant name, Clerk-managed org logo, API key, and
install snippet. Adds a banner pointing users to the new editing location.

No persistence change — settings.theme.primaryColor is still the source of truth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Commit F — `feat(widget): honor appearance config in embed widget`

The customer-facing switch. After this commit, real production widgets reflect the new appearance fields. **Manual smoke checklist gate before announcing this feature is live.**

### Task 13: Add the appearance read and CSS for new launcher variants

**Files:**
- Modify: `chatbot-platform/api/public/widget.js`

- [ ] **Step 1: Locate where `this.config` is first populated and add an `appearance` cache.**

Find the config-fetch / initialization site (the constructor or `_initConnection` path). Immediately after the line that resolves the API config into `this.config`, add:

```js
this.appearance = (this.config && this.config.appearance) || {};
```

If the config arrives via a fetch resolver later, place the assignment at the same point where `this.config = <resolved>;` happens.

- [ ] **Step 2: Add new CSS rules for the position variant and pill launcher.**

Inside the existing `<style>` block (the one that already declares `.cb-launcher`, around line 363), append:

```css
.cb-launcher--bottom-left {
  left: 24px;
  right: auto;
}
.cb-launcher--pill {
  width: auto;
  height: auto;
  padding: 10px 16px;
  border-radius: 999px;
  gap: 8px;
}
.cb-launcher__text {
  font-size: 14px;
  font-weight: 500;
  color: white;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### Task 14: Apply launcher position class at render time

- [ ] **Step 1: Find the render path where the launcher template is built (where the host element is created and `.cb-launcher` is attached, before line 1180 where `this.launcher = this.container.querySelector('.cb-launcher')` runs).**

After `this.launcher` is cached (after the existing line `this.launcher = this.container.querySelector('.cb-launcher');`), add:

```js
if (this.launcher && this.appearance.launcherPosition === 'bottom-left') {
  this.launcher.classList.add('cb-launcher--bottom-left');
}
```

This is additive — when `launcherPosition` is absent or `'bottom-right'`, no class is added and the existing styles apply.

### Task 15: Render the launcher label as a pill when present

- [ ] **Step 1: Locate the template literal that builds the launcher element's inner HTML.**

The launcher template currently renders an icon-only element. Inside that template, add a label span. Find the launcher template (search for `.cb-launcher__icon` HTML in the JS string templates) and update the inner HTML to:

```js
const labelHtml = this.appearance.launcherLabel
  ? `<span class="cb-launcher__text">${this.appearance.launcherLabel.replace(/</g, '&lt;')}</span>`
  : '';
// inside the template literal where the icon is inserted:
//   <div class="cb-launcher__icon cb-launcher__icon--closed">${ICONS.chat}</div>
//   ${labelHtml}
```

- [ ] **Step 2: After the launcher is cached, apply the `--pill` class if a label is set.**

Immediately after the position-class assignment in Task 14:

```js
if (this.launcher && this.appearance.launcherLabel) {
  this.launcher.classList.add('cb-launcher--pill');
}
```

### Task 16: Avatar rendering helper and call sites

- [ ] **Step 1: Add a small HTML-safe helper near the top of the widget code, alongside other utility functions.**

Locate the `utils` object (it's the file-level helpers). Add:

```js
function botAvatarHtml(avatarUrl) {
  if (avatarUrl) {
    const safe = String(avatarUrl)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<img src="${safe}" alt="" loading="lazy" class="cb-bot-avatar-img" />`;
  }
  return ICONS.bot;
}
```

And one CSS rule (inside the `<style>` block):

```css
.cb-bot-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}
```

- [ ] **Step 2: Update the assistant-message avatar template at line 1745.**

Find the current line (inside the message template literal):

```js
<div class="cb-message__avatar">${isUser ? ICONS.user : ICONS.bot}</div>
```

Change to:

```js
<div class="cb-message__avatar">${isUser ? ICONS.user : botAvatarHtml(this.appearance.avatarUrl)}</div>
```

- [ ] **Step 3: Update the header avatar at line 1620.**

Find the header avatar template:

```js
<div class="cb-header__avatar">
```

The opening tag is followed (in the same template literal) by content rendering `ICONS.bot`. Update that content reference so the header avatar renders via the helper:

```js
<div class="cb-header__avatar">${botAvatarHtml(this.appearance.avatarUrl)}</div>
```

If the header template currently embeds `ICONS.bot` directly inside the `cb-header__avatar` element, swap it for `${botAvatarHtml(this.appearance.avatarUrl)}` in that same spot.

### Task 17: Manual smoke checklist (deploy gate)

This commit changes live production widget behavior. After deploy (this repo pushes `main` straight to prod via Railway), run the full smoke checklist before announcing the feature is live.

- [ ] **Step 1: Set up a test tenant with each scenario.**

In the portal at `/ai?tab=appearances`:
1. Save a tenant with no `widget.*` settings (or use a known pre-MVP tenant) → expect today's exact behavior.
2. Save `launcherPosition: 'bottom-left'`.
3. Save `launcherLabel: 'Chat with us'`.
4. Save `avatarUrl: 'https://example.com/avatar.png'` (use any real public image).

- [ ] **Step 2: Open each scenario's embedded widget on a test page (or via `/widget-test?apiKey=…`) and verify:**

| # | Scenario | Expected |
|---|---|---|
| 1 | Pre-MVP tenant, no widget settings | Bottom-right circular icon launcher; no welcome bubble; bot SVG avatar |
| 2 | `launcherPosition: 'bottom-left'` | Launcher anchors bottom-left; panel still expands upward |
| 3 | `launcherLabel: 'Chat with us'` | Launcher renders as a pill with icon + text; long labels truncate at ~30 chars |
| 4 | `launcherLabel: null`, label cleared | Launcher is the circular icon-only button |
| 5 | `avatarUrl` set on widget | Header AND assistant-message avatars show the image |
| 6 | `avatarUrl` null | Header AND assistant-message avatars show `ICONS.bot` SVG |
| 7 | Existing tenant with `guardrails.greetingMessage` set | First message in panel is the greeting (regression test — no change in behavior) |
| 8 | Two tenant sites open side by side with different settings | No cross-contamination |

- [ ] **Step 3: Commit Commit F.**

```bash
cd "/Users/ianneo/Desktop/work/achraf/Kimi_Agent_Deploy Chatbot op Railway"
git add chatbot-platform/api/public/widget.js
git commit -m "feat(widget): honor appearance config in embed widget

Widget.js reads config.appearance and applies it: bottom-left launcher
position via a new --bottom-left class, optional pill rendering via
--pill class with launcher label text, and a server-resolved avatar URL
at the header and assistant-message sites via a new botAvatarHtml helper.

All changes are additive — when fields are absent, behavior is identical
to before. Greeting handling (config.greetingMessage path at line 1200)
is unchanged.

Manual smoke checklist (Section 7.5 of spec) run before merge.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Rollback playbook

- **Widget regression after Commit F deploys:** revert Commit F first. Widget reverts to today's behavior; admins can still configure settings (preview keeps working) but the embed stops applying them.
- **Portal regression after Commit D/E deploys:** revert D and/or E (portal-only); widget runtime unaffected.
- **API contract complaint after Commit B/C:** revert C first (drops `appearance` from `/widget/config`); revert B if needed (nothing consumes it yet at that point unless Commit D/F also shipped).

## Test summary

- `chatbot-platform/api/src/__tests__/unit/widget-appearance.schema.test.ts` — 9 cases
- `chatbot-platform/api/src/__tests__/unit/widget-appearance.controller.test.ts` — 5 cases
- `chatbot-platform/api/src/__tests__/unit/widget-config-appearance.test.ts` — 2 cases
- `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesPreview.test.tsx` — 7 cases
- `chatbot-platform/portal/src/pages/knowledge/ChatbotAppearancesForm.test.tsx` — 5 cases
- Manual smoke checklist for `widget.js` — 8 scenarios (no automated tests)
