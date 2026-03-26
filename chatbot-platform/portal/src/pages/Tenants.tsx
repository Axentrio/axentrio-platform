/**
 * Tenants Page
 * White-label config (colors, logo, webhook)
 * Displays the current tenant only (no multi-tenant listing API exists).
 */

import React, { useState, useEffect, useRef } from 'react';
import { Edit2, ExternalLink, Copy, Check, RefreshCw, Loader2, Camera, X } from 'lucide-react';
import { useOrganization } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { Modal } from '@components/Modal';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import type { Tenant } from '@app-types/index';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTenantSettings, useUpdateTenant, useRotateApiKey } from '../queries/useTenantQueries';

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
    secondaryColor: '#4338ca', // not supported by backend yet
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

const Tenants: React.FC = () => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const { organization } = useOrganization();

  // ---------- Fetch current tenant ----------
  const {
    data: rawTenant,
    isLoading,
    isError,
    error,
  } = useTenantSettings();

  const tenant = rawTenant ? mapApiToTenant(rawTenant as TenantApiData) : undefined;

  // ---------- Update tenant ----------
  const updateMutation = useUpdateTenant();

  // ---------- Rotate API key ----------
  const rotateMutation = useRotateApiKey();

  const handleEdit = () => {
    setIsModalOpen(true);
  };

  const handleSave = async (data: Partial<Tenant>) => {
    const payload: Record<string, unknown> = {};
    if (data.name) payload.name = data.name;
    if (data.webhookUrl !== undefined) payload.webhookUrl = data.webhookUrl;
    if (data.settings) payload.settings = data.settings;
    if (data.primaryColor) {
      payload.settings = {
        ...(payload.settings as Record<string, unknown> || {}),
        theme: { primaryColor: data.primaryColor },
      };
    }
    await updateMutation.mutateAsync(payload);
    setIsModalOpen(false);
  };

  const handleCopyKey = (apiKey: string) => {
    navigator.clipboard.writeText(apiKey);
    setCopiedKey(apiKey);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleRegenerateKey = async () => {
    await rotateMutation.mutateAsync();
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

  // ---------- Loading / Error states ----------
  if (isLoading) {
    return <PageSkeleton variant="list" rows={3} />;
  }

  if (isError || !tenant) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-bold text-text-primary">Tenant</h1>
        <Card variant="glass" className="p-6">
          <p className="text-text-secondary">
            {(error as Error)?.message || 'Failed to load tenant information.'}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Tenant</h1>
          <p className="text-text-secondary">Manage your white-label configuration</p>
        </div>
      </div>

      {/* Tenant Card */}
      <div className="max-w-2xl">
        <Card variant="glass" className="overflow-hidden">
          {/* Header */}
          <CardHeader className="px-6 py-4 bg-primary-600/10">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
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
                    className="relative w-12 h-12 rounded-xl overflow-hidden cursor-pointer p-0"
                  >
                    {organization?.hasImage ? (
                      <img
                        src={organization.imageUrl}
                        alt={tenant.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-white font-bold text-lg bg-primary-600">
                        {tenant.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className={cn(
                      "absolute inset-0 bg-black/50 flex items-center justify-center transition-opacity",
                      isUploadingLogo ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}>
                      {isUploadingLogo ? (
                        <Loader2 className="w-4 h-4 text-white animate-spin" />
                      ) : (
                        <Camera className="w-4 h-4 text-white" />
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
                <div>
                  <h3 className="font-semibold text-text-primary">{tenant.name}</h3>
                  <p className="text-sm text-text-muted">{tenant.slug}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleEdit}
                  className="text-text-secondary hover:text-text-primary"
                >
                  <Edit2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardHeader>

          {/* Body */}
          <CardContent className="px-6 py-4 space-y-4">
            {/* Colors */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">Brand Color:</span>
                <div
                  className="w-6 h-6 rounded border border-edge"
                  style={{ backgroundColor: tenant.primaryColor }}
                />
              </div>
            </div>

            {/* Webhook */}
            {tenant.webhookUrl && (
              <div className="flex items-center gap-2">
                <ExternalLink className="w-4 h-4 text-text-muted" />
                <span className="text-sm text-text-secondary truncate">{tenant.webhookUrl}</span>
              </div>
            )}

            {/* API Key */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-muted">API Key:</span>
              <Input
                readOnly
                value={`${tenant.apiKey?.substring(0, 20)}...`}
                className="flex-1 font-mono text-sm h-8 bg-surface-3"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleCopyKey(tenant.apiKey || '')}
                className={cn("h-8 w-8", copiedKey === tenant.apiKey && "text-status-online")}
                title="Copy API key"
              >
                {copiedKey === tenant.apiKey ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRegenerateKey}
                disabled={rotateMutation.isPending}
                className="h-8 w-8"
                title="Regenerate API key"
              >
                <RefreshCw className={cn("w-4 h-4", rotateMutation.isPending && "animate-spin")} />
              </Button>
            </div>

            {/* Stats */}
            <div className="flex items-center gap-4 pt-4 border-t border-edge">
              <div className="text-center">
                <p className="text-lg font-semibold text-text-primary">{tenant.currentAgents}</p>
                <p className="text-xs text-text-muted">Sessions</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-semibold text-text-primary">{tenant.maxAgents}</p>
                <p className="text-xs text-text-muted">Max</p>
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
      </div>

      {/* Edit Modal */}
      <TenantModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        tenant={tenant}
        onSave={handleSave}
        isSaving={updateMutation.isPending}
      />
    </div>
  );
};

// Color preset swatches
const COLOR_PRESETS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#2563eb', '#4f46e5', '#7c3aed',
];

const ColorField: React.FC<{ label: string; value: string; onChange: (c: string) => void }> = ({
  label,
  value,
  onChange,
}) => {
  const [showPicker, setShowPicker] = useState(false);

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="relative">
        <div
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => setShowPicker(!showPicker)}
        >
          <div
            className="w-10 h-10 rounded border border-edge shrink-0"
            style={{ backgroundColor: value }}
          />
          <Input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 text-sm font-mono"
            placeholder="#000000"
          />
        </div>
        {showPicker && (
          <div className="absolute top-12 left-0 z-50 bg-surface-2 border border-edge rounded-lg p-3 shadow-lg">
            <div className="grid grid-cols-5 gap-1.5">
              {COLOR_PRESETS.map((color) => (
                <Button
                  key={color}
                  variant="ghost"
                  type="button"
                  className={cn(
                    'w-8 h-8 rounded-md border-2 transition-transform hover:scale-110 p-0',
                    value === color ? 'border-white ring-1 ring-white/50' : 'border-transparent'
                  )}
                  style={{ backgroundColor: color }}
                  onClick={() => {
                    onChange(color);
                    setShowPicker(false);
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Tenant Modal Component
interface TenantModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenant: Tenant | null;
  onSave: (data: Partial<Tenant>) => void;
  isSaving?: boolean;
}

const TenantModal: React.FC<TenantModalProps> = ({ isOpen, onClose, tenant, onSave, isSaving }) => {
  const [formData, setFormData] = useState<Partial<Tenant>>({
    name: tenant?.name || '',
    slug: tenant?.slug || '',
    primaryColor: tenant?.primaryColor || '#6366f1',
    secondaryColor: tenant?.secondaryColor || '#4338ca',
    webhookUrl: tenant?.webhookUrl || '',
    maxAgents: tenant?.maxAgents || 10,
  });

  // Sync form data when tenant prop changes (e.g. modal re-opens after refetch)
  useEffect(() => {
    if (tenant) {
      setFormData({
        name: tenant.name,
        slug: tenant.slug,
        primaryColor: tenant.primaryColor || '#6366f1',
        secondaryColor: tenant.secondaryColor || '#4338ca',
        webhookUrl: tenant.webhookUrl || '',
        maxAgents: tenant.maxAgents || 10,
      });
    }
  }, [tenant]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit Tenant" size="md">
      <form onSubmit={handleSubmit} className="space-y-4 relative">
        <LoadingOverlay isLoading={!!isSaving} message="Saving changes..." />
        <div className="space-y-2">
          <Label htmlFor="tenant-name">Name</Label>
          <Input
            id="tenant-name"
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
            disabled={isSaving}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="tenant-slug">Slug</Label>
          <Input
            id="tenant-slug"
            type="text"
            value={formData.slug}
            disabled
            className="opacity-60"
          />
          <p className="text-xs text-text-muted">Slug cannot be changed after creation.</p>
        </div>

        <ColorField
          label="Brand Color"
          value={formData.primaryColor || '#6366f1'}
          onChange={(c) => setFormData({ ...formData, primaryColor: c })}
        />

        <div className="space-y-2">
          <Label htmlFor="tenant-webhook">Webhook URL</Label>
          <Input
            id="tenant-webhook"
            type="url"
            value={formData.webhookUrl}
            onChange={(e) => setFormData({ ...formData, webhookUrl: e.target.value })}
            placeholder="https://example.com/webhook"
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Changes'
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default Tenants;
