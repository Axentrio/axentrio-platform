/**
 * SocialChannelsContent
 * Reusable connect/disconnect UI for Telegram + Meta channels.
 * Rendered by /settings/channels and the AI & Content "Social" tab.
 */

import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, Bot, MessageCircle, Camera, Trash2, AlertCircle } from 'lucide-react';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  useMetaOAuthUrl,
  useMetaOAuthPages,
  useConnectMeta,
  useDisconnectChannel,
} from '../../queries/useChannelQueries';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  telegram: Bot,
  messenger: MessageCircle,
  instagram: Camera,
};

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  messenger: 'Messenger',
  instagram: 'Instagram',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  error: 'bg-red-500/10 text-red-400 border-red-500/20',
  disconnected: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  pending_setup: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

export function SocialChannelsContent() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: connections, isLoading } = useChannelConnections();
  const disconnectMutation = useDisconnectChannel();
  const metaOAuthUrl = useMetaOAuthUrl();
  const connectMeta = useConnectMeta();

  // Telegram connect state
  const [showTelegramModal, setShowTelegramModal] = useState(false);
  const [botToken, setBotToken] = useState('');
  const connectTelegram = useConnectTelegram();

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

  if (isLoading) {
    return <div className="p-6 text-zinc-400">Loading channels...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Channels</h2>
        <p className="text-sm text-zinc-400">
          Connect messaging platforms to receive and respond to customer messages.
        </p>
      </div>

      {/* Meta OAuth page selection (shown after OAuth redirect) */}
      {metaPages && metaPages.length > 0 && (
        <Card variant="glass">
          <CardHeader>
            <h3 className="text-sm font-medium text-white">Select Pages to Connect</h3>
            <p className="text-xs text-zinc-400">Choose which Facebook Pages to connect for messaging.</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {metaPages.map((page: Any) => (
              <label key={page.id} className="flex items-center gap-3 p-2 rounded hover:bg-white/5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedPageIds.includes(page.id)}
                  onChange={(e) => {
                    setSelectedPageIds((prev) =>
                      e.target.checked ? [...prev, page.id] : prev.filter((id: string) => id !== page.id),
                    );
                  }}
                  className="rounded border-zinc-600"
                />
                <span className="text-sm text-white">{page.name}</span>
                {page.instagramAccount && (
                  <Badge variant="outline" className="text-xs">
                    <Camera className="h-3 w-3 mr-1" />
                    @{page.instagramAccount.username}
                  </Badge>
                )}
              </label>
            ))}
            <div className="flex gap-2 pt-2">
              <Button onClick={handleConnectMetaPages} disabled={selectedPageIds.length === 0 || connectMeta.isPending}>
                {connectMeta.isPending ? 'Connecting...' : 'Connect Selected'}
              </Button>
              <Button variant="ghost" onClick={() => setSearchParams({})}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Connected channels list */}
      <Card variant="glass">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-white">Connected Channels</h3>
            <p className="text-xs text-zinc-400">
              {connections?.length || 0} channel{connections?.length !== 1 ? 's' : ''} connected
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowTelegramModal(true)}>
              <Bot className="h-4 w-4 mr-1" /> Telegram
            </Button>
            <Button size="sm" variant="outline" onClick={handleConnectFacebook} disabled={metaOAuthUrl.isPending}>
              <MessageCircle className="h-4 w-4 mr-1" /> Facebook
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!connections || connections.length === 0 ? (
            <div className="text-center py-8 text-zinc-500">
              <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No channels connected yet.</p>
              <p className="text-xs mt-1">Connect a Telegram bot or Facebook Page to get started.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {connections.map((conn) => {
                const Icon = CHANNEL_ICONS[conn.channel] || MessageSquare;
                return (
                  <div
                    key={conn.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-white/5 hover:bg-white/[0.07] transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Icon className="h-5 w-5 text-zinc-400" />
                      <div>
                        <p className="text-sm font-medium text-white">
                          {conn.label || conn.platformAccountId}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {CHANNEL_LABELS[conn.channel] || conn.channel}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {conn.lastError && (
                        <span className="text-xs text-red-400 max-w-[200px] truncate" title={conn.lastError}>
                          <AlertCircle className="h-3 w-3 inline mr-1" />
                          {conn.lastError}
                        </span>
                      )}
                      <Badge variant="outline" className={STATUS_COLORS[conn.status] || ''}>
                        {conn.status}
                      </Badge>
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
            <AlertDialogTitle>Connect Telegram Bot</AlertDialogTitle>
            <AlertDialogDescription>
              Enter your bot token from @BotFather to connect a Telegram bot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="botToken">Bot Token</Label>
            <Input
              id="botToken"
              type="password"
              placeholder="123456:ABC-DEF..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConnectTelegram} disabled={!botToken.trim() || connectTelegram.isPending}>
              {connectTelegram.isPending ? 'Connecting...' : 'Connect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Disconnect confirmation */}
      <AlertDialog open={!!disconnectTarget} onOpenChange={() => setDisconnectTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Channel</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop receiving messages from this channel. You can reconnect it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (disconnectTarget) {
                  disconnectMutation.mutate(disconnectTarget);
                  setDisconnectTarget(null);
                }
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default SocialChannelsContent;
