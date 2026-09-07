/**
 * SOCK-1: a Graph webhook must ack without waiting for the inbound pipeline.
 *
 * When Redis is down `getChannelInboundQueue()` returns null and the router
 * falls back to inline processing. That fallback runs the whole LLM turn, so
 * awaiting it holds the HTTP socket open for seconds and Meta re-delivers the
 * event. The router must fire it and return 200 immediately.
 *
 * The pipeline double here NEVER settles: if the router awaits it, the request
 * never completes and the test fails on the suite timeout. No sleeps needed —
 * the response itself is the signal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import type { Repository } from 'typeorm';

const { pipelineMock } = vi.hoisted(() => ({ pipelineMock: vi.fn() }));
vi.mock('../../channels/inbound-pipeline', () => ({ processInboundEvent: pipelineMock }));

import { createGraphWebhookRouter } from '../../channels/meta/graph-webhook';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { WebhookEventLog } from '../../database/entities/WebhookEventLog';
import { NormalizedEvent } from '../../channels/types';

const APP_SECRET = 'test-app-secret';

// Test doubles for entities the router only passes through / reads ids from.
const connection = { id: 'conn-1', channel: 'whatsapp' } as ChannelConnection;

const event: NormalizedEvent = {
  type: 'message',
  message: { type: 'text', content: 'hi' },
  sender: { externalUserId: 'u1', externalThreadId: 'u1' },
  dedupeKey: 'dedupe-1',
  timestamp: new Date(),
  rawEventType: 'message',
};

function buildApp(): express.Express {
  const router = createGraphWebhookRouter({
    name: 'test-webhook',
    verifyToken: 'vt',
    appSecret: APP_SECRET,
    normalize: () => [{ event, recipientId: 'r1', channel: 'whatsapp' }],
    resolve: async () => connection,
  });

  const app = express();
  // '*/*' so superagent sends the exact bytes we sign (a JSON content type
  // gets re-stringified and the HMAC no longer matches).
  app.use('/hook', express.raw({ type: '*/*' }), router);
  return app;
}

function post(app: express.Express) {
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
  const signature =
    'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
  return request(app)
    .post('/hook')
    .set('Content-Type', 'application/octet-stream')
    .set('X-Hub-Signature-256', signature)
    .send(body);
}

describe('Graph webhook inline fallback', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    const repo = {
      createQueryBuilder: () => ({
        insert: () => ({
          values: () => ({
            orIgnore: () => ({
              execute: async () => ({ identifiers: [{ id: 'log-1' }] }),
            }),
          }),
        }),
      }),
    };
    // Unchecked cast: a hand-rolled stub can't satisfy TypeORM's Repository
    // surface, and the router only uses the query-builder insert chain.
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue(
      repo as unknown as Repository<WebhookEventLog>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acks 200 while the inline pipeline is still running', async () => {
    // Executor form: this project's TS lib is ES2022, which has no
    // Promise.withResolvers, and the double must never settle anyway.
    pipelineMock.mockReturnValue(new Promise<void>(() => {}));

    const res = await post(buildApp());

    expect(res.status).toBe(200);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(pipelineMock).toHaveBeenCalledWith(event, connection);
  });

  it('acks 200 when the inline pipeline rejects', async () => {
    pipelineMock.mockRejectedValue(new Error('pipeline exploded'));

    const res = await post(buildApp());

    expect(res.status).toBe(200);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });
});
