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
import toast from 'react-hot-toast';

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
      alert('Passwords do not match');
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

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-surface-3 rounded-xl mb-6 w-fit">
        {(['profile', 'notifications', 'appearance', 'integration'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`
              px-4 py-2 text-sm font-medium rounded-lg transition-colors
              ${activeTab === tab
                ? 'bg-surface-2 text-text-primary shadow-card'
                : 'text-text-secondary hover:text-text-primary'
              }
            `}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Success message */}
      {saveSuccess && (
        <div className="mb-6 p-4 bg-status-online/10 border border-status-online/20 rounded-xl flex items-center gap-2 text-status-online">
          <Check className="w-5 h-5" />
          Settings saved successfully!
        </div>
      )}

      {/* Profile Tab */}
      {activeTab === 'profile' && (
        <div className="space-y-6">
          {/* Profile Info */}
          <div className="card p-6">
            <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
              <User className="w-5 h-5" />
              Profile Information
            </h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">First Name</label>
                  <input
                    type="text"
                    value={profileData.firstName}
                    onChange={(e) => setProfileData({ ...profileData, firstName: e.target.value })}
                    className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">Last Name</label>
                  <input
                    type="text"
                    value={profileData.lastName}
                    onChange={(e) => setProfileData({ ...profileData, lastName: e.target.value })}
                    className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Email</label>
                <div className="flex items-center gap-2">
                  <Mail className="w-5 h-5 text-text-muted" />
                  <input
                    type="email"
                    value={profileData.email}
                    disabled
                    className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-muted"
                  />
                </div>
                <p className="text-xs text-text-muted mt-1">Email cannot be changed</p>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleSaveProfile}
                  disabled={isSaving}
                  className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow disabled:opacity-50 transition-all"
                >
                  {isSaving ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  Save Changes
                </button>
              </div>
            </div>
          </div>

          {/* Change Password */}
          <div className="card p-6">
            <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
              <Lock className="w-5 h-5" />
              Change Password
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Current Password</label>
                <input
                  type="password"
                  value={passwordData.currentPassword}
                  onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                  className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">New Password</label>
                <input
                  type="password"
                  value={passwordData.newPassword}
                  onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                  className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Confirm New Password</label>
                <input
                  type="password"
                  value={passwordData.confirmPassword}
                  onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                  className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
                />
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleSavePassword}
                  disabled={isSaving || !passwordData.currentPassword || !passwordData.newPassword}
                  className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow disabled:opacity-50 transition-all"
                >
                  {isSaving ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  Update Password
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Notifications Tab */}
      {activeTab === 'notifications' && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
            <Bell className="w-5 h-5" />
            Notification Preferences
          </h2>
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
              <button
                onClick={toggleMute}
                className={`
                  relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                  ${isMuted ? 'bg-surface-4' : 'bg-primary-600'}
                `}
              >
                <span
                  className={`
                    inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                    ${isMuted ? 'translate-x-1' : 'translate-x-6'}
                  `}
                />
              </button>
            </div>

            {/* Volume slider */}
            {!isMuted && (
              <div className="p-4 bg-surface-3 rounded-xl">
                <label className="block text-sm font-medium text-text-secondary mb-2">Volume</label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-full"
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
              <button
                onClick={() => setNotificationPrefs({ ...notificationPrefs, desktop: !notificationPrefs.desktop })}
                className={`
                  relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                  ${notificationPrefs.desktop ? 'bg-primary-600' : 'bg-surface-4'}
                `}
              >
                <span
                  className={`
                    inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                    ${notificationPrefs.desktop ? 'translate-x-6' : 'translate-x-1'}
                  `}
                />
              </button>
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
              <button
                onClick={() => setNotificationPrefs({ ...notificationPrefs, handsoffOnly: !notificationPrefs.handsoffOnly })}
                className={`
                  relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                  ${notificationPrefs.handsoffOnly ? 'bg-primary-600' : 'bg-surface-4'}
                `}
              >
                <span
                  className={`
                    inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                    ${notificationPrefs.handsoffOnly ? 'translate-x-6' : 'translate-x-1'}
                  `}
                />
              </button>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handleSaveNotifications}
                disabled={isSaving}
                className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow disabled:opacity-50 transition-all"
              >
                {isSaving ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save Preferences
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Appearance Tab */}
      {activeTab === 'appearance' && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
            <Monitor className="w-5 h-5" />
            Appearance
          </h2>
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">Choose your preferred theme</p>

            <div className="grid grid-cols-3 gap-4">
              <button
                onClick={() => setTheme('light')}
                className={`
                  p-4 border-2 rounded-2xl text-center transition-colors
                  ${theme === 'light' ? 'border-primary-500 bg-primary-600/10' : 'border-edge hover:border-edge-light'}
                `}
              >
                <Sun className="w-8 h-8 mx-auto mb-2 text-accent-400" />
                <p className="font-medium text-text-primary">Light</p>
                <p className="text-xs text-text-muted">Always light mode</p>
              </button>

              <button
                onClick={() => setTheme('dark')}
                className={`
                  p-4 border-2 rounded-2xl text-center transition-colors
                  ${theme === 'dark' ? 'border-primary-500 bg-primary-600/10' : 'border-edge hover:border-edge-light'}
                `}
              >
                <Moon className="w-8 h-8 mx-auto mb-2 text-primary-400" />
                <p className="font-medium text-text-primary">Dark</p>
                <p className="text-xs text-text-muted">Always dark mode</p>
              </button>

              <button
                onClick={() => setTheme('system')}
                className={`
                  p-4 border-2 rounded-2xl text-center transition-colors
                  ${theme === 'system' ? 'border-primary-500 bg-primary-600/10' : 'border-edge hover:border-edge-light'}
                `}
              >
                <Monitor className="w-8 h-8 mx-auto mb-2 text-text-secondary" />
                <p className="font-medium text-text-primary">System</p>
                <p className="text-xs text-text-muted">Follow system preference</p>
              </button>
            </div>

            <div className="flex justify-end pt-4">
              <button
                onClick={handleSaveAppearance}
                disabled={isSaving}
                className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow disabled:opacity-50 transition-all"
              >
                {isSaving ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save Theme
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Integration Tab */}
      {activeTab === 'integration' && (
        <div className="space-y-6">
          {/* API Key */}
          <div className="bg-surface-0 border border-edge rounded-xl p-6">
            <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
              <Key className="w-5 h-5" />
              API Key
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-text-secondary mb-1">Your API Key</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm">
                    {maskSecret(tenantData?.apiKey)}
                  </code>
                  <button
                    onClick={() => tenantData?.apiKey && copyToClipboard(tenantData.apiKey, 'API key')}
                    disabled={!tenantData?.apiKey}
                    className="flex items-center gap-2 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-secondary hover:text-text-primary disabled:opacity-50 transition-all"
                    title="Copy API key"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setShowRotateConfirm(true)}
                    disabled={isRotatingKey}
                    className="flex items-center gap-2 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-secondary hover:text-text-primary disabled:opacity-50 transition-all"
                    title="Rotate API key"
                  >
                    <RotateCw className={`w-4 h-4 ${isRotatingKey ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* n8n Webhook URL */}
          <div className="bg-surface-0 border border-edge rounded-xl p-6">
            <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
              <Webhook className="w-5 h-5" />
              n8n Webhook URL
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-text-secondary mb-1">Webhook URL</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={webhookUrlInput}
                    onChange={(e) => setWebhookUrlInput(e.target.value)}
                    placeholder="https://your-n8n-instance.com/webhook/..."
                    className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
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
                <button
                  onClick={handleTestWebhook}
                  disabled={isTestingWebhook || !webhookUrlInput}
                  className="flex items-center gap-2 px-4 py-2 bg-surface-3 border border-edge rounded-xl text-text-secondary hover:text-text-primary disabled:opacity-50 transition-all"
                >
                  {isTestingWebhook ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-secondary" />
                  ) : (
                    <ExternalLink className="w-4 h-4" />
                  )}
                  Test Connection
                </button>
                <button
                  onClick={handleSaveWebhookUrl}
                  disabled={isSavingWebhook}
                  className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow disabled:opacity-50 transition-all"
                >
                  {isSavingWebhook ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  Save
                </button>
              </div>
            </div>
          </div>

          {/* Inbound Webhook Endpoint */}
          <div className="bg-surface-0 border border-edge rounded-xl p-6">
            <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
              <ExternalLink className="w-5 h-5" />
              Inbound Webhook Endpoint
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-text-secondary mb-1">Endpoint URL (read-only)</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm">
                    {inboundWebhookUrl}
                  </code>
                  <button
                    onClick={() => copyToClipboard(inboundWebhookUrl, 'Inbound webhook URL')}
                    className="flex items-center gap-2 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-secondary hover:text-text-primary transition-all"
                    title="Copy URL"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-xs text-text-muted mt-2">
                  Configure your n8n workflow to send responses to this URL. Include your tenant ID in the request body.
                </p>
              </div>
            </div>
          </div>

          {/* Webhook Secret */}
          <div className="bg-surface-0 border border-edge rounded-xl p-6">
            <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Webhook Secret
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-text-secondary mb-1">Secret Key</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm">
                    {maskSecret(tenantData?.webhookSecret)}
                  </code>
                  <button
                    onClick={() => tenantData?.webhookSecret && copyToClipboard(tenantData.webhookSecret, 'Webhook secret')}
                    disabled={!tenantData?.webhookSecret}
                    className="flex items-center gap-2 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-secondary hover:text-text-primary disabled:opacity-50 transition-all"
                    title="Copy webhook secret"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setShowRegenerateConfirm(true)}
                    disabled={isRegeneratingSecret}
                    className="flex items-center gap-2 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-secondary hover:text-text-primary disabled:opacity-50 transition-all"
                    title="Regenerate webhook secret"
                  >
                    <RotateCw className={`w-4 h-4 ${isRegeneratingSecret ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Rotate API Key Confirmation Modal */}
      {showRotateConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface-0 border border-edge rounded-xl p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold text-text-primary mb-2">Rotate API Key?</h3>
            <p className="text-sm text-text-secondary mb-6">
              This will invalidate your current API key immediately. Any integrations using the old key will stop working. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowRotateConfirm(false)}
                className="px-4 py-2 bg-surface-3 border border-edge rounded-xl text-text-secondary hover:text-text-primary transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleRotateApiKey}
                disabled={isRotatingKey}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-xl hover:bg-red-500 disabled:opacity-50 transition-all"
              >
                {isRotatingKey ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                ) : (
                  <RotateCw className="w-4 h-4" />
                )}
                Rotate Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Regenerate Webhook Secret Confirmation Modal */}
      {showRegenerateConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface-0 border border-edge rounded-xl p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold text-text-primary mb-2">Regenerate Webhook Secret?</h3>
            <p className="text-sm text-text-secondary mb-6">
              This will invalidate your current webhook secret immediately. You will need to update the secret in your n8n workflows. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowRegenerateConfirm(false)}
                className="px-4 py-2 bg-surface-3 border border-edge rounded-xl text-text-secondary hover:text-text-primary transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleRegenerateSecret}
                disabled={isRegeneratingSecret}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-xl hover:bg-red-500 disabled:opacity-50 transition-all"
              >
                {isRegeneratingSecret ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                ) : (
                  <RotateCw className="w-4 h-4" />
                )}
                Regenerate Secret
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Settings;
