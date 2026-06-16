/**
 * Settings → Features — tenant self-service feature on/off toggles.
 *
 * A tenant admin can switch entitlement-clamped features (channels, leads,
 * bookings, Success Meter) on or off for their workspace. Switches appear only
 * for entitled features; a feature the plan doesn't include shows a locked row
 * that links to billing. The API clamps every write to the entitlement ceiling.
 *
 * Plan: .scratch/plan-tenant-feature-toggles.md § 5.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  MessageCircle,
  MessageSquare,
  Camera,
  Send,
  UserPlus,
  CalendarCheck,
  Gauge,
  Lock,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useAppAuth } from '@auth/useAppAuth';
import {
  useEntitlements,
  useUpdateFeatureToggles,
  type ToggleableFeatureKey,
  type TenantFeatureToggles,
} from '@/queries/useEntitlementsQueries';

interface FeatureMeta {
  label: string;
  description: string;
  icon: LucideIcon;
}

// Local label/description metadata (the API taxonomy lives server-side; the
// portal only needs display strings for the 7 toggleable keys).
const FEATURE_META: Record<ToggleableFeatureKey, FeatureMeta> = {
  channelWhatsapp: { label: 'WhatsApp', description: 'Reply to WhatsApp messages with your AI bot.', icon: MessageCircle },
  channelMessenger: { label: 'Facebook Messenger', description: 'Reply to Messenger conversations.', icon: MessageSquare },
  channelInstagram: { label: 'Instagram DMs', description: 'Reply to Instagram direct messages.', icon: Camera },
  channelTelegram: { label: 'Telegram', description: 'Reply to Telegram messages.', icon: Send },
  leadCapture: { label: 'Leads', description: 'Capture and store leads from conversations.', icon: UserPlus },
  bookings: { label: 'Bookings', description: 'Let your bot schedule appointments.', icon: CalendarCheck },
  gapInsights: { label: 'Success Meter', description: 'AI insights into conversation gaps and outcomes.', icon: Gauge },
};

const CHANNEL_KEYS: ToggleableFeatureKey[] = [
  'channelWhatsapp',
  'channelMessenger',
  'channelInstagram',
  'channelTelegram',
];

interface FeatureGroup {
  id: string;
  title: string;
  keys: ToggleableFeatureKey[];
}

const GROUPS: FeatureGroup[] = [
  { id: 'channels', title: 'Social channels', keys: CHANNEL_KEYS },
  { id: 'leads', title: 'Leads', keys: ['leadCapture'] },
  { id: 'bookings', title: 'Bookings', keys: ['bookings'] },
  { id: 'insights', title: 'Success Meter', keys: ['gapInsights'] },
];

/** enabled = preference, defaulting ON when entitled (absent key = on). */
function isEnabled(toggles: TenantFeatureToggles, key: ToggleableFeatureKey): boolean {
  return toggles[key] ?? true;
}

const FeaturesSettings: React.FC = () => {
  const { t } = useTranslation();
  const { isRole } = useAppAuth();
  const isAdmin = isRole(['admin', 'super_admin']);

  const { data, isLoading } = useEntitlements();
  const updateToggles = useUpdateFeatureToggles();

  if (isLoading || !data) return <PageSkeleton variant="list" rows={4} />;

  const entitled = data.current.entitledFeatures;
  const toggles = data.current.featureToggles;
  const disabled = !isAdmin || updateToggles.isPending;

  // Build the FULL desired toggle map (PUT replaces the whole map) from the
  // current enabled state of every ENTITLED toggleable key, applying `changes`.
  const writeWith = (changes: Partial<Record<ToggleableFeatureKey, boolean>>) => {
    const next: TenantFeatureToggles = {};
    (Object.keys(FEATURE_META) as ToggleableFeatureKey[]).forEach((key) => {
      if (!entitled[key]) return; // never write a non-entitled key (API would 422 on `true`)
      next[key] = key in changes ? (changes[key] as boolean) : isEnabled(toggles, key);
    });
    updateToggles.mutate(next);
  };

  const entitledChannels = CHANNEL_KEYS.filter((k) => entitled[k]);
  const allChannelsOn = entitledChannels.length > 0 && entitledChannels.every((k) => isEnabled(toggles, k));

  const renderRow = (key: ToggleableFeatureKey) => {
    const meta = FEATURE_META[key];
    const Icon = meta.icon;
    const locked = !entitled[key];
    return (
      <div key={key} className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
            <Icon className="h-4 w-4 text-primary-400" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-text-primary">{t(`features.keys.${key}.label`, { defaultValue: meta.label })}</p>
            <p className="text-sm text-text-secondary truncate">
              {t(`features.keys.${key}.description`, { defaultValue: meta.description })}
            </p>
          </div>
        </div>
        {locked ? (
          <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
            <Link to="/settings/billing">
              <Lock className="h-3.5 w-3.5" />
              {t('features.upgrade', { defaultValue: 'Upgrade' })}
            </Link>
          </Button>
        ) : (
          <Switch
            checked={isEnabled(toggles, key)}
            onCheckedChange={(v) => writeWith({ [key]: v })}
            disabled={disabled}
          />
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">
          {t('features.header.title', { defaultValue: 'Features' })}
        </h2>
        <p className="text-sm text-text-secondary mt-0.5">
          {t('features.header.subtitle', {
            defaultValue: 'Turn features on or off for your workspace. Features your plan doesn’t include show an upgrade option.',
          })}
        </p>
      </div>

      {GROUPS.map((group) => (
        <Card key={group.id} variant="glass">
          <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
            <h3 className="font-medium text-text-primary">
              {t(`features.groups.${group.id}`, { defaultValue: group.title })}
            </h3>
            {/* Channels "all at once" master — toggles every entitled channel. */}
            {group.id === 'channels' && entitledChannels.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-muted">
                  {t('features.allChannels', { defaultValue: 'All channels' })}
                </span>
                <Switch
                  checked={allChannelsOn}
                  onCheckedChange={(v) =>
                    writeWith(Object.fromEntries(entitledChannels.map((k) => [k, v])))
                  }
                  disabled={disabled}
                />
              </div>
            )}
          </CardHeader>
          <CardContent className="p-0 divide-y divide-edge">
            {group.keys.map(renderRow)}
          </CardContent>
        </Card>
      ))}

      {!isAdmin && (
        <p className="text-xs text-text-muted">
          {t('features.adminOnly', { defaultValue: 'Only workspace admins can change these settings.' })}
        </p>
      )}
    </div>
  );
};

export default FeaturesSettings;
