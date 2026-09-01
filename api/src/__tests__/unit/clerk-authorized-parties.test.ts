import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseClerkAuthorizedParties,
  clerkMiddlewareOptions,
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

describe('server.ts Clerk wiring', () => {
  it('passes authorizedParties into clerkMiddleware when the list is set', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../server.ts'),
      'utf8',
    );
    expect(src).toContain(
      'clerkMiddleware({ authorizedParties: clerkAuthorizedParties })',
    );
    expect(src).toContain(
      'const clerkAuthorizedParties = config.clerk.authorizedParties;',
    );
  });
});
