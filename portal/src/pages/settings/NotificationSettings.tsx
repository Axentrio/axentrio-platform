/**
 * Notification Settings
 * Sound, desktop, and handoff notification preferences
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Volume2, VolumeX, Monitor } from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
import { useNotificationSound } from '@websocket/notificationSound';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';

const NotificationSettings: React.FC = () => {
  const { user } = useAppAuth();
  const { t } = useTranslation();
  const { isMuted, toggleMute, volume, setVolume } = useNotificationSound();
  const [desktopEnabled, setDesktopEnabled] = useState(user?.preferences?.notifications?.desktop ?? true);
  const [handsoffOnly, setHandsoffOnly] = useState(user?.preferences?.notifications?.handsoffOnly ?? false);

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
          {/* Sound notifications */}
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
            <Switch checked={!isMuted} onCheckedChange={() => toggleMute()} />
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
            <Switch checked={desktopEnabled} onCheckedChange={setDesktopEnabled} />
          </div>

          {/* Handoff only */}
          <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-surface-2 rounded-xl">
                <Bell className="w-5 h-5 text-primary-400" />
              </div>
              <div>
                <p className="font-medium text-text-primary">{t('settings.notifications.handsoffOnly.title')}</p>
                <p className="text-sm text-text-secondary">{t('settings.notifications.handsoffOnly.description')}</p>
              </div>
            </div>
            <Switch checked={handsoffOnly} onCheckedChange={setHandsoffOnly} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default NotificationSettings;
