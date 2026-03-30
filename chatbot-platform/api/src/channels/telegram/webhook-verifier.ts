import { Request } from 'express';
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
    return headerToken === connection.webhookSecret;
  }
}
