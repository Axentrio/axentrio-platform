import type { ElementType } from 'react';
import { Globe } from 'lucide-react';
import { SiTelegram, SiMessenger, SiInstagram, SiWhatsapp } from 'react-icons/si';

export const CHANNEL_ICONS: Record<string, ElementType> = {
  telegram: SiTelegram,
  messenger: SiMessenger,
  instagram: SiInstagram,
  whatsapp: SiWhatsapp,
  widget: Globe,
};

export const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  widget: 'Website widget',
};

export const CHANNEL_COLORS: Record<string, string> = {
  telegram: 'bg-sky-500/15 text-sky-400',
  messenger: 'bg-blue-500/15 text-blue-400',
  instagram: 'bg-pink-500/15 text-pink-400',
  whatsapp: 'bg-emerald-500/15 text-emerald-400',
  widget: 'bg-zinc-500/15 text-zinc-400',
};

export function channelKeyOf(channel?: string, source?: string): string {
  return (channel || source || '').toLowerCase();
}
