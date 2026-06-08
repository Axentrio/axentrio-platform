import { createHmac } from 'crypto';
import { AppDataSource } from '../database/data-source';
import { WebhookDeliveryLog } from '../database/entities/WebhookDeliveryLog';
import { logger } from '../utils/logger';
import { safeOutboundRequest } from '../security/ssrf-guard';
import type { EventWebhookConfig, WebhookEvent } from './webhook.types';

const TIMEOUT_MS = 10_000;

// Conservative retry schedule (M0 PR10).
// Delay BEFORE each attempt: 0s / 5s / 30s.
// Total: 3 attempts. After the 3rd failure, the event is dead-lettered
// (logged as `webhook_dead_letter` and left in the WebhookDeliveryLog
// table with status='failed', attempt=3).
const RETRY_DELAYS_MS = [0, 5_000, 30_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

// ---- Per-URL circuit breaker ----
// After FAILURE_THRESHOLD consecutive failures, skip delivery for COOLDOWN_MS.
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000; // 1 minute
const circuits = new Map<string, { failures: number; openUntil: number }>();

function isCircuitOpen(url: string): boolean {
  const cb = circuits.get(url);
  if (!cb) return false;
  if (cb.failures < FAILURE_THRESHOLD) return false;
  if (Date.now() >= cb.openUntil) {
    // Half-open: allow one probe attempt
    cb.failures = FAILURE_THRESHOLD - 1;
    return false;
  }
  return true;
}

function recordSuccess(url: string): void {
  circuits.delete(url);
}

function recordFailure(url: string): void {
  const cb = circuits.get(url) ?? { failures: 0, openUntil: 0 };
  cb.failures++;
  if (cb.failures >= FAILURE_THRESHOLD) {
    cb.openUntil = Date.now() + COOLDOWN_MS;
  }
  circuits.set(url, cb);
}

function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persist a single delivery attempt to WebhookDeliveryLog.
 * Best-effort — failures to write the log do NOT fail the delivery.
 */
async function persistAttempt(params: {
  tenantId: string;
  event: WebhookEvent;
  url: string;
  attempt: number;
  status: 'success' | 'failed' | 'dropped';
  httpStatus?: number;
  durationMs: number;
  error?: string;
}): Promise<void> {
  try {
    if (!AppDataSource.isInitialized) return;
    const repo = AppDataSource.getRepository(WebhookDeliveryLog);
    await repo.save(
      repo.create({
        tenantId: params.tenantId,
        event: params.event.type,
        direction: 'outbound' as const,
        url: params.url,
        status: params.status,
        httpStatus: params.httpStatus,
        durationMs: params.durationMs,
        error: params.error,
        attempt: params.attempt,
        requestBody: params.event as unknown as Record<string, unknown>,
      }),
    );
  } catch (err) {
    logger.warn('Failed to write outbound webhook delivery log', {
      error: err instanceof Error ? err.message : String(err),
      eventId: params.event.id,
      tenantId: params.tenantId,
    });
  }
}

export async function deliverWebhook(
  config: EventWebhookConfig,
  event: WebhookEvent,
): Promise<void> {
  const tenantId = event.tenantId;

  // Skip delivery if circuit is open (endpoint repeatedly failing).
  // Persist a `dropped` row so operators can see this in the delivery log.
  if (isCircuitOpen(config.url)) {
    logger.warn('Webhook circuit open, skipping delivery', { url: config.url, eventId: event.id });
    await persistAttempt({
      tenantId,
      event,
      url: config.url,
      attempt: 1,
      status: 'dropped',
      durationMs: 0,
      error: 'circuit_open',
    });
    return;
  }

  const body = JSON.stringify(event);
  const signature = signPayload(config.secret, body);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (delay > 0) {
      await sleep(delay);
    }

    const startedAt = Date.now();
    try {
      // Guarded outbound (SSRF #A): https-only, public-IP-pinned, no redirects.
      // validateStatus:()=>true preserves the 4xx=no-retry / 5xx=retry semantics
      // below (the body string is sent verbatim so the signature stays valid).
      const response = await safeOutboundRequest({
        method: 'POST',
        url: config.url,
        data: body,
        timeout: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Webhook-Event': event.type,
          'X-Webhook-Id': event.id,
        },
        validateStatus: () => true,
      });

      const durationMs = Date.now() - startedAt;

      if (response.status >= 200 && response.status < 300) {
        recordSuccess(config.url);
        logger.info('Webhook delivered', { url: config.url, eventId: event.id, status: response.status, attempt });
        await persistAttempt({
          tenantId,
          event,
          url: config.url,
          attempt,
          status: 'success',
          httpStatus: response.status,
          durationMs,
        });
        return;
      }

      // Don't retry on 4xx client errors — endpoint responded, clear circuit
      if (response.status >= 400 && response.status < 500) {
        recordSuccess(config.url);
        logger.warn('Webhook rejected by server (4xx), not retrying', {
          url: config.url,
          eventId: event.id,
          status: response.status,
          attempt,
        });
        await persistAttempt({
          tenantId,
          event,
          url: config.url,
          attempt,
          status: 'failed',
          httpStatus: response.status,
          durationMs,
          error: `HTTP ${response.status}`,
        });
        return;
      }

      logger.warn('Webhook delivery failed (5xx), will retry', {
        url: config.url,
        eventId: event.id,
        status: response.status,
        attempt,
      });
      await persistAttempt({
        tenantId,
        event,
        url: config.url,
        attempt,
        status: 'failed',
        httpStatus: response.status,
        durationMs,
        error: `HTTP ${response.status}`,
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const errorMessage = isAbort
        ? 'timeout'
        : err instanceof Error
          ? err.message
          : String(err);

      logger.warn('Webhook delivery error, will retry', {
        url: config.url,
        eventId: event.id,
        attempt,
        error: errorMessage,
      });
      await persistAttempt({
        tenantId,
        event,
        url: config.url,
        attempt,
        status: 'failed',
        durationMs,
        error: errorMessage,
      });
    }
  }

  // All MAX_ATTEMPTS attempts exhausted: dead-letter.
  recordFailure(config.url);
  logger.error('webhook_dead_letter', {
    reason: 'webhook_dead_letter',
    url: config.url,
    eventId: event.id,
    eventType: event.type,
    tenantId,
    attempts: MAX_ATTEMPTS,
  });
}
