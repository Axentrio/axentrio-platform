/**
 * Shared webhook plumbing for Meta-family channels (Messenger, Instagram,
 * WhatsApp). They all use the same Graph mechanics: a `hub.challenge`
 * subscription handshake and an `X-Hub-Signature-256` HMAC over the raw body.
 *
 * Telegram does NOT use this — it authenticates with a per-connection header
 * token and runs through the generic `/channels/:channel/webhook` pipeline.
 *
 * Meta-family channels need a dedicated raw-body route because (a) HMAC must be
 * computed over the exact bytes and (b) the GET challenge has no connection
 * context (the verify token is app-wide). A single inbound POST can also carry
 * events for multiple connections, which the connection-scoped generic pipeline
 * can't express.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { ChannelConnection, ChannelType } from '../../database/entities/ChannelConnection';
import { WebhookVerifier, NormalizedEvent } from '../types';
import { AppDataSource } from '../../database/data-source';
import { WebhookEventLog } from '../../database/entities/WebhookEventLog';
import { processInboundEvent } from '../inbound-pipeline';
import { getChannelInboundQueue } from '../inbound-queue.processor';
import { logger } from '../../utils/logger';

/** Validate `X-Hub-Signature-256` against an HMAC-SHA256 of the raw body. */
export function verifyGraphSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  const sigBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expected);
  return sigBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

/** Handle the GET subscription challenge (app-wide verify token). */
export function handleGraphChallenge(req: Request, verifyToken: string): string | null {
  const mode = req.query['hub.mode'] as string | undefined;
  const token = req.query['hub.verify_token'] as string | undefined;
  const challenge = req.query['hub.challenge'] as string | undefined;

  // Fail closed when no verify token is configured — otherwise an unset token
  // (default '') is satisfied by an empty `hub.verify_token` param, letting an
  // attacker complete the subscription handshake. See security audit #J.
  if (verifyToken && mode === 'subscribe' && token === verifyToken) {
    return challenge ?? '';
  }
  return null;
}

/**
 * Reusable WebhookVerifier for any Graph channel. Reads the raw body from
 * `req.rawBody` (generic pipeline) or a Buffer `req.body` (raw-body route).
 */
export class GraphWebhookVerifier implements WebhookVerifier {
  constructor(private readonly verifyToken: string, private readonly appSecret: string) {}

  handleVerificationChallenge(req: Request, _connection: ChannelConnection): string | null {
    return handleGraphChallenge(req, this.verifyToken);
  }

  verifySignature(req: Request, _connection: ChannelConnection): boolean {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody
      ?? (Buffer.isBuffer(req.body) ? (req.body as Buffer) : undefined);
    if (!raw) return false;
    return verifyGraphSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, this.appSecret);
  }
}

export interface GraphWebhookEvent {
  event: NormalizedEvent;
  recipientId: string;
  channel: ChannelType;
}

export interface GraphWebhookConfig {
  /** Used in log lines, e.g. 'meta-webhook' or 'whatsapp-webhook'. */
  name: string;
  verifyToken: string;
  appSecret: string;
  /** Parse a raw Graph payload into normalized events tagged by recipient + channel. */
  normalize: (payload: unknown) => GraphWebhookEvent[];
  /** Resolve the owning connection for a recipient id + channel. */
  resolve: (recipientId: string, channel: ChannelType) => Promise<ChannelConnection | null>;
}

/**
 * Build a dedicated raw-body webhook Router shared by all Meta-family channels.
 * Mount it BEFORE express.json() with `express.raw({ type: 'application/json' })`.
 */
export function createGraphWebhookRouter(config: GraphWebhookConfig): Router {
  const router = Router();
  const tag = `[${config.name}]`;

  // GET — subscription verification challenge
  router.get('/', (req: Request, res: Response) => {
    const challenge = handleGraphChallenge(req, config.verifyToken);
    if (challenge !== null) {
      logger.info(`${tag} Verification challenge accepted`);
      return res.status(200).send(challenge);
    }
    logger.warn(`${tag} Verification challenge failed`, { mode: req.query['hub.mode'] });
    return res.status(403).send('Forbidden');
  });

  // POST — event ingress (raw body for HMAC verification)
  router.post('/', async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;

    // 1. Verify HMAC signature over the raw body
    if (!verifyGraphSignature(rawBody, req.headers['x-hub-signature-256'] as string | undefined, config.appSecret)) {
      logger.warn(`${tag} Invalid or missing HMAC signature`);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 2. Parse JSON from raw body
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    // 3. Normalize and dispatch (one payload may target multiple connections)
    const eventLogRepo = AppDataSource.getRepository(WebhookEventLog);
    const queue = getChannelInboundQueue();

    for (const { event, recipientId, channel } of config.normalize(payload)) {
      try {
        const connection = await config.resolve(recipientId, channel);
        if (!connection) continue;

        // Dedupe via INSERT ... ON CONFLICT DO NOTHING. Meta delivers webhooks
        // at-least-once (chatty read/delivery receipts especially), so duplicate
        // dedupeKeys are EXPECTED, not errors. orIgnore() avoids raising a DB
        // exception on the conflict — previously the plain save() threw 23505,
        // which the query logger surfaced as noisy error spam. A skipped insert
        // just means we've already seen this event.
        const insertResult = await eventLogRepo
          .createQueryBuilder()
          .insert()
          .values({
            channelConnectionId: connection.id,
            channel: connection.channel,
            dedupeKey: event.dedupeKey,
            eventType: event.rawEventType,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb column; QB .values() generic rejects Record<string,unknown>
            rawPayload: payload as any,
            status: 'received',
          })
          .orIgnore()
          .execute();

        const isDuplicate = insertResult.identifiers.length === 0 || insertResult.identifiers[0] == null;
        if (isDuplicate) {
          logger.debug(`${tag} Duplicate ${channel} webhook event ignored`, {
            dedupeKey: event.dedupeKey,
            eventType: event.rawEventType,
          });
          continue;
        }

        if (queue) {
          await queue.add('channel-inbound', {
            eventDedupeKey: event.dedupeKey,
            connectionId: connection.id,
            event,
          }, {
            jobId: event.dedupeKey,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: 100,
            removeOnFail: 500,
          });
        } else {
          await processInboundEvent(event, connection);
        }
      } catch (error: any) {
        if (error?.code === '23505') continue; // Duplicate dedupe key
        logger.error(`${tag} Error processing ${channel} event:`, error);
      }
    }

    // 4. Return 200 fast (Graph requires a quick ack)
    return res.status(200).json({ ok: true });
  });

  return router;
}
