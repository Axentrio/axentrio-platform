/**
 * SocialChannelsContent
 * Reusable connect/disconnect UI for Telegram + Meta channels.
 * Rendered by /settings/channels and the AI & Content "Social" tab.
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import {
  MessageSquare, Trash2, AlertCircle, RefreshCw, Loader2,
} from 'lucide-react';
import { SiTelegram, SiMessenger, SiInstagram, SiWhatsapp, SiFacebook } from 'react-icons/si';
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
  useConnectTelegram,
  useConnectWhatsApp,
  useMetaOAuthUrl,
  useMetaOAuthPages,
  useConnectMeta,
  useDisconnectChannel,
  useHealthCheckChannel,
  useUpdateChannelBot,
} from '../../queries/useChannelQueries';
import { useBots } from '@/queries/useBotsQueries';
import { timeAgo } from '@/utils/timeAgo';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  telegram: SiTelegram,
  messenger: SiMessenger,
  instagram: SiInstagram,
  whatsapp: SiWhatsapp,
};

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
};

// Brand tint for the channel icon tile.
const CHANNEL_COLORS: Record<string, string> = {
  telegram: 'bg-sky-500/15 text-sky-400',
  messenger: 'bg-blue-500/15 text-blue-400',
  instagram: 'bg-pink-500/15 text-pink-400',
  whatsapp: 'bg-emerald-500/15 text-emerald-400',
};

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

export function SocialChannelsContent() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: connections, isLoading } = useChannelConnections();
  const disconnectMutation = useDisconnectChannel();
  const healthCheckMutation = useHealthCheckChannel();
  const updateChannelBot = useUpdateChannelBot();
  const { data: botsData } = useBots();
  const bots = botsData?.bots ?? [];
  const metaOAuthUrl = useMetaOAuthUrl();
  const connectMeta = useConnectMeta();

  // Telegram connect state
  const [showTelegramModal, setShowTelegramModal] = useState(false);
  const [botToken, setBotToken] = useState('');
  const connectTelegram = useConnectTelegram();

  // WhatsApp connect state
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [waPhoneNumberId, setWaPhoneNumberId] = useState('');
  const [waAccessToken, setWaAccessToken] = useState('');
  const [waWabaId, setWaWabaId] = useState('');
  const connectWhatsApp = useConnectWhatsApp();

  // Meta OAuth page selection state
  const metaSetupToken = searchParams.get('meta_setup');
  const { data: metaPages } = useMetaOAuthPages(metaSetupToken);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);

  // Disconnect confirmation
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);

  // Handle Meta page selection
  useEffect(() => {
    if (metaPages && metaPages.length > 0) {
      setSelectedPageIds(metaPages.map((p: Any) => p.id));
    }
  }, [metaPages]);

  const handleConnectFacebook = async () => {
    const url = await metaOAuthUrl.mutateAsync();
    if (url) window.location.href = url;
  };

  const handleConnectMetaPages = async () => {
    if (!metaSetupToken || selectedPageIds.length === 0) return;
    await connectMeta.mutateAsync({ pageIds: selectedPageIds, sessionToken: metaSetupToken });
    setSearchParams({});
  };

  const handleConnectTelegram = async () => {
    if (!botToken.trim()) return;
    await connectTelegram.mutateAsync({ botToken: botToken.trim() });
    setBotToken('');
    setShowTelegramModal(false);
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
      {metaPages && metaPages.length > 0 && (
        <Card variant="glass">
          <CardHeader>
            <h3 className="text-sm font-medium text-white">{t('ai.social.metaPages.title')}</h3>
            <p className="text-xs text-zinc-400">{t('ai.social.metaPages.description')}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {metaPages.map((page: Any) => (
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
                {page.instagramAccount && (
                  <Badge variant="outline" className="text-xs">
                    <SiInstagram className="h-3 w-3 mr-1" />
                    @{page.instagramAccount.username}
                  </Badge>
                )}
              </label>
            ))}
            <div className="flex gap-2 pt-2">
              <Button onClick={handleConnectMetaPages} disabled={selectedPageIds.length === 0 || connectMeta.isPending}>
                {connectMeta.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {connectMeta.isPending ? t('ai.social.metaPages.connecting') : t('ai.social.metaPages.connectSelected')}
              </Button>
              <Button variant="ghost" onClick={() => setSearchParams({})}>{t('common.cancel')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Connected channels list */}
      <Card variant="glass">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-white">{t('ai.social.connected.title')}</h3>
            <p className="text-xs text-zinc-400">
              {t('ai.social.connected.count', { count: connectionCount })}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowTelegramModal(true)}>
              <SiTelegram className="h-4 w-4 mr-1" /> {t('ai.social.telegram.title')}
            </Button>
            <Button size="sm" variant="outline" onClick={handleConnectFacebook} disabled={metaOAuthUrl.isPending}>
              {metaOAuthUrl.isPending
                ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                : <SiFacebook className="h-4 w-4 mr-1" />}
              {metaOAuthUrl.isPending
                ? t('ai.social.facebook.connecting', { defaultValue: 'Connecting…' })
                : t('ai.social.facebook.title')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowWhatsAppModal(true)}>
              <SiWhatsapp className="h-4 w-4 mr-1" /> {t('ai.social.whatsapp.title', { defaultValue: 'WhatsApp' })}
            </Button>
          </div>
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
              {connections.map((conn) => {
                const Icon = CHANNEL_ICONS[conn.channel] || MessageSquare;
                const activityParts: string[] = [];
                if (conn.lastInboundAt) activityParts.push(t('ai.social.activity.received', { time: timeAgo(conn.lastInboundAt) }));
                if (conn.lastOutboundAt) activityParts.push(t('ai.social.activity.sent', { time: timeAgo(conn.lastOutboundAt) }));
                const checkingThis =
                  healthCheckMutation.isPending && healthCheckMutation.variables === conn.id;
                return (
                  <div
                    key={conn.id}
                    className="group flex items-center justify-between gap-3 p-3 rounded-lg bg-white/5 hover:bg-white/[0.07] transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${CHANNEL_COLORS[conn.channel] || 'bg-white/10 text-zinc-400'}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate">
                          {conn.label || conn.platformAccountId}
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
                    <div className="flex items-center gap-3 shrink-0">
                      {conn.channel !== 'widget' && (
                        <Select
                          value={conn.botId ?? '__default__'}
                          onValueChange={(v) =>
                            updateChannelBot.mutate({
                              connectionId: conn.id,
                              botId: v === '__default__' ? null : v,
                            })
                          }
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
                        <span className="text-xs text-red-400 max-w-[200px] truncate" title={conn.lastError}>
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
                      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
                        <Button
                          size="sm"
                          variant="ghost"
                          title={t('ai.social.actions.checkHealth')}
                          disabled={checkingThis}
                          onClick={() => healthCheckMutation.mutate(conn.id)}
                        >
                          <RefreshCw className={`h-4 w-4 ${checkingThis ? 'animate-spin' : ''}`} />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-400 hover:text-red-300"
                          onClick={() => setDisconnectTarget(conn.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Telegram connect modal */}
      <AlertDialog open={showTelegramModal} onOpenChange={setShowTelegramModal}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ai.social.telegram.modal.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ai.social.telegram.modal.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <details className="mt-2 rounded-lg bg-white/5 px-3 py-2 text-xs text-zinc-400">
            <summary className="cursor-pointer select-none text-zinc-300">
              {t('ai.social.telegram.modal.help.summary')}
            </summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>
                {t('ai.social.telegram.modal.help.step1.prefix')}{' '}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-400 underline"
                >
                  @BotFather
                </a>
                {t('ai.social.telegram.modal.help.step1.suffix')}
              </li>
              <li>
                {t('ai.social.telegram.modal.help.step2.prefix')}{' '}
                <code className="rounded bg-white/10 px-1">/newbot</code>{' '}
                {t('ai.social.telegram.modal.help.step2.suffix')}
              </li>
              <li>
                {t('ai.social.telegram.modal.help.step3.prefix')}{' '}
                <code className="rounded bg-white/10 px-1">123456:ABC-DEF...</code>
                {t('ai.social.telegram.modal.help.step3.suffix')}
              </li>
              <li>{t('ai.social.telegram.modal.help.step4')}</li>
            </ol>
          </details>
          <div className="py-4">
            <Label htmlFor="botToken">{t('ai.social.telegram.modal.tokenLabel')}</Label>
            <Input
              id="botToken"
              type="password"
              placeholder="123456:ABC-DEF..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleConnectTelegram(); }}
              disabled={!botToken.trim() || connectTelegram.isPending}
            >
              {connectTelegram.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {connectTelegram.isPending ? t('ai.social.telegram.modal.connecting') : t('ai.social.telegram.modal.connect')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* WhatsApp connect modal */}
      <AlertDialog open={showWhatsAppModal} onOpenChange={setShowWhatsAppModal}>
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
                value={waPhoneNumberId}
                onChange={(e) => setWaPhoneNumberId(e.target.value)}
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
                value={waAccessToken}
                onChange={(e) => setWaAccessToken(e.target.value)}
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
                value={waWabaId}
                onChange={(e) => setWaWabaId(e.target.value)}
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleConnectWhatsApp(); }}
              disabled={!waPhoneNumberId.trim() || !waAccessToken.trim() || connectWhatsApp.isPending}
            >
              {connectWhatsApp.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {connectWhatsApp.isPending
                ? t('ai.social.whatsapp.modal.connecting', { defaultValue: 'Connecting…' })
                : t('ai.social.whatsapp.modal.connect', { defaultValue: 'Connect' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Disconnect confirmation */}
      <AlertDialog
        open={!!disconnectTarget}
        onOpenChange={(open) => { if (!open && !disconnectMutation.isPending) setDisconnectTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ai.social.disconnect.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ai.social.disconnect.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnectMutation.isPending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={disconnectMutation.isPending}
              onClick={async (e) => {
                e.preventDefault();
                if (!disconnectTarget) return;
                try {
                  await disconnectMutation.mutateAsync(disconnectTarget);
                  setDisconnectTarget(null);
                } catch {
                  // error surfaced via the mutation's toast; keep dialog open to retry
                }
              }}
            >
              {disconnectMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {disconnectMutation.isPending
                ? t('ai.social.disconnect.disconnecting', { defaultValue: 'Disconnecting…' })
                : t('ai.social.disconnect.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

