/**
 * Hand-craft + sign + POST a Stripe webhook event to the local API.
 *
 * Use cases where Stripe CLI's synthetic triggers won't bind cleanly to
 * the tenant's real customer/subscription — past_due dunning, trial_will_end,
 * incomplete signups. The signature uses the same scheme Stripe uses, so
 * the API's stripe.webhooks.constructEvent verifies it identically.
 *
 *   npx ts-node scripts/test-webhook-signed.ts <event-type> <json-event-data>
 *
 * Example:
 *
 *   npx ts-node scripts/test-webhook-signed.ts \
 *     invoice.payment_failed \
 *     '{"id":"in_test","customer":"cus_X","subscription":"sub_Y","object":"invoice"}'
 *
 * Reads STRIPE_WEBHOOK_SECRET + the webhook port (4081 → /api/v1/webhooks/billing/stripe)
 * from .env. No external network — everything stays on localhost.
 */
import 'dotenv/config';
import crypto from 'crypto';
import http from 'http';

const [, , eventType, dataJson] = process.argv;
if (!eventType || !dataJson) {
  console.error('usage: test-webhook-signed <event-type> <event-data-json>');
  process.exit(1);
}

const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (!secret) {
  console.error('STRIPE_WEBHOOK_SECRET not set in env');
  process.exit(1);
}

const parsedData = JSON.parse(dataJson);
const eventId = `evt_local_${crypto.randomBytes(8).toString('hex')}`;
const event = {
  id: eventId,
  object: 'event',
  api_version: '2026-04-22.dahlia',
  created: Math.floor(Date.now() / 1000),
  type: eventType,
  livemode: false,
  pending_webhooks: 1,
  data: { object: parsedData },
  request: { id: null, idempotency_key: null },
};

const payload = JSON.stringify(event);
const timestamp = Math.floor(Date.now() / 1000);
const signed = `${timestamp}.${payload}`;
const signature = crypto.createHmac('sha256', secret).update(signed).digest('hex');
const stripeSignature = `t=${timestamp},v1=${signature}`;

const req = http.request(
  {
    hostname: 'localhost',
    port: 4081,
    path: '/api/v1/webhooks/billing/stripe',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': stripeSignature,
      'Content-Length': Buffer.byteLength(payload),
    },
  },
  (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      console.log(`HTTP ${res.statusCode}  event=${eventId}  type=${eventType}`);
      if (body) console.log(body);
    });
  },
);
req.on('error', (err) => {
  console.error('request failed:', err.message);
  process.exit(1);
});
req.write(payload);
req.end();
