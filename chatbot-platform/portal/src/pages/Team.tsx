/**
 * Team Page
 * Agent management, shifts, SLA monitoring
 */

import React, { useState } from 'react';
import { Plus, Edit2, Trash2, Clock, Star, MessageSquare, Calendar } from 'lucide-react';
import { useOrganization } from '@clerk/clerk-react';
import { Modal } from '@components/Modal';
import type { Agent, AgentShift, UserStatus } from '@app-types/index';

// Mock agents - replace with actual data
const mockAgents: Agent[] = [
  {
    id: '1',
    userId: '1',
    email: 'john.doe@example.com',
    firstName: 'John',
    lastName: 'Doe',
    role: 'agent',
    status: 'online',
    skills: ['support', 'sales'],
    maxConcurrentChats: 5,
    currentChats: 2,
    isActive: true,
    createdAt: new Date().toISOString(),
    performance: {
      totalChats: 145,
      avgResponseTime: 28,
      avgResolutionTime: 12,
      csatScore: 4.8,
      handoffAcceptanceRate: 95,
      onlineHours: 160,
    },
  },
  {
    id: '2',
    userId: '2',
    email: 'jane.smith@example.com',
    firstName: 'Jane',
    lastName: 'Smith',
    role: 'supervisor',
    status: 'online',
    skills: ['support', 'technical', 'escalations'],
    maxConcurrentChats: 3,
    currentChats: 1,
    isActive: true,
    createdAt: new Date().toISOString(),
    performance: {
      totalChats: 89,
      avgResponseTime: 22,
      avgResolutionTime: 15,
      csatScore: 4.9,
      handoffAcceptanceRate: 100,
      onlineHours: 140,
    },
  },
  {
    id: '3',
    userId: '3',
    email: 'mike.rodriguez@example.com',
    firstName: 'Mike',
    lastName: 'Rodriguez',
    role: 'agent',
    status: 'away',
    skills: ['technical', 'billing'],
    maxConcurrentChats: 4,
    currentChats: 0,
    isActive: true,
    createdAt: new Date().toISOString(),
    performance: {
      totalChats: 112,
      avgResponseTime: 35,
      avgResolutionTime: 18,
      csatScore: 4.5,
      handoffAcceptanceRate: 88,
      onlineHours: 150,
    },
  },
];

const mockShifts: AgentShift[] = [
  { id: '1', agentId: '1', dayOfWeek: 1, startTime: '09:00', endTime: '17:00', timezone: 'America/New_York' },
  { id: '2', agentId: '1', dayOfWeek: 2, startTime: '09:00', endTime: '17:00', timezone: 'America/New_York' },
  { id: '3', agentId: '1', dayOfWeek: 3, startTime: '09:00', endTime: '17:00', timezone: 'America/New_York' },
  { id: '4', agentId: '1', dayOfWeek: 4, startTime: '09:00', endTime: '17:00', timezone: 'America/New_York' },
  { id: '5', agentId: '1', dayOfWeek: 5, startTime: '09:00', endTime: '17:00', timezone: 'America/New_York' },
];

const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const Team: React.FC = () => {
  const [agents, setAgents] = useState<Agent[]>(mockAgents);
  const [shifts] = useState<AgentShift[]>(mockShifts);
  const [isAgentModalOpen, setIsAgentModalOpen] = useState(false);
  const [, setIsShiftModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [, setSelectedAgentForShifts] = useState<Agent | null>(null);
  const [activeTab, setActiveTab] = useState<'members' | 'agents' | 'shifts' | 'performance'>('members');

  const handleCreateAgent = () => {
    setEditingAgent(null);
    setIsAgentModalOpen(true);
  };

  const handleEditAgent = (agent: Agent) => {
    setEditingAgent(agent);
    setIsAgentModalOpen(true);
  };

  const handleDeleteAgent = async (agentId: string) => {
    if (confirm('Are you sure you want to remove this agent?')) {
      setAgents((prev) => prev.filter((a) => a.id !== agentId));
    }
  };

  const handleSaveAgent = (data: Partial<Agent>) => {
    if (editingAgent) {
      setAgents((prev) =>
        prev.map((a) => (a.id === editingAgent.id ? { ...a, ...data } as Agent : a))
      );
    } else {
      const newAgent: Agent = {
        id: Date.now().toString(),
        userId: Date.now().toString(),
        email: data.email || '',
        firstName: data.firstName || '',
        lastName: data.lastName || '',
        role: data.role || 'agent',
        status: 'offline',
        skills: data.skills || [],
        maxConcurrentChats: data.maxConcurrentChats || 5,
        currentChats: 0,
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      setAgents((prev) => [...prev, newAgent]);
    }
    setIsAgentModalOpen(false);
  };

  const handleManageShifts = (agent: Agent) => {
    setSelectedAgentForShifts(agent);
    setIsShiftModalOpen(true);
  };

  const handleUpdateStatus = (agentId: string, status: UserStatus) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, status } : a))
    );
  };

  const onlineAgents = agents.filter((a) => a.status === 'online').length;
  const totalChats = agents.reduce((sum, a) => sum + (a.performance?.totalChats || 0), 0);
  const avgCsat = agents.length > 0
    ? agents.reduce((sum, a) => sum + (a.performance?.csatScore || 0), 0) / agents.length
    : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Team</h1>
          <p className="text-text-secondary">Manage agents and schedules</p>
        </div>
        <button
          onClick={handleCreateAgent}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow transition-all"
        >
          <Plus className="w-4 h-4" />
          Add Agent
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card p-6">
          <p className="text-sm font-medium text-text-secondary">Total Agents</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{agents.length}</p>
        </div>
        <div className="card p-6">
          <p className="text-sm font-medium text-text-secondary">Online Now</p>
          <p className="text-2xl font-bold font-mono text-status-online">{onlineAgents}</p>
        </div>
        <div className="card p-6">
          <p className="text-sm font-medium text-text-secondary">Total Chats (MTD)</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{totalChats}</p>
        </div>
        <div className="card p-6">
          <p className="text-sm font-medium text-text-secondary">Avg CSAT</p>
          <p className="text-2xl font-bold font-mono text-accent-400">{avgCsat.toFixed(1)}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-edge">
        <nav className="flex gap-6">
          {(['members', 'agents', 'shifts', 'performance'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`
                py-3 text-sm font-medium border-b-2 transition-colors
                ${activeTab === tab
                  ? 'border-primary-500 text-primary-400'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
                }
              `}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'members' && (
        <OrgMembersPanel />
      )}

      {activeTab === 'agents' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-3">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Agent</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Role</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Skills</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Chats</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {agents.map((agent) => (
                  <tr key={agent.id} className="hover:bg-surface-3">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-primary-600/20 flex items-center justify-center">
                          <span className="text-sm font-medium text-primary-400">
                            {agent.firstName[0]}{agent.lastName[0]}
                          </span>
                        </div>
                        <div>
                          <p className="font-medium text-text-primary">{agent.firstName} {agent.lastName}</p>
                          <p className="text-sm text-text-muted">{agent.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <select
                        value={agent.status}
                        onChange={(e) => handleUpdateStatus(agent.id, e.target.value as UserStatus)}
                        className="text-sm bg-surface-3 border border-edge rounded-xl px-2 py-1 text-text-primary focus:outline-none focus:border-primary-500"
                      >
                        <option value="online">Online</option>
                        <option value="away">Away</option>
                        <option value="busy">Busy</option>
                        <option value="offline">Offline</option>
                      </select>
                    </td>
                    <td className="px-6 py-4">
                      <span className="capitalize text-text-secondary">{agent.role}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-1 flex-wrap">
                        {agent.skills?.map((skill) => (
                          <span key={skill} className="px-2 py-0.5 text-xs bg-surface-3 text-text-secondary rounded-full">
                            {skill}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-text-secondary">
                        {agent.currentChats}/{agent.maxConcurrentChats}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleManageShifts(agent)}
                          className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl"
                          title="Manage shifts"
                        >
                          <Calendar className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleEditAgent(agent)}
                          className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteAgent(agent.id)}
                          className="p-2 text-text-secondary hover:text-red-400 hover:bg-red-500/10 rounded-xl"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'shifts' && (
        <div className="card p-6">
          <h3 className="text-lg font-semibold text-text-primary mb-4">Weekly Schedule</h3>
          <div className="grid grid-cols-7 gap-4">
            {daysOfWeek.map((day, index) => (
              <div key={day} className="border border-edge rounded-xl p-4">
                <h4 className="font-medium text-text-primary mb-3">{day}</h4>
                <div className="space-y-2">
                  {shifts
                    .filter((s: AgentShift) => s.dayOfWeek === index)
                    .map((shift: AgentShift) => {
                      const agent = agents.find((a) => a.id === shift.agentId);
                      return (
                        <div key={shift.id} className="text-sm bg-primary-600/10 p-2 rounded-lg">
                          <p className="font-medium text-primary-400">{agent?.firstName}</p>
                          <p className="text-primary-300">{shift.startTime} - {shift.endTime}</p>
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'performance' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-3">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Agent</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">
                    <MessageSquare className="w-4 h-4 inline mr-1" />
                    Total Chats
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">
                    <Clock className="w-4 h-4 inline mr-1" />
                    Avg Response
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">
                    <Star className="w-4 h-4 inline mr-1" />
                    CSAT
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Acceptance Rate</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Online Hours</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {agents.map((agent) => (
                  <tr key={agent.id} className="hover:bg-surface-3">
                    <td className="px-6 py-4">
                      <p className="font-medium text-text-primary">{agent.firstName} {agent.lastName}</p>
                    </td>
                    <td className="px-6 py-4 text-text-secondary">{agent.performance?.totalChats || 0}</td>
                    <td className="px-6 py-4 text-text-secondary">{agent.performance?.avgResponseTime || 0}s</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1">
                        <Star className="w-4 h-4 text-accent-400 fill-accent-400" />
                        <span className="text-text-primary">{agent.performance?.csatScore || 0}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-text-secondary">
                      {agent.performance?.handoffAcceptanceRate || 0}%
                    </td>
                    <td className="px-6 py-4 text-text-secondary">{agent.performance?.onlineHours || 0}h</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Agent Modal */}
      <AgentModal
        isOpen={isAgentModalOpen}
        onClose={() => setIsAgentModalOpen(false)}
        agent={editingAgent}
        onSave={handleSaveAgent}
      />
    </div>
  );
};

// Organization Members Panel
const OrgMembersPanel: React.FC = () => {
  const { organization, memberships, isLoaded } = useOrganization({
    memberships: { infinite: true },
  });
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'org:admin' | 'org:member'>('org:member');
  const [isInviting, setIsInviting] = useState(false);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState(false);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!organization || !inviteEmail.trim()) return;

    setIsInviting(true);
    setInviteError(null);
    try {
      await organization.inviteMember({
        emailAddress: inviteEmail.trim(),
        role: inviteRole,
      });
      setInviteEmail('');
      setInviteSuccess(true);
      setTimeout(() => setInviteSuccess(false), 3000);
      setShowInviteForm(false);
    } catch (err: any) {
      setInviteError(err?.errors?.[0]?.message || err?.message || 'Failed to send invite');
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!organization || !confirm('Remove this member from the organization?')) return;
    try {
      await organization.removeMember(userId);
    } catch (err: any) {
      alert(err?.errors?.[0]?.message || 'Failed to remove member');
    }
  };

  const handleUpdateRole = async (userId: string, role: string) => {
    if (!organization) return;
    try {
      await organization.updateMember({ userId, role });
    } catch (err: any) {
      alert(err?.errors?.[0]?.message || 'Failed to update role');
    }
  };

  if (!isLoaded) {
    return (
      <div className="card p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-surface-3 rounded w-1/4" />
          <div className="h-12 bg-surface-3 rounded" />
          <div className="h-12 bg-surface-3 rounded" />
        </div>
      </div>
    );
  }

  const members = memberships?.data || [];

  return (
    <div className="space-y-4">
      {/* Invite success */}
      {inviteSuccess && (
        <div className="p-4 bg-status-online/10 border border-status-online/20 rounded-xl flex items-center gap-2 text-status-online text-sm">
          Invitation sent successfully!
        </div>
      )}

      {/* Invite form */}
      {showInviteForm && (
        <div className="card p-6">
          <h3 className="text-lg font-semibold text-text-primary mb-4">Invite Member</h3>
          <form onSubmit={handleInvite} className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-text-secondary mb-1">Email</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@company.com"
                className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Role</label>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'org:admin' | 'org:member')}
                className="px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500"
              >
                <option value="org:member">Member</option>
                <option value="org:admin">Admin</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={isInviting}
              className="px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow disabled:opacity-50 transition-all"
            >
              {isInviting ? 'Sending...' : 'Send Invite'}
            </button>
            <button
              type="button"
              onClick={() => setShowInviteForm(false)}
              className="px-4 py-2 border border-edge text-text-secondary rounded-xl hover:bg-surface-3"
            >
              Cancel
            </button>
          </form>
          {inviteError && (
            <p className="mt-2 text-sm text-red-400">{inviteError}</p>
          )}
        </div>
      )}

      {/* Members table */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary">
            Members <span className="text-text-muted font-normal">({members.length})</span>
          </h3>
          {!showInviteForm && (
            <button
              onClick={() => setShowInviteForm(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-primary-600 text-white text-sm rounded-xl hover:bg-primary-500 hover:shadow-glow transition-all"
            >
              <Plus className="w-4 h-4" />
              Invite
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-surface-3">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">User</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Joined</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Role</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {members.map((membership: any) => {
                const user = membership.publicUserData;
                const initials = `${user?.firstName?.[0] || ''}${user?.lastName?.[0] || user?.identifier?.[0] || '?'}`;
                const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.identifier || 'Unknown';
                const email = user?.identifier || '';
                const joinedDate = new Date(membership.createdAt).toLocaleDateString();

                return (
                  <tr key={membership.id} className="hover:bg-surface-3">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {user?.imageUrl ? (
                          <img src={user.imageUrl} alt="" className="w-10 h-10 rounded-full" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-primary-600/20 flex items-center justify-center">
                            <span className="text-sm font-medium text-primary-400">{initials}</span>
                          </div>
                        )}
                        <div>
                          <p className="font-medium text-text-primary">{name}</p>
                          <p className="text-sm text-text-muted">{email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-text-secondary text-sm">{joinedDate}</td>
                    <td className="px-6 py-4">
                      <select
                        value={membership.role}
                        onChange={(e) => handleUpdateRole(user?.userId, e.target.value)}
                        className="text-sm bg-surface-3 border border-edge rounded-xl px-2 py-1 text-text-primary focus:outline-none focus:border-primary-500"
                      >
                        <option value="org:admin">Admin</option>
                        <option value="org:member">Member</option>
                      </select>
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => handleRemoveMember(user?.userId)}
                        className="p-2 text-text-secondary hover:text-red-400 hover:bg-red-500/10 rounded-xl"
                        title="Remove member"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// Agent Modal Component
interface AgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  agent: Agent | null;
  onSave: (data: Partial<Agent>) => void;
}

const AgentModal: React.FC<AgentModalProps> = ({ isOpen, onClose, agent, onSave }) => {
  const [formData, setFormData] = useState<Partial<Agent>>({
    firstName: agent?.firstName || '',
    lastName: agent?.lastName || '',
    email: agent?.email || '',
    role: agent?.role || 'agent',
    maxConcurrentChats: agent?.maxConcurrentChats || 5,
    skills: agent?.skills || [],
  });

  const [skillInput, setSkillInput] = useState('');

  const handleAddSkill = () => {
    if (skillInput.trim() && !formData.skills?.includes(skillInput.trim())) {
      setFormData({ ...formData, skills: [...(formData.skills || []), skillInput.trim()] });
      setSkillInput('');
    }
  };

  const handleRemoveSkill = (skill: string) => {
    setFormData({ ...formData, skills: formData.skills?.filter((s) => s !== skill) || [] });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={agent ? 'Edit Agent' : 'Add Agent'} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">First Name</label>
            <input
              type="text"
              value={formData.firstName}
              onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
              className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Last Name</label>
            <input
              type="text"
              value={formData.lastName}
              onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
              className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
              required
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Email</label>
          <input
            type="email"
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Role</label>
            <select
              value={formData.role}
              onChange={(e) => setFormData({ ...formData, role: e.target.value as Agent['role'] })}
              className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
            >
              <option value="agent">Agent</option>
              <option value="supervisor">Supervisor</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Max Concurrent Chats</label>
            <input
              type="number"
              value={formData.maxConcurrentChats}
              onChange={(e) => setFormData({ ...formData, maxConcurrentChats: parseInt(e.target.value) })}
              className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
              min={1}
              max={10}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Skills</label>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={skillInput}
              onChange={(e) => setSkillInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddSkill())}
              className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
              placeholder="Add a skill..."
            />
            <button
              type="button"
              onClick={handleAddSkill}
              className="px-4 py-2 bg-surface-3 text-text-secondary rounded-xl hover:bg-surface-4 border border-edge"
            >
              Add
            </button>
          </div>
          <div className="flex gap-2 flex-wrap">
            {formData.skills?.map((skill) => (
              <span key={skill} className="inline-flex items-center gap-1 px-2 py-1 bg-primary-600/20 text-primary-400 rounded-full text-sm">
                {skill}
                <button type="button" onClick={() => handleRemoveSkill(skill)} className="hover:text-primary-300">
                  ×
                </button>
              </span>
            ))}
          </div>
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
            {agent ? 'Save Changes' : 'Create Agent'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default Team;
