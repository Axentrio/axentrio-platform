/**
 * Wire-envelope test for the Phase 0 ZodError → ValidationError adapter
 * inside `asyncHandler`.
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md §4 Phase 0,
 * codex round 6 #9.
 *
 * Before the adapter, controllers that called `schema.parse(req.body)` would
 * surface bad input as 500 / INTERNAL_ERROR (ZodError isn't an ApiError).
 * After the adapter, those calls become 422 / VALIDATION_ERROR with the
 * flattened Zod issues in `error.details.fieldErrors`.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

import { asyncHandler, errorHandler } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

const schema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.post(
    '/items',
    asyncHandler(async (req, res) => {
      const data = schema.parse(req.body);
      res.json({ received: data });
    }),
  );
  app.use(errorHandler);
  return app;
}

describe('asyncHandler + ZodError → 422 envelope on the wire', () => {
  it('valid body passes through to the handler', async () => {
    const res = await request(makeApp())
      .post('/items')
      .send({ name: 'thing', count: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: { name: 'thing', count: 3 } });
  });

  it('rejects with 422 / VALIDATION_ERROR + flattened fieldErrors', async () => {
    const res = await request(makeApp())
      .post('/items')
      .send({ name: 42, count: 'oops' });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: { fieldErrors: expect.any(Object) },
      },
      meta: { requestId: expect.any(String), path: '/items' },
    });
    const fieldErrors = res.body.error.details.fieldErrors as Record<string, string[]>;
    expect(Object.keys(fieldErrors)).toEqual(expect.arrayContaining(['name', 'count']));
  });

  it('non-Zod errors thrown inside asyncHandler still propagate as-typed', async () => {
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.get(
      '/oops',
      asyncHandler(async () => {
        throw new Error('genuine internal');
      }),
    );
    app.use(errorHandler);

    const res = await request(app).get('/oops');

    // Plain Error → 500 / INTERNAL_ERROR with redacted message.
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('An unexpected error occurred');
  });
});
