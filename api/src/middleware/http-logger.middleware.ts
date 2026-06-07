import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

// Per-request access log. Logs once on response 'finish' with method, path,
// status, latency and the request/tenant/user context so every request is
// traceable in Railway logs. Runs after requestIdMiddleware so req.requestId
// is populated. /health and /health/ready are skipped to keep Railway probes
// out of the logs.
export function httpLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/health' || req.path === '/health/ready') {
    next();
    return;
  }

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const logData = {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs),
      ip: req.ip,
      userId: req.user?.id,
      tenantId: req.tenant?.id || req.user?.tenantId,
    };

    // 5xx is handled (and Sentry-captured) by the error handler; here we only
    // record the access line. Use warn for client errors, info otherwise.
    if (res.statusCode >= 500) {
      logger.error('Request completed with server error', logData);
    } else if (res.statusCode >= 400) {
      logger.warn('Request completed with client error', logData);
    } else {
      logger.info('Request completed', logData);
    }
  });

  next();
}
