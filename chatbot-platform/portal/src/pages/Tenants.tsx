/**
 * Tenants Page
 * White-label config (colors, logo, webhook)
 * Displays the current tenant only (no multi-tenant listing API exists).
 */

import React, { useState, useEffect } from 'react';
import { Edit2, ExternalLink, Copy, Check, RefreshCw, Loader2 } from 'lucide-react';
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
    primaryColor: '#6366f1',   // not returned by API; use default
    secondaryColor: '#4338ca', // not returned by API; use default
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
          <CardHeader
            className="px-6 py-4"
            style={{ backgroundColor: tenant.primaryColor + '15' }}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg"
                  style={{ backgroundColor: tenant.primaryColor }}
                >
                  {tenant.name.charAt(0).toUpperCase()}
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
                <span className="text-sm text-text-muted">Primary:</span>
                <div
                  className="w-6 h-6 rounded border border-edge"
                  style={{ backgroundColor: tenant.primaryColor }}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">Secondary:</span>
                <div
                  className="w-6 h-6 rounded border border-edge"
                  style={{ backgroundColor: tenant.secondaryColor }}
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

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Primary Color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={formData.primaryColor}
                onChange={(e) => setFormData({ ...formData, primaryColor: e.target.value })}
                className="w-10 h-10 rounded border border-edge bg-surface-3"
              />
              <Input
                type="text"
                value={formData.primaryColor}
                onChange={(e) => setFormData({ ...formData, primaryColor: e.target.value })}
                className="flex-1 text-sm"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Secondary Color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={formData.secondaryColor}
                onChange={(e) => setFormData({ ...formData, secondaryColor: e.target.value })}
                className="w-10 h-10 rounded border border-edge bg-surface-3"
              />
              <Input
                type="text"
                value={formData.secondaryColor}
                onChange={(e) => setFormData({ ...formData, secondaryColor: e.target.value })}
                className="flex-1 text-sm"
              />
            </div>
          </div>
        </div>

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
