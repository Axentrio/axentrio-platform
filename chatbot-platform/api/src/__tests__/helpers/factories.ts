import crypto from 'crypto';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { User } from '../../database/entities/User';
import { Agent } from '../../database/entities/Agent';
import { ChatSession } from '../../database/entities/ChatSession';
import { Participant } from '../../database/entities/Participant';
import { Message } from '../../database/entities/Message';
import { AuditLog } from '../../database/entities/AuditLog';
import { PendingInvite } from '../../database/entities/PendingInvite';
import { HandoffRequest } from '../../database/entities/HandoffRequest';

export async function createTestTenant(overrides: Partial<Tenant> = {}): Promise<Tenant> {
  const repo = AppDataSource.getRepository(Tenant);
  return repo.save(
    repo.create({
      name: 'Test Tenant',
      slug: `test-${crypto.randomBytes(4).toString('hex')}`,
      apiKey: `cb_${crypto.randomBytes(32).toString('base64url')}`,
      tier: 'pro',
      status: 'active',
      settings: {},
      ...overrides,
    }),
  );
}

export async function createTestUser(
  tenantId: string,
  overrides: Partial<User> = {},
): Promise<User> {
  const repo = AppDataSource.getRepository(User);
  return repo.save(
    repo.create({
      tenantId,
      email: `user-${crypto.randomBytes(4).toString('hex')}@test.com`,
      name: 'Test User',
      clerkUserId: `clerk_${crypto.randomBytes(8).toString('hex')}`,
      role: 'admin',
      isActive: true,
      ...overrides,
    }),
  );
}

export async function createTestAgent(
  tenantId: string,
  userId: string,
  overrides: Partial<Agent> = {},
): Promise<Agent> {
  const repo = AppDataSource.getRepository(Agent);
  return repo.save(
    repo.create({
      tenantId,
      userId,
      status: 'online',
      maxConcurrentChats: 5,
      currentChatCount: 0,
      ...overrides,
    }),
  );
}

export async function createTestSession(
  tenantId: string,
  overrides: Partial<ChatSession> = {},
): Promise<ChatSession> {
  const repo = AppDataSource.getRepository(ChatSession);
  return repo.save(
    repo.create({
      tenantId,
      visitorId: `visitor-${crypto.randomBytes(4).toString('hex')}`,
      status: 'active',
      source: 'widget',
      messageCount: 0,
      unreadCount: 0,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      ...overrides,
    }),
  );
}

export async function createTestParticipant(
  sessionId: string,
  overrides: Partial<Participant> = {},
): Promise<Participant> {
  const repo = AppDataSource.getRepository(Participant);
  return repo.save(
    repo.create({
      sessionId,
      type: 'user',
      name: 'Test Visitor',
      joinedAt: new Date(),
      ...overrides,
    }),
  );
}

export async function createTestMessage(
  sessionId: string,
  tenantId: string,
  participantId: string,
  overrides: Partial<Message> = {},
): Promise<Message> {
  const repo = AppDataSource.getRepository(Message);
  return repo.save(
    repo.create({
      sessionId,
      tenantId,
      participantId,
      type: 'text',
      content: 'Test message',
      status: 'sent',
      ...overrides,
    }),
  );
}

export async function createTestAuditLog(overrides: Partial<AuditLog> = {}): Promise<AuditLog> {
  const repo = AppDataSource.getRepository(AuditLog);
  return repo.save(
    repo.create({
      actorId: crypto.randomUUID(),
      action: 'test.action',
      entityType: 'test',
      entityId: crypto.randomUUID(),
      ...overrides,
    }),
  );
}

export async function createTestPendingInvite(
  tenantId: string,
  overrides: Partial<PendingInvite> = {},
): Promise<PendingInvite> {
  const repo = AppDataSource.getRepository(PendingInvite);
  return repo.save(
    repo.create({
      tenantId,
      email: `invite-${crypto.randomBytes(4).toString('hex')}@test.com`,
      role: 'agent',
      invitedBy: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ...overrides,
    }),
  );
}

export async function createTestHandoffRequest(
  sessionId: string,
  tenantId: string,
  overrides: Partial<HandoffRequest> = {},
): Promise<HandoffRequest> {
  const repo = AppDataSource.getRepository(HandoffRequest);
  return repo.save(
    repo.create({
      sessionId,
      tenantId,
      requestedBy: crypto.randomUUID(),
      requestedAt: new Date(),
      status: 'requested',
      reason: 'user_request',
      priority: 'medium',
      ...overrides,
    }),
  );
}
