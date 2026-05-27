# Cal.com Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cal.com configuration card to Settings → Integrations so tenants can connect Cal.com and enable AI-powered appointment booking with minimal input (API key + pick event type).

**Architecture:** New `POST /calcom/connect` endpoint validates the Cal.com API key and fetches event types in one call. Frontend `CalcomSettings` component manages a connect → pick → connected state machine. Existing `PATCH /integrations` endpoint handles saving the event type selection and disconnecting. Webhook URL auto-set on first Cal.com save if currently empty.

**Tech Stack:** React, TanStack Query, shadcn/ui, Zod, Express, axios, Cal.com API v2

**Spec:** `docs/superpowers/specs/2026-04-02-calcom-settings-ui-design.md`

---

### Task 1: Backend — Connect Endpoint

**Files:**
- Modify: `api/src/knowledge/integrations.controller.ts`
- Modify: `api/src/knowledge/integrations.routes.ts`
- Create: `api/src/__tests__/unit/calcom-connect.test.ts`

- [ ] **Step 1: Write the failing test for the connect endpoint**

```typescript
// api/src/__tests__/unit/calcom-connect.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock dependencies
const mockFindOneOrFail = vi.fn();
const mockSave = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({ findOneOrFail: mockFindOneOrFail, save: mockSave }),
  },
}));

vi.mock('../../utils/encryption', () => ({
  encrypt: (val: string) => `encrypted:${val}`,
}));

let mockAxiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...args: any[]) => mockAxiosGet(...args) } }));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config/environment', () => ({
  config: { n8n: { defaultWebhookUrl: 'https://test-webhook.example.com/webhook' } },
}));

import { connectCalcom } from '../../knowledge/integrations.controller';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/connect', (req, res, next) => {
    (req as any).tenantId = 'tenant-123';
    next();
  }, connectCalcom);
  return app;
}

describe('POST /calcom/connect', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    mockFindOneOrFail.mockResolvedValue({
      id: 'tenant-123',
      settings: {},
      webhookUrl: null,
      webhookSecret: null,
    });
    mockSave.mockImplementation((t: any) => Promise.resolve(t));
  });

  it('should return 400 if apiKey is missing', async () => {
    const res = await request(app).post('/connect').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('API key is required');
  });

  it('should return 400 if Cal.com rejects the key', async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 401 } });
    const res = await request(app).post('/connect').send({ apiKey: 'bad-key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid or expired');
  });

  it('should return 400 if no event types found', async () => {
    mockAxiosGet.mockResolvedValue({ data: { data: [] } });
    const res = await request(app).post('/connect').send({ apiKey: 'cal_live_good' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No event types');
  });

  it('should encrypt key, store it, and return event types', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        data: [
          { id: 123, title: '30 min Meeting', lengthInMinutes: 30, slug: '30min' },
          { id: 456, title: '60 min Call', lengthInMinutes: 60, slug: '60min' },
        ],
      },
    });

    const res = await request(app).post('/connect').send({ apiKey: 'cal_live_good' });
    expect(res.status).toBe(200);
    expect(res.body.eventTypes).toHaveLength(2);
    expect(res.body.eventTypes[0]).toEqual({ id: 123, title: '30 min Meeting', length: 30, slug: '30min' });
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          integrations: expect.objectContaining({
            calcom: expect.objectContaining({ apiKey: 'encrypted:cal_live_good' }),
          }),
        }),
      })
    );
  });

  it('should auto-set webhookUrl if currently empty', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { data: [{ id: 1, title: 'Test', lengthInMinutes: 30, slug: 'test' }] },
    });

    const res = await request(app).post('/connect').send({ apiKey: 'cal_live_good' });
    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: expect.any(String),
      })
    );
  });

  it('should NOT overwrite existing webhookUrl', async () => {
    mockFindOneOrFail.mockResolvedValue({
      id: 'tenant-123',
      settings: {},
      webhookUrl: 'https://custom.example.com/webhook',
      webhookSecret: 'existing-secret',
    });
    mockAxiosGet.mockResolvedValue({
      data: { data: [{ id: 1, title: 'Test', lengthInMinutes: 30, slug: 'test' }] },
    });

    const res = await request(app).post('/connect').send({ apiKey: 'cal_live_good' });
    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ webhookUrl: 'https://custom.example.com/webhook' })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run calcom-connect --no-coverage`
Expected: FAIL — `connectCalcom` is not exported from integrations.controller

- [ ] **Step 3: Implement the connect endpoint**

Add to `api/src/knowledge/integrations.controller.ts`:

```typescript
import axios from 'axios';
import crypto from 'crypto';

// ... existing imports and functions ...

import { config } from '../config/environment';

export async function connectCalcom(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const { apiKey } = req.body;

  if (!apiKey || typeof apiKey !== 'string') {
    res.status(400).json({ error: 'API key is required' });
    return;
  }

  // Validate key against Cal.com and fetch event types
  let eventTypes: Array<{ id: number; title: string; length: number; slug: string }>;
  try {
    const response = await axios.get('https://api.cal.com/v2/event-types', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'cal-api-version': '2024-09-04',
      },
      timeout: 10000,
    });

    const raw = response.data?.data || [];
    eventTypes = raw.map((et: any) => ({
      id: et.id,
      title: et.title || et.slug,
      length: et.lengthInMinutes || et.length || 0,
      slug: et.slug,
    }));
  } catch (err: any) {
    if (err.response?.status === 401) {
      res.status(400).json({ error: 'Invalid or expired API key' });
      return;
    }
    res.status(502).json({ error: 'Failed to connect to Cal.com' });
    return;
  }

  if (eventTypes.length === 0) {
    res.status(400).json({ error: 'No event types found. Create one in Cal.com first.' });
    return;
  }

  // Store encrypted key
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const existing = tenant.settings?.integrations || {};
  // Clear previous eventTypeId on reconnect — user must re-select
  tenant.settings = {
    ...tenant.settings,
    integrations: {
      ...existing,
      calcom: {
        apiKey: encrypt(apiKey),
        // Preserve language/collectFields but clear eventTypeId
        language: existing.calcom?.language,
        collectFields: existing.calcom?.collectFields,
      },
    },
  };

  // Auto-set webhook URL if empty (use config, not hardcoded)
  if (!tenant.webhookUrl && config.n8n.defaultWebhookUrl) {
    tenant.webhookUrl = config.n8n.defaultWebhookUrl;
    if (!tenant.webhookSecret) {
      tenant.webhookSecret = crypto.randomBytes(32).toString('hex');
    }
  }

  await tenantRepo.save(tenant);
  logger.info(`Cal.com connected for tenant ${tenantId}`, { eventTypeCount: eventTypes.length });

  res.json({ eventTypes });
}
```

- [ ] **Step 4: Add the route**

Add to `api/src/knowledge/integrations.routes.ts`:

```typescript
// Connect Cal.com: admin only
router.post('/integrations/calcom/connect', requireRole('admin'), asyncHandler(ctrl.connectCalcom));
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `cd chatbot-platform/api && npx vitest run calcom-connect --no-coverage`
Expected: All 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add api/src/knowledge/integrations.controller.ts api/src/knowledge/integrations.routes.ts api/src/__tests__/unit/calcom-connect.test.ts
git commit -m "feat: add POST /calcom/connect endpoint for Cal.com integration setup"
```

---

### Task 2: Backend — Auto-set webhook URL on integration save

**Files:**
- Modify: `api/src/knowledge/integrations.controller.ts`
- Modify: `api/src/__tests__/unit/integrations-controller.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the existing `api/src/__tests__/unit/integrations-controller.test.ts` in the appropriate describe block:

```typescript
it('should auto-set webhookUrl when saving calcom with eventTypeId and webhookUrl is empty', async () => {
  mockFindOneOrFail.mockResolvedValue({
    id: 'tenant-123',
    settings: { integrations: { calcom: { apiKey: 'encrypted:key' } } },
    webhookUrl: null,
    webhookSecret: null,
  });

  const res = await request(app)
    .patch('/integrations')
    .send({ calcom: { eventTypeId: 123 } });

  expect(res.status).toBe(200);
  expect(mockSave).toHaveBeenCalledWith(
    expect.objectContaining({
      webhookUrl: expect.any(String),
    })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run integrations-controller --no-coverage`
Expected: FAIL — webhookUrl not being set

- [ ] **Step 3: Add auto-set logic to updateIntegrations**

In `api/src/knowledge/integrations.controller.ts`, add to `updateIntegrations` after `await tenantRepo.save(tenant)` — actually, before the save, after the settings merge:

```typescript
  // Auto-set webhook URL if saving Cal.com with eventTypeId and webhook not configured
  if (updated.calcom?.eventTypeId && !tenant.webhookUrl && config.n8n.defaultWebhookUrl) {
    tenant.webhookUrl = config.n8n.defaultWebhookUrl;
    if (!tenant.webhookSecret) {
      tenant.webhookSecret = crypto.randomBytes(32).toString('hex');
    }
  }
```

Add this block right before `await tenantRepo.save(tenant);` in the `updateIntegrations` function. `crypto` and `config` are already imported from Task 1.

- [ ] **Step 4: Run tests and verify they pass**

Run: `cd chatbot-platform/api && npx vitest run integrations-controller --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/knowledge/integrations.controller.ts api/src/__tests__/unit/integrations-controller.test.ts
git commit -m "feat: auto-set webhookUrl when Cal.com eventTypeId is saved"
```

---

### Task 3: Frontend — Query hooks and query keys

**Files:**
- Modify: `portal/src/queries/queryKeys.ts`
- Create: `portal/src/queries/useIntegrationQueries.ts`

- [ ] **Step 1: Add query keys**

Add to `portal/src/queries/queryKeys.ts` inside the `queryKeys` object:

```typescript
  integrations: {
    all: () => ['integrations'] as const,
    calcom: () => [...queryKeys.integrations.all(), 'calcom'] as const,
  },
```

- [ ] **Step 2: Create integration query hooks**

```typescript
// portal/src/queries/useIntegrationQueries.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface CalcomEventType {
  id: number;
  title: string;
  length: number;
  slug: string;
}

interface CalcomIntegration {
  hasApiKey: boolean;
  eventTypeId?: number;
  collectFields?: string[];
  language?: string;
}

interface IntegrationsData {
  calcom?: CalcomIntegration;
}

export function useIntegrations() {
  return useQuery({
    queryKey: queryKeys.integrations.all(),
    queryFn: async () => {
      // GET /integrations returns raw JSON (not enveloped), so no unwrapping needed
      const result = await api.get<Any>('/tenants/me/integrations');
      return result as IntegrationsData;
    },
  });
}

export function useConnectCalcom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) =>
      api.post<{ eventTypes: CalcomEventType[] }>('/tenants/me/integrations/calcom/connect', { apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
    },
    onError: (err: Any) => {
      const msg = err?.response?.data?.error || err?.message || 'Failed to connect';
      toast.error(msg);
    },
  });
}

export function useUpdateIntegrations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Any) => api.patch('/tenants/me/integrations', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      toast.success('Settings saved');
    },
    onError: () => toast.error('Failed to save settings'),
  });
}
```

- [ ] **Step 3: Add export to queries index**

Add to `portal/src/queries/index.ts`:

```typescript
export * from './useIntegrationQueries';
```

- [ ] **Step 4: Commit**

```bash
git add portal/src/queries/queryKeys.ts portal/src/queries/useIntegrationQueries.ts portal/src/queries/index.ts
git commit -m "feat: add integration query hooks for Cal.com settings"
```

---

### Task 4: Frontend — CalcomSettings component

**Files:**
- Create: `portal/src/components/settings/CalcomSettings.tsx`
- Modify: `portal/src/components/settings/IntegrationTab.tsx`

- [ ] **Step 1: Create the CalcomSettings component**

```tsx
// portal/src/components/settings/CalcomSettings.tsx
import React, { useState, useEffect } from 'react';
import { Calendar, CheckCircle, Loader2, X, ChevronDown, Eye, EyeOff } from 'lucide-react';
import {
  useIntegrations,
  useConnectCalcom,
  useUpdateIntegrations,
} from '../../queries/useIntegrationQueries';

type State = 'idle' | 'connecting' | 'pick_event_type' | 'saving' | 'connected' | 'disconnecting';

interface EventType {
  id: number;
  title: string;
  length: number;
  slug: string;
}

export const CalcomSettings: React.FC = () => {
  const { data: integrations, isLoading } = useIntegrations();
  const connectMutation = useConnectCalcom();
  const updateMutation = useUpdateIntegrations();

  const [state, setState] = useState<State>('idle');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [selectedEventType, setSelectedEventType] = useState<number | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [language, setLanguage] = useState('en');
  const [collectFields, setCollectFields] = useState<string[]>(['name', 'email']);

  // Derive state from server data on load
  useEffect(() => {
    if (!integrations) return;
    const calcom = integrations.calcom;
    if (calcom?.hasApiKey && calcom?.eventTypeId) {
      setState('connected');
      setSelectedEventType(calcom.eventTypeId);
      setLanguage(calcom.language || 'en');
      setCollectFields(calcom.collectFields || ['name', 'email']);
    } else if (calcom?.hasApiKey && !calcom?.eventTypeId) {
      // Key stored but no event type selected yet — need to reconnect to fetch types
      setState('idle');
    } else {
      setState('idle');
    }
  }, [integrations]);

  const handleConnect = async () => {
    setConnectError(null);
    setState('connecting');
    try {
      const result = await connectMutation.mutateAsync(apiKey);
      const types = (result as any)?.eventTypes || (result as any)?.data?.eventTypes || [];
      setEventTypes(types);
      if (types.length === 1) {
        setSelectedEventType(types[0].id);
      }
      setState('pick_event_type');
      setApiKey('');
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Connection failed';
      setConnectError(msg);
      setState('idle');
    }
  };

  const handleSaveEventType = async () => {
    if (!selectedEventType) return;
    setState('saving');
    try {
      // Always send full payload to avoid partial-update defaults overwriting existing values
      await updateMutation.mutateAsync({
        calcom: {
          eventTypeId: selectedEventType,
          language,
          collectFields,
        },
      });
      setState('connected');
    } catch {
      setState('pick_event_type');
    }
  };

  const handleDisconnect = async () => {
    setState('disconnecting');
    try {
      await updateMutation.mutateAsync({ calcom: null });
      setState('idle');
      setEventTypes([]);
      setSelectedEventType(null);
      setShowDisconnectConfirm(false);
    } catch {
      setState('connected');
      setShowDisconnectConfirm(false);
    }
  };

  const toggleCollectField = (field: string) => {
    setCollectFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    );
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-edge bg-surface-3 p-6">
        <div className="flex items-center gap-2 text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading...
        </div>
      </div>
    );
  }

  const selectedType = eventTypes.find((et) => et.id === selectedEventType);

  return (
    <div className="rounded-xl border border-edge bg-surface-3 p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-600/10">
            <Calendar className="h-5 w-5 text-primary-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-primary">Appointment Booking</h3>
            <p className="text-xs text-text-muted">Connect Cal.com to let your chatbot book appointments</p>
          </div>
        </div>
        {state === 'connected' && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-500">
            <CheckCircle className="h-3 w-3" />
            Connected
          </span>
        )}
      </div>

      {/* Idle: API Key Input */}
      {state === 'idle' && (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-secondary mb-1 block">Cal.com API Key</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="cal_live_..."
                  className="w-full rounded-lg border border-edge bg-transparent px-3 py-2 text-sm text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-secondary"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <button
                onClick={handleConnect}
                disabled={!apiKey.trim()}
                className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Connect
              </button>
            </div>
            <p className="text-xs text-text-muted mt-1">
              Find your API key at Cal.com → Settings → Developer → API Keys
            </p>
          </div>
          {connectError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
              {connectError}
            </div>
          )}
        </div>
      )}

      {/* Connecting spinner */}
      {state === 'connecting' && (
        <div className="flex items-center gap-2 text-text-muted py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Connecting to Cal.com...
        </div>
      )}

      {/* Pick Event Type */}
      {state === 'pick_event_type' && (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-secondary mb-1 block">Event Type</label>
            <p className="text-xs text-text-muted mb-2">Select which appointment type the chatbot should book</p>
            <div className="relative">
              <select
                value={selectedEventType || ''}
                onChange={(e) => setSelectedEventType(Number(e.target.value))}
                className="w-full appearance-none rounded-lg border border-edge bg-transparent px-3 py-2 text-sm text-primary focus:border-primary-500 focus:outline-none pr-8"
              >
                <option value="">Select an event type...</option>
                {eventTypes.map((et) => (
                  <option key={et.id} value={et.id}>
                    {et.title} ({et.length} min)
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted pointer-events-none" />
            </div>
          </div>
          <button
            onClick={handleSaveEventType}
            disabled={!selectedEventType}
            className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      )}

      {/* Saving spinner */}
      {state === 'saving' && (
        <div className="flex items-center gap-2 text-text-muted py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Saving...
        </div>
      )}

      {/* Connected */}
      {state === 'connected' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-edge px-3 py-2">
            <div>
              <p className="text-sm text-primary">
                {selectedType?.title || `Event Type #${selectedEventType}`}
                {selectedType && <span className="text-text-muted ml-1">({selectedType.length} min)</span>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  // Re-connect to fetch fresh event types for switching
                  setState('idle');
                  setApiKey('');
                  setEventTypes([]);
                }}
                className="text-xs text-primary-400 hover:text-primary-300"
              >
                Change
              </button>
              <button
                onClick={() => setShowDisconnectConfirm(true)}
                className="text-xs text-red-400 hover:text-red-300"
              >
                Disconnect
              </button>
            </div>
          </div>

          {/* Advanced Settings */}
          <div>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-secondary"
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
              Advanced Settings
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3 pl-4 border-l border-edge">
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">Language</label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="rounded-lg border border-edge bg-transparent px-3 py-1.5 text-sm text-primary focus:border-primary-500 focus:outline-none"
                  >
                    <option value="en">English</option>
                    <option value="nl">Nederlands</option>
                    <option value="fr">Français</option>
                    <option value="de">Deutsch</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">Collect from customer</label>
                  <div className="flex flex-wrap gap-2">
                    {['name', 'email', 'phone', 'notes'].map((field) => (
                      <label key={field} className="flex items-center gap-1.5 text-xs text-secondary">
                        <input
                          type="checkbox"
                          checked={collectFields.includes(field)}
                          onChange={() => toggleCollectField(field)}
                          disabled={field === 'name' || field === 'email'}
                          className="rounded border-edge"
                        />
                        {field.charAt(0).toUpperCase() + field.slice(1)}
                      </label>
                    ))}
                  </div>
                </div>
                <button
                  onClick={handleSaveEventType}
                  className="rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-600"
                >
                  Save Advanced Settings
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Disconnect Confirmation */}
      {showDisconnectConfirm && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 space-y-2">
          <p className="text-sm text-primary">Disconnect Cal.com? Your chatbot will no longer be able to book appointments.</p>
          <div className="flex gap-2">
            <button
              onClick={handleDisconnect}
              disabled={state === 'disconnecting'}
              className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
            >
              {state === 'disconnecting' ? 'Disconnecting...' : 'Yes, Disconnect'}
            </button>
            <button
              onClick={() => setShowDisconnectConfirm(false)}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-secondary hover:bg-surface-3"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Add CalcomSettings to IntegrationTab**

At the top of `portal/src/components/settings/IntegrationTab.tsx`, add the import:

```typescript
import { CalcomSettings } from './CalcomSettings';
```

Then render it inside the component. Find the closing `</div>` after the "API Key" card section (after the first `<Card>` block) and add before the "Webhook URL" card:

```tsx
{/* Cal.com Booking */}
<CalcomSettings />
```

The exact insertion point is after the API Key card and before the Webhook URL card in the IntegrationTab component's JSX.

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/settings/CalcomSettings.tsx portal/src/components/settings/IntegrationTab.tsx
git commit -m "feat: add Cal.com settings UI component with connect/disconnect flow"
```

---

### Task 5: Integration test and deploy

**Files:**
- No new files — run existing tests + manual verification

- [ ] **Step 1: Run all backend tests**

Run: `cd chatbot-platform/api && npx vitest run --no-coverage`
Expected: All tests PASS

- [ ] **Step 2: Run portal build**

Run: `cd chatbot-platform/portal && npm run build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Commit and push**

```bash
git push origin main
```

- [ ] **Step 4: Verify deployment**

After Railway deploys:
1. Open portal Settings → Integrations
2. Verify "Appointment Booking" card appears
3. Test connect flow with a Cal.com API key
4. Verify event type dropdown appears
5. Select event type and save
6. Verify "Connected" badge shows
7. Test disconnect flow
