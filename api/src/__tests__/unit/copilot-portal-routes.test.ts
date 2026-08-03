/**
 * The route directory Copilot is allowed to link to.
 *
 * The whole value of giving the assistant this list is that its links WORK. A route
 * renamed in the portal and not here turns every answer that mentions that screen into a
 * dead end — and a dead end is worse than no link, because the customer cannot tell
 * whether they took a wrong turn or the feature does not exist.
 *
 * So this test reads the portal's actual route table and checks the list against it.
 * It is deliberately coupled across the package boundary: that coupling is the point.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PORTAL_ROUTES, renderRouteDirectory } from '../../copilot/portal-routes';

/** Every `path="..."` in the portal's router, resolved to absolute paths. */
function portalRoutePaths(): Set<string> {
  const app = readFileSync(join(__dirname, '../../../../portal/src/App.tsx'), 'utf8');

  const top = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
  const paths = new Set<string>();
  for (const p of top) paths.add(p.startsWith('/') ? p : `/${p}`);

  // Nested settings routes are written relative (`path="billing"`), so pair each
  // child with its parent prefix.
  const settingsBlock = /<Route path="\/settings"[\s\S]*?<\/Route>/.exec(app)?.[0] ?? '';
  for (const m of settingsBlock.matchAll(/<Route\s+path="([^"/][^"]*)"/g)) {
    paths.add(`/settings/${m[1]}`);
  }
  return paths;
}

describe('PORTAL_ROUTES', () => {
  const real = portalRoutePaths();

  it('found the portal router at all', () => {
    // Guards the guard: a moved App.tsx would otherwise make every assertion below
    // vacuous and this file would keep passing while protecting nothing.
    expect(real.size).toBeGreaterThan(15);
    expect(real.has('/leads')).toBe(true);
    expect(real.has('/settings/billing')).toBe(true);
  });

  it('only names routes the portal actually serves', () => {
    const dangling = PORTAL_ROUTES.filter((r) => !real.has(r.path)).map((r) => r.path);
    expect(dangling).toEqual([]);
  });

  it('never sends a tenant admin somewhere only a super admin can go', () => {
    expect(PORTAL_ROUTES.filter((r) => r.path.startsWith('/admin'))).toEqual([]);
  });

  it('carries no dynamic segments — Copilot has no resource ids by design', () => {
    expect(PORTAL_ROUTES.filter((r) => r.path.includes(':'))).toEqual([]);
  });

  it('gives every route a purpose, since that is what the model matches on', () => {
    for (const r of PORTAL_ROUTES) {
      expect(r.label.length, r.path).toBeGreaterThan(0);
      expect(r.purpose.length, r.path).toBeGreaterThan(10);
    }
  });

  it('renders one line per route for the prompt', () => {
    const lines = renderRouteDirectory().split('\n');
    expect(lines).toHaveLength(PORTAL_ROUTES.length);
    expect(lines[0]).toContain('/inbox');
  });
});
