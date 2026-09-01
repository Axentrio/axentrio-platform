import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  parseClerkAuthorizedParties,
  clerkMiddlewareOptions,
  isClerkAzpAllowed,
} from '../../config/clerk-authorized-parties';

/**
 * HTTP stand-in for clerkMiddleware({ authorizedParties }) azp checks.
 * Unauthenticated (no azp) passes. A presented azp must be in the list.
 */
function azpGuard(parties: string[]) {
  const opts = clerkMiddlewareOptions(parties);
  const allowed = opts?.authorizedParties ?? [];
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const azp = req.header('x-azp');
    if (!isClerkAzpAllowed(azp, allowed)) {
      res.status(401).json({ error: 'unauthorized_party' });
      return;
    }
    next();
  };
}

function appFor(raw: string | undefined) {
  const parties = parseClerkAuthorizedParties(raw);
  const app = express();
  app.use(azpGuard(parties));
  app.get('/ok', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('clerk authorizedParties HTTP (staging list)', () => {
  const app = appFor('https://staging.axentrio.com');

  it('allows azp https://staging.axentrio.com', async () => {
    const res = await request(app)
      .get('/ok')
      .set('x-azp', 'https://staging.axentrio.com');
    expect(res.status).toBe(200);
  });

  it('rejects azp https://app.axentrio.com', async () => {
    const res = await request(app)
      .get('/ok')
      .set('x-azp', 'https://app.axentrio.com');
    expect(res.status).toBe(401);
  });

  it('rejects azp https://dev.axentrio.com', async () => {
    const res = await request(app)
      .get('/ok')
      .set('x-azp', 'https://dev.axentrio.com');
    expect(res.status).toBe(401);
  });

  it('passes through when no azp is presented', async () => {
    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
  });
});

describe('clerk authorizedParties HTTP (unset, like dev/prod)', () => {
  const app = appFor(undefined);

  it('does not reject prod or dev azp when the list is empty', async () => {
    const prod = await request(app)
      .get('/ok')
      .set('x-azp', 'https://app.axentrio.com');
    const dev = await request(app)
      .get('/ok')
      .set('x-azp', 'https://dev.axentrio.com');
    expect(prod.status).toBe(200);
    expect(dev.status).toBe(200);
  });
});
