import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseClerkAuthorizedParties,
  clerkMiddlewareOptions,
  mountClerkMiddleware,
} from '../../config/clerk-authorized-parties';

describe('parseClerkAuthorizedParties', () => {
  it('unset → empty list (dev/prod keep clerkMiddleware() with no parties)', () => {
    expect(parseClerkAuthorizedParties(undefined)).toEqual([]);
    expect(parseClerkAuthorizedParties('')).toEqual([]);
    expect(clerkMiddlewareOptions([])).toBeUndefined();
  });

  it('staging origin → that origin and clerkMiddleware options', () => {
    expect(parseClerkAuthorizedParties('https://staging.axentrio.com')).toEqual([
      'https://staging.axentrio.com',
    ]);
    expect(
      clerkMiddlewareOptions(['https://staging.axentrio.com']),
    ).toEqual({ authorizedParties: ['https://staging.axentrio.com'] });
  });
});

describe('mountClerkMiddleware', () => {
  it('passes authorizedParties into clerkMiddleware when the list is set', () => {
    const middleware = vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next());
    mountClerkMiddleware(['https://staging.axentrio.com'], middleware as never);
    expect(middleware).toHaveBeenCalledWith({
      authorizedParties: ['https://staging.axentrio.com'],
    });
  });

  it('calls clerkMiddleware with no options when the list is empty', () => {
    const middleware = vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next());
    mountClerkMiddleware([], middleware as never);
    expect(middleware).toHaveBeenCalledWith();
  });
});

describe('server.ts Clerk wiring', () => {
  it('mounts Clerk through mountClerkMiddleware(config.clerk.authorizedParties)', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../server.ts'),
      'utf8',
    );
    expect(src).toContain(
      'app.use(mountClerkMiddleware(config.clerk.authorizedParties));',
    );
  });
});
