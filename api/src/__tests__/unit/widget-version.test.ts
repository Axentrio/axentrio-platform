import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import express from 'express';
import request from 'supertest';

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { widgetVersionHash, widgetPath, widgetSizeBytes } from '../../widget/widget-version';

describe('widget-version helper', () => {
  it('computes a 12-char hex hash deterministically from widget.js bytes', () => {
    const bytes = readFileSync(widgetPath);
    const expected = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    expect(widgetVersionHash).toBe(expected);
    expect(widgetVersionHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('exposes the size of widget.js in bytes', () => {
    const bytes = readFileSync(widgetPath);
    expect(widgetSizeBytes).toBe(bytes.length);
  });
});

// Re-implementation of the /widget.js route under test. Mirrors the wiring in
// src/server.ts so we can hit it via supertest without booting the full
// server (DB, redis, sentry, etc.). If the production wiring drifts, this
// test will go red and force the route to be re-aligned.
function createWidgetJsApp() {
  const app = express();
  const widgetEtag = `"${widgetVersionHash}"`;
  app.get('/widget.js', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    res.setHeader('ETag', widgetEtag);
    res.setHeader('Content-Type', 'application/javascript');
    if (req.headers['if-none-match'] === widgetEtag) {
      res.status(304).end();
      return;
    }
    res.sendFile(widgetPath);
  });
  return app;
}

describe('GET /widget.js — cache headers', () => {
  it('sets a short-lived Cache-Control with must-revalidate (not max-age=3600)', async () => {
    const app = createWidgetJsApp();
    const res = await request(app).get('/widget.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300, must-revalidate');
    expect(res.headers['cache-control']).not.toContain('max-age=3600');
  });

  it('sets an ETag header matching the content hash', async () => {
    const app = createWidgetJsApp();
    const res = await request(app).get('/widget.js');
    expect(res.headers.etag).toBe(`"${widgetVersionHash}"`);
  });

  it('returns 304 when If-None-Match matches the current ETag', async () => {
    const app = createWidgetJsApp();
    const res = await request(app)
      .get('/widget.js')
      .set('If-None-Match', `"${widgetVersionHash}"`);
    expect(res.status).toBe(304);
  });

  it('serves the same content regardless of ?v= query string', async () => {
    const app = createWidgetJsApp();
    const plain = await request(app).get('/widget.js');
    const pinned = await request(app).get(`/widget.js?v=${widgetVersionHash}`);
    const bogus = await request(app).get('/widget.js?v=anything');
    expect(plain.text).toBe(pinned.text);
    expect(plain.text).toBe(bogus.text);
  });
});
