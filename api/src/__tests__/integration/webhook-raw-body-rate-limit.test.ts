/**
 * The four raw-body provider webhooks must be BOTH signature-verified and
 * IP rate limited.
 *
 * They mount ahead of `express.json()` because HMAC verification needs the
 * exact request bytes. That also put them ahead of `app.use(rateLimitByIp)`,
 * so an attacker who could not forge a signature could still flood them for
 * free. `rateLimitWebhookByIp` now runs first on each of those four mounts,
 * with a separate per-IP bucket for each route.
 *
 * Every request body below is deliberately spaced so that a JSON parse plus
 * re-serialize would change the bytes. A signature computed over the sent
 * string therefore only verifies if the raw Buffer survived the limiter
 * untouched. That is the assertion that matters most here.
 *
 * The limit is lowered through `WEBHOOK_IP_RATE_LIMIT.maxRequests`, which
 * `rateLimitWebhookByIp` reads per call. Integration tests never call
 * `initializeRedis`, so `getRedisClient()` is null, no Redis limiter is built
 * and the capped in-memory counter enforces the current value.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { Webhook } from 'svix';
import type * as EnvironmentModule from '../../config/environment';

const { CLERK_SECRET, META_SECRET, WHATSAPP_SECRET } = vi.hoisted(() => ({
  // svix rejects anything that is not `whsec_` + base64 in its constructor.
  CLERK_SECRET: 'whsec_dGVzdF9jbGVya193ZWJob29rX3NlY3JldA==',
  META_SECRET: 'test_meta_app_secret',
  WHATSAPP_SECRET: 'test_whatsapp_app_secret',
}));

// `config` is `as const`, so these cannot be set by assignment. Mock the module
// the way `rate-limit-wire.test.ts` does, but keep every other setting real.
// `server.ts` boots off this same object.
//
// The secrets live here rather than in `.env.test` because that file is shared
// with every other suite. `verifyGraphSignature` fails closed on an empty app
// secret, so without them no test could produce a validly signed Meta or
// WhatsApp webhook, and the raw-body assertion would have nothing to prove.
vi.mock('../../config/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvironmentModule>();
  return {
    ...actual,
    config: {
      ...actual.config,
      clerk: { ...actual.config.clerk, webhookSecret: CLERK_SECRET },
      meta: { ...actual.config.meta, appSecret: META_SECRET },
      whatsapp: { ...actual.config.whatsapp, appSecret: WHATSAPP_SECRET },
    },
  };
});

import { app } from '../../server';
import { config } from '../../config/environment';
import {
  setStripeClient,
  StripeBillingProvider,
} from '../../billing/providers/stripe';
import { registerBillingProvider } from '../../billing/provider-registry';
import { WEBHOOK_IP_RATE_LIMIT } from '../../middleware/rate-limit.middleware';

const WEBHOOK_LIMIT = 3;
const DEFAULT_WEBHOOK_LIMIT = WEBHOOK_IP_RATE_LIMIT.maxRequests;

/** Raw bytes handed to `stripe.webhooks.constructEvent` by the billing route. */
let stripeRawBodySeen: unknown;

interface WebhookCase {
  name: string;
  path: string;
  /** Sent verbatim; the extra spaces die in any parse/re-serialize round trip. */
  rawBody: string;
  sign: (rawBody: string) => Record<string, string>;
  /** Per-request stubs (billing needs a Stripe client). */
  arrange?: () => void;
  assertAccepted: (res: request.Response, rawBody: string) => void;
}

function graphSignature(rawBody: string, appSecret: string): Record<string, string> {
  return {
    'x-hub-signature-256':
      'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex'),
  };
}

const cases: WebhookCase[] = [
  {
    name: 'Clerk',
    path: '/api/v1/webhooks/clerk',
    rawBody: '{"type":"session.created",   "data":{}}',
    sign: (rawBody) => {
      const messageId = `msg_${crypto.randomUUID()}`;
      const timestamp = new Date();
      return {
        'svix-id': messageId,
        'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
        'svix-signature': new Webhook(config.clerk.webhookSecret as string).sign(
          messageId,
          timestamp,
          rawBody,
        ),
      };
    },
    assertAccepted: (res) => {
      expect(res.status).toBe(200);
    },
  },
  {
    name: 'Meta',
    path: '/api/v1/channels/meta/webhook',
    rawBody: '{"object":"page",   "entry":[]}',
    sign: (rawBody) => graphSignature(rawBody, config.meta.appSecret),
    assertAccepted: (res) => {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    },
  },
  {
    name: 'WhatsApp',
    path: '/api/v1/channels/whatsapp/webhook',
    rawBody: '{"object":"whatsapp_business_account",   "entry":[]}',
    sign: (rawBody) => graphSignature(rawBody, config.whatsapp.appSecret),
    assertAccepted: (res) => {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    },
  },
  {
    name: 'Billing',
    path: '/api/v1/webhooks/billing/stripe',
    rawBody: '{"id":"evt_raw_body_probe",   "type":"invoice.upcoming"}',
    // Stripe's own verifier is stubbed, so the raw-body proof for this route is
    // the Buffer it received, asserted below.
    sign: () => ({ 'stripe-signature': 't=1,v1=stub' }),
    arrange: () => {
      stripeRawBodySeen = undefined;
      setStripeClient({
        customers: { search: vi.fn(), create: vi.fn(), update: vi.fn() },
        checkout: { sessions: { create: vi.fn() } },
        billingPortal: { sessions: { create: vi.fn() } },
        subscriptions: { retrieve: vi.fn(), update: vi.fn() },
        subscriptionSchedules: {
          create: vi.fn(),
          update: vi.fn(),
          retrieve: vi.fn(),
          release: vi.fn(),
        },
        webhooks: {
          constructEvent: vi.fn((payload: unknown) => {
            stripeRawBodySeen = payload;
            // Unhandled type → normalizeWebhookEvent returns null → 200, no DB work.
            return { id: 'evt_raw_body_probe', type: 'invoice.upcoming', created: 1, data: { object: {} } };
          }),
        },
      } as never);
    },
    assertAccepted: (res, rawBody) => {
      expect(res.status).toBe(200);
      expect(Buffer.isBuffer(stripeRawBodySeen)).toBe(true);
      expect((stripeRawBodySeen as Buffer).toString('utf8')).toBe(rawBody);
    },
  },
];

// The limiter's counters are module state that outlives a test, so every test
// claims IPs nobody else used. TEST-NET-2 (RFC 5737) is never routable.
let allocatedIps = 0;
function nextClientIp(): string {
  allocatedIps += 1;
  return `198.51.100.${allocatedIps}`;
}

function caseNamed(name: string): WebhookCase {
  const found = cases.find((c) => c.name === name);
  if (!found) throw new Error(`no webhook case named ${name}`);
  return found;
}

function send(webhook: WebhookCase, clientIp: string) {
  return request(app)
    .post(webhook.path)
    .set('X-Forwarded-For', clientIp)
    .set('Content-Type', 'application/json')
    .set(webhook.sign(webhook.rawBody))
    .send(webhook.rawBody);
}

beforeAll(() => {
  // server.ts only registers the Stripe provider inside startServer(), which
  // integration tests don't run.
  registerBillingProvider(new StripeBillingProvider());
});

beforeEach(() => {
  WEBHOOK_IP_RATE_LIMIT.maxRequests = WEBHOOK_LIMIT;
});

afterEach(() => {
  WEBHOOK_IP_RATE_LIMIT.maxRequests = DEFAULT_WEBHOOK_LIMIT;
  setStripeClient(null);
  vi.restoreAllMocks();
});

describe.each(cases)('$name webhook - raw body and IP rate limit', (webhook) => {
  it('accepts a validly signed webhook and verifies it against the unmodified raw body', async () => {
    webhook.arrange?.();

    const res = await send(webhook, nextClientIp());

    webhook.assertAccepted(res, webhook.rawBody);
  });

  it('passes every request up to the limit untouched', async () => {
    webhook.arrange?.();
    const clientIp = nextClientIp();

    for (let i = 0; i < WEBHOOK_LIMIT; i++) {
      // eslint-disable-next-line no-await-in-loop -- the limiter counts requests, so they must be sequential
      const res = await send(webhook, clientIp);
      webhook.assertAccepted(res, webhook.rawBody);
    }
  });

  it('rejects the request after the limit with 429 and Retry-After', async () => {
    webhook.arrange?.();
    const clientIp = nextClientIp();

    for (let i = 0; i < WEBHOOK_LIMIT; i++) {
      // eslint-disable-next-line no-await-in-loop -- the limiter counts requests, so they must be sequential
      await send(webhook, clientIp);
    }

    const res = await send(webhook, clientIp);

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('counts each client IP separately', async () => {
    webhook.arrange?.();
    const floodingIp = nextClientIp();

    for (let i = 0; i <= WEBHOOK_LIMIT; i++) {
      // eslint-disable-next-line no-await-in-loop -- the limiter counts requests, so they must be sequential
      await send(webhook, floodingIp);
    }

    const res = await send(webhook, nextClientIp());

    webhook.assertAccepted(res, webhook.rawBody);
  });
});

describe('per-route webhook buckets', () => {
  it.each(cases)('a flood on $name leaves the other webhook routes open to the same IP', async (flooded) => {
    const clientIp = nextClientIp();
    flooded.arrange?.();

    for (let i = 0; i < WEBHOOK_LIMIT; i++) {
      // eslint-disable-next-line no-await-in-loop -- the limiter counts requests, so they must be sequential
      await send(flooded, clientIp);
    }
    expect((await send(flooded, clientIp)).status).toBe(429);

    for (const other of cases.filter((c) => c !== flooded)) {
      other.arrange?.();
      // eslint-disable-next-line no-await-in-loop -- one shared IP, checked route by route
      const res = await send(other, clientIp);
      other.assertAccepted(res, other.rawBody);
    }
  });
});

describe('429 body shape on the raw-body webhooks', () => {
  async function floodThenSend(webhook: WebhookCase): Promise<request.Response> {
    const clientIp = nextClientIp();
    webhook.arrange?.();
    for (let i = 0; i < WEBHOOK_LIMIT; i++) {
      // eslint-disable-next-line no-await-in-loop -- the limiter counts requests, so they must be sequential
      await send(webhook, clientIp);
    }
    return send(webhook, clientIp);
  }

  it('keeps the legacy body on billing, because the Stripe body shape is a partner contract', async () => {
    const res = await floodThenSend(caseNamed('Billing'));

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: 'Too Many Requests',
      retryAfter: expect.any(Number),
      message: expect.any(String),
    });
  });

  it('sends the RATE_LIMIT_EXCEEDED envelope on Clerk, which has no legacy-body claim', async () => {
    const res = await floodThenSend(caseNamed('Clerk'));

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMIT_EXCEEDED' },
    });
  });
});
