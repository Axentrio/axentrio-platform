/**
 * Widget & Brand Settings
 * Branding configuration (logo, color, display name) extracted from Tenants page.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Camera, X, Loader2, Save, Check, Copy } from 'lucide-react';
import { useOrganization } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useTenantSettings, useUpdateTenant } from '@/queries/useTenantQueries';
import type { Tenant } from '@app-types/index';

/** Shape of the unwrapped GET /tenants/me response (envelope stripped by interceptor) */
interface TenantApiData {
  id: string;
  name: string;
  slug: string;
  apiKey: string;
  tier: string;
  status: string;
  settings: Tenant['settings'] | null;
  maxSessions: number;
  currentSessions: number;
  webhookUrl: string | null;
  webhookSecret: string | null;
  customDomain: string | null;
  createdAt: string;
}

/** Map the API response into the frontend Tenant shape */
function mapApiToTenant(data: TenantApiData): Tenant {
  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    apiKey: data.apiKey,
    primaryColor: data.settings?.theme?.primaryColor || '#6366f1',
    secondaryColor: '#4338ca',
    webhookUrl: data.webhookUrl ?? undefined,
    settings: data.settings ?? {
      businessHours: { timezone: 'UTC', schedule: [] },
      autoHandoff: true,
      handoffTriggers: { sentimentThreshold: 0.3, consecutiveFailures: 3, explicitRequest: true, timeoutSeconds: 300 },
      responseTimeSLA: 2,
      csatEnabled: true,
    },
    createdAt: data.createdAt,
    updatedAt: data.createdAt,
    isActive: data.status === 'active',
    maxAgents: data.maxSessions ?? 0,
    currentAgents: data.currentSessions ?? 0,
  };
}

// Color preset swatches
const COLOR_PRESETS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#2563eb', '#4f46e5', '#7c3aed',
];

const WidgetBrandSettings: React.FC = () => {
  const { organization } = useOrganization();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);

  // ---------- Fetch current tenant ----------
  const { data: rawTenant, isLoading, isError, error } = useTenantSettings();
  const tenant = rawTenant ? mapApiToTenant(rawTenant as TenantApiData) : undefined;

  // ---------- Local form state ----------
  const [displayName, setDisplayName] = useState('');
  const [brandColor, setBrandColor] = useState('#6366f1');
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Sync form state when tenant data loads
  useEffect(() => {
    if (tenant) {
      setDisplayName(tenant.name);
      setBrandColor(tenant.primaryColor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTenant]);

  // ---------- Update tenant ----------
  const updateMutation = useUpdateTenant();

  const handleSave = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    try {
      const payload: Record<string, unknown> = {};
      if (displayName !== tenant?.name) payload.name = displayName;
      if (brandColor !== tenant?.primaryColor) {
        payload.settings = { theme: { primaryColor: brandColor } };
      }
      if (Object.keys(payload).length > 0) {
        await updateMutation.mutateAsync(payload);
      }
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch {
      toast.error('Failed to save branding settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !organization) return;
    setIsUploadingLogo(true);
    try {
      await organization.setLogo({ file });
      toast.success('Organization logo updated');
    } catch {
      toast.error('Failed to update logo');
    } finally {
      setIsUploadingLogo(false);
      if (logoInputRef.current) logoInputRef.current.value = '';
    }
  };

  const handleLogoRemove = async () => {
    if (!organization) return;
    setIsUploadingLogo(true);
    try {
      await organization.setLogo({ file: null });
      toast.success('Organization logo removed');
    } catch {
      toast.error('Failed to remove logo');
    } finally {
      setIsUploadingLogo(false);
    }
  };

  const isDirty = tenant && (displayName !== tenant.name || brandColor !== tenant.primaryColor);

  const apiUrl = (import.meta.env.VITE_API_URL || '').replace('/api/v1', '') || window.location.origin;
  const embedSnippet = `<script src="${apiUrl}/widget.js"\n  data-api-key="${tenant?.apiKey}"></script>`;

  // ---------- Loading / Error states ----------
  if (isLoading) {
    return <PageSkeleton variant="list" rows={3} />;
  }

  if (isError || !tenant) {
    return (
      <Card variant="glass" className="p-6">
        <p className="text-text-secondary">
          {(error as Error)?.message || 'Failed to load branding settings.'}
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Widget & Brand</h2>
        <p className="text-sm text-text-secondary">
          Customize how your chat widget appears to visitors
        </p>
      </div>

      {/* Logo Section */}
      <Card variant="glass">
        <CardHeader>
          <h3 className="font-medium text-text-primary">Logo</h3>
          <p className="text-sm text-text-muted">
            Your organization logo appears in the chat widget header
          </p>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <input
            ref={logoInputRef}
            type="file"
            accept="image/*"
            onChange={handleLogoUpload}
            className="hidden"
          />
          <div className="relative group">
            <Button
              variant="ghost"
              type="button"
              onClick={() => logoInputRef.current?.click()}
              disabled={isUploadingLogo}
              className="relative w-16 h-16 rounded-xl overflow-hidden cursor-pointer p-0"
            >
              {organization?.hasImage ? (
                <img
                  src={organization.imageUrl}
                  alt={tenant.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-white font-bold text-xl bg-primary-600">
                  {tenant.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div className={cn(
                'absolute inset-0 bg-black/50 flex items-center justify-center transition-opacity',
                isUploadingLogo ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}>
                {isUploadingLogo ? (
                  <Loader2 className="w-5 h-5 text-white animate-spin" />
                ) : (
                  <Camera className="w-5 h-5 text-white" />
                )}
              </div>
            </Button>
            {organization?.hasImage && !isUploadingLogo && (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={(e) => { e.stopPropagation(); handleLogoRemove(); }}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-surface-3 border border-edge flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive hover:border-destructive text-text-muted hover:text-white"
                title="Remove logo"
              >
                <X className="w-3 h-3" />
              </Button>
            )}
          </div>
          <div className="text-sm text-text-muted">
            <p>Click to upload a new logo</p>
            <p className="text-xs">Recommended: 256x256px, PNG or SVG</p>
          </div>
        </CardContent>
      </Card>

      {/* Display Name */}
      <Card variant="glass">
        <CardHeader>
          <h3 className="font-medium text-text-primary">Display Name</h3>
          <p className="text-sm text-text-muted">
            The name shown in the chat widget header
          </p>
        </CardHeader>
        <CardContent>
          <div className="max-w-sm space-y-2">
            <Label htmlFor="display-name">Name</Label>
            <Input
              id="display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your company name"
            />
          </div>
        </CardContent>
      </Card>

      {/* Brand Color */}
      <Card variant="glass">
        <CardHeader>
          <h3 className="font-medium text-text-primary">Brand Color</h3>
          <p className="text-sm text-text-muted">
            Primary color used in the chat widget and visitor-facing elements
          </p>
        </CardHeader>
        <CardContent>
          <div className="max-w-sm space-y-3">
            <div className="relative">
              <div
                className="flex items-center gap-2 cursor-pointer"
                onClick={() => setShowColorPicker(!showColorPicker)}
              >
                <div
                  className="w-10 h-10 rounded border border-edge shrink-0"
                  style={{ backgroundColor: brandColor }}
                />
                <Input
                  type="text"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 text-sm font-mono"
                  placeholder="#000000"
                />
              </div>
              {showColorPicker && (
                <div className="absolute top-12 left-0 z-50 bg-surface-2 border border-edge rounded-lg p-3 shadow-lg">
                  <div className="grid grid-cols-5 gap-1.5">
                    {COLOR_PRESETS.map((color, index) => (
                      <Button
                        key={index}
                        variant="ghost"
                        type="button"
                        className={cn(
                          'w-8 h-8 rounded-md border-2 transition-transform hover:scale-110 p-0',
                          brandColor === color ? 'border-white ring-1 ring-white/50' : 'border-transparent'
                        )}
                        style={{ backgroundColor: color }}
                        onClick={() => {
                          setBrandColor(color);
                          setShowColorPicker(false);
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Widget Preview */}
      <Card variant="glass">
        <CardHeader>
          <h3 className="font-medium text-text-primary">Preview</h3>
          <p className="text-sm text-text-muted">
            How your widget will appear to visitors
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-4">
            <div className="w-72 rounded-xl border border-edge shadow-lg overflow-hidden bg-surface-1">
              {/* Widget header */}
              <div
                className="px-4 py-3 flex items-center gap-3"
                style={{ backgroundColor: brandColor }}
              >
                {organization?.hasImage ? (
                  <img
                    src={organization.imageUrl}
                    alt={displayName}
                    className="w-8 h-8 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-sm">
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <p className="text-white font-medium text-sm">{displayName || 'Your Company'}</p>
                  <div className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    <span className="text-white/70 text-xs">Online</span>
                  </div>
                </div>
              </div>
              {/* Widget body placeholder */}
              <div className="px-4 py-6 space-y-3">
                <div className="flex justify-start">
                  <div className="bg-surface-3 rounded-lg rounded-bl-none px-3 py-2 text-xs text-text-secondary max-w-[80%]">
                    Hi! How can I help you today?
                  </div>
                </div>
                <div className="flex justify-end">
                  <div
                    className="rounded-lg rounded-br-none px-3 py-2 text-xs text-white max-w-[80%]"
                    style={{ backgroundColor: brandColor }}
                  >
                    I have a question about pricing
                  </div>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Status */}
      <Card variant="glass">
        <CardHeader>
          <h3 className="font-medium text-text-primary">Status</h3>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-lg font-semibold text-text-primary">{tenant.currentAgents}</p>
              <p className="text-xs text-text-muted">Active Sessions</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-text-primary">{tenant.maxAgents}</p>
              <p className="text-xs text-text-muted">Max Sessions</p>
            </div>
            <div className="flex-1 text-right">
              <Badge
                className={cn(
                  tenant.isActive
                    ? 'bg-status-online/10 text-status-online border-status-online/20'
                    : 'bg-surface-3 text-text-muted border-edge'
                )}
              >
                {tenant.isActive ? 'Active' : 'Inactive'}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Embed Widget */}
      <Card variant="glass">
        <CardHeader>
          <h3 className="font-medium text-text-primary">Embed Widget</h3>
          <p className="text-xs text-text-muted">Add this snippet to your website's HTML, just before the closing &lt;/body&gt; tag</p>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <pre className="bg-black/20 rounded-lg p-3 font-mono text-xs text-text-secondary overflow-x-auto whitespace-pre-wrap break-all">
              {embedSnippet}
            </pre>
            <button
              onClick={() => {
                navigator.clipboard.writeText(embedSnippet);
                toast.success('Copied to clipboard');
              }}
              className="absolute top-2 right-2 p-1.5 rounded-md bg-surface-3/80 hover:bg-surface-3 text-text-muted hover:text-text-secondary transition-colors"
              title="Copy snippet"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving || !isDirty}>
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : saveSuccess ? (
            <>
              <Check className="w-4 h-4 mr-2" />
              Saved
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              Save Changes
            </>
          )}
        </Button>
      </div>
    </div>
  );
};

export default WidgetBrandSettings;
