import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { securityHeadersMiddleware, widgetCspMiddleware } from '../../security/csp.middleware';

describe('securityHeadersMiddleware (#K) — unit', () => {
  it('sets clickjacking + sniffing + referrer headers', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as never;
    let called = false;
    securityHeadersMiddleware({} as never, res, (() => { called = true; }) as never);
    expect(called).toBe(true);
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });
});

describe('security-headers mount ordering (#K) — route-level', () => {
  // Mirrors server.ts: pre-stack routes (widget) registered BEFORE the security
  // stack must NOT get X-Frame-Options; routes after it must.
  const app = express();
  app.get('/widget.js', (_req, res) => { res.send('// widget'); });          // pre-stack
  app.use('/api/v1/widget', widgetCspMiddleware, (_req, res) => res.json({ ok: true })); // pre-stack, permissive CSP
  app.use(securityHeadersMiddleware);                                          // the stack
  app.get('/api/v1/things', (_req, res) => res.json({ ok: true }));           // post-stack

  it('pre-stack /widget.js has no X-Frame-Options (stays embeddable)', async () => {
    const r = await request(app).get('/widget.js');
    expect(r.headers['x-frame-options']).toBeUndefined();
  });

  it('widget API CSP allows framing anywhere', async () => {
    const r = await request(app).get('/api/v1/widget');
    expect(r.headers['content-security-policy'] || '').toContain('frame-ancestors *');
    expect(r.headers['x-frame-options']).toBeUndefined();
  });

  it('post-stack API route gets X-Frame-Options DENY + nosniff', async () => {
    const r = await request(app).get('/api/v1/things');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
