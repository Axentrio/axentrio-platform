import { cn } from '@/lib/utils';
import { CHANNEL_COLORS, CHANNEL_ICONS, CHANNEL_LABELS, channelKeyOf } from '@/lib/channelMeta';

export function ChannelBadge({
  channel,
  source,
  className,
}: {
  channel?: string;
  source?: string;
  className?: string;
}) {
  const key = channelKeyOf(channel, source);
  if (!key) return null;
  const Icon = CHANNEL_ICONS[key];
  const label = CHANNEL_LABELS[key] ?? key;
  const color = CHANNEL_COLORS[key] ?? 'bg-surface-3 text-text-secondary';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0',
        color,
        className,
      )}
      title={label}
      aria-label={label}
    >
      {Icon ? <Icon className="w-3 h-3" aria-hidden /> : null}
      <span>{label}</span>
    </span>
  );
}
