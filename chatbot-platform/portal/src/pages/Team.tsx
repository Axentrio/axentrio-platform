/**
 * Team Page
 * Agent management, shifts, SLA monitoring
 */

import React, { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, Clock, Star, MessageSquare, Calendar } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@services/apiClient';
import {
  useAgentList,
  useAgentShifts,
  useUpdateAgent,
  useUpdateAgentStatus,
} from '../queries/useAgentQueries';
import {
  useTenantMembers,
  useTenantInvites,
  useInviteMember,
  useResendInvite,
  useCancelInvite,
  useUpdateMemberRole,
  useDeactivateMember,
  useReactivateMember,
} from '../queries/useTenantQueries';
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

// API response types
interface ApiAgent {
  id: string;
  name: string;
  email: string;
  role: string;
  status: UserStatus;
  maxConcurrentChats: number;
  currentChatCount: number;
  skills: string[];
  languages: string[];
  lastActiveAt: string;
  createdAt: string;
}

interface PerformanceResponse {
  totalChatsHandled: number;
  avgResponseTimeSeconds: number;
  satisfactionScore: number;
  currentChatCount: number;
}

/** Map API agent shape to the local Agent interface */
function mapApiAgent(a: ApiAgent): Agent {
  const nameParts = a.name.trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  return {
    id: a.id,
    userId: a.id,
    email: a.email,
    firstName,
    lastName,
    role: a.role as Agent['role'],
    status: a.status,
    skills: a.skills ?? [],
    maxConcurrentChats: a.maxConcurrentChats,
    currentChats: a.currentChatCount,
    isActive: a.status !== 'offline',
    createdAt: a.createdAt,
  };
}

const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const Team: React.FC = () => {
  const [isAgentModalOpen, setIsAgentModalOpen] = useState(false);
  const [, setIsShiftModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [, setSelectedAgentForShifts] = useState<Agent | null>(null);

  // Fetch agents from API
  const { data: agentsData, isLoading: agentsLoading } = useAgentList();

  const agents: Agent[] = (agentsData ?? []).map(mapApiAgent);

  // Fetch shifts for all visible agents
  const selectedShiftAgent = agents[0]; // shifts tab shows all; fetch per-agent if needed
  const { data: shiftsData } = useAgentShifts(selectedShiftAgent?.id ?? '');
  const shifts: AgentShift[] = shiftsData?.shifts ?? [];

  // Fetch performance for each agent (aggregated)
  const { data: performanceMap } = useQuery({
    queryKey: ['agents', 'performance', agents.map((a) => a.id).join(',')],
    queryFn: async () => {
      const results: Record<string, PerformanceResponse> = {};
      await Promise.all(
        agents.map(async (agent) => {
          try {
            const perf = await api.get<PerformanceResponse>(`/agents/${agent.id}/performance`);
            results[agent.id] = perf;
          } catch {
            // Performance data unavailable for this agent
          }
        })
      );
      return results;
    },
    enabled: agents.length > 0,
  });

  // Mutation: update agent fields
  const updateAgentMutation = useUpdateAgent();

  // Mutation: update agent status
  const updateStatusMutation = useUpdateAgentStatus();

  const handleCreateAgent = () => {
    setEditingAgent(null);
    setIsAgentModalOpen(true);
  };

  const handleEditAgent = (agent: Agent) => {
    setEditingAgent(agent);
    setIsAgentModalOpen(true);
  };

  const handleSaveAgent = (data: Partial<Agent>) => {
    if (editingAgent) {
      updateAgentMutation.mutate({
        id: editingAgent.id,
        maxConcurrentChats: data.maxConcurrentChats,
        skills: data.skills,
        languages: [],
      });
    }
    // Note: no POST /agents endpoint available — new agent creation is handled via Clerk invite
    setIsAgentModalOpen(false);
  };

  const handleManageShifts = (agent: Agent) => {
    setSelectedAgentForShifts(agent);
    setIsShiftModalOpen(true);
  };

  const handleUpdateStatus = (agentId: string, status: UserStatus) => {
    updateStatusMutation.mutate({ id: agentId, status });
  };

  const onlineAgents = agents.filter((a) => a.status === 'online').length;
  const totalChats = performanceMap
    ? Object.values(performanceMap).reduce((sum, p) => sum + (p.totalChatsHandled || 0), 0)
    : 0;
  const avgCsat = performanceMap && Object.keys(performanceMap).length > 0
    ? Object.values(performanceMap).reduce((sum, p) => sum + (p.satisfactionScore || 0), 0) / Object.keys(performanceMap).length
    : 0;

  if (agentsLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-surface-3 rounded w-1/4" />
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 bg-surface-3 rounded-xl" />
            ))}
          </div>
          <div className="h-64 bg-surface-3 rounded-xl" />
        </div>
      </div>
    );
  }

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
                            {agent.firstName?.[0] || ''}{agent.lastName?.[0] || ''}
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
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">Active Chats</TableHead>
                  <TableHead className="text-xs font-medium text-text-secondary uppercase">-</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => {
                  const perf = performanceMap?.[agent.id];
                  return (
                    <TableRow key={agent.id}>
                      <TableCell>
                        <p className="font-medium text-text-primary">{agent.firstName} {agent.lastName}</p>
                      </TableCell>
                      <TableCell className="text-text-secondary">{perf?.totalChatsHandled ?? 0}</TableCell>
                      <TableCell className="text-text-secondary">{perf?.avgResponseTimeSeconds ?? 0}s</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Star className="w-4 h-4 text-accent-400 fill-accent-400" />
                          <span className="text-text-primary">{perf?.satisfactionScore?.toFixed(1) ?? '0.0'}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {perf?.currentChatCount ?? 0}
                      </TableCell>
                      <TableCell className="text-text-secondary">-</TableCell>
                    </TableRow>
                  );
                })}
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

    </div>
  );
};

// Organization Members Panel — uses backend endpoints for invite and role changes
interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  avatarUrl?: string;
  lastLoginAt?: string;
  createdAt: string;
}

interface PendingInviteItem {
  id: string;
  email: string;
  role: string;
  invitedBy: { name: string; email: string } | null;
  createdAt: string;
  expiresAt: string;
  isExpired: boolean;
}

const OrgMembersPanel: React.FC = () => {
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('agent');
  const [showInviteForm, setShowInviteForm] = useState(false);

  // AlertDialog state for remove member
  const [removeMemberUserId, setRemoveMemberUserId] = useState<string | null>(null);

  // Fetch members from backend
  const { data: membersData, isLoading } = useTenantMembers();

  const members: TeamMember[] = membersData ?? [];

  // Fetch pending invites
  const { data: invitesData } = useTenantInvites();

  const pendingInvites: PendingInviteItem[] = invitesData ?? [];

  const resendMutation = useResendInvite();

  const cancelInviteMutation = useCancelInvite();

  // Invite mutation — calls backend endpoint
  const inviteMutation = useInviteMember();

  // Role change mutation — calls backend endpoint
  const updateRoleMutation = useUpdateMemberRole();

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    inviteMutation.mutate({ email: inviteEmail.trim(), name: '', role: inviteRole }, {
      onSuccess: () => {
        setInviteEmail('');
        setShowInviteForm(false);
      },
    });
  };

  // Deactivate mutation
  const deactivateMutation = useDeactivateMember();

  // Reactivate mutation
  const reactivateMutation = useReactivateMember();

  const confirmRemoveMember = () => {
    if (removeMemberUserId) {
      deactivateMutation.mutate(removeMemberUserId, {
        onSettled: () => setRemoveMemberUserId(null),
      });
    }
  };

  if (isLoading) {
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

  return (
    <div className="space-y-4">
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
                onValueChange={(value) => setInviteRole(value)}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="supervisor">Supervisor</SelectItem>
                  <SelectItem value="agent">Agent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? 'Sending...' : 'Send Invite'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowInviteForm(false)}
            >
              Cancel
            </Button>
          </form>
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
            {members.map((member) => {
              const nameParts = (member.name || '').trim().split(/\s+/);
              const initials = `${nameParts[0]?.[0] || ''}${nameParts[1]?.[0] || member.email?.[0] || '?'}`;
              const joinedDate = new Date(member.createdAt).toLocaleDateString();

              return (
                <TableRow key={member.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      {member.avatarUrl ? (
                        <img src={member.avatarUrl} alt="" className="w-10 h-10 rounded-full" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-primary-600/20 flex items-center justify-center">
                          <span className="text-sm font-medium text-primary-400">{initials}</span>
                        </div>
                      )}
                      <div>
                        <p className="font-medium text-text-primary">
                          {member.name || 'Unknown'}
                          {!member.isActive && (
                            <Badge className="ml-2 bg-surface-3 text-text-muted border-edge text-xs">Inactive</Badge>
                          )}
                        </p>
                        <p className="text-sm text-text-muted">{member.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-text-secondary text-sm">{joinedDate}</TableCell>
                  <TableCell>
                    <Select
                      value={member.role}
                      onValueChange={(value) => updateRoleMutation.mutate({ userId: member.id, role: value })}
                    >
                      <SelectTrigger className="w-[140px] h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="supervisor">Supervisor</SelectItem>
                        <SelectItem value="agent">Agent</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {!member.isActive ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => reactivateMutation.mutate(member.id)}
                          disabled={reactivateMutation.isPending}
                          className="text-status-online border-status-online/30 hover:bg-status-online/10"
                        >
                          Reactivate
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setRemoveMemberUserId(member.id)}
                          className="hover:text-red-400 hover:bg-red-500/10"
                          title="Deactivate member"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {/* Pending Invites */}
      {pendingInvites.length > 0 && (
        <Card variant="glass" className="overflow-hidden">
          <div className="px-6 py-4 border-b border-edge">
            <h3 className="font-semibold text-text-primary">
              Pending Invites <span className="text-text-muted font-normal">({pendingInvites.length})</span>
            </h3>
          </div>
          <Table>
            <TableHeader className="bg-surface-3">
              <TableRow>
                <TableHead className="text-xs font-medium text-text-secondary uppercase">Email</TableHead>
                <TableHead className="text-xs font-medium text-text-secondary uppercase">Role</TableHead>
                <TableHead className="text-xs font-medium text-text-secondary uppercase">Invited By</TableHead>
                <TableHead className="text-xs font-medium text-text-secondary uppercase">Expires</TableHead>
                <TableHead className="text-xs font-medium text-text-secondary uppercase">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pendingInvites.map((invite) => {
                const expiresDate = new Date(invite.expiresAt);
                const daysLeft = Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

                return (
                  <TableRow key={invite.id}>
                    <TableCell className="text-text-primary">{invite.email}</TableCell>
                    <TableCell>
                      <span className="capitalize text-text-secondary">{invite.role}</span>
                    </TableCell>
                    <TableCell className="text-text-secondary text-sm">
                      {invite.invitedBy?.name ?? '\u2014'}
                    </TableCell>
                    <TableCell>
                      {invite.isExpired ? (
                        <Badge className="bg-status-busy/10 text-status-busy border-status-busy/20">Expired</Badge>
                      ) : (
                        <span className="text-text-secondary text-sm">{daysLeft}d left</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => resendMutation.mutate(invite.id)}
                          disabled={resendMutation.isPending}
                          className="text-xs"
                        >
                          Resend
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => cancelInviteMutation.mutate(invite.id)}
                          disabled={cancelInviteMutation.isPending}
                          className="text-xs hover:text-red-400 hover:bg-red-500/10"
                        >
                          Cancel
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Remove Member AlertDialog */}
      <AlertDialog open={!!removeMemberUserId} onOpenChange={(open) => { if (!open) setRemoveMemberUserId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Member</AlertDialogTitle>
            <AlertDialogDescription>
              Remove this member from the organization? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
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

  useEffect(() => {
    setFormData({
      firstName: agent?.firstName || '',
      lastName: agent?.lastName || '',
      email: agent?.email || '',
      role: agent?.role || 'agent',
      maxConcurrentChats: agent?.maxConcurrentChats || 5,
      skills: agent?.skills || [],
    });
  }, [agent]);

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
