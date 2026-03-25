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
  Copy,
  RotateCw,
  CheckCircle,
  XCircle,
  Minus,
  ExternalLink,
  Key,
  Webhook,
  Shield,
} from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
import { useNotificationSound } from '@websocket/notificationSound';
import { useQuery } from '@tanstack/react-query';
import { api } from '@services/apiClient';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
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

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

interface TenantData {
  apiKey?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  [key: string]: unknown;
}

function maskSecret(value: string | undefined): string {
  if (!value) return '---';
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  } catch {
    toast.error('Failed to copy to clipboard');
  }
}

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

  // Password form state
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  // Notification preferences
  const [notificationPrefs, setNotificationPrefs] = useState({
    sound: user?.preferences?.notifications?.sound ?? true,
    desktop: user?.preferences?.notifications?.desktop ?? true,
    handsoffOnly: user?.preferences?.notifications?.handsoffOnly ?? false,
  });

  // Appearance preferences
  const [theme, setTheme] = useState(user?.preferences?.theme || 'system');

  // Integration state
  const { data: tenantData, refetch: refetchTenant } = useQuery<TenantData>({
    queryKey: ['tenant-me'],
    queryFn: () => api.get<TenantData>('/v1/tenants/me'),
    enabled: activeTab === 'integration',
  });

  const [webhookUrlInput, setWebhookUrlInput] = useState('');
  const [webhookUrlInitialized, setWebhookUrlInitialized] = useState(false);
  const [isRotatingKey, setIsRotatingKey] = useState(false);
  const [isSavingWebhook, setIsSavingWebhook] = useState(false);
  const [isTestingWebhook, setIsTestingWebhook] = useState(false);
  const [isRegeneratingSecret, setIsRegeneratingSecret] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [webhookTestStatus, setWebhookTestStatus] = useState<'idle' | 'success' | 'failed'>('idle');
  const [webhookResponseTime, setWebhookResponseTime] = useState<number | null>(null);

  // Sync webhook URL input from tenant data
  if (tenantData?.webhookUrl && !webhookUrlInitialized) {
    setWebhookUrlInput(tenantData.webhookUrl);
    setWebhookUrlInitialized(true);
  }

  const handleRotateApiKey = async () => {
    setIsRotatingKey(true);
    try {
      await api.post('/v1/tenants/me/api-key/rotate');
      await refetchTenant();
      toast.success('API key rotated successfully');
    } catch {
      toast.error('Failed to rotate API key');
    } finally {
      setIsRotatingKey(false);
      setShowRotateConfirm(false);
    }
  };

  const handleSaveWebhookUrl = async () => {
    setIsSavingWebhook(true);
    try {
      await api.patch('/v1/tenants/me', { webhookUrl: webhookUrlInput });
      await refetchTenant();
      toast.success('Webhook URL saved');
    } catch {
      toast.error('Failed to save webhook URL');
    } finally {
      setIsSavingWebhook(false);
    }
  };

  const handleTestWebhook = async () => {
    setIsTestingWebhook(true);
    setWebhookTestStatus('idle');
    setWebhookResponseTime(null);
    const start = Date.now();
    try {
      await api.post('/v1/tenants/me/webhook-test');
      const elapsed = Date.now() - start;
      setWebhookTestStatus('success');
      setWebhookResponseTime(elapsed);
      toast.success(`Webhook connected (${elapsed}ms)`);
    } catch {
      setWebhookTestStatus('failed');
      toast.error('Webhook test failed');
    } finally {
      setIsTestingWebhook(false);
    }
  };

  const handleRegenerateSecret = async () => {
    setIsRegeneratingSecret(true);
    try {
      await api.post('/v1/tenants/me/webhook-secret/regenerate');
      await refetchTenant();
      toast.success('Webhook secret regenerated');
    } catch {
      toast.error('Failed to regenerate webhook secret');
    } finally {
      setIsRegeneratingSecret(false);
      setShowRegenerateConfirm(false);
    }
  };

  const handleSaveProfile = async () => {
    setIsSaving(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Profile is managed by Clerk — update via Clerk dashboard
    setIsSaving(false);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleSavePassword = async () => {
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    setIsSaving(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setIsSaving(false);
    setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
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

  const inboundWebhookUrl = `${API_URL}/v1/n8n/webhook/inbound`;

  const webhookStatusIcon = () => {
    if (!tenantData?.webhookUrl) {
      return <Minus className="w-5 h-5 text-text-muted" />;
    }
    if (webhookTestStatus === 'success') {
      return <CheckCircle className="w-5 h-5 text-status-online" />;
    }
    if (webhookTestStatus === 'failed') {
      return <XCircle className="w-5 h-5 text-red-500" />;
    }
    return <Minus className="w-5 h-5 text-text-muted" />;
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
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="lastName" className="text-text-secondary">Last Name</Label>
                      <Input
                        id="lastName"
                        type="text"
                        value={profileData.lastName}
                        onChange={(e) => setProfileData({ ...profileData, lastName: e.target.value })}
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
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Save Changes
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Change Password */}
            <Card variant="glass">
              <CardHeader>
                <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                  <Lock className="w-5 h-5" />
                  Change Password
                </h2>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-1">
                    <Label htmlFor="currentPassword" className="text-text-secondary">Current Password</Label>
                    <Input
                      id="currentPassword"
                      type="password"
                      value={passwordData.currentPassword}
                      onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="newPassword" className="text-text-secondary">New Password</Label>
                    <Input
                      id="newPassword"
                      type="password"
                      value={passwordData.newPassword}
                      onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="confirmPassword" className="text-text-secondary">Confirm New Password</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      value={passwordData.confirmPassword}
                      onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      onClick={handleSavePassword}
                      disabled={isSaving || !passwordData.currentPassword || !passwordData.newPassword}
                    >
                      {isSaving ? (
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Update Password
                    </Button>
                  </div>
                </div>
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
          <div className="space-y-6">
            {/* API Key */}
            <Card variant="glass">
              <CardHeader>
                <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                  <Key className="w-5 h-5" />
                  API Key
                </h2>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <Label className="text-text-secondary mb-1 block">Your API Key</Label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm">
                        {maskSecret(tenantData?.apiKey)}
                      </code>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => tenantData?.apiKey && copyToClipboard(tenantData.apiKey, 'API key')}
                        disabled={!tenantData?.apiKey}
                        title="Copy API key"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setShowRotateConfirm(true)}
                        disabled={isRotatingKey}
                        title="Rotate API key"
                      >
                        <RotateCw className={cn("w-4 h-4", isRotatingKey && "animate-spin")} />
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* n8n Webhook URL */}
            <Card variant="glass">
              <CardHeader>
                <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                  <Webhook className="w-5 h-5" />
                  n8n Webhook URL
                </h2>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <Label className="text-text-secondary mb-1 block">Webhook URL</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="text"
                        value={webhookUrlInput}
                        onChange={(e) => setWebhookUrlInput(e.target.value)}
                        placeholder="https://your-n8n-instance.com/webhook/..."
                        className="flex-1 font-mono text-sm"
                      />
                      <span title={
                        webhookTestStatus === 'success' ? 'Connected' :
                        webhookTestStatus === 'failed' ? 'Connection failed' :
                        'Not tested'
                      }>
                        {webhookStatusIcon()}
                      </span>
                    </div>
                    {webhookTestStatus === 'success' && webhookResponseTime !== null && (
                      <p className="text-xs text-status-online mt-1">Response time: {webhookResponseTime}ms</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 justify-end">
                    <Button
                      variant="outline"
                      onClick={handleTestWebhook}
                      disabled={isTestingWebhook || !webhookUrlInput}
                    >
                      {isTestingWebhook ? (
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-secondary" />
                      ) : (
                        <ExternalLink className="w-4 h-4" />
                      )}
                      Test Connection
                    </Button>
                    <Button
                      onClick={handleSaveWebhookUrl}
                      disabled={isSavingWebhook}
                    >
                      {isSavingWebhook ? (
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Save
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Inbound Webhook Endpoint */}
            <Card variant="glass">
              <CardHeader>
                <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                  <ExternalLink className="w-5 h-5" />
                  Inbound Webhook Endpoint
                </h2>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <Label className="text-text-secondary mb-1 block">Endpoint URL (read-only)</Label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm">
                        {inboundWebhookUrl}
                      </code>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => copyToClipboard(inboundWebhookUrl, 'Inbound webhook URL')}
                        title="Copy URL"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-text-muted mt-2">
                      Configure your n8n workflow to send responses to this URL. Include your tenant ID in the request body.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Webhook Secret */}
            <Card variant="glass">
              <CardHeader>
                <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                  <Shield className="w-5 h-5" />
                  Webhook Secret
                </h2>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <Label className="text-text-secondary mb-1 block">Secret Key</Label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm">
                        {maskSecret(tenantData?.webhookSecret)}
                      </code>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => tenantData?.webhookSecret && copyToClipboard(tenantData.webhookSecret, 'Webhook secret')}
                        disabled={!tenantData?.webhookSecret}
                        title="Copy webhook secret"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setShowRegenerateConfirm(true)}
                        disabled={isRegeneratingSecret}
                        title="Regenerate webhook secret"
                      >
                        <RotateCw className={cn("w-4 h-4", isRegeneratingSecret && "animate-spin")} />
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Rotate API Key Confirmation Dialog */}
      <AlertDialog open={showRotateConfirm} onOpenChange={setShowRotateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate API Key?</AlertDialogTitle>
            <AlertDialogDescription>
              This will invalidate your current API key immediately. Any integrations using the old key will stop working. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRotateApiKey}
              disabled={isRotatingKey}
              className={cn(
                "bg-red-600 text-white hover:bg-red-500",
                isRotatingKey && "opacity-50 pointer-events-none"
              )}
            >
              {isRotatingKey ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              ) : (
                <RotateCw className="w-4 h-4" />
              )}
              Rotate Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Regenerate Webhook Secret Confirmation Dialog */}
      <AlertDialog open={showRegenerateConfirm} onOpenChange={setShowRegenerateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate Webhook Secret?</AlertDialogTitle>
            <AlertDialogDescription>
              This will invalidate your current webhook secret immediately. You will need to update the secret in your n8n workflows. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRegenerateSecret}
              disabled={isRegeneratingSecret}
              className={cn(
                "bg-red-600 text-white hover:bg-red-500",
                isRegeneratingSecret && "opacity-50 pointer-events-none"
              )}
            >
              {isRegeneratingSecret ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              ) : (
                <RotateCw className="w-4 h-4" />
              )}
              Regenerate Secret
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Settings;
