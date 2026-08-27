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
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  MessageCircle,
  MessageSquare,
  Camera,
  Send,
  UserPlus,
  CalendarCheck,
  Gauge,
  Music2,
  AtSign,
  Lock,
  Pause,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useAppAuth } from '@auth/useAppAuth';
import {
  useEntitlements,
  useUpdateFeatureToggles,
  type ToggleableFeatureKey,
  type TenantFeatureToggles,
  type PlanFeatures,
} from '@/queries/useEntitlementsQueries';
import { usePauseAllBots } from '@/queries/useBotsQueries';

interface FeatureMeta {
  label: string;
  description: string;
  icon: LucideIcon;
}

/**
 * The toggleable keys this page actually shows.
 *
 * `proactiveLeadCapture` is excluded: nothing on the server reads it today (the
 * chip-offer implementation was removed; the prompt-level one isn't built), so a
 * switch for it would promise behaviour that cannot happen. Excluding it by name
 * rather than widening the map to `Partial` keeps every OTHER key tsc-enforced —
 * a new toggleable feature still fails the build until it has display strings.
 */
type SurfacedFeatureKey = Exclude<ToggleableFeatureKey, 'proactiveLeadCapture'>;

// Local label/description metadata (the API taxonomy lives server-side; the
// portal only needs display strings for the keys it surfaces).
const FEATURE_META: Record<SurfacedFeatureKey, FeatureMeta> = {
  channelWhatsapp: { label: 'WhatsApp', description: 'Reply to WhatsApp messages with your AI bot.', icon: MessageCircle },
  channelMessenger: { label: 'Facebook Messenger', description: 'Reply to Messenger conversations.', icon: MessageSquare },
  channelInstagram: { label: 'Instagram DMs', description: 'Reply to Instagram direct messages.', icon: Camera },
  channelTelegram: { label: 'Telegram', description: 'Reply to Telegram messages.', icon: Send },
  channelLinkedin: { label: 'LinkedIn', description: 'Reply to LinkedIn messages.', icon: MessageSquare },
  channelTiktok: { label: 'TikTok', description: 'Reply to TikTok messages.', icon: Music2 },
  channelX: { label: 'X', description: 'Reply to X direct messages.', icon: AtSign },
  leadCapture: { label: 'Leads', description: 'Capture and store leads from conversations.', icon: UserPlus },
  bookings: { label: 'Bookings', description: 'Let your bot schedule appointments.', icon: CalendarCheck },
  gapInsights: { label: 'Success Meter', description: 'AI insights into conversation gaps and outcomes.', icon: Gauge },
};

const CHANNEL_KEYS: SurfacedFeatureKey[] = [
  'channelWhatsapp',
  'channelMessenger',
  'channelInstagram',
  'channelTelegram',
  'channelLinkedin',
  'channelTiktok',
  'channelX',
];

interface FeatureGroup {
  id: string;
  title: string;
  keys: SurfacedFeatureKey[];
}

const GROUPS: FeatureGroup[] = [
  { id: 'channels', title: 'Social channels', keys: CHANNEL_KEYS },
  // NOTE: GROUPS is NOT tsc-enforced (FEATURE_META is). A key present in META but
  // missing here renders no switch while still being written on every save — so
  // any addition to META must be added here too.
  { id: 'leads', title: 'Leads', keys: ['leadCapture'] },
  { id: 'bookings', title: 'Bookings', keys: ['bookings'] },
  { id: 'insights', title: 'Success Meter', keys: ['gapInsights'] },
];

/**
 * Enabled = the tenant's stored preference; when absent, fall back to the EFFECTIVE
 * value the server computed (`features`).
 *
 * It used to default to `true` unconditionally, which is right for the features a
 * tenant bought but wrong for the server's OPT-IN keys (`OPT_IN_FEATURES`), which
 * stay off until explicitly switched on: a hardcoded `?? true` would show a switch
 * reading "on" while the feature was inert — and worse, the save path would then
 * persist `true`. No surfaced key is opt-in right now, but the mechanism must not
 * be re-hardcoded the next time one is.
 *
 * Deferring to `features` keeps the single source of truth server-side, so the
 * opt-in list does not have to be duplicated in the portal and cannot drift from it.
 */
function isEnabled(
  toggles: TenantFeatureToggles,
  features: PlanFeatures,
  key: SurfacedFeatureKey,
): boolean {
  return toggles[key] ?? features[key] === true;
}

const FeaturesSettings: React.FC = () => {
  const { t } = useTranslation();
  const { isRole } = useAppAuth();
  const isAdmin = isRole(['admin', 'super_admin']);
  const [pauseAllOpen, setPauseAllOpen] = useState(false);

  const { data, isLoading } = useEntitlements();
  const updateToggles = useUpdateFeatureToggles();
  const pauseAllBots = usePauseAllBots();

  if (isLoading || !data) return <PageSkeleton variant="list" rows={4} />;

  const entitled = data.current.entitledFeatures;
  const toggles = data.current.featureToggles;
  // Effective values: what is actually live right now, after the opt-in default and
  // the parent-child cascade. Drives the switch state so the UI can't disagree
  // with the server about whether a feature is on.
  const effective = data.current.features;
  const disabled = !isAdmin || updateToggles.isPending;

  // Build the FULL desired toggle map (PUT replaces the whole map) from the
  // current enabled state of every ENTITLED surfaced key, applying `changes`.
  // A key we don't surface is therefore dropped from the stored map on the next
  // save — correct for `proactiveLeadCapture`, which is opt-in (absent = off) and
  // has no consumer, so the drop lands it exactly where it already effectively is.
  const writeWith = (changes: Partial<Record<SurfacedFeatureKey, boolean>>) => {
    const next: TenantFeatureToggles = {};
    (Object.keys(FEATURE_META) as SurfacedFeatureKey[]).forEach((key) => {
      if (!entitled[key]) return; // never write a non-entitled key (API would 422 on `true`)
      next[key] = key in changes ? (changes[key] as boolean) : isEnabled(toggles, effective, key);
    });
    updateToggles.mutate(next);
  };

  const entitledChannels = CHANNEL_KEYS.filter((k) => entitled[k]);
  const allChannelsOn = entitledChannels.length > 0 && entitledChannels.every((k) => isEnabled(toggles, effective, k));

  const handlePauseAll = async () => {
    try {
      const result = await pauseAllBots.mutateAsync();
      toast.success(t('features.pauseAllBots.success', { count: result.pausedCount }));
      setPauseAllOpen(false);
    } catch {
      toast.error(t('common.actionFailed'));
    }
  };

  const renderRow = (key: SurfacedFeatureKey) => {
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
            checked={isEnabled(toggles, effective, key)}
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

      {isAdmin && (
        <Card variant="glass">
          <CardContent className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium text-text-primary">
                {t('features.pauseAllBots.button', { defaultValue: 'Pause all bots' })}
              </p>
              <p className="text-sm text-text-secondary">
                {t('features.pauseAllBots.confirmBody', {
                  defaultValue:
                    'This turns the AI assistant off on every bot in your workspace. Each bot can be turned back on individually in its bot editor.',
                })}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => setPauseAllOpen(true)}
              disabled={pauseAllBots.isPending}
              className="shrink-0 gap-1.5"
            >
              <Pause className="h-4 w-4" />
              {t('features.pauseAllBots.button', { defaultValue: 'Pause all bots' })}
            </Button>
          </CardContent>
        </Card>
      )}

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

      <AlertDialog open={pauseAllOpen} onOpenChange={(open) => !pauseAllBots.isPending && setPauseAllOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('features.pauseAllBots.confirmTitle', {
                defaultValue: 'Pause the AI assistant on every bot?',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('features.pauseAllBots.confirmBody', {
                defaultValue:
                  'This turns the AI assistant off on every bot in your workspace. Each bot can be turned back on individually in its bot editor.',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pauseAllBots.isPending}>
              {t('features.pauseAllBots.cancel', { defaultValue: 'Cancel' })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handlePauseAll();
              }}
              disabled={pauseAllBots.isPending}
            >
              {t('features.pauseAllBots.confirm', { defaultValue: 'Pause all bots' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default FeaturesSettings;
