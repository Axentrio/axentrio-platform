# n8n Onboarding Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable customers to go from sign-up to a working AI chatbot in under 10 minutes, without reading docs.

**Architecture:** Fix the existing webhook test endpoint to use production-matching HMAC signatures, add `requireAdmin` to the `GET /tenants/me` secrets response, build a guided "Bot Connection" setup section in the portal's IntegrationTab, and ship one import-ready n8n template with inline troubleshooting. Path A (connect existing workflow) ships first, Path B (template download + guide) ships second.

**Tech Stack:** Express + TypeORM (API), React + TanStack Query + Tailwind (Portal), Vitest + Supertest (Tests), n8n workflow JSON

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `api/src/routes/webhook-admin.routes.ts` | Fix test endpoint to use HMAC signing |
| Modify | `api/src/routes/tenants.ts:33-67` | Add `requireAdmin` to `GET /tenants/me` for secrets |
| Modify | `portal/src/components/settings/IntegrationTab.tsx` | Add setup wizard section, troubleshooting, template download |
| Modify | `portal/src/queries/useWebhookQueries.ts` | Enhance test webhook response handling |
| Create | `api/src/utils/webhook-signature.ts` | Shared HMAC signature generation (DRY with outbound.service.ts) |
| Modify | `api/src/n8n/outbound.service.ts:468-473` | Use shared signature util |
| Modify | `api/src/__tests__/integration/webhook.test.ts` | Add tests for HMAC test endpoint |
| Modify | `docs/n8n-workflows/basic-chatbot.json` | Make import-ready with parameterized URLs and auth headers |

---

### Task 1: Extract Shared HMAC Signature Utility

**Files:**
- Create: `api/src/utils/webhook-signature.ts`
- Modify: `api/src/n8n/outbound.service.ts:468-473`

The test endpoint and the outbound service both need to sign payloads the same way. Extract the HMAC logic into a shared utility so they stay in sync.

- [ ] **Step 1: Create the shared signature utility**

Create `api/src/utils/webhook-signature.ts`:

```typescript
import crypto from 'crypto';

/**
 * Generate HMAC-SHA256 signature for webhook payloads.
 * Format: sha256=<hex_digest>
 */
export function generateWebhookSignature(payload: unknown, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  return `sha256=${hmac.digest('hex')}`;
}
```

- [ ] **Step 2: Update outbound.service.ts to use the shared utility**

In `api/src/n8n/outbound.service.ts`, replace the `generateSignature` private method (lines 468-473):

```typescript
// At the top of the file, add:
import { generateWebhookSignature } from '../utils/webhook-signature';

// Replace the private generateSignature method body (line 468-473) with:
private generateSignature(payload: unknown, secret: string): string {
  return generateWebhookSignature(payload, secret);
}
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `cd api && npx vitest run src/__tests__/unit/circuit-breaker.test.ts --reporter=verbose`
Expected: All existing tests PASS (no signature logic changed, just extracted)

- [ ] **Step 4: Commit**

```bash
git add api/src/utils/webhook-signature.ts api/src/n8n/outbound.service.ts
git commit -m "refactor: extract shared HMAC signature utility"
```

---

### Task 2: Fix Test Webhook Endpoint to Use HMAC Signing

**Files:**
- Modify: `api/src/routes/webhook-admin.routes.ts:76-141`
- Modify: `api/src/__tests__/integration/webhook.test.ts`

The current test endpoint sends `X-Webhook-Secret` as a plain header, but production outbound delivery uses `X-Webhook-Signature` with HMAC. This means a workflow can "pass" the test but fail on real traffic. Fix the test endpoint to sign exactly like production.

- [ ] **Step 1: Write the failing test**

Add to `api/src/__tests__/integration/webhook.test.ts`, inside a new describe block:

```typescript
describe('POST /api/v1/tenants/me/webhooks/test — HMAC signing', () => {
  it('should send X-Webhook-Signature header matching production format', async () => {
    // This test verifies the test endpoint signs its payload with HMAC,
    // not a plain X-Webhook-Secret header.
    // We can't easily intercept the outgoing request in an integration test,
    // but we can verify the response includes the signature that was sent.
    const tenant = await createTestTenant({
      webhookUrl: 'https://httpbin.org/post',
      webhookSecret: 'hmac-test-secret',
    });

    const res = await request(app)
      .post('/api/v1/tenants/me/webhooks/test')
      .set('Authorization', `Bearer test-token-${tenant.id}`)
      .send();

    // The endpoint should return signature metadata so the UI can display it
    expect(res.body.data).toHaveProperty('signatureHeader');
    expect(res.body.data.signatureHeader).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('should include production-matching headers in test payload', async () => {
    const tenant = await createTestTenant({
      webhookUrl: 'https://httpbin.org/post',
      webhookSecret: 'hmac-test-secret',
    });

    const res = await request(app)
      .post('/api/v1/tenants/me/webhooks/test')
      .set('Authorization', `Bearer test-token-${tenant.id}`)
      .send();

    // Response should include the headers that were sent for debugging
    expect(res.body.data).toHaveProperty('headersSent');
    expect(res.body.data.headersSent).toHaveProperty('X-Webhook-Signature');
    expect(res.body.data.headersSent).toHaveProperty('X-Tenant-ID');
    expect(res.body.data.headersSent).toHaveProperty('X-Event-Type');
    expect(res.body.data.headersSent).toHaveProperty('X-Timestamp');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/__tests__/integration/webhook.test.ts --reporter=verbose`
Expected: FAIL — `signatureHeader` and `headersSent` not in response

- [ ] **Step 3: Update the test endpoint to use HMAC signing and return debug info**

Replace the `POST /test` handler in `api/src/routes/webhook-admin.routes.ts` (lines 76-141):

```typescript
import { generateWebhookSignature } from '../utils/webhook-signature';

/**
 * POST /api/v1/tenants/me/webhooks/test — send test ping with production-matching headers
 */
router.post('/test', asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOne({ where: { id: tenantId } });

  if (!tenant?.webhookUrl) throw new BadRequestError('No webhook URL configured');

  const payload = {
    event: 'webhook.test',
    tenantId,
    sessionId: 'test-session',
    payload: { type: 'text', content: 'Test ping from chatbot platform' },
    timestamp: new Date().toISOString(),
  };

  // Build production-matching headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-ID': tenantId,
    'X-Event-Type': 'webhook.test',
    'X-Timestamp': payload.timestamp,
  };

  let signatureHeader: string | null = null;
  if (tenant.webhookSecret) {
    signatureHeader = generateWebhookSignature(payload, tenant.webhookSecret);
    headers['X-Webhook-Signature'] = signatureHeader;
  }

  const startTime = Date.now();
  try {
    const response = await axios.post(tenant.webhookUrl, payload, {
      timeout: 10000,
      headers,
    });

    const durationMs = Date.now() - startTime;

    // Log successful test
    const logRepo = AppDataSource.getRepository(WebhookDeliveryLog);
    await logRepo.save(logRepo.create({
      tenantId,
      event: 'webhook.test',
      direction: 'outbound' as const,
      url: tenant.webhookUrl,
      status: 'success' as const,
      httpStatus: response.status,
      durationMs,
    }));

    sendSuccess(res, {
      status: response.status,
      durationMs,
      signatureHeader,
      headersSent: headers,
      payloadSent: payload,
      responseBody: typeof response.data === 'object' ? response.data : { raw: String(response.data).slice(0, 500) },
    });
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const axiosErr = err as { response?: { status: number; data?: unknown }; message?: string; code?: string };

    // Log failed test
    const logRepo = AppDataSource.getRepository(WebhookDeliveryLog);
    await logRepo.save(logRepo.create({
      tenantId,
      event: 'webhook.test',
      direction: 'outbound' as const,
      url: tenant.webhookUrl,
      status: 'failed' as const,
      httpStatus: axiosErr.response?.status,
      durationMs,
      error: axiosErr.message || 'Unknown error',
    }));

    // Return failure info with diagnostic hints
    const diagnostic = diagnosTestFailure(axiosErr);

    res.json({
      success: false,
      data: {
        status: axiosErr.response?.status || 0,
        durationMs,
        error: axiosErr.message,
        errorCode: axiosErr.code,
        signatureHeader,
        headersSent: headers,
        payloadSent: payload,
        diagnostic,
      },
    });
  }
}));

/**
 * Provide human-readable diagnostic hints for common webhook test failures
 */
function diagnosTestFailure(err: { response?: { status: number; data?: unknown }; message?: string; code?: string }): string {
  const status = err.response?.status;
  const code = err.code;

  if (code === 'ECONNREFUSED') return 'Connection refused — is your n8n instance running and is the webhook URL correct?';
  if (code === 'ENOTFOUND') return 'Host not found — check the webhook URL for typos.';
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return 'Request timed out — is your n8n instance reachable from the internet? If using n8n Cloud, check the workflow is active.';
  if (status === 401) return 'Unauthorized — your n8n workflow may be checking credentials that don\'t match. Verify the webhook secret.';
  if (status === 403) return 'Forbidden — check firewall or access rules on your n8n instance.';
  if (status === 404) return 'Not found — the webhook path may be wrong, or the workflow is inactive. In n8n, workflows must be active for production webhooks to work (test URLs only work while the workflow editor is open).';
  if (status === 500) return 'Server error on your webhook endpoint — check your n8n execution log for errors.';
  if (status && status >= 400) return `HTTP ${status} error from your webhook endpoint. Check your n8n execution log.`;

  return 'Unexpected error — check that the webhook URL is correct and the n8n workflow is active.';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/__tests__/integration/webhook.test.ts --reporter=verbose`
Expected: PASS for the new HMAC signing tests

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/webhook-admin.routes.ts api/src/__tests__/integration/webhook.test.ts
git commit -m "fix: test webhook endpoint uses HMAC signing matching production"
```

---

### Task 3: Add `requireAdmin` to Secrets in `GET /tenants/me`

**Files:**
- Modify: `api/src/routes/tenants.ts:33-67`
- Modify: `api/src/__tests__/integration/tenant.test.ts`

Currently `GET /tenants/me` returns `apiKey` and `webhookSecret` to any authenticated user. Only admins should see secrets.

- [ ] **Step 1: Write the failing test**

Add to `api/src/__tests__/integration/tenant.test.ts`:

```typescript
describe('GET /api/v1/tenants/me — secret visibility', () => {
  it('should not return apiKey or webhookSecret for non-admin users', async () => {
    const res = await request(app)
      .get('/api/v1/tenants/me')
      .set('Authorization', 'Bearer test-agent-token')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('apiKey');
    expect(res.body.data).not.toHaveProperty('webhookSecret');
    // Should still have non-sensitive fields
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('name');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/__tests__/integration/tenant.test.ts --reporter=verbose`
Expected: FAIL — apiKey and webhookSecret are currently returned for all users

- [ ] **Step 3: Implement conditional secret visibility**

In `api/src/routes/tenants.ts`, modify the `GET /me` handler (lines 48-64) to conditionally include secrets:

```typescript
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin';

    res.json({
      success: true,
      data: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        tier: tenant.tier,
        status: tenant.status,
        settings: tenant.settings,
        maxSessions: tenant.maxSessions,
        currentSessions: tenant.currentSessions,
        webhookUrl: tenant.webhookUrl,
        customDomain: tenant.customDomain,
        createdAt: tenant.createdAt,
        // Secrets only visible to admins
        ...(isAdmin ? {
          apiKey: tenant.apiKey,
          webhookSecret: tenant.webhookSecret,
        } : {}),
      },
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/__tests__/integration/tenant.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/tenants.ts api/src/__tests__/integration/tenant.test.ts
git commit -m "fix: hide apiKey and webhookSecret from non-admin users"
```

---

### Task 4: Enhance Frontend Test Webhook Response Handling

**Files:**
- Modify: `portal/src/queries/useWebhookQueries.ts`

Update the `useTestWebhook` hook to return the full diagnostic response so the UI can display it.

- [ ] **Step 1: Update useTestWebhook to return response data**

In `portal/src/queries/useWebhookQueries.ts`, update the `useTestWebhook` mutation:

```typescript
export function useTestWebhook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post('/tenants/me/webhooks/test');
      return res.data; // Return full response including diagnostic info
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.status() });
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.deliveries() });
      if (data?.success === false) {
        // Test completed but webhook failed — not a network error
        return; // Let the caller handle the UI
      }
      toast.success('Test webhook sent successfully');
    },
    onError: () => {
      toast.error('Failed to send test webhook');
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add portal/src/queries/useWebhookQueries.ts
git commit -m "feat: return full diagnostic data from test webhook mutation"
```

---

### Task 5: Build the "Bot Connection" Setup Section in IntegrationTab

**Files:**
- Modify: `portal/src/components/settings/IntegrationTab.tsx`

Add a guided "Bot Connection" section at the top of the IntegrationTab with:
- Step indicator (1. Connect → 2. Test → 3. Embed)
- Webhook URL input with inline test + diagnostic results
- Inbound URL + secret display with auth instructions
- Troubleshooting panel for test failures
- Embed snippet with platform tabs (HTML, React)

- [ ] **Step 1: Add the setup status helper and types**

At the top of `IntegrationTab.tsx`, after the existing interfaces (after line 77), add:

```typescript
interface TestResult {
  success: boolean;
  data: {
    status: number;
    durationMs: number;
    error?: string;
    errorCode?: string;
    diagnostic?: string;
    signatureHeader?: string;
    headersSent?: Record<string, string>;
    payloadSent?: Record<string, unknown>;
    responseBody?: Record<string, unknown>;
  };
}

type SetupStep = 'connect' | 'test' | 'embed';

function getSetupStep(tenantData: Record<string, unknown> | undefined, testPassed: boolean): SetupStep {
  if (!tenantData?.webhookUrl) return 'connect';
  if (!testPassed) return 'test';
  return 'embed';
}
```

- [ ] **Step 2: Add state and compute setup step in the component**

Inside the `IntegrationTab` component, after the existing state declarations (after line 124), add:

```typescript
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testPassed, setTestPassed] = useState(false);
  const [activeEmbedTab, setActiveEmbedTab] = useState<'html' | 'react'>('html');

  const currentStep = getSetupStep(tenantData as Record<string, unknown> | undefined, testPassed);
```

- [ ] **Step 3: Add the Bot Connection setup card**

At the top of the return JSX (after `<div className="space-y-6">`), before the existing API Key card, add the Bot Connection section:

```tsx
      {/* Bot Connection Setup */}
      <Card variant="glass" className="border-2 border-accent/30">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary">
            Bot Connection Setup
          </h2>
          <div className="flex items-center gap-4 mt-2">
            {(['connect', 'test', 'embed'] as const).map((step, i) => (
              <div key={step} className="flex items-center gap-2">
                <div className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold',
                  currentStep === step ? 'bg-accent text-white' :
                  (['connect', 'test', 'embed'].indexOf(currentStep) > i) ? 'bg-status-online text-white' :
                  'bg-surface-3 text-text-muted'
                )}>
                  {(['connect', 'test', 'embed'].indexOf(currentStep) > i) ? '✓' : i + 1}
                </div>
                <span className={cn(
                  'text-sm',
                  currentStep === step ? 'text-text-primary font-medium' : 'text-text-muted'
                )}>
                  {step === 'connect' ? 'Connect' : step === 'test' ? 'Test' : 'Embed'}
                </span>
                {i < 2 && <div className="w-8 h-px bg-edge" />}
              </div>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Step 1: Webhook URL */}
          <div>
            <Label className="text-text-secondary mb-1 block">
              Your n8n Webhook URL
            </Label>
            <p className="text-xs text-text-muted mb-2">
              Paste the webhook URL from your n8n workflow's trigger node. This is where we'll send visitor messages.
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={webhookUrlInput}
                onChange={e => setWebhookUrlInput(e.target.value)}
                placeholder="https://your-n8n.example.com/webhook/..."
                className="flex-1 font-mono text-sm"
              />
              <Button
                variant="outline"
                onClick={() => saveWebhookUrl.mutate(webhookUrlInput)}
                disabled={saveWebhookUrl.isPending || !webhookUrlInput}
              >
                <Save className="w-4 h-4 mr-1" />
                Save
              </Button>
              <Button
                variant="default"
                onClick={async () => {
                  const result = await testWebhook.mutateAsync();
                  const parsed = (result as { data?: TestResult })?.data as TestResult | undefined;
                  if (parsed) {
                    setTestResult(parsed);
                    setTestPassed(parsed.success !== false && (parsed.data?.status ?? 0) >= 200 && (parsed.data?.status ?? 0) < 300);
                  }
                }}
                disabled={testWebhook.isPending || !tenantData?.webhookUrl}
              >
                {testWebhook.isPending ? (
                  <RotateCw className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Activity className="w-4 h-4 mr-1" />
                )}
                Test
              </Button>
            </div>
          </div>

          {/* Test Result */}
          {testResult && (
            <div className={cn(
              'rounded-xl border p-4',
              testPassed ? 'border-status-online/50 bg-status-online/5' : 'border-red-500/50 bg-red-500/5'
            )}>
              <div className="flex items-center gap-2 mb-2">
                <div className={cn(
                  'w-3 h-3 rounded-full',
                  testPassed ? 'bg-status-online' : 'bg-red-500'
                )} />
                <span className={cn(
                  'font-medium text-sm',
                  testPassed ? 'text-status-online' : 'text-red-500'
                )}>
                  {testPassed ? 'Connection successful' : 'Connection failed'}
                </span>
                <span className="text-xs text-text-muted ml-auto">
                  {testResult.data?.durationMs}ms · HTTP {testResult.data?.status || 'N/A'}
                </span>
              </div>
              {!testPassed && testResult.data?.diagnostic && (
                <p className="text-sm text-text-secondary mb-2">
                  {testResult.data.diagnostic}
                </p>
              )}
              {testResult.data?.payloadSent && (
                <details className="mt-2">
                  <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary">
                    Show request/response details
                  </summary>
                  <div className="mt-2 space-y-2">
                    <div>
                      <p className="text-xs font-medium text-text-muted mb-1">Request payload:</p>
                      <pre className="text-xs bg-surface-3 rounded-lg p-2 overflow-x-auto">
                        {JSON.stringify(testResult.data.payloadSent, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-text-muted mb-1">Headers sent:</p>
                      <pre className="text-xs bg-surface-3 rounded-lg p-2 overflow-x-auto">
                        {JSON.stringify(testResult.data.headersSent, null, 2)}
                      </pre>
                    </div>
                    {testResult.data?.responseBody && (
                      <div>
                        <p className="text-xs font-medium text-text-muted mb-1">Response body:</p>
                        <pre className="text-xs bg-surface-3 rounded-lg p-2 overflow-x-auto">
                          {JSON.stringify(testResult.data.responseBody, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Inbound Webhook Info */}
          <div className="border border-edge rounded-xl p-4 space-y-3">
            <p className="text-sm font-medium text-text-primary">
              Your n8n workflow needs to send responses back to this URL:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-lg text-text-primary font-mono text-sm">
                {inboundWebhookUrl}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(inboundWebhookUrl, 'Inbound webhook URL')}
              >
                <Copy className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-xs text-text-muted">
              Include these headers in your HTTP Request node:
            </p>
            <pre className="text-xs bg-surface-3 rounded-lg p-3 overflow-x-auto font-mono">
{`Headers:
  Content-Type: application/json
  X-Webhook-Secret: ${tenantData?.webhookSecret ? maskSecret(tenantData.webhookSecret as string) : '<your webhook secret>'}

Body (JSON):
{
  "action": "message.send",
  "tenantId": "${tenantData?.id || '<your-tenant-id>'}",
  "sessionId": "{{ $json.sessionId }}",
  "payload": {
    "type": "text",
    "content": "{{ $json.aiResponse }}"
  }
}`}
            </pre>
          </div>

          {/* Embed Code (visible after test passes) */}
          {testPassed && (
            <div className="border border-status-online/30 rounded-xl p-4 space-y-3">
              <p className="text-sm font-medium text-text-primary">
                Your bot is connected. Add this snippet to your website:
              </p>
              <div className="flex gap-2 mb-2">
                <button
                  className={cn('text-xs px-3 py-1 rounded-lg', activeEmbedTab === 'html' ? 'bg-accent text-white' : 'bg-surface-3 text-text-muted')}
                  onClick={() => setActiveEmbedTab('html')}
                >HTML</button>
                <button
                  className={cn('text-xs px-3 py-1 rounded-lg', activeEmbedTab === 'react' ? 'bg-accent text-white' : 'bg-surface-3 text-text-muted')}
                  onClick={() => setActiveEmbedTab('react')}
                >React</button>
              </div>
              <pre className="text-xs bg-surface-3 rounded-lg p-3 overflow-x-auto font-mono">
                {activeEmbedTab === 'html'
                  ? `<script\n  src="${window.location.origin}/widget.js"\n  data-api-key="${tenantData?.apiKey || '<your-api-key>'}"\n  async\n></script>`
                  : `import { ChatWidget } from '@handsoff/widget';\n\n<ChatWidget apiKey="${tenantData?.apiKey || '<your-api-key>'}" />`
                }
              </pre>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(
                  activeEmbedTab === 'html'
                    ? `<script src="${window.location.origin}/widget.js" data-api-key="${tenantData?.apiKey || ''}" async></script>`
                    : `import { ChatWidget } from '@handsoff/widget';\n\n<ChatWidget apiKey="${tenantData?.apiKey || ''}" />`,
                  'Embed snippet'
                )}
              >
                <Copy className="w-4 h-4 mr-1" />
                Copy snippet
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
```

- [ ] **Step 4: Verify the portal compiles**

Run: `cd portal && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/settings/IntegrationTab.tsx portal/src/queries/useWebhookQueries.ts
git commit -m "feat: add Bot Connection setup section with diagnostics and embed code"
```

---

### Task 6: Make basic-chatbot.json Import-Ready

**Files:**
- Modify: `docs/n8n-workflows/basic-chatbot.json`

The current template has unresolved `{{ $json.webhookUrl }}` placeholders and no `X-Webhook-Secret` header. Fix it to be a properly parameterized, import-and-run template that new users only need to update 2 values: their inbound URL and their webhook secret.

- [ ] **Step 1: Read the full current template**

Read `docs/n8n-workflows/basic-chatbot.json` to understand all nodes.

- [ ] **Step 2: Update the template**

Update the "Send to Chatbot" HTTP Request node to:
1. Use a clearly-marked placeholder URL: `https://YOUR-API-URL/api/v1/webhooks/inbound`
2. Include `X-Webhook-Secret` header with placeholder: `YOUR-WEBHOOK-SECRET`
3. Include `Content-Type: application/json` header
4. Use the correct inbound payload format with `action`, `tenantId`, `sessionId`, `payload`

The updated "Send to Chatbot" node parameters should be:

```json
{
  "parameters": {
    "method": "POST",
    "url": "=https://YOUR-API-URL/api/v1/webhooks/inbound",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        { "name": "Content-Type", "value": "application/json" },
        { "name": "X-Webhook-Secret", "value": "=YOUR-WEBHOOK-SECRET" }
      ]
    },
    "sendBody": true,
    "bodyParameters": {
      "parameters": [
        { "name": "action", "value": "message.send" },
        { "name": "tenantId", "value": "={{ $json.tenantId }}" },
        { "name": "sessionId", "value": "={{ $json.sessionId }}" },
        { "name": "payload", "value": "={{ JSON.stringify({ type: 'text', content: $json.responseText }) }}" }
      ]
    }
  }
}
```

Also update the workflow name to: `"name": "HandsOff Basic Chatbot (Import Ready)"`

Add a "Sticky Note" node with setup instructions:

```json
{
  "parameters": {
    "content": "## Setup Instructions\n\n1. Replace YOUR-API-URL in the 'Send to Chatbot' node with your API URL (e.g. https://api.handsoff.chat)\n2. Replace YOUR-WEBHOOK-SECRET in the 'Send to Chatbot' node with your webhook secret from Settings → Integrations\n3. Activate this workflow\n4. Copy the webhook URL from the trigger node and paste it in Settings → Integrations → Webhook URL"
  },
  "id": "setup-note",
  "name": "Setup Instructions",
  "type": "n8n-nodes-base.stickyNote",
  "typeVersion": 1,
  "position": [50, 100]
}
```

- [ ] **Step 3: Validate the JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('docs/n8n-workflows/basic-chatbot.json', 'utf8')); console.log('Valid JSON')"`
Expected: `Valid JSON`

- [ ] **Step 4: Commit**

```bash
git add docs/n8n-workflows/basic-chatbot.json
git commit -m "fix: make basic-chatbot template import-ready with auth headers"
```

---

### Task 7: Add Template Download to IntegrationTab

**Files:**
- Modify: `portal/src/components/settings/IntegrationTab.tsx`

Add a "Download n8n Template" section below the Bot Connection card for users who don't have a workflow yet.

- [ ] **Step 1: Add the template download section**

After the Bot Connection card closing `</Card>`, add:

```tsx
      {/* n8n Template Download */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <ExternalLink className="w-5 h-5" />
            Don't have an n8n workflow?
          </h2>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-text-secondary">
            Download our starter template and import it into your n8n instance. It includes a webhook trigger, message handling, and response formatting — you just need to add your AI provider credentials.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                window.open('/api/v1/templates/basic-chatbot.json', '_blank');
              }}
            >
              Download Basic Template
            </Button>
          </div>
          <details>
            <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary">
              Quick setup guide
            </summary>
            <ol className="mt-2 text-sm text-text-secondary space-y-1 list-decimal list-inside">
              <li>Download the template JSON file above</li>
              <li>In n8n, go to Workflows → Import from File → select the JSON</li>
              <li>Open the "Send to Chatbot" node → replace <code className="text-xs bg-surface-3 px-1 rounded">YOUR-API-URL</code> with your API URL</li>
              <li>In the same node, replace <code className="text-xs bg-surface-3 px-1 rounded">YOUR-WEBHOOK-SECRET</code> with the secret shown below in "Webhook Secret"</li>
              <li>Activate the workflow</li>
              <li>Copy the webhook URL from the trigger node and paste it in the field above</li>
              <li>Click "Test" to verify the connection</li>
            </ol>
          </details>
        </CardContent>
      </Card>
```

- [ ] **Step 2: Add the template download API endpoint**

Create a static file serve route in `api/src/routes/tenants.ts` (or a new template routes file). The simplest approach is to serve the file from the docs directory:

In `api/src/server.ts`, after the existing static file middleware, add:

```typescript
import path from 'path';

// Serve n8n workflow templates
app.use('/api/v1/templates', express.static(
  path.join(__dirname, '../../docs/n8n-workflows'),
  { maxAge: '1h', setHeaders: (res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment');
  }}
));
```

- [ ] **Step 3: Verify the portal compiles**

Run: `cd portal && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/settings/IntegrationTab.tsx api/src/server.ts
git commit -m "feat: add n8n template download with setup guide"
```

---

### Task 8: Add `requireAdmin` to Webhook Admin Routes

**Files:**
- Modify: `api/src/server.ts:139`
- Modify: `api/src/__tests__/integration/webhook.test.ts`

The webhook admin routes (`/tenants/me/webhooks/*`) should require admin access since they expose delivery logs, test endpoints, and connection status.

- [ ] **Step 1: Write the failing test**

Add to `api/src/__tests__/integration/webhook.test.ts`:

```typescript
describe('Webhook admin routes — role authorization', () => {
  it('should return 403 for non-admin users on POST /test', async () => {
    const res = await request(app)
      .post('/api/v1/tenants/me/webhooks/test')
      .set('Authorization', 'Bearer test-agent-token') // agent role, not admin
      .send();

    expect(res.status).toBe(403);
  });

  it('should return 403 for non-admin users on GET /status', async () => {
    const res = await request(app)
      .get('/api/v1/tenants/me/webhooks/status')
      .set('Authorization', 'Bearer test-agent-token')
      .send();

    expect(res.status).toBe(403);
  });

  it('should return 403 for non-admin users on GET /deliveries', async () => {
    const res = await request(app)
      .get('/api/v1/tenants/me/webhooks/deliveries')
      .set('Authorization', 'Bearer test-agent-token')
      .send();

    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && npx vitest run src/__tests__/integration/webhook.test.ts --reporter=verbose`
Expected: FAIL — 200 instead of 403

- [ ] **Step 3: Add requireAdmin middleware to webhook admin route mounting**

In `api/src/server.ts` line 139, add `requireAdmin` to the middleware chain:

```typescript
apiRouter.use('/tenants/me/webhooks', requireClerkAuth, autoProvision, requireAdmin, webhookAdminRoutes);
```

Make sure `requireAdmin` is imported at the top of the file (check if it's already imported from middleware).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/__tests__/integration/webhook.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/server.ts api/src/__tests__/integration/webhook.test.ts
git commit -m "fix: require admin role for webhook admin routes"
```

---

## Summary of Changes

| Task | What | Why |
|------|------|-----|
| 1 | Extract HMAC signature utility | DRY — test and production use same signing |
| 2 | Fix test endpoint HMAC + diagnostics | Test matches production auth; failures are actionable |
| 3 | Hide secrets from non-admins | Security — agents shouldn't see API keys |
| 4 | Enhance test webhook response | Frontend needs diagnostic data from test results |
| 5 | Bot Connection setup section | Guided onboarding UX with step indicator |
| 6 | Fix basic-chatbot template | Import-ready with auth headers and setup note |
| 7 | Template download + guide | Path B — users without n8n workflows |
| 8 | Admin-gate webhook routes | Security — only admins manage webhooks |
