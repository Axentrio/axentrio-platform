/**
 * Notification Settings
 * Sound, desktop, channel, and event notification preferences
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Volume2, VolumeX, Monitor, Save, Loader2 } from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
import { api } from '@services/apiClient';
import { ENDPOINTS } from '@config/api.config';
import { useNotificationSound } from '@websocket/notificationSound';
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '@contracts/notification-preferences';
import { isDesktopNotificationsEnabled, setDesktopNotificationsEnabled } from '@utils/desktopNotificationPref';
import { toast } from 'sonner';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';

type ResolvedNotificationPreferences = Required<NotificationPreferences>;

interface NotificationPreferencesResponse {
  preferences: NotificationPreferences;
}

const NotificationSettings: React.FC = () => {
  const { notificationPreferences: serverPrefs, setNotificationPreferences } = useAppAuth();
  const { t } = useTranslation();
  const { isMuted, setMuted, volume, setVolume } = useNotificationSound();
  const [prefs, setPrefs] = useState<ResolvedNotificationPreferences>(() => serverPrefs);
  const [savedPrefs, setSavedPrefs] = useState<ResolvedNotificationPreferences>(() => serverPrefs);
  const [desktopEnabled, setDesktopEnabled] = useState(() => isDesktopNotificationsEnabled());
  const [isSaving, setIsSaving] = useState(false);

  const isDirty = JSON.stringify(prefs) !== JSON.stringify(savedPrefs);

  const handleDesktopNotificationsChange = async (enabled: boolean) => {
    if (!enabled) {
      setDesktopNotificationsEnabled(false);
      setDesktopEnabled(false);
      return;
    }

    if (!('Notification' in window)) {
      toast.error(t('settings.notifications.desktop.permissionDenied'));
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        setDesktopNotificationsEnabled(true);
        setDesktopEnabled(true);
      } else {
        toast.error(t('settings.notifications.desktop.permissionDenied'));
      }
    } catch {
      toast.error(t('settings.notifications.desktop.permissionDenied'));
    }
  };

  const handleSave = async () => {
    if (!isDirty || isSaving) return;

    setIsSaving(true);
    try {
      const response = await api.patch<NotificationPreferencesResponse>(ENDPOINTS.users.preferences, {
        notificationPreferences: prefs,
      });
      const foldedPreferences: ResolvedNotificationPreferences = {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        ...(response.preferences ?? {}),
      };
      setPrefs(foldedPreferences);
      setSavedPrefs(foldedPreferences);
      setNotificationPreferences(foldedPreferences);
      toast.success(t('common.saved'));
    } catch {
      toast.error(t('settings.notifications.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card variant="glass">
      <CardHeader>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <Bell className="w-5 h-5" />
          {t('settings.notifications.title')}
        </h2>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {/* Channels: sound, platform, and email */}
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-surface-2 rounded-xl">
                  {isMuted ? <VolumeX className="w-5 h-5 text-text-secondary" /> : <Volume2 className="w-5 h-5 text-primary-400" />}
                </div>
                <div>
                  <p className="font-medium text-text-primary">{t('settings.notifications.sound.title')}</p>
                  <p className="text-sm text-text-secondary">{t('settings.notifications.sound.description')}</p>
                </div>
              </div>
              <Switch
                aria-label={t('settings.notifications.sound.title')}
                checked={prefs.sound}
                onCheckedChange={(checked) => {
                  setPrefs((previous) => ({ ...previous, sound: checked }));
                  setMuted(!checked);
                }}
              />
            </div>

            {/* Volume slider */}
            {!isMuted && (
              <div className="p-4 bg-surface-3 rounded-xl">
                <Label className="text-text-secondary mb-2 block">{t('settings.notifications.volume')}</Label>
                <Slider
                  min={0}
                  max={1}
                  step={0.1}
                  value={[volume]}
                  onValueChange={([v]) => setVolume(v)}
                />
                <p className="text-sm text-text-muted mt-1">{Math.round(volume * 100)}%</p>
              </div>
            )}

            <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
              <div>
                <p className="font-medium text-text-primary">{t('settings.notifications.platform.title')}</p>
                <p className="text-sm text-text-secondary">{t('settings.notifications.platform.description')}</p>
              </div>
              <Switch
                aria-label={t('settings.notifications.platform.title')}
                checked={prefs.push}
                onCheckedChange={(checked) => setPrefs((previous) => ({ ...previous, push: checked }))}
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
              <div>
                <p className="font-medium text-text-primary">{t('settings.notifications.email.title')}</p>
                <p className="text-sm text-text-secondary">{t('settings.notifications.email.description')}</p>
              </div>
              <Switch
                aria-label={t('settings.notifications.email.title')}
                checked={prefs.email}
                onCheckedChange={(checked) => setPrefs((previous) => ({ ...previous, email: checked }))}
              />
            </div>
          </div>

          {/* Events: handoff requests and new messages */}
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-surface-2 rounded-xl">
                  <Bell className="w-5 h-5 text-primary-400" />
                </div>
                <div>
                  <p className="font-medium text-text-primary">{t('settings.notifications.handoffRequest.title')}</p>
                  <p className="text-sm text-text-secondary">{t('settings.notifications.handoffRequest.description')}</p>
                </div>
              </div>
              <Switch
                aria-label={t('settings.notifications.handoffRequest.title')}
                checked={prefs.handoffRequest}
                onCheckedChange={(checked) => setPrefs((previous) => ({ ...previous, handoffRequest: checked }))}
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
              <div>
                <p className="font-medium text-text-primary">{t('settings.notifications.newMessage.title')}</p>
                <p className="text-sm text-text-secondary">{t('settings.notifications.newMessage.description')}</p>
              </div>
              <Switch
                aria-label={t('settings.notifications.newMessage.title')}
                checked={prefs.newMessage}
                onCheckedChange={(checked) => setPrefs((previous) => ({ ...previous, newMessage: checked }))}
              />
            </div>
          </div>

          {/* Desktop notifications */}
          <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-surface-2 rounded-xl">
                <Monitor className="w-5 h-5 text-primary-400" />
              </div>
              <div>
                <p className="font-medium text-text-primary">{t('settings.notifications.desktop.title')}</p>
                <p className="text-sm text-text-secondary">{t('settings.notifications.desktop.description')}</p>
              </div>
            </div>
            <Switch
              aria-label={t('settings.notifications.desktop.title')}
              checked={desktopEnabled}
              onCheckedChange={(enabled) => void handleDesktopNotificationsChange(enabled)}
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={!isDirty || isSaving}>
              {isSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {t('common.save')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default NotificationSettings;
