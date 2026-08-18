import { describe, it, expect } from 'vitest';
import { resolveWsUrl } from './api.config';

describe('resolveWsUrl', () => {
  it('prefers an explicit VITE_WS_URL', () => {
    expect(resolveWsUrl('https://api.axentrio.com', 'https://other.example/api/v1')).toBe(
      'https://api.axentrio.com',
    );
  });

  it('derives the socket origin from the REST API URL when WS env is unset', () => {
    expect(resolveWsUrl(undefined, 'https://api.axentrio.com/api/v1')).toBe(
      'https://api.axentrio.com',
    );
    expect(resolveWsUrl('', 'http://localhost:4081/api/v1')).toBe('http://localhost:4081');
  });

  it('falls back to localhost when both are missing', () => {
    expect(resolveWsUrl(undefined, undefined)).toBe('http://localhost:5000');
  });
});
