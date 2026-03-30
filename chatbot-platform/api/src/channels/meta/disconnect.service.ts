import axios from 'axios';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { getMetaPageAccessToken } from '../credential-utils';
import { logger } from '../../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

/**
 * Disconnect a Meta (Messenger or Instagram) connection.
 * Unsubscribes from webhooks and clears credentials.
 */
export async function disconnectMetaConnection(connectionId: string): Promise<void> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  const connection = await repo.findOne({ where: { id: connectionId } });

  if (!connection) throw new Error('Connection not found');

  const accessToken = getMetaPageAccessToken(connection.credentials);
  const accountId = connection.platformAccountId;

  // Unsubscribe from webhooks (best-effort)
  if (accessToken && accountId) {
    try {
      await axios.delete(`${GRAPH_API}/${accountId}/subscribed_apps`, {
        params: { access_token: accessToken },
        timeout: 10000,
      });
    } catch (error) {
      logger.warn(`[meta-disconnect] Failed to unsubscribe ${accountId}:`, error);
    }
  }

  // Clear credentials and mark as disconnected
  connection.credentials = {};
  connection.status = 'disconnected';
  await repo.save(connection);

  // If disconnecting a Messenger Page, also disconnect linked IG accounts
  if (connection.channel === 'messenger') {
    const linkedIgConnections = await repo.find({
      where: {
        tenantId: connection.tenantId,
        channel: 'instagram' as any,
        status: 'active' as any,
      },
    });

    for (const ig of linkedIgConnections) {
      const linkedPageId = (ig.config as any)?.linkedPageId;
      if (linkedPageId === connection.platformAccountId) {
        ig.credentials = {};
        ig.status = 'disconnected';
        await repo.save(ig);
        logger.info(`[meta-disconnect] Also disconnected linked IG ${ig.id}`);
      }
    }
  }
}
