import type { ChannelType } from '../database/entities/ChannelConnection';

export type AddressControlChannel = 'widget' | 'messenger' | 'instagram' | 'whatsapp';

/** Unknown and Telegram fail closed: only these four surfaces return server-observed actions. */
export function canRenderAddressControls(channel: unknown): channel is AddressControlChannel {
  return channel === 'widget' || channel === 'messenger' || channel === 'instagram' || channel === 'whatsapp';
}

export function isMetaAddressControlChannel(channel: ChannelType | undefined): channel is 'messenger' | 'instagram' | 'whatsapp' {
  return channel === 'messenger' || channel === 'instagram' || channel === 'whatsapp';
}
