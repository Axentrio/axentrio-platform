/**
 * Team Page
 * Agent management, shifts, SLA monitoring
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Edit2, Trash2, Clock, Star, MessageSquare, Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import { InlineError } from '@/components/ui/inline-error';
import { useQuery } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '@services/apiClient';
import {
  useAgentList,
  useAgentShifts,
  useUpdateAgent,
  useOptimisticUpdateAgentStatus,
} from '../queries/useAgentQueries';
import { queryKeys } from '../queries/queryKeys';
import {
  useTenantMembers,
  useTenantInvites,
  useInviteMember,
  useResendInvite,
  useCancelInvite,
  useOptimisticUpdateMemberRole,
  useOptimisticDeactivateMember,
  useOptimisticReactivateMember,
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

const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const Team: React.FC = () => {
  const { t } = useTranslation();
  const [isAgentModalOpen, setIsAgentModalOpen] = useState(false);
  const [, setIsShiftModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [, setSelectedAgentForShifts] = useState<Agent | null>(null);

  // Fetch agents from API
  const { data: agentsData, isLoading: agentsLoading } = useAgentList();

  const agentsList = Array.isArray(agentsData) ? agentsData : (agentsData as any)?.data ?? [];
  const agents: Agent[] = agentsList.map(mapApiAgent);

  // Fetch shifts for all visible agents
  const selectedShiftAgent = agents[0]; // shifts tab shows all; fetch per-agent if needed
  const { data: shiftsData } = useAgentShifts(selectedShiftAgent?.id ?? '');
  const shifts: AgentShift[] = shiftsData?.shifts ?? [];

  // Fetch performance for each agent (aggregated)
  const { data: performanceMap } = useQuery({
    queryKey: [...queryKeys.agents.all(), 'performance-batch', agents.map((a) => a.id).join(',')],
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

  // Mutation: update agent status (optimistic)
  const updateStatusMutation = useOptimisticUpdateAgentStatus(queryKeys.agents.list(undefined));

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
    return <PageSkeleton variant="list" rows={6} />;
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">{t('team.header.title')}</h1>
          <p className="text-text-secondary">{t('team.header.subtitle')}</p>
        </div>
        <Button onClick={handleCreateAgent}>
          <Plus className="w-4 h-4" />
          {t('team.agents.actions.add')}
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card variant="glass" className="p-6">
          <p className="text-sm font-medium text-text-secondary">{t('team.stats.totalAgents.label')}</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{agents.length}</p>
        </Card>
        <Card variant="glass" className="p-6">
          <p className="text-sm font-medium text-text-secondary">{t('team.stats.onlineNow.label')}</p>
          <p className="text-2xl font-bold font-mono text-status-online">{onlineAgents}</p>
        </Card>
        <Card variant="glass" className="p-6">
          <p className="text-sm font-medium text-text-secondary">{t('team.stats.totalChatsMtd.label')}</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{totalChats}</p>
        </Card>
        <Card variant="glass" className="p-6">
          <p className="text-sm font-medium text-text-secondary">{t('team.stats.avgCsat.label')}</p>
          <p className="text-2xl font-bold font-mono text-accent-400">{avgCsat.toFixed(1)}</p>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">{t('team.tabs.members')}</TabsTrigger>
          <TabsTrigger value="agents">{t('team.tabs.agents')}</TabsTrigger>
          <TabsTrigger value="shifts">{t('team.tabs.shifts')}</TabsTrigger>
          <TabsTrigger value="performance">{t('team.tabs.performance')}</TabsTrigger>
        </TabsList>

        {/* Tab Content */}
        <TabsContent value="members">
          <OrgMembersPanel />
        </TabsContent>

        <TabsContent value="agents">
          <Card variant="glass" className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('team.agents.columns.agent')}</TableHead>
                  <TableHead>{t('team.agents.columns.status')}</TableHead>
                  <TableHead>{t('team.agents.columns.role')}</TableHead>
                  <TableHead>{t('team.agents.columns.skills')}</TableHead>
                  <TableHead>{t('team.agents.columns.chats')}</TableHead>
                  <TableHead>{t('team.agents.columns.actions')}</TableHead>
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
                          <SelectItem value="online">{t('team.agents.statuses.online')}</SelectItem>
                          <SelectItem value="away">{t('team.agents.statuses.away')}</SelectItem>
                          <SelectItem value="busy">{t('team.agents.statuses.busy')}</SelectItem>
                          <SelectItem value="offline">{t('team.agents.statuses.offline')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <span className="text-text-secondary">{t(`roles.${agent.role}`)}</span>
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
                          title={t('team.agents.actions.manageShifts')}
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
            <h3 className="text-lg font-semibold text-text-primary mb-4">{t('team.shifts.weeklySchedule')}</h3>
            <div className="grid grid-cols-7 gap-4">
              {dayKeys.map((dayKey, index) => (
                <div key={dayKey} className="border border-edge rounded-xl p-4">
                  <h4 className="font-medium text-text-primary mb-3">{t(`team.shifts.days.${dayKey}`)}</h4>
                  <div className="space-y-2">
                    {shifts.flatMap((shift: AgentShift) => {
                      if (shift.dayOfWeek !== index) return [];
                      const agent = agents.find((a) => a.id === shift.agentId);
                      return [
                        <div key={shift.id} className="text-sm bg-primary-600/10 p-2 rounded-lg">
                          <p className="font-medium text-primary-400">{agent?.firstName}</p>
                          <p className="text-primary-300">{shift.startTime} - {shift.endTime}</p>
                        </div>,
                      ];
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
              <TableHeader>
                <TableRow>
                  <TableHead>{t('team.performance.columns.agent')}</TableHead>
                  <TableHead>
                    <MessageSquare className="w-3.5 h-3.5 inline mr-1.5 -mt-px" />
                    {t('team.performance.columns.totalChats')}
                  </TableHead>
                  <TableHead>
                    <Clock className="w-3.5 h-3.5 inline mr-1.5 -mt-px" />
                    {t('team.performance.columns.avgResponse')}
                  </TableHead>
                  <TableHead>
                    <Star className="w-3.5 h-3.5 inline mr-1.5 -mt-px" />
                    {t('team.performance.columns.csat')}
                  </TableHead>
                  <TableHead>{t('team.performance.columns.activeChats')}</TableHead>
                  <TableHead className="w-12" />
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
                      <TableCell className="text-text-secondary">{t('team.performance.responseSeconds', { count: perf?.avgResponseTimeSeconds ?? 0 })}</TableCell>
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
  const { t } = useTranslation();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('agent');
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [mutatingRowIds, setMutatingRowIds] = useState<Set<string>>(new Set());

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
  const updateRoleMutation = useOptimisticUpdateMemberRole();

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviteError(null);
    inviteMutation.mutate({ email: inviteEmail.trim(), name: '', role: inviteRole }, {
      onSuccess: () => {
        setInviteEmail('');
        setShowInviteForm(false);
        setInviteError(null);
      },
      onError: (error: any) => {
        setInviteError(
          extractApiErrorMessage(error) ?? t('team.dialogs.invite.errorFallback')
        );
      },
    });
  };

  // Deactivate mutation
  const deactivateMutation = useOptimisticDeactivateMember();

  // Reactivate mutation
  const reactivateMutation = useOptimisticReactivateMember();

  const addMutatingRow = (id: string) =>
    setMutatingRowIds((prev) => new Set(prev).add(id));
  const removeMutatingRow = (id: string) =>
    setMutatingRowIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const confirmRemoveMember = () => {
    if (removeMemberUserId) {
      deactivateMutation.mutate(removeMemberUserId, {
        onSettled: () => setRemoveMemberUserId(null),
      });
    }
  };

  if (isLoading) {
    return <PageSkeleton variant="list" rows={4} />;
  }

  return (
    <div className="space-y-4">
      {/* Invite form */}
      {showInviteForm && (
        <Card variant="glass" className="p-6 relative">
          <LoadingOverlay isLoading={inviteMutation.isPending} message={t('team.dialogs.invite.sending')} />
          <h3 className="text-lg font-semibold text-text-primary mb-4">{t('team.dialogs.invite.title')}</h3>
          <form onSubmit={handleInvite} className="flex items-end gap-3">
            <div className="flex-1">
              <Label className="mb-1 text-text-secondary">{t('team.dialogs.invite.emailLabel')}</Label>
              <Input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder={t('team.dialogs.invite.emailPlaceholder')}
                required
              />
            </div>
            <div>
              <Label className="mb-1 text-text-secondary">{t('team.dialogs.invite.roleLabel')}</Label>
              <Select
                value={inviteRole}
                onValueChange={(value) => setInviteRole(value)}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{t('roles.admin')}</SelectItem>
                  <SelectItem value="supervisor">{t('roles.supervisor')}</SelectItem>
                  <SelectItem value="agent">{t('roles.agent')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? t('team.dialogs.invite.sendingShort') : t('team.dialogs.invite.send')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowInviteForm(false)}
              disabled={inviteMutation.isPending}
            >
              {t('common.cancel')}
            </Button>
          </form>
          <InlineError message={inviteError} className="mt-2" />
        </Card>
      )}

      {/* Members table */}
      <Card variant="glass" className="overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary">
            {t('team.members.title')} <span className="text-text-muted font-normal">({members.length})</span>
          </h3>
          {!showInviteForm && (
            <Button size="sm" onClick={() => setShowInviteForm(true)}>
              <Plus className="w-4 h-4" />
              {t('team.members.actions.invite')}
            </Button>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('team.members.columns.user')}</TableHead>
              <TableHead>{t('team.members.columns.joined')}</TableHead>
              <TableHead>{t('team.members.columns.role')}</TableHead>
              <TableHead>{t('team.members.columns.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const nameParts = (member.name || '').trim().split(/\s+/);
              const initials = `${nameParts[0]?.[0] || ''}${nameParts[1]?.[0] || member.email?.[0] || '?'}`;
              const joinedDate = new Date(member.createdAt).toLocaleDateString();

              return (
                <TableRow
                  key={member.id}
                  className={cn(
                    mutatingRowIds.has(member.id) && 'opacity-60 pointer-events-none',
                  )}
                >
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
                          {member.name || t('team.members.unknownName')}
                          {!member.isActive && (
                            <Badge className="ml-2 bg-surface-3 text-text-muted border-edge text-xs">{t('team.members.badges.inactive')}</Badge>
                          )}
                        </p>
                        <p className="text-sm text-text-muted">{member.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-text-secondary text-sm">{joinedDate}</TableCell>
                  <TableCell>
                    {member.role === 'super_admin' ? (
                      <span className="text-sm text-text-secondary">{t('roles.super_admin')}</span>
                    ) : (
                      <Select
                        value={member.role}
                        onValueChange={(value) => {
                          addMutatingRow(member.id);
                          updateRoleMutation.mutate(
                            { userId: member.id, role: value },
                            { onSettled: () => removeMutatingRow(member.id) },
                          );
                        }}
                      >
                        <SelectTrigger className="w-[140px] h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">{t('roles.admin')}</SelectItem>
                          <SelectItem value="supervisor">{t('roles.supervisor')}</SelectItem>
                          <SelectItem value="agent">{t('roles.agent')}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {!member.isActive ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            addMutatingRow(member.id);
                            reactivateMutation.mutate(member.id, {
                              onSettled: () => removeMutatingRow(member.id),
                            });
                          }}
                          disabled={reactivateMutation.isPending || mutatingRowIds.has(member.id)}
                          className="text-status-online border-status-online/30 hover:bg-status-online/10"
                        >
                          {t('team.members.actions.reactivate')}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setRemoveMemberUserId(member.id)}
                          className="hover:text-red-400 hover:bg-red-500/10"
                          title={t('team.members.actions.deactivate')}
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
              {t('team.invites.title')} <span className="text-text-muted font-normal">({pendingInvites.length})</span>
            </h3>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('team.invites.columns.email')}</TableHead>
                <TableHead>{t('team.invites.columns.role')}</TableHead>
                <TableHead>{t('team.invites.columns.invitedBy')}</TableHead>
                <TableHead>{t('team.invites.columns.expires')}</TableHead>
                <TableHead>{t('team.invites.columns.actions')}</TableHead>
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
                      <span className="text-text-secondary">{t(`roles.${invite.role}`)}</span>
                    </TableCell>
                    <TableCell className="text-text-secondary text-sm">
                      {invite.invitedBy?.name ?? '\u2014'}
                    </TableCell>
                    <TableCell>
                      {invite.isExpired ? (
                        <Badge className="bg-status-busy/10 text-status-busy border-status-busy/20">{t('team.invites.statuses.expired')}</Badge>
                      ) : (
                        <span className="text-text-secondary text-sm">{t('team.invites.daysLeft', { count: daysLeft })}</span>
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
                          {t('team.invites.actions.resend')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => cancelInviteMutation.mutate(invite.id)}
                          disabled={cancelInviteMutation.isPending}
                          className="text-xs hover:text-red-400 hover:bg-red-500/10"
                        >
                          {t('common.cancel')}
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
            <AlertDialogTitle>{t('team.dialogs.deactivate.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('team.dialogs.deactivate.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); confirmRemoveMember(); }}>{t('team.dialogs.deactivate.confirm')}</AlertDialogAction>
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
  const { t } = useTranslation();
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
    <Modal isOpen={isOpen} onClose={onClose} title={agent ? t('team.dialogs.agent.editTitle') : t('team.dialogs.agent.addTitle')} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="mb-1 text-text-secondary">{t('team.dialogs.agent.firstNameLabel')}</Label>
            <Input
              type="text"
              value={formData.firstName}
              onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
              required
            />
          </div>
          <div>
            <Label className="mb-1 text-text-secondary">{t('team.dialogs.agent.lastNameLabel')}</Label>
            <Input
              type="text"
              value={formData.lastName}
              onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
              required
            />
          </div>
        </div>

        <div>
          <Label className="mb-1 text-text-secondary">{t('team.dialogs.agent.emailLabel')}</Label>
          <Input
            type="email"
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="mb-1 text-text-secondary">{t('team.dialogs.agent.roleLabel')}</Label>
            <Select
              value={formData.role}
              onValueChange={(value) => setFormData({ ...formData, role: value as Agent['role'] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">{t('roles.agent')}</SelectItem>
                <SelectItem value="supervisor">{t('roles.supervisor')}</SelectItem>
                <SelectItem value="admin">{t('roles.admin')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 text-text-secondary">{t('team.dialogs.agent.maxConcurrentChatsLabel')}</Label>
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
          <Label className="mb-1 text-text-secondary">{t('team.dialogs.agent.skillsLabel')}</Label>
          <div className="flex gap-2 mb-2">
            <Input
              type="text"
              value={skillInput}
              onChange={(e) => setSkillInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddSkill())}
              placeholder={t('team.dialogs.agent.skillsPlaceholder')}
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleAddSkill}
            >
              {t('team.dialogs.agent.skillsAdd')}
            </Button>
          </div>
          <div className="flex gap-2 flex-wrap">
            {formData.skills?.map((skill) => (
              <Badge key={skill} variant="secondary" className="inline-flex items-center gap-1">
                {skill}
                <Button variant="ghost" size="icon" type="button" onClick={() => handleRemoveSkill(skill)} className="h-4 w-4 hover:text-primary-300 p-0">
                  ×
                </Button>
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
            {t('common.cancel')}
          </Button>
          <Button type="submit">
            {agent ? t('team.dialogs.agent.saveChanges') : t('team.dialogs.agent.create')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default Team;
