import axios from 'axios';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { encryptCredential } from '../credential-utils';
import { logger } from '../../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

interface PageToConnect {
  id: string;
  name: string;
  accessToken: string;
  picture?: string;
  instagramAccount?: {
    id: string;
    username?: string;
    profilePicUrl?: string;
  };
}

/**
 * Set up Messenger (and optionally Instagram) connections for selected Pages.
 */
export async function setupMetaConnections(
  tenantId: string,
  pages: PageToConnect[],
): Promise<ChannelConnection[]> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  const connections: ChannelConnection[] = [];

  for (const page of pages) {
    // 1. Subscribe page to webhooks
    try {
      await axios.post(
        `${GRAPH_API}/${page.id}/subscribed_apps`,
        null,
        {
          params: {
            access_token: page.accessToken,
            subscribed_fields: 'messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads,messaging_referrals',
          },
          timeout: 10000,
        },
      );
    } catch (error) {
      logger.error(`[meta-setup] Failed to subscribe page ${page.id}:`, error);
      throw new Error(`Failed to subscribe Page "${page.name}" to webhooks`);
    }

    // 2. Create Messenger connection
    const messengerConn = repo.create({
      tenantId,
      channel: 'messenger',
      status: 'active',
      label: page.name,
      platformAccountId: page.id,
      credentials: {
        pageAccessToken: encryptCredential(page.accessToken),
        pageId: page.id,
      },
      config: {
        pageName: page.name,
        pageImageUrl: page.picture,
      },
    });
    const savedMessenger = await repo.save(messengerConn);
    connections.push(savedMessenger);

    // 3. If IG account linked, subscribe and create IG connection
    if (page.instagramAccount) {
      try {
        await axios.post(
          `${GRAPH_API}/${page.instagramAccount.id}/subscribed_apps`,
          null,
          {
            params: {
              access_token: page.accessToken,
              subscribed_fields: 'messages,messaging_postbacks,message_reactions',
            },
            timeout: 10000,
          },
        );

        const igConn = repo.create({
          tenantId,
          channel: 'instagram',
          status: 'active',
          label: page.instagramAccount.username
            ? `@${page.instagramAccount.username}`
            : `${page.name} (Instagram)`,
          platformAccountId: page.instagramAccount.id,
          credentials: {
            pageAccessToken: encryptCredential(page.accessToken),
            pageId: page.id,
            igBusinessId: page.instagramAccount.id,
          },
          config: {
            igUsername: page.instagramAccount.username,
            igProfilePicUrl: page.instagramAccount.profilePicUrl,
            linkedPageId: page.id,
          },
        });
        const savedIg = await repo.save(igConn);
        connections.push(savedIg);
      } catch (error) {
        logger.warn(`[meta-setup] Failed to subscribe IG account ${page.instagramAccount.id}:`, error);
        // Don't fail the whole operation — Messenger is still connected
      }
    }
  }

  return connections;
}
