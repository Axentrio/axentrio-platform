import crypto from 'crypto';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { User } from '../../database/entities/User';
import { Agent } from '../../database/entities/Agent';
import { ChatSession } from '../../database/entities/ChatSession';
import { Participant } from '../../database/entities/Participant';
import { Message } from '../../database/entities/Message';

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
      ...overrides,
    }),
  );
}

export async function createTestParticipant(
  sessionId: string,
  tenantId: string,
  overrides: Partial<Participant> = {},
): Promise<Participant> {
  const repo = AppDataSource.getRepository(Participant);
  return repo.save(
    repo.create({
      sessionId,
      tenantId,
      participantType: 'visitor',
      participantId: `visitor-${crypto.randomBytes(4).toString('hex')}`,
      name: 'Test Visitor',
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
