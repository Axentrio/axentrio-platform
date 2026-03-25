/**
 * Team Page
 * Agent management, shifts, SLA monitoring
 */

import React, { useState } from 'react';
import { Plus, Edit2, Trash2, Clock, Star, MessageSquare, Calendar } from 'lucide-react';
import { useOrganization } from '@clerk/clerk-react';
import { Modal } from '@components/Modal';
import type { Agent, AgentShift, UserStatus } from '@app-types/index';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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

  // AlertDialog state for delete agent
  const [deleteAgentId, setDeleteAgentId] = useState<string | null>(null);

  const handleCreateAgent = () => {
    setEditingAgent(null);
    setIsAgentModalOpen(true);
  };

  const handleEditAgent = (agent: Agent) => {
    setEditingAgent(agent);
    setIsAgentModalOpen(true);
  };

  const handleDeleteAgent = (agentId: string) => {
    setDeleteAgentId(agentId);
  };

  const confirmDeleteAgent = () => {
    if (deleteAgentId) {
      setAgents((prev) => prev.filter((a) => a.id !== deleteAgentId));
      setDeleteAgentId(null);
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
        <Button onClick={handleCreateAgent}>
          <Plus className="w-4 h-4 mr-2" />
          Add Agent
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card variant="glass" className="p-6">
          <p className="text-sm font-medium text-text-secondary">Total Agents</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{agents.length}</p>
        </Card>
        <Card variant="glass" className="p-6">
          <p className="text-sm font-medium text-text-secondary">Online Now</p>
          <p className="text-2xl font-bold font-mono text-status-online">{onlineAgents}</p>
        </Card>
        <Card variant="glass" className="p-6">
          <p className="text-sm font-medium text-text-secondary">Total Chats (MTD)</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{totalChats}</p>
        </Card>
        <Card variant="glass" className="p-6">
          <p className="text-sm font-medium text-text-secondary">Avg CSAT</p>
          <p className="text-2xl font-bold font-mono text-accent-400">{avgCsat.toFixed(1)}</p>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="shifts">Shifts</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
        </TabsList>

        {/* Tab Content */}
        <TabsContent value="members">
          <OrgMembersPanel />
        </TabsContent>

        <TabsContent value="agents">
          <Card variant="glass" className="overflow-hidden">
            <Table>
              <TableHeader className="bg-surface-3">
                <TableRow>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">Agent</TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">Status</TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">Role</TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">Skills</TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">Chats</TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell>
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
                    </TableCell>
                    <TableCell>
                      <Select
                        value={agent.status}
                        onValueChange={(value) => handleUpdateStatus(agent.id, value as UserStatus)}
                      >
                        <SelectTrigger className="w-[110px] h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="online">Online</SelectItem>
                          <SelectItem value="away">Away</SelectItem>
                          <SelectItem value="busy">Busy</SelectItem>
                          <SelectItem value="offline">Offline</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <span className="capitalize text-text-secondary">{agent.role}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {agent.skills?.map((skill) => (
                          <Badge key={skill} variant="secondary">
                            {skill}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-text-secondary">
                        {agent.currentChats}/{agent.maxConcurrentChats}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleManageShifts(agent)}
                          title="Manage shifts"
                        >
                          <Calendar className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEditAgent(agent)}
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteAgent(agent.id)}
                          className="hover:text-red-400 hover:bg-red-500/10"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="shifts">
          <Card variant="glass" className="p-6">
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
          </Card>
        </TabsContent>

        <TabsContent value="performance">
          <Card variant="glass" className="overflow-hidden">
            <Table>
              <TableHeader className="bg-surface-3">
                <TableRow>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">Agent</TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">
                    <MessageSquare className="w-4 h-4 inline mr-1" />
                    Total Chats
                  </TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">
                    <Clock className="w-4 h-4 inline mr-1" />
                    Avg Response
                  </TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">
                    <Star className="w-4 h-4 inline mr-1" />
                    CSAT
                  </TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">Acceptance Rate</TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">Online Hours</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <p className="font-medium text-text-primary">{agent.firstName} {agent.lastName}</p>
                    </TableCell>
                    <TableCell className="text-text-secondary">{agent.performance?.totalChats || 0}</TableCell>
                    <TableCell className="text-text-secondary">{agent.performance?.avgResponseTime || 0}s</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Star className="w-4 h-4 text-accent-400 fill-accent-400" />
                        <span className="text-text-primary">{agent.performance?.csatScore || 0}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-text-secondary">
                      {agent.performance?.handoffAcceptanceRate || 0}%
                    </TableCell>
                    <TableCell className="text-text-secondary">{agent.performance?.onlineHours || 0}h</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Agent Modal */}
      <AgentModal
        isOpen={isAgentModalOpen}
        onClose={() => setIsAgentModalOpen(false)}
        agent={editingAgent}
        onSave={handleSaveAgent}
      />

      {/* Delete Agent AlertDialog */}
      <AlertDialog open={!!deleteAgentId} onOpenChange={(open) => !open && setDeleteAgentId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Agent</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this agent? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteAgent}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

  // AlertDialog state for remove member
  const [removeMemberUserId, setRemoveMemberUserId] = useState<string | null>(null);
  const [removeMemberError, setRemoveMemberError] = useState<string | null>(null);

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

  const confirmRemoveMember = async () => {
    if (!organization || !removeMemberUserId) return;
    try {
      await organization.removeMember(removeMemberUserId);
      setRemoveMemberUserId(null);
      setRemoveMemberError(null);
    } catch (err: any) {
      setRemoveMemberError(err?.errors?.[0]?.message || 'Failed to remove member');
    }
  };

  const handleUpdateRole = async (userId: string, role: string) => {
    if (!organization) return;
    try {
      await organization.updateMember({ userId, role });
    } catch (err: any) {
      // Inline error handling — role update errors are non-critical
      console.error('Failed to update role:', err?.errors?.[0]?.message || err?.message);
    }
  };

  if (!isLoaded) {
    return (
      <Card variant="glass" className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-surface-3 rounded w-1/4" />
          <div className="h-12 bg-surface-3 rounded" />
          <div className="h-12 bg-surface-3 rounded" />
        </div>
      </Card>
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
        <Card variant="glass" className="p-6">
          <h3 className="text-lg font-semibold text-text-primary mb-4">Invite Member</h3>
          <form onSubmit={handleInvite} className="flex items-end gap-3">
            <div className="flex-1">
              <Label className="mb-1 text-text-secondary">Email</Label>
              <Input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@company.com"
                required
              />
            </div>
            <div>
              <Label className="mb-1 text-text-secondary">Role</Label>
              <Select
                value={inviteRole}
                onValueChange={(value) => setInviteRole(value as 'org:admin' | 'org:member')}
              >
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="org:member">Member</SelectItem>
                  <SelectItem value="org:admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={isInviting}>
              {isInviting ? 'Sending...' : 'Send Invite'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowInviteForm(false)}
            >
              Cancel
            </Button>
          </form>
          {inviteError && (
            <p className="mt-2 text-sm text-red-400">{inviteError}</p>
          )}
        </Card>
      )}

      {/* Members table */}
      <Card variant="glass" className="overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary">
            Members <span className="text-text-muted font-normal">({members.length})</span>
          </h3>
          {!showInviteForm && (
            <Button size="sm" onClick={() => setShowInviteForm(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Invite
            </Button>
          )}
        </div>
        <Table>
          <TableHeader className="bg-surface-3">
            <TableRow>
              <TableHead className="text-xs font-medium text-text-secondary uppercase">User</TableHead>
              <TableHead className="text-xs font-medium text-text-secondary uppercase">Joined</TableHead>
              <TableHead className="text-xs font-medium text-text-secondary uppercase">Role</TableHead>
              <TableHead className="text-xs font-medium text-text-secondary uppercase">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((membership: any) => {
              const user = membership.publicUserData;
              const initials = `${user?.firstName?.[0] || ''}${user?.lastName?.[0] || user?.identifier?.[0] || '?'}`;
              const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.identifier || 'Unknown';
              const email = user?.identifier || '';
              const joinedDate = new Date(membership.createdAt).toLocaleDateString();

              return (
                <TableRow key={membership.id}>
                  <TableCell>
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
                  </TableCell>
                  <TableCell className="text-text-secondary text-sm">{joinedDate}</TableCell>
                  <TableCell>
                    <Select
                      value={membership.role}
                      onValueChange={(value) => handleUpdateRole(user?.userId, value)}
                    >
                      <SelectTrigger className="w-[120px] h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="org:admin">Admin</SelectItem>
                        <SelectItem value="org:member">Member</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setRemoveMemberUserId(user?.userId)}
                      className="hover:text-red-400 hover:bg-red-500/10"
                      title="Remove member"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {/* Remove Member AlertDialog */}
      <AlertDialog open={!!removeMemberUserId} onOpenChange={(open) => { if (!open) { setRemoveMemberUserId(null); setRemoveMemberError(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Member</AlertDialogTitle>
            <AlertDialogDescription>
              Remove this member from the organization? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeMemberError && (
            <p className="text-sm text-red-400">{removeMemberError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoveMember}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
            <Label className="mb-1 text-text-secondary">First Name</Label>
            <Input
              type="text"
              value={formData.firstName}
              onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
              required
            />
          </div>
          <div>
            <Label className="mb-1 text-text-secondary">Last Name</Label>
            <Input
              type="text"
              value={formData.lastName}
              onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
              required
            />
          </div>
        </div>

        <div>
          <Label className="mb-1 text-text-secondary">Email</Label>
          <Input
            type="email"
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="mb-1 text-text-secondary">Role</Label>
            <Select
              value={formData.role}
              onValueChange={(value) => setFormData({ ...formData, role: value as Agent['role'] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="supervisor">Supervisor</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 text-text-secondary">Max Concurrent Chats</Label>
            <Input
              type="number"
              value={formData.maxConcurrentChats}
              onChange={(e) => setFormData({ ...formData, maxConcurrentChats: parseInt(e.target.value) })}
              min={1}
              max={10}
            />
          </div>
        </div>

        <div>
          <Label className="mb-1 text-text-secondary">Skills</Label>
          <div className="flex gap-2 mb-2">
            <Input
              type="text"
              value={skillInput}
              onChange={(e) => setSkillInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddSkill())}
              placeholder="Add a skill..."
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleAddSkill}
            >
              Add
            </Button>
          </div>
          <div className="flex gap-2 flex-wrap">
            {formData.skills?.map((skill) => (
              <Badge key={skill} variant="secondary" className="inline-flex items-center gap-1">
                {skill}
                <button type="button" onClick={() => handleRemoveSkill(skill)} className="hover:text-primary-300">
                  ×
                </button>
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit">
            {agent ? 'Save Changes' : 'Create Agent'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default Team;
