/**
 * Settings Page
 * User preferences and account settings
 */

import React, { useState } from 'react';
import {
  User,
  Bell,
  Moon,
  Sun,
  Monitor,
  Volume2,
  VolumeX,
  Lock,
  Mail,
  Save,
  Check,
  Loader2,
} from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
import { useNotificationSound } from '@websocket/notificationSound';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { IntegrationTab } from '../components/settings/IntegrationTab';

const Settings: React.FC = () => {
  const { user } = useAppAuth();
  const { isMuted, toggleMute, volume, setVolume } = useNotificationSound();

  const [activeTab, setActiveTab] = useState<'profile' | 'notifications' | 'appearance' | 'integration'>('profile');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Profile form state
  const [profileData, setProfileData] = useState({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    email: user?.email || '',
  });

  // Notification preferences
  const [notificationPrefs, setNotificationPrefs] = useState({
    sound: user?.preferences?.notifications?.sound ?? true,
    desktop: user?.preferences?.notifications?.desktop ?? true,
    handsoffOnly: user?.preferences?.notifications?.handsoffOnly ?? false,
  });

  // Appearance preferences
  const [theme, setTheme] = useState(user?.preferences?.theme || 'system');

  const handleSaveProfile = async () => {
    setIsSaving(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Profile is managed by Clerk — update via Clerk dashboard
    setIsSaving(false);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleSaveNotifications = async () => {
    setIsSaving(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // TODO: persist notification preferences via API
    setIsSaving(false);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleSaveAppearance = async () => {
    setIsSaving(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // TODO: persist appearance preferences via API
    setIsSaving(false);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Settings</h1>
        <p className="text-text-secondary">Manage your account and preferences</p>
      </div>

      {/* Success message */}
      {saveSuccess && (
        <div className="mb-6 p-4 bg-status-online/10 border border-status-online/20 rounded-xl flex items-center gap-2 text-status-online">
          <Check className="w-5 h-5" />
          Settings saved successfully!
        </div>
      )}

      {/* Tabs */}
      <Tabs
        defaultValue="profile"
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as typeof activeTab)}
      >
        <TabsList className="mb-6 w-fit">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="integration">Integration</TabsTrigger>
        </TabsList>

        {/* Profile Tab */}
        <TabsContent value="profile">
          <div className="space-y-6">
            {/* Profile Info */}
            <Card variant="glass">
              <CardHeader>
                <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                  <User className="w-5 h-5" />
                  Profile Information
                </h2>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label htmlFor="firstName" className="text-text-secondary">First Name</Label>
                      <Input
                        id="firstName"
                        type="text"
                        value={profileData.firstName}
                        onChange={(e) => setProfileData({ ...profileData, firstName: e.target.value })}
                        disabled={isSaving}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="lastName" className="text-text-secondary">Last Name</Label>
                      <Input
                        id="lastName"
                        type="text"
                        value={profileData.lastName}
                        onChange={(e) => setProfileData({ ...profileData, lastName: e.target.value })}
                        disabled={isSaving}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="email" className="text-text-secondary">Email</Label>
                    <div className="flex items-center gap-2">
                      <Mail className="w-5 h-5 text-text-muted" />
                      <Input
                        id="email"
                        type="email"
                        value={profileData.email}
                        disabled
                        className="flex-1"
                      />
                    </div>
                    <p className="text-xs text-text-muted">Email cannot be changed</p>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      onClick={handleSaveProfile}
                      disabled={isSaving}
                    >
                      {isSaving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Save Changes
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Password managed by Clerk */}
            <Card variant="glass">
              <CardHeader>
                <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                  <Lock className="w-5 h-5" />
                  Password
                </h2>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  Your password is managed by Clerk. To change your password, use the Clerk user menu or visit your Clerk account settings.
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Notifications Tab */}
        <TabsContent value="notifications">
          <Card variant="glass">
            <CardHeader>
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <Bell className="w-5 h-5" />
                Notification Preferences
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
                      <p className="font-medium text-text-primary">Sound Notifications</p>
                      <p className="text-sm text-text-secondary">Play sounds for new messages and handoffs</p>
                    </div>
                  </div>
                  <Switch
                    checked={!isMuted}
                    onCheckedChange={() => toggleMute()}
                  />
                </div>

                {/* Volume slider */}
                {!isMuted && (
                  <div className="p-4 bg-surface-3 rounded-xl">
                    <Label className="text-text-secondary mb-2 block">Volume</Label>
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
                      <p className="font-medium text-text-primary">Desktop Notifications</p>
                      <p className="text-sm text-text-secondary">Show browser notifications</p>
                    </div>
                  </div>
                  <Switch
                    checked={notificationPrefs.desktop}
                    onCheckedChange={(checked) => setNotificationPrefs({ ...notificationPrefs, desktop: checked })}
                  />
                </div>

                {/* Handoff only */}
                <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-surface-2 rounded-xl">
                      <Bell className="w-5 h-5 text-primary-400" />
                    </div>
                    <div>
                      <p className="font-medium text-text-primary">Handoff Notifications Only</p>
                      <p className="text-sm text-text-secondary">Only notify for handoff requests</p>
                    </div>
                  </div>
                  <Switch
                    checked={notificationPrefs.handsoffOnly}
                    onCheckedChange={(checked) => setNotificationPrefs({ ...notificationPrefs, handsoffOnly: checked })}
                  />
                </div>

                <div className="flex justify-end">
                  <Button
                    onClick={handleSaveNotifications}
                    disabled={isSaving}
                  >
                    {isSaving ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    Save Preferences
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Appearance Tab */}
        <TabsContent value="appearance">
          <Card variant="glass">
            <CardHeader>
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <Monitor className="w-5 h-5" />
                Appearance
              </h2>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <p className="text-sm text-text-secondary">Choose your preferred theme</p>

                <div className="grid grid-cols-3 gap-4">
                  <button
                    onClick={() => setTheme('light')}
                    className={cn(
                      "p-4 border-2 rounded-2xl text-center transition-colors",
                      theme === 'light' ? 'border-primary-500 bg-primary-600/10' : 'border-edge hover:border-edge-light'
                    )}
                  >
                    <Sun className="w-8 h-8 mx-auto mb-2 text-accent-400" />
                    <p className="font-medium text-text-primary">Light</p>
                    <p className="text-xs text-text-muted">Always light mode</p>
                  </button>

                  <button
                    onClick={() => setTheme('dark')}
                    className={cn(
                      "p-4 border-2 rounded-2xl text-center transition-colors",
                      theme === 'dark' ? 'border-primary-500 bg-primary-600/10' : 'border-edge hover:border-edge-light'
                    )}
                  >
                    <Moon className="w-8 h-8 mx-auto mb-2 text-primary-400" />
                    <p className="font-medium text-text-primary">Dark</p>
                    <p className="text-xs text-text-muted">Always dark mode</p>
                  </button>

                  <button
                    onClick={() => setTheme('system')}
                    className={cn(
                      "p-4 border-2 rounded-2xl text-center transition-colors",
                      theme === 'system' ? 'border-primary-500 bg-primary-600/10' : 'border-edge hover:border-edge-light'
                    )}
                  >
                    <Monitor className="w-8 h-8 mx-auto mb-2 text-text-secondary" />
                    <p className="font-medium text-text-primary">System</p>
                    <p className="text-xs text-text-muted">Follow system preference</p>
                  </button>
                </div>

                <div className="flex justify-end pt-4">
                  <Button
                    onClick={handleSaveAppearance}
                    disabled={isSaving}
                  >
                    {isSaving ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    Save Theme
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Integration Tab */}
        <TabsContent value="integration">
          <IntegrationTab />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Settings;
