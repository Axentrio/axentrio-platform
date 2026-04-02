export const queryKeys = {
  agents: {
    all: () => ['agents'] as const,
    lists: () => [...queryKeys.agents.all(), 'list'] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.agents.lists(), filters] as const,
    detail: (id: string) => [...queryKeys.agents.all(), 'detail', id] as const,
    performance: (id: string) => [...queryKeys.agents.detail(id), 'performance'] as const,
    shifts: (id: string) => [...queryKeys.agents.detail(id), 'shifts'] as const,
  },
  tenants: {
    all: () => ['tenants'] as const,
    me: () => [...queryKeys.tenants.all(), 'me'] as const,
    lists: () => [...queryKeys.tenants.all(), 'list'] as const,
    detail: (id: string) => [...queryKeys.tenants.all(), 'detail', id] as const,
    auditLogs: (id: string) => [...queryKeys.tenants.detail(id), 'audit-logs'] as const,
    members: () => [...queryKeys.tenants.me(), 'members'] as const,
    invites: () => [...queryKeys.tenants.me(), 'invites'] as const,
  },
  chats: {
    all: () => ['chats'] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.chats.all(), 'list', filters] as const,
    detail: (id: string) => [...queryKeys.chats.all(), 'detail', id] as const,
    messages: (id: string) => [...queryKeys.chats.detail(id), 'messages'] as const,
  },
  handoffs: {
    all: () => ['handoffs'] as const,
    list: (status?: string) => [...queryKeys.handoffs.all(), 'list', status] as const,
  },
  webhooks: {
    all: () => ['webhooks'] as const,
    status: () => [...queryKeys.webhooks.all(), 'status'] as const,
    deliveries: (page?: number) => [...queryKeys.webhooks.all(), 'deliveries', page] as const,
  },
  dashboard: {
    all: () => ['dashboard'] as const,
    metrics: () => [...queryKeys.dashboard.all(), 'metrics'] as const,
  },
  notifications: {
    all: () => ['notifications'] as const,
    list: () => [...queryKeys.notifications.all(), 'list'] as const,
  },
  analytics: {
    all: () => ['analytics'] as const,
    timeseries: (startDate?: string, endDate?: string) => [...queryKeys.analytics.all(), 'timeseries', startDate, endDate] as const,
    chatMetrics: (from?: string, to?: string) => [...queryKeys.analytics.all(), 'chat-metrics', from, to] as const,
    agents: () => [...queryKeys.analytics.all(), 'agents'] as const,
  },
  knowledge: {
    all: () => ['knowledge'] as const,
    base: () => [...queryKeys.knowledge.all(), 'base'] as const,
    documents: () => [...queryKeys.knowledge.all(), 'documents'] as const,
    stats: () => [...queryKeys.knowledge.all(), 'stats'] as const,
  },
  cannedResponses: {
    all: () => ['cannedResponses'] as const,
    lists: () => [...queryKeys.cannedResponses.all(), 'list'] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.cannedResponses.lists(), filters] as const,
    detail: (id: string) => [...queryKeys.cannedResponses.all(), 'detail', id] as const,
  },
  admin: {
    all: () => ['admin'] as const,
    users: () => [...queryKeys.admin.all(), 'users'] as const,
    analytics: () => [...queryKeys.admin.all(), 'analytics'] as const,
    tenants: () => [...queryKeys.admin.all(), 'tenants'] as const,
    tenantDetail: (id: string) => [...queryKeys.admin.all(), 'tenant-detail', id] as const,
    tenantAudit: (id: string) => [...queryKeys.admin.tenantDetail(id), 'audit'] as const,
    auditLogs: () => [...queryKeys.admin.all(), 'audit-logs'] as const,
  },
  integrations: {
    all: () => ['integrations'] as const,
    calcom: () => [...queryKeys.integrations.all(), 'calcom'] as const,
  },
};
