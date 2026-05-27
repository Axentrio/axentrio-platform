import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { ApiError, buildErrorResponse } from './error-handler';
import { ERROR_CODES } from './error-codes';

/**
 * Paths that must keep the LEGACY 503 body shape `{ error: 'Request timeout' }`
 * even after the global response-envelope migration (plan §10, decision (a)).
 *
 * `timeoutMiddleware` is mounted inside `apiRouter` and fronts everything below
 * `apiRouter.use(...)` — including n8n inbound, channel webhooks, internal RAG,
 * internal booking, and the channel-webhook receivers. Those endpoints are
 * §5 out-of-scope: external integrations parse the response body and changing
 * it without coordinated downstream updates breaks contracts.
 *
 * Each entry is in the list because of a documented provider/integration
 * contract:
 *   - `/api/v1/webhooks/inbound`  — n8n inbound (codex round 5 #4: the actual
 *                                   mount path is `/webhooks/inbound`, NOT
 *                                   `/webhooks/n8n/inbound`).
 *   - `/api/v1/webhooks/health`   — n8n monitoring probe.
 *   - `/api/v1/webhooks/events`   — n8n legacy SSE consumer.
 *   - `/api/v1/internal/rag`      — n8n RAG search (plan §3.3).
 *   - `/api/v1/internal/booking`  — n8n booking (plan §3.3).
 *   - `/api/v1/channels/:c/webhook` — provider-facing channel ingest.
 *
 * Match on `req.originalUrl` (NOT `req.path`) because `timeoutMiddleware` runs
 * inside `apiRouter` where `req.path` is mount-relative (codex round 5 #3).
 */
const LEGACY_ENVELOPE_PATHS = [
  /^\/api\/v1\/webhooks\/inbound(\?|$|\/)/,
  /^\/api\/v1\/webhooks\/health(\?|$|\/)/,
  /^\/api\/v1\/webhooks\/events(\?|$|\/)/,
  /^\/api\/v1\/internal\/rag(\?|$|\/)/,
  /^\/api\/v1\/internal\/booking(\?|$|\/)/,
  /^\/api\/v1\/channels\/[^/?]+\/webhook(\?|$|\/)/,
] as const;

function shouldUseLegacyEnvelope(req: Request): boolean {
  const url = req.originalUrl;
  return LEGACY_ENVELOPE_PATHS.some((re) => re.test(url));
}

export function timeoutMiddleware(timeoutMs: number = 30000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn('Request timeout', {
          method: req.method,
          url: req.originalUrl,
          timeoutMs,
        });

        if (shouldUseLegacyEnvelope(req)) {
          // Preserve the legacy 503 body for OOS integration endpoints
          // (plan §10 carve-out). Same status, same Retry semantics — only the
          // body shape diverges from the new envelope to keep contracts intact.
          res.status(503).json({ error: 'Request timeout' }); // envelope-allow: OOS legacy 503 (plan §10)
          return;
        }

        // New envelope path. The original handler is still running so we cannot
        // call `next(err)`; instead reuse `buildErrorResponse` inline to keep a
        // single source of envelope construction (plan §6.1).
        const timeoutErr = new ApiError(
          'Request timeout',
          503,
          ERROR_CODES.REQUEST_TIMEOUT,
        );
        res.status(503).json(buildErrorResponse(timeoutErr, req));
      }
    }, timeoutMs);

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  };
}
