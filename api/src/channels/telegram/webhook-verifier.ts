import { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { WebhookVerifier } from '../types';

export class TelegramWebhookVerifier implements WebhookVerifier {
  handleVerificationChallenge(_req: Request, _connection: ChannelConnection): string | null {
    return null; // Telegram doesn't use GET challenges
  }

  verifySignature(req: Request, connection: ChannelConnection): boolean {
    const headerToken = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
    if (!headerToken || !connection.webhookSecret) {
      return false;
    }
    // Constant-time comparison — the secret token is the sole inbound auth
    // factor for Telegram (no per-payload HMAC). See security audit #J.
    const a = Buffer.from(headerToken);
    const b = Buffer.from(connection.webhookSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
