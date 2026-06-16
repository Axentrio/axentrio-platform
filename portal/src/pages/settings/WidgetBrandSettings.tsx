/**
 * Widget & Brand Settings
 * Branding configuration (logo, display name) extracted from Tenants page.
 * Widget appearance (color, avatar, launcher) is configured under AI & Content → Chatbot Appearances.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Camera, X, Loader2, Save, Check } from 'lucide-react';
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
import { useAppAuth } from '@/auth/useAppAuth';
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

/** Map the API response into the frontend Tenant shape.
 * Note: `primaryColor` and `secondaryColor` are required by the shared `Tenant`
 * type but are not rendered on this page — color is edited under
 * `/ai?tab=appearances`. The mapping is retained to satisfy the type contract
 * for consumers that still read these fields elsewhere.
 */
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

const WidgetBrandSettings: React.FC = () => {
  const { t } = useTranslation();
  const { organization } = useOrganization();
  // Renaming the org maps to PATCH /tenants/me (requireAdmin) — gate the field
  // client-side so non-admins don't tab in and hit a 403 on save. isRole('admin')
  // also returns true for super_admin, matching the API guard.
  const { isRole } = useAppAuth();
  const canEditName = isRole('admin');
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);

  // ---------- Fetch current tenant ----------
  const { data: rawTenant, isLoading, isError, error } = useTenantSettings();
  const tenant = rawTenant ? mapApiToTenant(rawTenant as TenantApiData) : undefined;

  // ---------- Local form state ----------
  const [displayName, setDisplayName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Sync form state when tenant data loads
  useEffect(() => {
    if (tenant) {
      setDisplayName(tenant.name);
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
      if (Object.keys(payload).length > 0) {
        await updateMutation.mutateAsync(payload);
        // The API renamed the Clerk org server-side; refresh the local Clerk
        // session so the org switcher / other surfaces show the new name now.
        if (payload.name) await organization?.reload?.();
      }
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch {
      toast.error(t('settings.widget.saveFailed'));
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
      toast.success(t('settings.widget.logo.uploaded'));
    } catch {
      toast.error(t('settings.widget.logo.uploadFailed'));
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
      toast.success(t('settings.widget.logo.removed'));
    } catch {
      toast.error(t('settings.widget.logo.removeFailed'));
    } finally {
      setIsUploadingLogo(false);
    }
  };

  const isDirty = tenant && displayName !== tenant.name;

  // ---------- Loading / Error states ----------
  if (isLoading) {
    return <PageSkeleton variant="list" rows={3} />;
  }

  if (isError || !tenant) {
    return (
      <Card variant="glass" className="p-6">
        <p className="text-text-secondary">
          {(error as Error)?.message || t('settings.widget.loadFailed')}
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{t('settings.widget.title')}</h2>
        <p className="text-sm text-text-secondary">
          {t('settings.widget.description')}
        </p>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        {t('settings.widget.appearanceNotice.prefix')}{' '}
        <Link to="/ai?tab=appearances" className="underline">
          {t('settings.widget.appearanceNotice.linkText')}
        </Link>
        {t('settings.widget.appearanceNotice.suffix')}
      </div>

      {/* Logo Section */}
      <Card variant="glass">
        <CardHeader>
          <h3 className="font-medium text-text-primary">{t('settings.widget.logo.title')}</h3>
          <p className="text-sm text-text-muted">
            {t('settings.widget.logo.description')}
          </p>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <input
            ref={logoInputRef}
            type="file"
            accept="image/*"
            aria-label={t('settings.widget.logo.title')}
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
                title={t('settings.widget.logo.removeTitle')}
              >
                <X className="w-3 h-3" />
              </Button>
            )}
          </div>
          <div className="text-sm text-text-muted">
            <p>{t('settings.widget.logo.uploadHint')}</p>
            <p className="text-xs">{t('settings.widget.logo.recommended')}</p>
          </div>
        </CardContent>
      </Card>

      {/* Display Name */}
      <Card variant="glass">
        <CardHeader>
          <h3 className="font-medium text-text-primary">{t('settings.widget.displayName.title')}</h3>
          <p className="text-sm text-text-muted">
            {t('settings.widget.displayName.description')}
          </p>
        </CardHeader>
        <CardContent>
          <div className="max-w-sm space-y-2">
            <Label htmlFor="display-name">{t('settings.widget.displayName.label')}</Label>
            <Input
              id="display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('settings.widget.displayName.placeholder')}
              disabled={!canEditName}
            />
            {!canEditName && (
              <p className="text-xs text-text-muted">{t('settings.widget.displayName.adminOnly')}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Status */}
      <Card variant="glass">
        <CardHeader>
          <h3 className="font-medium text-text-primary">{t('settings.widget.status.title')}</h3>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-lg font-semibold text-text-primary">{tenant.currentAgents}</p>
              <p className="text-xs text-text-muted">{t('settings.widget.status.activeSessions')}</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-text-primary">{tenant.maxAgents}</p>
              <p className="text-xs text-text-muted">{t('settings.widget.status.maxSessions')}</p>
            </div>
            <div className="flex-1 text-right">
              <Badge
                className={cn(
                  tenant.isActive
                    ? 'bg-status-online/10 text-status-online border-status-online/20'
                    : 'bg-surface-3 text-text-muted border-edge'
                )}
              >
                {tenant.isActive ? t('settings.widget.status.active') : t('settings.widget.status.inactive')}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving || !isDirty || !canEditName}>
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t('common.saving')}
            </>
          ) : saveSuccess ? (
            <>
              <Check className="w-4 h-4 mr-2" />
              {t('common.saved')}
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              {t('common.save')}
            </>
          )}
        </Button>
      </div>
    </div>
  );
};

export default WidgetBrandSettings;
