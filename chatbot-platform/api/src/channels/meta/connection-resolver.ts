import { AppDataSource } from '../../database/data-source';
import { ChannelConnection, ChannelType } from '../../database/entities/ChannelConnection';
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
