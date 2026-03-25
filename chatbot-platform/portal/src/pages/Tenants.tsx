/**
 * Tenants Page
 * White-label config (colors, logo, webhook)
 */

import React, { useState } from 'react';
import { Plus, Edit2, Trash2, ExternalLink, Copy, Check, RefreshCw } from 'lucide-react';
import { Modal } from '@components/Modal';
import type { Tenant } from '@app-types/index';

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

  const handleCreate = () => {
    setEditingTenant(null);
    setIsModalOpen(true);
  };

  const handleEdit = (tenant: Tenant) => {
    setEditingTenant(tenant);
    setIsModalOpen(true);
  };

  const handleDelete = async (tenantId: string) => {
    if (confirm('Are you sure you want to delete this tenant?')) {
      setTenants((prev) => prev.filter((t) => t.id !== tenantId));
    }
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
        <button
          onClick={handleCreate}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow transition-all"
        >
          <Plus className="w-4 h-4" />
          Add Tenant
        </button>
      </div>

      {/* Tenants Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {tenants.map((tenant) => (
          <div
            key={tenant.id}
            className="card overflow-hidden"
          >
            {/* Header */}
            <div
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
                  <button
                    onClick={() => handleEdit(tenant)}
                    className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3/50 rounded-xl transition-colors"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(tenant.id)}
                    className="p-2 text-text-secondary hover:text-red-400 hover:bg-red-500/10 rounded-xl transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 py-4 space-y-4">
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
                <code className="flex-1 px-2 py-1 bg-surface-3 rounded text-sm font-mono text-text-secondary truncate">
                  {tenant.apiKey?.substring(0, 20)}...
                </code>
                <button
                  onClick={() => handleCopyKey(tenant.apiKey || '')}
                  className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded transition-colors"
                  title="Copy API key"
                >
                  {copiedKey === tenant.apiKey ? (
                    <Check className="w-4 h-4 text-status-online" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
                <button
                  onClick={() => handleRegenerateKey(tenant.id)}
                  className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded transition-colors"
                  title="Regenerate API key"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
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
                  <span
                    className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                      tenant.isActive
                        ? 'bg-status-online/10 text-status-online'
                        : 'bg-surface-3 text-text-muted'
                    }`}
                  >
                    {tenant.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Create/Edit Modal */}
      <TenantModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        tenant={editingTenant}
        onSave={handleSave}
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
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Name</label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Slug</label>
          <input
            type="text"
            value={formData.slug}
            onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
            className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Primary Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={formData.primaryColor}
                onChange={(e) => setFormData({ ...formData, primaryColor: e.target.value })}
                className="w-10 h-10 rounded border border-edge bg-surface-3"
              />
              <input
                type="text"
                value={formData.primaryColor}
                onChange={(e) => setFormData({ ...formData, primaryColor: e.target.value })}
                className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-sm text-text-primary"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Secondary Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={formData.secondaryColor}
                onChange={(e) => setFormData({ ...formData, secondaryColor: e.target.value })}
                className="w-10 h-10 rounded border border-edge bg-surface-3"
              />
              <input
                type="text"
                value={formData.secondaryColor}
                onChange={(e) => setFormData({ ...formData, secondaryColor: e.target.value })}
                className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-sm text-text-primary"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Webhook URL</label>
          <input
            type="url"
            value={formData.webhookUrl}
            onChange={(e) => setFormData({ ...formData, webhookUrl: e.target.value })}
            className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
            placeholder="https://example.com/webhook"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Max Agents</label>
          <input
            type="number"
            value={formData.maxAgents}
            onChange={(e) => setFormData({ ...formData, maxAgents: parseInt(e.target.value) })}
            className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
            min={1}
            max={100}
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-edge text-text-secondary rounded-xl hover:bg-surface-3"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow transition-all"
          >
            {tenant ? 'Save Changes' : 'Create Tenant'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default Tenants;
