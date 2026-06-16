import axios from 'axios';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { encryptCredential } from '../credential-utils';
import { logger } from '../../utils/logger';
import { FB_GRAPH_API as GRAPH_API } from './graph-api';
import { isChannelEntitled } from '../channel-entitlement';
import { getEntitlements } from '../../billing/entitlements';
import { PlanLimitError } from '../../billing/enforce';

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
): Promise<{ connections: ChannelConnection[]; skipped: Array<'messenger' | 'instagram'> }> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  const connections: ChannelConnection[] = [];

  // Per-channel entitlement filter (channels plan D8): resolved ONCE before
  // any external side effect — a locked channel type is never externally
  // subscribed and never gets a (re)activated connection row.
  const [messengerEntitled, instagramEntitled] = await Promise.all([
    isChannelEntitled(tenantId, 'messenger'),
    isChannelEntitled(tenantId, 'instagram'),
  ]);
  const skipped: Array<'messenger' | 'instagram'> = [];
  if (!messengerEntitled) skipped.push('messenger');
  if (!instagramEntitled) skipped.push('instagram');
  if (!messengerEntitled && !instagramEntitled) {
    // Callers gate on "any Meta channel entitled" before invoking, but the
    // entitlement may change mid-OAuth — never return a "successful" no-op.
    // Carry the same reason as the gate so the portal can distinguish
    // "turned off in Settings" from "upgrade needed" (hardening Fix C).
    const e = await getEntitlements(tenantId);
    const reason =
      e.entitledFeatures.channelMessenger || e.entitledFeatures.channelInstagram
        ? 'disabled_by_tenant'
        : 'not_entitled';
    throw new PlanLimitError('plan_limit_channel_meta', null, { channel: 'messenger|instagram', reason });
  }

  for (const page of pages) {
    // 1. Subscribe page to webhooks — the page-level subscription is the
    // transport for BOTH Messenger and IG DMs, so it runs when either type
    // is entitled (and we get here only if at least one is).
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

    // 2. Create or reuse Messenger connection (reactivate if previously
    // disconnected) — entitled tenants only.
    if (!messengerEntitled) {
      logger.info('[meta-setup] messenger not entitled — skipping connection', { tenantId, pageId: page.id });
    } else {
      await upsertMessengerConnection(repo, tenantId, page, connections);
    }

    // 3. If IG account linked, subscribe and create IG connection.
    if (page.instagramAccount && instagramEntitled) {
      await upsertInstagramConnection(repo, tenantId, page, connections);
    } else if (page.instagramAccount && !instagramEntitled) {
      logger.info('[meta-setup] instagram not entitled — skipping IG connection', {
        tenantId,
        igId: page.instagramAccount.id,
      });
    }
  }

  return { connections, skipped };
}

async function upsertMessengerConnection(
  repo: ReturnType<typeof AppDataSource.getRepository<ChannelConnection>>,
  tenantId: string,
  page: PageToConnect,
  connections: ChannelConnection[],
): Promise<void> {
  {
    let messengerConn = await repo.findOne({
      where: { platformAccountId: page.id, channel: 'messenger' as any },
    });

    if (messengerConn) {
      // Reactivate existing connection
      messengerConn.tenantId = tenantId;
      messengerConn.status = 'active';
      messengerConn.label = page.name;
      messengerConn.credentials = {
        pageAccessToken: encryptCredential(page.accessToken),
        pageId: page.id,
      };
      messengerConn.config = {
        pageName: page.name,
        pageImageUrl: page.picture,
      };
      messengerConn.lastError = null;
    } else {
      messengerConn = repo.create({
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
    }
    const savedMessenger = await repo.save(messengerConn);
    connections.push(savedMessenger);
  }
}

async function upsertInstagramConnection(
  repo: ReturnType<typeof AppDataSource.getRepository<ChannelConnection>>,
  tenantId: string,
  page: PageToConnect,
  connections: ChannelConnection[],
): Promise<void> {
  {
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

        let igConn = await repo.findOne({
          where: { platformAccountId: page.instagramAccount.id, channel: 'instagram' as any },
        });

        if (igConn) {
          igConn.tenantId = tenantId;
          igConn.status = 'active';
          igConn.label = page.instagramAccount.username
            ? `@${page.instagramAccount.username}`
            : `${page.name} (Instagram)`;
          igConn.credentials = {
            pageAccessToken: encryptCredential(page.accessToken),
            pageId: page.id,
            igBusinessId: page.instagramAccount.id,
          };
          igConn.config = {
            igUsername: page.instagramAccount.username,
            igProfilePicUrl: page.instagramAccount.profilePicUrl,
            linkedPageId: page.id,
          };
          igConn.lastError = null;
        } else {
          igConn = repo.create({
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
        }
        const savedIg = await repo.save(igConn);
        connections.push(savedIg);
      } catch (error) {
        logger.warn(`[meta-setup] Failed to subscribe IG account ${page.instagramAccount.id}:`, error);
        // Don't fail the whole operation — Messenger is still connected
      }
    }
  }
}
