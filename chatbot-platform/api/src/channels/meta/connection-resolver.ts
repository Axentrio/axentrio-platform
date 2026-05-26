import { Request } from 'express';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection, ChannelType } from '../../database/entities/ChannelConnection';
import { ConnectionResolver } from '../types';
import { logger } from '../../utils/logger';

/**
 * Resolve a ChannelConnection by platform account ID and channel type.
 * For Messenger: platformAccountId = Page ID
 * For Instagram: platformAccountId = IG Business Account ID
 */
export async function resolveMetaConnection(
  recipientId: string,
  channel: 'messenger' | 'instagram',
): Promise<ChannelConnection | null> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  const connection = await repo.findOne({
    where: {
      platformAccountId: recipientId,
      channel: channel as ChannelType,
      status: 'active',
    },
  });

  if (!connection) {
    logger.warn(`[meta] No active ${channel} connection for recipient ${recipientId}`);
  }

  return connection;
}

/**
 * Adapter-interface resolver, scoped to one Meta channel. Reads the Page/IG id
 * (the message recipient) from the parsed webhook body. The dedicated raw-body
 * route resolves per-event instead — this exists so each Meta adapter satisfies
 * the ChannelAdapter contract, mirroring the WhatsApp adapter.
 */
export class MetaConnectionResolver implements ConnectionResolver {
  constructor(private readonly channel: 'messenger' | 'instagram') {}

  async resolve(req: Request): Promise<ChannelConnection | null> {
    const body = req.body as
      | { entry?: Array<{ messaging?: Array<{ recipient?: { id?: string } }> }> }
      | undefined;
    const recipientId = body?.entry?.[0]?.messaging?.[0]?.recipient?.id;
    if (!recipientId) return null;
    return resolveMetaConnection(recipientId, this.channel);
  }
}
