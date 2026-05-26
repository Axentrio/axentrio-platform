import { Request } from 'express';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection, ChannelType } from '../../database/entities/ChannelConnection';
import { ConnectionResolver } from '../types';
import { logger } from '../../utils/logger';

/**
 * Resolve the WhatsApp ChannelConnection that owns a business phone number.
 * `platformAccountId` stores the Cloud API `phone_number_id`.
 */
export async function resolveWhatsAppConnection(
  phoneNumberId: string,
): Promise<ChannelConnection | null> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  const connection = await repo.findOne({
    where: {
      platformAccountId: phoneNumberId,
      channel: 'whatsapp' as ChannelType,
      status: 'active',
    },
  });

  if (!connection) {
    logger.warn(`[whatsapp] No active connection for phone_number_id ${phoneNumberId}`);
  }

  return connection;
}

/**
 * Adapter-interface resolver. Reads the business `phone_number_id` from the
 * (parsed) webhook body. The dedicated raw-body route resolves per-event
 * instead, since one WABA payload can target multiple numbers — this exists so
 * the WhatsApp adapter satisfies the ChannelAdapter contract for reuse.
 */
export class WhatsAppConnectionResolver implements ConnectionResolver {
  async resolve(req: Request): Promise<ChannelConnection | null> {
    const body = req.body as
      | { entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string } } }> }> }
      | undefined;
    const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    if (!phoneNumberId) return null;
    return resolveWhatsAppConnection(phoneNumberId);
  }
}
