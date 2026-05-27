import { ChannelType } from '../database/entities/ChannelConnection';
import { ChannelAdapter } from './types';

const adapters = new Map<ChannelType, ChannelAdapter>();

export function registerChannelAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.channel, adapter);
}

export function getChannelAdapter(channel: ChannelType): ChannelAdapter | undefined {
  return adapters.get(channel);
}

export function getRegisteredChannels(): ChannelType[] {
  return Array.from(adapters.keys());
}
