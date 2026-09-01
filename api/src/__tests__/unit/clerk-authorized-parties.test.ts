import { describe, it, expect } from 'vitest';
import {
  parseClerkAuthorizedParties,
  clerkMiddlewareOptions,
  isClerkAzpAllowed,
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

  it('splits a comma list and trims', () => {
    expect(
      parseClerkAuthorizedParties(
        'https://staging.axentrio.com, https://app.staging.axentrio.com',
      ),
    ).toEqual([
      'https://staging.axentrio.com',
      'https://app.staging.axentrio.com',
    ]);
  });
});

describe('isClerkAzpAllowed', () => {
  const staging = ['https://staging.axentrio.com'];

  it('empty list allows every azp (middleware options omitted)', () => {
    expect(isClerkAzpAllowed('https://app.axentrio.com', [])).toBe(true);
  });

  it('staging list allows the staging origin', () => {
    expect(isClerkAzpAllowed('https://staging.axentrio.com', staging)).toBe(true);
  });

  it('staging list rejects prod and dev origins', () => {
    expect(isClerkAzpAllowed('https://app.axentrio.com', staging)).toBe(false);
    expect(isClerkAzpAllowed('https://dev.axentrio.com', staging)).toBe(false);
  });
});
