import { Request } from 'express';
import { getRepository } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { ConnectionResolver } from '../types';

export class TelegramConnectionResolver implements ConnectionResolver {
  async resolve(req: Request): Promise<ChannelConnection | null> {
    const headerToken = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
    if (!headerToken) return null;

    const repo = getRepository(ChannelConnection);
    return repo.findOne({
      where: {
        channel: 'telegram',
        webhookSecret: headerToken,
        status: 'active',
      },
    }) as Promise<ChannelConnection | null>;
  }
}
