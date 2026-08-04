/**
 * Telling "out of credit" apart from "busy" is the whole point.
 *
 * OpenAI returns BOTH as HTTP 429. On 2026-08-03 the platform key hit
 * `credit_balance_exhausted`; every tenant's bot failed, and because the error
 * looked like ordinary throttling nothing alerted — it surfaced only when a
 * customer complained to a customer, who messaged the founder on Telegram. A
 * rate limit wants a retry; an exhausted balance wants someone to pay an invoice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isUpstreamQuotaExhausted, isUpstreamRateLimit } from '../../llm/upstream-error';

const sendEmail = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../automations', () => ({ getEmailService: () => ({ send: sendEmail }) }));

const chat = vi.fn();
vi.mock('../../llm/provider-factory', () => ({ getProvider: () => ({ chat }) }));

import {
  probeProviderHealth,
  runProviderHealthCheck,
  __resetProviderHealthAlertState,
} from '../../llm/provider-health';

/** The exact shape the OpenAI SDK threw in the 2026-08-03 outage. */
const quotaError = () =>
  Object.assign(new Error('429 You have no credits remaining.'), {
    status: 429,
    code: 'credit_balance_exhausted',
    type: 'insufficient_quota',
  });

const rateLimitError = () =>
  Object.assign(new Error('429 Rate limit reached'), { status: 429, code: 'rate_limit_exceeded' });

describe('upstream error classification', () => {
  it('separates an exhausted balance from ordinary throttling', () => {
    expect(isUpstreamQuotaExhausted(quotaError())).toBe(true);
    expect(isUpstreamQuotaExhausted(rateLimitError())).toBe(false);
    // Both are still 429s — which is precisely why status alone is not enough.
    expect(isUpstreamRateLimit(quotaError())).toBe(true);
    expect(isUpstreamRateLimit(rateLimitError())).toBe(true);
  });

  it('reads the code from a nested HTTP body as well as the SDK surface', () => {
    expect(isUpstreamQuotaExhausted({ status: 429, error: { code: 'insufficient_quota' } })).toBe(true);
  });

  it('does not fire on unrelated failures', () => {
    expect(isUpstreamQuotaExhausted(new Error('socket hang up'))).toBe(false);
    expect(isUpstreamQuotaExhausted(null)).toBe(false);
    expect(isUpstreamQuotaExhausted({ status: 500 })).toBe(false);
  });
});

describe('provider health probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetProviderHealthAlertState();
  });
  afterEach(() => vi.clearAllMocks());

  it('reports ok when a completion comes back', async () => {
    chat.mockResolvedValue({ content: 'ok', usage: {}, finishReason: 'stop' });
    expect(await probeProviderHealth()).toEqual({ state: 'ok' });
  });

  it('classifies an exhausted balance, not merely "rate limited"', async () => {
    chat.mockRejectedValue(quotaError());
    expect((await probeProviderHealth()).state).toBe('quota_exhausted');
  });

  it('classifies genuine throttling separately', async () => {
    chat.mockRejectedValue(rateLimitError());
    expect((await probeProviderHealth()).state).toBe('rate_limited');
  });

  it('treats anything else as unreachable rather than throwing', async () => {
    chat.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await probeProviderHealth()).state).toBe('unreachable');
  });
});

describe('alerting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetProviderHealthAlertState();
  });

  it('emails once when credit runs out, and says every tenant is affected', async () => {
    chat.mockRejectedValue(quotaError());
    await runProviderHealthCheck();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const { subject, body } = sendEmail.mock.calls[0][0];
    expect(subject).toMatch(/URGENT/i);
    expect(body).toMatch(/out of credit|quota/i);
    expect(body).toMatch(/EVERY tenant/i);
  });

  it('does not re-alert while the outage persists', async () => {
    // A 5-minute probe would otherwise send 288 identical emails a day and train
    // everyone to filter them — at which point the next outage is invisible again.
    chat.mockRejectedValue(quotaError());
    await runProviderHealthCheck();
    await runProviderHealthCheck();
    await runProviderHealthCheck();

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('alerts again on recovery, so nobody is left assuming it is still down', async () => {
    chat.mockRejectedValue(quotaError());
    await runProviderHealthCheck();
    chat.mockResolvedValue({ content: 'ok', usage: {}, finishReason: 'stop' });
    await runProviderHealthCheck();

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[1][0].subject).toMatch(/recovered/i);
  });

  it('never alerts on transient throttling', async () => {
    // Ordinary busyness under load is not an outage.
    chat.mockRejectedValue(rateLimitError());
    await runProviderHealthCheck();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not let throttling clear a standing quota alert', async () => {
    chat.mockRejectedValue(quotaError());
    await runProviderHealthCheck();
    sendEmail.mockClear();

    chat.mockRejectedValue(rateLimitError());
    await runProviderHealthCheck();
    // Still down; a throttle in between must not fake a recovery…
    expect(sendEmail).not.toHaveBeenCalled();

    chat.mockRejectedValue(quotaError());
    await runProviderHealthCheck();
    // …nor re-alert once the quota failure reappears.
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('survives an undeliverable alert', async () => {
    sendEmail.mockRejectedValue(new Error('SMTP down'));
    chat.mockRejectedValue(quotaError());
    await expect(runProviderHealthCheck()).resolves.toMatchObject({ state: 'quota_exhausted' });
  });

  it('never throws, whatever the provider does', async () => {
    chat.mockRejectedValue('a bare string, not an Error');
    await expect(runProviderHealthCheck()).resolves.toBeDefined();
  });
});
