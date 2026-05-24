/**
 * Tests for UpgradeCTA (M1, subscription/feature-access epic).
 *
 * - tier='pro' | 'essential' → renders a button that POSTs to
 *   /billing/checkout-session and hard-redirects via window.location.assign().
 * - tier='enterprise'        → renders a `<a href="mailto:…">` (no POST).
 * - tier='free'              → renders nothing.
 * - API failure (e.g. `billing_misconfigured`) → surfaces a toast and does NOT
 *   redirect away from the page.
 *
 * Note: the production component does not call any `getStripePriceIdFor`
 * helper (it just forwards `planId` to the backend), so the "price id is
 * null" branch from the spec is covered transitively by the API-error path —
 * the backend would respond with `billing_misconfigured` in that case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { AxiosError, AxiosHeaders } from 'axios';

const { apiPost, toastError } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../services/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../../services/apiClient')>(
    '../../services/apiClient',
  );
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: apiPost,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: toastError, info: vi.fn() },
}));

import { UpgradeCTA } from './UpgradeCTA';

function renderUI(props: React.ComponentProps<typeof UpgradeCTA>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <UpgradeCTA {...props} />
    </QueryClientProvider>,
  );
}

// jsdom's `window.location.assign` is not spy-able directly. We swap the
// whole `location` object for an in-test stub that exposes a vi.fn for assign
// and is restored after each test.
let assignMock: ReturnType<typeof vi.fn>;
let originalLocation: Location;

beforeEach(() => {
  apiPost.mockReset();
  toastError.mockReset();
  originalLocation = window.location;
  assignMock = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...originalLocation, assign: assignMock, href: originalLocation.href },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe('UpgradeCTA — self-serve checkout (essential / pro)', () => {
  it("renders a button and POSTs to /billing/checkout-session for tier='pro'", async () => {
    apiPost.mockResolvedValueOnce({ url: 'https://checkout.stripe.com/abc' });
    const user = userEvent.setup();
    renderUI({ tier: 'pro' });

    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
    await user.click(button);

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(
      '/billing/checkout-session',
      expect.objectContaining({ planId: 'pro' }),
    );

    // Hard navigation occurs via window.location.assign(result.url).
    expect(assignMock).toHaveBeenCalledWith('https://checkout.stripe.com/abc');
  });

  it("renders a button and POSTs to /billing/checkout-session for tier='essential'", async () => {
    apiPost.mockResolvedValueOnce({ url: 'https://checkout.stripe.com/xyz' });
    const user = userEvent.setup();
    renderUI({ tier: 'essential' });

    await user.click(screen.getByRole('button'));

    expect(apiPost).toHaveBeenCalledWith(
      '/billing/checkout-session',
      expect.objectContaining({ planId: 'essential' }),
    );
    expect(assignMock).toHaveBeenCalledWith('https://checkout.stripe.com/xyz');
  });
});

describe('UpgradeCTA — enterprise (sales)', () => {
  it('renders a mailto link, not a checkout POST', async () => {
    const user = userEvent.setup();
    renderUI({ tier: 'enterprise' });

    // The component renders a Button-as-anchor wrapping a real <a>.
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href');
    expect(link.getAttribute('href')).toMatch(/^mailto:/);

    await user.click(link);
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('UpgradeCTA — non-self-serve tier', () => {
  it("renders nothing for tier='free'", () => {
    const { container } = renderUI({ tier: 'free' });
    expect(container.firstChild).toBeNull();
  });
});

describe('UpgradeCTA — defensive error handling', () => {
  it('surfaces a toast and does NOT navigate when the API returns billing_misconfigured', async () => {
    const err = new AxiosError('configuration error', '500');
    err.response = {
      status: 500,
      statusText: 'Internal Server Error',
      data: { error: { code: 'billing_misconfigured', message: 'Stripe price id not set' } },
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
    apiPost.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    renderUI({ tier: 'pro' });

    await user.click(screen.getByRole('button'));

    // Toast surfaces the upstream message (extractApiErrorMessage path).
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Stripe price id not set');
    // No navigation away from the SPA.
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('falls back to a generic upgrade-error toast when the server gives no message', async () => {
    const err = new AxiosError('boom', '500');
    err.response = {
      status: 500,
      statusText: 'Internal Server Error',
      data: {},
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
    apiPost.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    renderUI({ tier: 'pro' });

    await user.click(screen.getByRole('button'));

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(assignMock).not.toHaveBeenCalled();
  });
});
