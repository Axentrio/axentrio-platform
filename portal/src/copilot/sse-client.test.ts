/**
 * The copilot SSE stream bypasses apiClient, so it does NOT inherit the
 * X-Tenant-Context header that apiClient sets on every other request. Without
 * it a super-admin's copilot turn is answered against their own tenant instead
 * of the one they are impersonating — a silent wrong-tenant answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamCopilotMessages } from './sse-client';
import { useTenantContextStore } from '../stores/tenantContextStore';

/** A 200 response whose body ends immediately — enough to exercise the header path. */
function emptyStreamResponse(): Response {
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
  } as unknown as Response;
}

async function drain(): Promise<void> {
  const args = {
    message: 'hi',
    getToken: async () => 'tok',
    signal: new AbortController().signal,
  };
  for await (const _event of streamCopilotMessages(args)) {
    // no events: the mock body is empty
  }
}

function sentHeaders(): Record<string, string> {
  const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
  return init.headers as Record<string, string>;
}

describe('streamCopilotMessages tenant context', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(emptyStreamResponse()));
    useTenantContextStore.setState({ activeTenant: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useTenantContextStore.setState({ activeTenant: null });
  });

  it('sends X-Tenant-Context when a super admin is impersonating a tenant', async () => {
    useTenantContextStore.setState({
      activeTenant: { tenantId: 'tenant-impersonated', tenantName: 'Other Co' },
    });

    await drain();

    expect(sentHeaders()['X-Tenant-Context']).toBe('tenant-impersonated');
    expect(sentHeaders().Authorization).toBe('Bearer tok');
  });

  it('omits X-Tenant-Context for an ordinary session', async () => {
    await drain();

    expect(sentHeaders()).not.toHaveProperty('X-Tenant-Context');
  });
});
