/**
 * Tenants Page
 * White-label config (colors, logo, webhook)
 */

import React, { useState } from 'react';
import { Plus, Edit2, Trash2, ExternalLink, Copy, Check, RefreshCw } from 'lucide-react';
import { Modal } from '@components/Modal';
import type { Tenant } from '@app-types/index';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// Mock tenants - replace with actual data
const mockTenants: Tenant[] = [
  {
    id: '1',
    name: 'Acme Corp',
    slug: 'acme',
    primaryColor: '#6366f1',
    secondaryColor: '#4338ca',
    webhookUrl: 'https://acme.com/webhook',
    apiKey: 'ak_live_xxxxxxxxxxxx',
    settings: {
      businessHours: { timezone: 'America/New_York', schedule: [] },
      autoHandoff: true,
      handoffTriggers: { sentimentThreshold: 0.3, consecutiveFailures: 3, explicitRequest: true, timeoutSeconds: 300 },
      responseTimeSLA: 2,
      csatEnabled: true,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isActive: true,
    maxAgents: 10,
    currentAgents: 5,
  },
  {
    id: '2',
    name: 'TechStart Inc',
    slug: 'techstart',
    primaryColor: '#34d399',
    secondaryColor: '#059669',
    webhookUrl: 'https://techstart.io/webhook',
    apiKey: 'ak_live_yyyyyyyyyyyy',
    settings: {
      businessHours: { timezone: 'America/Los_Angeles', schedule: [] },
      autoHandoff: true,
      handoffTriggers: { sentimentThreshold: 0.3, consecutiveFailures: 3, explicitRequest: true, timeoutSeconds: 300 },
      responseTimeSLA: 2,
      csatEnabled: true,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isActive: true,
    maxAgents: 5,
    currentAgents: 2,
  },
];

const Tenants: React.FC = () => {
  const [tenants, setTenants] = useState<Tenant[]>(mockTenants);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [tenantToDelete, setTenantToDelete] = useState<string | null>(null);

  const handleCreate = () => {
    setEditingTenant(null);
    setIsModalOpen(true);
  };

  const handleEdit = (tenant: Tenant) => {
    setEditingTenant(tenant);
    setIsModalOpen(true);
  };

  const handleDeleteClick = (tenantId: string) => {
    setTenantToDelete(tenantId);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (tenantToDelete) {
      setTenants((prev) => prev.filter((t) => t.id !== tenantToDelete));
    }
    setDeleteDialogOpen(false);
    setTenantToDelete(null);
  };

  const handleSave = async (data: Partial<Tenant>) => {
    if (editingTenant) {
      setTenants((prev) =>
        prev.map((t) => (t.id === editingTenant.id ? { ...t, ...data } as Tenant : t))
      );
    } else {
      const newTenant: Tenant = {
        id: Date.now().toString(),
        name: data.name || '',
        slug: data.slug || '',
        primaryColor: data.primaryColor || '#6366f1',
        secondaryColor: data.secondaryColor || '#4338ca',
        settings: {
          businessHours: { timezone: 'UTC', schedule: [] },
          autoHandoff: true,
          handoffTriggers: { sentimentThreshold: 0.3, consecutiveFailures: 3, explicitRequest: true, timeoutSeconds: 300 },
          responseTimeSLA: 2,
          csatEnabled: true,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isActive: true,
        maxAgents: 10,
        currentAgents: 0,
      };
      setTenants((prev) => [...prev, newTenant]);
    }
    setIsModalOpen(false);
  };

  const handleCopyKey = (apiKey: string) => {
    navigator.clipboard.writeText(apiKey);
    setCopiedKey(apiKey);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleRegenerateKey = async (tenantId: string) => {
    const newKey = `ak_live_${Math.random().toString(36).substring(7)}`;
    setTenants((prev) =>
      prev.map((t) => (t.id === tenantId ? { ...t, apiKey: newKey } : t))
    );
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Tenants</h1>
          <p className="text-text-secondary">Manage white-label configurations</p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="w-4 h-4 mr-2" />
          Add Tenant
        </Button>
      </div>

      {/* Tenants Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {tenants.map((tenant) => (
          <Card key={tenant.id} variant="glass" className="overflow-hidden">
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
                    onClick={() => handleEdit(tenant)}
                    className="text-text-secondary hover:text-text-primary"
                  >
                    <Edit2 className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeleteClick(tenant.id)}
                    className="text-text-secondary hover:text-red-400 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-4 h-4" />
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
                  onClick={() => handleRegenerateKey(tenant.id)}
                  className="h-8 w-8"
                  title="Regenerate API key"
                >
                  <RefreshCw className="w-4 h-4" />
                </Button>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 pt-4 border-t border-edge">
                <div className="text-center">
                  <p className="text-lg font-semibold text-text-primary">{tenant.currentAgents}</p>
                  <p className="text-xs text-text-muted">Agents</p>
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
        ))}
      </div>

      {/* Create/Edit Modal */}
      <TenantModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        tenant={editingTenant}
        onSave={handleSave}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Tenant</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this tenant? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setTenantToDelete(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

// Tenant Modal Component
interface TenantModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenant: Tenant | null;
  onSave: (data: Partial<Tenant>) => void;
}

const TenantModal: React.FC<TenantModalProps> = ({ isOpen, onClose, tenant, onSave }) => {
  const [formData, setFormData] = useState<Partial<Tenant>>({
    name: tenant?.name || '',
    slug: tenant?.slug || '',
    primaryColor: tenant?.primaryColor || '#6366f1',
    secondaryColor: tenant?.secondaryColor || '#4338ca',
    webhookUrl: tenant?.webhookUrl || '',
    maxAgents: tenant?.maxAgents || 10,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={tenant ? 'Edit Tenant' : 'Add Tenant'} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="tenant-name">Name</Label>
          <Input
            id="tenant-name"
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="tenant-slug">Slug</Label>
          <Input
            id="tenant-slug"
            type="text"
            value={formData.slug}
            onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
            required
          />
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

        <div className="space-y-2">
          <Label htmlFor="tenant-max-agents">Max Agents</Label>
          <Input
            id="tenant-max-agents"
            type="number"
            value={formData.maxAgents}
            onChange={(e) => setFormData({ ...formData, maxAgents: parseInt(e.target.value) })}
            min={1}
            max={100}
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">
            {tenant ? 'Save Changes' : 'Create Tenant'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default Tenants;
