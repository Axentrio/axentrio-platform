import { describe, it, expect } from 'vitest';
import { Request } from 'express';
import { TelegramWebhookVerifier } from '../../channels/telegram/webhook-verifier';
import { handleGraphChallenge } from '../../channels/meta/graph-webhook';
import { ChannelConnection } from '../../database/entities/ChannelConnection';

// Regression tests for security-audit batch 1 (pure-function fixes).

describe('TelegramWebhookVerifier.verifySignature (#J constant-time secret)', () => {
  const verifier = new TelegramWebhookVerifier();
  const conn = (secret: string | null): ChannelConnection => {
    const c = new ChannelConnection();
    c.webhookSecret = secret as string;
    return c;
  };
  const reqWith = (token?: string): Request =>
    ({ headers: token === undefined ? {} : { 'x-telegram-bot-api-secret-token': token } }) as unknown as Request;

  it('accepts a matching secret token', () => {
    expect(verifier.verifySignature(reqWith('s3cr3t-token-value'), conn('s3cr3t-token-value'))).toBe(true);
  });
  it('rejects a wrong secret token', () => {
    expect(verifier.verifySignature(reqWith('wrong-token'), conn('s3cr3t-token-value'))).toBe(false);
  });
  it('rejects a different-length token (no timingSafeEqual throw)', () => {
    expect(verifier.verifySignature(reqWith('short'), conn('s3cr3t-token-value'))).toBe(false);
  });
  it('rejects when header missing', () => {
    expect(verifier.verifySignature(reqWith(undefined), conn('s3cr3t-token-value'))).toBe(false);
  });
  it('rejects when connection has no secret', () => {
    expect(verifier.verifySignature(reqWith('anything'), conn(null))).toBe(false);
  });
});

describe('handleGraphChallenge (#J fail-closed when verify token unset)', () => {
  const reqWith = (q: Record<string, string>): Request => ({ query: q }) as unknown as Request;

  it('returns the challenge when token matches a configured verify token', () => {
    expect(
      handleGraphChallenge(reqWith({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': 'abc' }), 'vt'),
    ).toBe('abc');
  });
  it('returns null when verify token is unset even if the param is empty', () => {
    expect(
      handleGraphChallenge(reqWith({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'abc' }), ''),
    ).toBeNull();
  });
  it('returns null on token mismatch', () => {
    expect(
      handleGraphChallenge(reqWith({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'abc' }), 'vt'),
    ).toBeNull();
  });
});
