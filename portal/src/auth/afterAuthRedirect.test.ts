import { describe, expect, it } from 'vitest';
import { afterAuthRedirectPath } from './afterAuthRedirect';

describe('afterAuthRedirectPath', () => {
  it('keeps the Legal Invoices path and query after sign-in', () => {
    expect(
      afterAuthRedirectPath({
        pathname: '/admin/legal-invoices',
        search: '?invoice=li_1',
      }),
    ).toBe('/admin/legal-invoices?invoice=li_1');
  });

  it('keeps the root path', () => {
    expect(afterAuthRedirectPath({ pathname: '/' })).toBe('/');
  });

  it('rejects a protocol-relative path', () => {
    expect(afterAuthRedirectPath({ pathname: '//evil.example' })).toBe('/');
  });
});
