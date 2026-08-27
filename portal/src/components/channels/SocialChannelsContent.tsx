/**
 * SocialChannelsContent
 * Reusable connect/disconnect UI for Telegram + Meta channels.
 * Rendered by /settings/channels and the AI & Content "Social" tab.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import {
  MessageSquare, Trash2, AlertCircle, RefreshCw, Loader2, Lock, PowerOff,
} from 'lucide-react';
import { SiFacebook, SiInstagram, SiWhatsapp } from 'react-icons/si';
import { CHANNEL_COLORS, CHANNEL_ICONS, CHANNEL_LABELS } from '@/lib/channelMeta';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  useChannelConnections,
  useConnectWhatsApp,
  useWhatsAppEmbeddedSignupConfig,
  useCompleteWhatsAppEmbeddedSignup,
  useMetaOAuthUrl,
  useMetaOAuthPages,
  useConnectMeta,
  useDisconnectChannel,
  useHealthCheckChannel,
  useUpdateChannelBot,
  useUpdateChannelAutoCapture,
} from '../../queries/useChannelQueries';
import type { ChannelConnection } from '../../queries/useChannelQueries';
import { useBots } from '@/queries/useBotsQueries';
import type { BotListItem } from '@/queries/useBotsQueries';
import { useIsEntitled, useHasFeature } from '../../queries/useEntitlementsQueries';
import { queryKeys } from '../../queries/queryKeys';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { timeAgo } from '@/utils/timeAgo';
import { openMetaOAuthPopup } from '@/lib/metaOAuthPopup';
import { launchWhatsAppEmbeddedSignup } from '@/lib/whatsappEmbeddedSignup';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Status indicator: colored dot + text.
const STATUS_DOT: Record<string, string> = {
  active: 'bg-emerald-400',
  error: 'bg-red-400',
  disconnected: 'bg-zinc-500',
  pending_setup: 'bg-amber-400',
};

const STATUS_TEXT: Record<string, string> = {
  active: 'text-emerald-400',
  error: 'text-red-400',
  disconnected: 'text-zinc-400',
  pending_setup: 'text-amber-400',
};

/** Plan state of one channel: in-plan ceiling, switched off, usable now. */
interface ChannelGate {
  entitled: boolean;
  off: boolean;
  available: boolean;
}

/** Prefix icon of a gated connect button: locked (upgrade) or switched off. */
function GateIcon({ gate }: { gate: ChannelGate }) {
  if (!gate.entitled) return <Lock className="h-3 w-3 mr-1" />;
  if (gate.off) return <PowerOff className="h-3 w-3 mr-1" />;
  return null;
}

interface ChannelConnectButtonsProps {
  metaGate: ChannelGate;
  whatsappGate: ChannelGate;
  lockedHint: string;
  offHint: string;
  onConnectFacebook: () => void;
  isFacebookPending: boolean;
  onConnectWhatsApp: () => void;
  isWhatsAppPending: boolean;
}

function ChannelConnectButtons({
  metaGate,
  whatsappGate,
  lockedHint,
  offHint,
  onConnectFacebook,
  isFacebookPending,
  onConnectWhatsApp,
  isWhatsAppPending,
}: ChannelConnectButtonsProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={onConnectFacebook}
        disabled={isFacebookPending || !metaGate.available}
        title={!metaGate.entitled ? lockedHint : metaGate.off ? offHint : undefined}
      >
        <GateIcon gate={metaGate} />
        {isFacebookPending
          ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          : <SiFacebook className="h-4 w-4 mr-1" />}
        {isFacebookPending
          ? t('ai.social.facebook.connecting', { defaultValue: 'Connecting…' })
          : t('ai.social.facebook.title')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={onConnectWhatsApp}
        disabled={!whatsappGate.available || isWhatsAppPending}
        title={!whatsappGate.entitled ? lockedHint : whatsappGate.off ? offHint : undefined}
      >
        <GateIcon gate={whatsappGate} />
        {isWhatsAppPending
          ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          : <SiWhatsapp className="h-4 w-4 mr-1" />}
        {t('ai.social.whatsapp.title', { defaultValue: 'WhatsApp' })}
      </Button>
    </div>
  );
}

/** Page row of the Meta OAuth session (the endpoint returns untyped JSON). */
interface MetaOAuthPage {
  id: string;
  name: string;
  instagramAccount?: { username: string } | null;
}

interface MetaPageSelectionCardProps {
  pages: MetaOAuthPage[] | undefined;
  selectedPageIds: string[];
  setSelectedPageIds: React.Dispatch<React.SetStateAction<string[]>>;
  messengerEntitled: boolean;
  instagramEntitled: boolean;
  onConnect: () => void;
  isConnecting: boolean;
  onCancel: () => void;
}

/** Meta OAuth page selection (shown after the OAuth redirect). */
function MetaPageSelectionCard({
  pages,
  selectedPageIds,
  setSelectedPageIds,
  messengerEntitled,
  instagramEntitled,
  onConnect,
  isConnecting,
  onCancel,
}: MetaPageSelectionCardProps) {
  const { t } = useTranslation();
  if (!pages || pages.length === 0) return null;
  return (
    <Card variant="glass">
      <CardHeader>
        <h3 className="text-sm font-medium text-white">{t('ai.social.metaPages.title')}</h3>
        <p className="text-xs text-zinc-400">{t('ai.social.metaPages.description')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {pages.map((page) => (
          <label key={page.id} className="flex items-center gap-3 p-2 rounded hover:bg-white/5 cursor-pointer">
            <Checkbox
              checked={selectedPageIds.includes(page.id)}
              onCheckedChange={(checked) => {
                setSelectedPageIds((prev) =>
                  checked ? [...prev, page.id] : prev.filter((id: string) => id !== page.id),
                );
              }}
            />
            <span className="text-sm text-white">{page.name}</span>
            {!messengerEntitled && (
              <Badge variant="outline" className="text-xs text-amber-400 border-amber-400/40">
                <Lock className="h-3 w-3 mr-1" />
                {t('ai.social.metaPages.messengerLocked', { defaultValue: 'Messenger locked on your plan' })}
              </Badge>
            )}
            {page.instagramAccount && (
              <Badge
                variant="outline"
                className={`text-xs ${!instagramEntitled ? 'text-amber-400 border-amber-400/40' : ''}`}
              >
                {!instagramEntitled && <Lock className="h-3 w-3 mr-1" />}
                <SiInstagram className="h-3 w-3 mr-1" />
                @{page.instagramAccount.username}
                {!instagramEntitled &&
                  ` — ${t('ai.social.metaPages.igLocked', { defaultValue: 'locked on your plan' })}`}
              </Badge>
            )}
          </label>
        ))}
        <div className="flex gap-2 pt-2">
          <Button onClick={onConnect} disabled={selectedPageIds.length === 0 || isConnecting}>
            {isConnecting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isConnecting ? t('ai.social.metaPages.connecting') : t('ai.social.metaPages.connectSelected')}
          </Button>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Left side of a connection row: icon, label, plan lock, activity. */
function ConnectionRowIdentity({
  conn,
  planLocked,
  activityParts,
}: {
  conn: ChannelConnection;
  planLocked: boolean;
  activityParts: string[];
}) {
  const { t } = useTranslation();
  const Icon = CHANNEL_ICONS[conn.channel] || MessageSquare;
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${CHANNEL_COLORS[conn.channel] || 'bg-white/10 text-zinc-400'}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-white truncate">
          {conn.label || conn.platformAccountId}
          {planLocked && (
            <Badge variant="outline" className="ml-2 text-xs text-amber-400 border-amber-400/40">
              <Lock className="h-3 w-3 mr-1" />
              {t('ai.social.planLocked', { defaultValue: 'Plan locked — upgrade to reactivate' })}
            </Badge>
          )}
        </p>
        <p className="text-xs text-zinc-500 truncate">
          {CHANNEL_LABELS[conn.channel] || conn.channel}
          {conn.lastHealthCheckAt && (
            <span className="ml-1.5 text-zinc-600" title={new Date(conn.lastHealthCheckAt).toLocaleString()}>
              {t('ai.social.activity.checked', { time: timeAgo(conn.lastHealthCheckAt) })}
            </span>
          )}
        </p>
        {activityParts.length > 0 && (
          <p className="text-xs text-zinc-600 mt-0.5 truncate">{activityParts.join(' · ')}</p>
        )}
      </div>
    </div>
  );
}

interface ConnectionRowControlsProps {
  conn: ChannelConnection;
  bots: BotListItem[];
  /** Connection whose health check is in flight, if any. */
  checkingConnectionId?: string;
  isAutoCapturePending: boolean;
  onAutoCaptureChange: (connectionId: string, enabled: boolean) => void;
  onBotChange: (connectionId: string, botId: string | null) => void;
  onHealthCheck: (connectionId: string) => void;
  onDisconnect: (connectionId: string) => void;
}

/** Right side of a connection row: lead capture, bot, status, actions. */
function ConnectionRowControls({
  conn,
  bots,
  checkingConnectionId,
  isAutoCapturePending,
  onAutoCaptureChange,
  onBotChange,
  onHealthCheck,
  onDisconnect,
}: ConnectionRowControlsProps) {
  const { t } = useTranslation();
  const checkingThis = checkingConnectionId === conn.id;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {conn.channel !== 'widget' && (
        <label
          className="flex items-center gap-1.5 text-xs text-zinc-400"
          title={t('ai.social.autoCapture.hint', { defaultValue: 'Auto-create a lead from each new conversation on this channel' })}
        >
          <Switch
            checked={conn.config?.autoCaptureLeads !== false}
            disabled={isAutoCapturePending}
            onCheckedChange={(c) => onAutoCaptureChange(conn.id, c)}
            aria-label={t('ai.social.autoCapture.aria', { defaultValue: 'Auto-capture leads' })}
          />
          {t('ai.social.autoCapture.label', { defaultValue: 'Capture leads' })}
        </label>
      )}
      {conn.channel !== 'widget' && (
        <Select
          value={conn.botId ?? '__default__'}
          onValueChange={(v) => onBotChange(conn.id, v === '__default__' ? null : v)}
        >
          <SelectTrigger
            className="h-8 w-44"
            aria-label={t('ai.social.botPicker.aria', { defaultValue: 'Bot for this channel' })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">
              {t('ai.social.botPicker.default', { defaultValue: 'Default bot' })}
            </SelectItem>
            {bots.flatMap((b) =>
              b.status === 'active'
                ? [
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                      {b.isDefault
                        ? ` ${t('ai.social.botPicker.defaultSuffix', { defaultValue: '(default)' })}`
                        : ''}
                    </SelectItem>,
                  ]
                : [],
            )}
          </SelectContent>
        </Select>
      )}
      {conn.lastError && (
        <span className="text-xs text-red-400 max-w-full truncate" title={conn.lastError}>
          <AlertCircle className="h-3 w-3 inline mr-1" />
          {conn.lastError}
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[conn.status] || 'bg-zinc-500'}`} />
        <span className={`text-xs font-medium capitalize ${STATUS_TEXT[conn.status] || 'text-zinc-400'}`}>
          {t(`ai.social.status.${conn.status}`, { defaultValue: conn.status })}
        </span>
      </span>
      <div className="flex items-center gap-1 transition-opacity md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100">
        <Button
          size="sm"
          variant="ghost"
          title={t('ai.social.actions.checkHealth')}
          disabled={checkingThis}
          onClick={() => onHealthCheck(conn.id)}
        >
          <RefreshCw className={`h-4 w-4 ${checkingThis ? 'animate-spin' : ''}`} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-red-400 hover:text-red-300"
          onClick={() => onDisconnect(conn.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/** One connected channel. Plan-locked rows keep their credentials (plan D4):
 *  everything reactivates on upgrade, so they read as quiet, not broken. */
function ConnectionRow({
  conn,
  channelEntitled,
  ...controls
}: Omit<ConnectionRowControlsProps, 'conn'> & {
  conn: ChannelConnection;
  channelEntitled: Record<string, boolean>;
}) {
  const { t } = useTranslation();
  const planLocked = conn.channel !== 'widget' && channelEntitled[conn.channel] === false;
  const activityParts: string[] = [];
  if (conn.lastInboundAt) activityParts.push(t('ai.social.activity.received', { time: timeAgo(conn.lastInboundAt) }));
  if (conn.lastOutboundAt) activityParts.push(t('ai.social.activity.sent', { time: timeAgo(conn.lastOutboundAt) }));
  return (
    <div
      className={`group flex flex-col gap-3 p-3 rounded-lg bg-white/5 hover:bg-white/[0.07] transition-colors ${planLocked ? 'opacity-70' : ''}`}
    >
      <ConnectionRowIdentity conn={conn} planLocked={planLocked} activityParts={activityParts} />
      <ConnectionRowControls conn={conn} {...controls} />
    </div>
  );
}

interface WhatsAppConnectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phoneNumberId: string;
  setPhoneNumberId: (value: string) => void;
  accessToken: string;
  setAccessToken: (value: string) => void;
  wabaId: string;
  setWabaId: (value: string) => void;
  isPending: boolean;
  onConnect: () => void;
}

/** Manual WhatsApp Cloud API credentials modal. */
function WhatsAppConnectModal({
  open,
  onOpenChange,
  phoneNumberId,
  setPhoneNumberId,
  accessToken,
  setAccessToken,
  wabaId,
  setWabaId,
  isPending,
  onConnect,
}: WhatsAppConnectModalProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('ai.social.whatsapp.modal.title', { defaultValue: 'Connect WhatsApp' })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('ai.social.whatsapp.modal.description', {
              defaultValue:
                'Connect a WhatsApp Cloud API number using its Phone Number ID and a permanent access token from Meta Business.',
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <details className="mt-2 rounded-lg bg-white/5 px-3 py-2 text-xs text-zinc-400">
          <summary className="cursor-pointer select-none text-zinc-300">
            {t('ai.social.whatsapp.modal.help.summary', { defaultValue: 'Where do I find these?' })}
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>
              {t('ai.social.whatsapp.modal.help.step1', {
                defaultValue: 'In the Meta App Dashboard, open WhatsApp → API Setup.',
              })}
            </li>
            <li>
              {t('ai.social.whatsapp.modal.help.step2', {
                defaultValue: 'Copy the Phone number ID and your System User access token.',
              })}
            </li>
            <li>
              {t('ai.social.whatsapp.modal.help.step3', {
                defaultValue:
                  'Optionally add the WhatsApp Business Account ID so we can subscribe webhooks for you.',
              })}
            </li>
          </ol>
        </details>
        <div className="space-y-3 py-4">
          <div>
            <Label htmlFor="waPhoneNumberId">
              {t('ai.social.whatsapp.modal.phoneNumberIdLabel', { defaultValue: 'Phone Number ID' })}
            </Label>
            <Input
              id="waPhoneNumberId"
              placeholder="123456789012345"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="waAccessToken">
              {t('ai.social.whatsapp.modal.accessTokenLabel', { defaultValue: 'Access Token' })}
            </Label>
            <Input
              id="waAccessToken"
              type="password"
              placeholder="EAAG..."
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="waWabaId">
              {t('ai.social.whatsapp.modal.wabaIdLabel', {
                defaultValue: 'Business Account ID (optional)',
              })}
            </Label>
            <Input
              id="waWabaId"
              placeholder="WABA ID"
              value={wabaId}
              onChange={(e) => setWabaId(e.target.value)}
            />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); onConnect(); }}
            disabled={!phoneNumberId.trim() || !accessToken.trim() || isPending}
          >
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isPending
              ? t('ai.social.whatsapp.modal.connecting', { defaultValue: 'Connecting…' })
              : t('ai.social.whatsapp.modal.connect', { defaultValue: 'Connect' })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Disconnect confirmation. Stays open on failure so the operator can retry. */
function DisconnectConfirmDialog({
  target,
  isPending,
  onDismiss,
  onConfirm,
}: {
  target: string | null;
  isPending: boolean;
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={!!target}
      onOpenChange={(open) => { if (!open && !isPending) onDismiss(); }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('ai.social.disconnect.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('ai.social.disconnect.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 hover:bg-red-700"
            disabled={isPending}
            onClick={(e) => { e.preventDefault(); onConfirm(); }}
          >
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isPending
              ? t('ai.social.disconnect.disconnecting', { defaultValue: 'Disconnecting…' })
              : t('ai.social.disconnect.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SocialChannelsContent() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: connections, isLoading } = useChannelConnections();
  const disconnectMutation = useDisconnectChannel();
  const healthCheckMutation = useHealthCheckChannel();
  const updateChannelBot = useUpdateChannelBot();
  const updateAutoCapture = useUpdateChannelAutoCapture();
  const { data: botsData } = useBots();
  const bots = botsData?.bots ?? [];
  const metaOAuthUrl = useMetaOAuthUrl();
  const connectMeta = useConnectMeta();

  // Per-channel plan entitlements. The entitlements query caches for 5
  // minutes; refetch on mount so a just-changed plan/override is reflected
  // the moment the tenant lands here.
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.entitlements.all() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Plan-locked state keys off the entitlement CEILING (useIsEntitled), not the
  // effective flag — a channel the tenant merely toggled off is still in-plan and
  // must not show the "upgrade" lock. Its on/off lives in Settings → Features; the
  // backend keeps a toggled-off channel inert regardless.
  const channelEntitled: Record<string, boolean> = {
    // telegram connect is removed from the UI, but the entitlement is kept so any
    // pre-existing telegram connection row still computes its plan-locked state.
    telegram: useIsEntitled('channelTelegram'),
    whatsapp: useIsEntitled('channelWhatsapp'),
    messenger: useIsEntitled('channelMessenger'),
    instagram: useIsEntitled('channelInstagram'),
  };
  // EFFECTIVE flag (entitled AND switched on). A channel that's entitled but
  // toggled off is a distinct state from not-in-plan: it points to Settings →
  // Features (not upgrade). `channelOff` = entitled but switched off.
  const channelEnabled: Record<string, boolean> = {
    telegram: useHasFeature('channelTelegram'),
    whatsapp: useHasFeature('channelWhatsapp'),
    messenger: useHasFeature('channelMessenger'),
    instagram: useHasFeature('channelInstagram'),
  };
  const channelOff = (ch: string): boolean => channelEntitled[ch] && !channelEnabled[ch];
  const channelAvailable = (ch: string): boolean => channelEntitled[ch] && channelEnabled[ch];
  const anyMetaEntitled = channelEntitled.messenger || channelEntitled.instagram;
  const anyMetaAvailable = channelAvailable('messenger') || channelAvailable('instagram');
  const anyMetaOff = anyMetaEntitled && !anyMetaAvailable;
  // Hint copy shared by the connect buttons.
  const offHint = t('ai.social.offHint', { defaultValue: 'Turned off — enable in Settings → Features' });
  const lockedHint = t('ai.social.lockedHint', { defaultValue: 'Available on Pro and Enterprise plans' });
  const metaGate: ChannelGate = {
    entitled: anyMetaEntitled,
    off: anyMetaOff,
    available: anyMetaAvailable,
  };
  const whatsappGate: ChannelGate = {
    entitled: channelEntitled.whatsapp,
    off: channelOff('whatsapp'),
    available: channelAvailable('whatsapp'),
  };

  // WhatsApp connect state
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [waPhoneNumberId, setWaPhoneNumberId] = useState('');
  const [waAccessToken, setWaAccessToken] = useState('');
  const [waWabaId, setWaWabaId] = useState('');
  const connectWhatsApp = useConnectWhatsApp();
  const { data: waEsConfig } = useWhatsAppEmbeddedSignupConfig();
  const completeWhatsAppEs = useCompleteWhatsAppEmbeddedSignup();
  const whatsappEsEnabled = Boolean(waEsConfig?.enabled && waEsConfig.appId && waEsConfig.configId);

  // Meta OAuth page selection state
  const metaSetupToken = searchParams.get('meta_setup');
  const { data: metaPages } = useMetaOAuthPages(metaSetupToken);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);

  // Disconnect confirmation
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);

  useEffect(() => {
    const oauthError = searchParams.get('error');
    if (!oauthError) return;
    toast.error(
      oauthError === 'denied'
        ? t('ai.social.facebook.denied', { defaultValue: 'Facebook connect was cancelled.' })
        : t('ai.social.facebook.failed', { defaultValue: 'Facebook connect failed. Try again.' }),
    );
    const next = new URLSearchParams(searchParams);
    next.delete('error');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, t]);

  useEffect(() => {
    if (metaPages && metaPages.length > 0) {
      setSelectedPageIds(metaPages.map((p: Any) => p.id));
    }
  }, [metaPages]);

  const handleConnectFacebook = async () => {
    const url = await metaOAuthUrl.mutateAsync({
      display: 'popup',
      returnPath: '/settings/channels',
    });
    if (!url) return;
    const result = await openMetaOAuthPopup(url);
    if (result.status === 'navigated') return;
    if (result.status === 'cancelled') {
      toast.info(t('ai.social.facebook.denied', { defaultValue: 'Facebook connect was cancelled.' }));
      return;
    }
    if (result.status === 'error') {
      toast.error(
        result.error === 'denied'
          ? t('ai.social.facebook.denied', { defaultValue: 'Facebook connect was cancelled.' })
          : t('ai.social.facebook.failed', { defaultValue: 'Facebook connect failed. Try again.' }),
      );
      return;
    }
    setSearchParams({ meta_setup: result.sessionToken });
  };

  const handleConnectMetaPages = async () => {
    if (!metaSetupToken || selectedPageIds.length === 0) return;
    const result = await connectMeta.mutateAsync({ pageIds: selectedPageIds, sessionToken: metaSetupToken });
    // Surface entitlement-filtered channel types so the skip is never silent.
    const skipped: string[] = (result as Any)?.skipped ?? [];
    if (skipped.length > 0) {
      toast.info(
        t('ai.social.metaPages.skippedNotice', {
          defaultValue: 'Not included in your plan (skipped): {{channels}}',
          channels: skipped.map((s) => CHANNEL_LABELS[s] ?? s).join(', '),
        }),
      );
    }
    // IG subscribe/upsert is non-fatal on the API. useConnectMeta only toasts
    // the Facebook success; this screen surfaces why an expected IG
    // connection is missing.
    const igWarnings: Array<{ pageId: string; pageName?: string; reason: string }> =
      (result as Any)?.instagramWarnings ?? [];
    for (const warning of igWarnings) {
      toast.warning(
        t('ai.social.metaPages.instagramWarning', {
          defaultValue:
            'Facebook Page connected, but Instagram could not be set up for {{page}}: {{reason}}',
          page: warning.pageName || warning.pageId,
          reason: warning.reason,
        }),
      );
    }
    setSearchParams({});
  };

  const handleConnectWhatsApp = async () => {
    if (!waPhoneNumberId.trim() || !waAccessToken.trim()) return;
    await connectWhatsApp.mutateAsync({
      phoneNumberId: waPhoneNumberId.trim(),
      accessToken: waAccessToken.trim(),
      wabaId: waWabaId.trim() || undefined,
    });
    setWaPhoneNumberId('');
    setWaAccessToken('');
    setWaWabaId('');
    setShowWhatsAppModal(false);
  };

  const handleConnectWhatsAppEmbedded = async () => {
    if (!waEsConfig?.appId || !waEsConfig.configId) return;
    try {
      const result = await launchWhatsAppEmbeddedSignup({
        appId: waEsConfig.appId,
        configId: waEsConfig.configId,
        graphVersion: waEsConfig.graphVersion,
      });
      const phoneNumberId = result.session.phone_number_id;
      const wabaId = result.session.waba_id;
      if (!phoneNumberId || !wabaId) {
        toast.error(
          t('ai.social.whatsapp.esMissingAssets', {
            defaultValue: 'WhatsApp signup finished without a phone number. Try again.',
          }),
        );
        return;
      }
      await completeWhatsAppEs.mutateAsync({
        code: result.code,
        phoneNumberId,
        wabaId,
      });
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('ai.social.whatsapp.esFailed', { defaultValue: 'WhatsApp connect failed. Try again.' }),
      );
    }
  };

  // Embedded signup when the app is configured for it; manual credentials
  // modal otherwise.
  const handleWhatsAppButtonClick = () => {
    if (whatsappEsEnabled) {
      void handleConnectWhatsAppEmbedded();
      return;
    }
    setShowWhatsAppModal(true);
  };

  const handleConfirmDisconnect = async () => {
    if (!disconnectTarget) return;
    try {
      await disconnectMutation.mutateAsync(disconnectTarget);
      setDisconnectTarget(null);
    } catch {
      // error surfaced via the mutation's toast; keep dialog open to retry
    }
  };

  if (isLoading) {
    return <div className="p-6 text-zinc-400">{t('ai.social.loading')}</div>;
  }

  const connectionCount = connections?.length || 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('ai.social.header.title')}</h2>
        <p className="text-sm text-zinc-400">
          {t('ai.social.header.description')}
        </p>
      </div>

      {/* Meta OAuth page selection (shown after OAuth redirect) */}
      <MetaPageSelectionCard
        pages={metaPages}
        selectedPageIds={selectedPageIds}
        setSelectedPageIds={setSelectedPageIds}
        messengerEntitled={channelEntitled.messenger}
        instagramEntitled={channelEntitled.instagram}
        onConnect={handleConnectMetaPages}
        isConnecting={connectMeta.isPending}
        onCancel={() => setSearchParams({})}
      />

      {/* Connected channels list */}
      <Card variant="glass">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-medium text-white">{t('ai.social.connected.title')}</h3>
            <p className="text-xs text-zinc-400">
              {t('ai.social.connected.count', { count: connectionCount })}
            </p>
          </div>
          <ChannelConnectButtons
            metaGate={metaGate}
            whatsappGate={whatsappGate}
            lockedHint={lockedHint}
            offHint={offHint}
            onConnectFacebook={handleConnectFacebook}
            isFacebookPending={metaOAuthUrl.isPending}
            onConnectWhatsApp={handleWhatsAppButtonClick}
            isWhatsAppPending={completeWhatsAppEs.isPending}
          />
        </CardHeader>
        <CardContent>
          {!connections || connections.length === 0 ? (
            <div className="text-center py-8 text-zinc-500">
              <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">{t('ai.social.empty.title')}</p>
              <p className="text-xs mt-1">{t('ai.social.empty.description')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {connections.map((conn) => (
                <ConnectionRow
                  key={conn.id}
                  conn={conn}
                  channelEntitled={channelEntitled}
                  bots={bots}
                  checkingConnectionId={
                    healthCheckMutation.isPending ? healthCheckMutation.variables : undefined
                  }
                  isAutoCapturePending={updateAutoCapture.isPending}
                  onAutoCaptureChange={(connectionId, enabled) =>
                    updateAutoCapture.mutate({ connectionId, enabled })
                  }
                  onBotChange={(connectionId, botId) =>
                    updateChannelBot.mutate({ connectionId, botId })
                  }
                  onHealthCheck={(connectionId) => healthCheckMutation.mutate(connectionId)}
                  onDisconnect={setDisconnectTarget}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* WhatsApp connect modal */}
      <WhatsAppConnectModal
        open={showWhatsAppModal}
        onOpenChange={setShowWhatsAppModal}
        phoneNumberId={waPhoneNumberId}
        setPhoneNumberId={setWaPhoneNumberId}
        accessToken={waAccessToken}
        setAccessToken={setWaAccessToken}
        wabaId={waWabaId}
        setWabaId={setWaWabaId}
        isPending={connectWhatsApp.isPending}
        onConnect={handleConnectWhatsApp}
      />

      {/* Disconnect confirmation */}
      <DisconnectConfirmDialog
        target={disconnectTarget}
        isPending={disconnectMutation.isPending}
        onDismiss={() => setDisconnectTarget(null)}
        onConfirm={handleConfirmDisconnect}
      />
    </div>
  );
}

