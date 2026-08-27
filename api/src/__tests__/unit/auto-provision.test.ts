import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

vi.mock('../../config/environment', () => ({
  config: {
    onboarding: { grantProTrial: false },
    superAdmin: { emails: [] as string[] },
    env: 'test',
  },
}));

vi.mock('../../config/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetAuth = vi.fn();

vi.mock('@clerk/express', () => ({
  getAuth: (...args: unknown[]) => mockGetAuth(...args),
  clerkClient: {
    organizations: {
      getOrganization: vi.fn(),
      getOrganizationMembershipList: vi.fn(),
    },
    users: {
      getUser: vi.fn(),
    },
  },
}));

// Entities are used as runtime values (`manager.findOne(Tenant, …)`,
// `.into(User)`), so they must exist — but they never need TypeORM metadata
// here because the data source itself is mocked.
const { TenantEntity, UserEntity, AgentEntity, PendingInviteEntity } = vi.hoisted(() => ({
  TenantEntity: class Tenant {},
  UserEntity: class User {},
  AgentEntity: class Agent {},
  PendingInviteEntity: class PendingInvite {},
}));

vi.mock('../../database/entities/Tenant', () => ({ Tenant: TenantEntity }));
vi.mock('../../database/entities/User', () => ({ User: UserEntity }));
vi.mock('../../database/entities/Agent', () => ({ Agent: AgentEntity }));
vi.mock('../../database/entities/PendingInvite', () => ({ PendingInvite: PendingInviteEntity }));

const mockGetRepository = vi.fn();
const mockRunInTransaction = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: (entity: unknown) => mockGetRepository(entity) },
  runInTransaction: (fn: unknown) => mockRunInTransaction(fn),
}));

vi.mock('../../billing/service', () => ({
  grantOnboardingProTrial: vi.fn(),
}));

vi.mock('../../services/bot-config.service', () => ({
  ensureAnchorBot: vi.fn(async () => ({ id: 'bot-1' })),
}));

vi.mock('../../knowledge/attach-shared-kb', () => ({
  ensureSharedKbAttached: vi.fn(),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import type { NextFunction, Response } from 'express';
import { autoProvision, type ProvisionedRequest } from '../../middleware/clerk.middleware';
import { ApiError, BadRequestError } from '../../middleware/error-handler';
import { ERROR_CODES } from '../../middleware/error-codes';

// ── Fixtures ────────────────────────────────────────────────────────────────

interface FakeRepo {
  findOne: Mock;
  save: Mock;
  remove: Mock;
  createQueryBuilder: Mock;
}

function makeRepo(): FakeRepo {
  const insertChain: Record<string, unknown> = {};
  const chain = {
    insert: () => insertChain,
    into: () => insertChain,
    values: () => insertChain,
    orIgnore: () => insertChain,
    execute: vi.fn(async () => ({ raw: [] })),
    where: () => chain,
    andWhere: () => chain,
    getOne: vi.fn(async () => null),
    getMany: vi.fn(async () => []),
  };
  Object.assign(insertChain, chain);
  return {
    findOne: vi.fn(async () => null),
    save: vi.fn(async (x: unknown) => x),
    remove: vi.fn(async () => undefined),
    createQueryBuilder: vi.fn(() => chain),
  };
}

let tenantRepo: FakeRepo;
let userRepo: FakeRepo;
let agentRepo: FakeRepo;
let pendingInviteRepo: FakeRepo;

function makeTenant(overrides: Record<string, unknown> = {}) {
  return { id: 'tenant-1', name: 'Acme', status: 'active', tier: 'free', ...overrides };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'jane@acme.test',
    name: 'Jane Doe',
    role: 'admin',
    emailVerified: true,
    ...overrides,
  };
}

function run(orgId: string | null, userId = 'clerk_user_1') {
  mockGetAuth.mockReturnValue({ userId, orgId });
  const req = {} as ProvisionedRequest;
  const next = vi.fn() as unknown as NextFunction;
  return {
    req,
    next: next as unknown as Mock,
    done: autoProvision(req, {} as Response, next),
  };
}

describe('autoProvision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantRepo = makeRepo();
    userRepo = makeRepo();
    agentRepo = makeRepo();
    pendingInviteRepo = makeRepo();
    mockGetRepository.mockImplementation((entity: unknown) => {
      if (entity === TenantEntity) return tenantRepo;
      if (entity === UserEntity) return userRepo;
      if (entity === AgentEntity) return agentRepo;
      if (entity === PendingInviteEntity) return pendingInviteRepo;
      throw new Error('unexpected repository requested');
    });
  });

  it('rejects a request with no organization selected', async () => {
    const { next, done } = run(null, 'clerk_user_noorg');
    await done;

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.statusCode).toBe(400);
    expect(mockGetRepository).not.toHaveBeenCalled();
  });

  it('attaches ids for an existing active tenant, user and agent', async () => {
    tenantRepo.findOne.mockResolvedValue(makeTenant());
    userRepo.findOne.mockResolvedValue(makeUser());
    agentRepo.findOne.mockResolvedValue({ id: 'agent-1' });

    const { req, next, done } = run('org_existing', 'clerk_user_existing');
    await done;

    expect(next).toHaveBeenCalledWith();
    expect(req.tenantId).toBe('tenant-1');
    expect(req.userId).toBe('user-1');
    expect(req.agentId).toBe('agent-1');
    expect(req.userRole).toBe('admin');
    expect(req.tenantName).toBe('Acme');
    expect(req.clerkUserId).toBe('clerk_user_existing');
    expect(req.clerkOrgId).toBe('org_existing');
    expect(req.user).toEqual({
      id: 'agent-1',
      email: 'jane@acme.test',
      role: 'admin',
      tenantId: 'tenant-1',
      clerkUserId: 'clerk_user_existing',
      type: 'agent',
    });
    expect(mockRunInTransaction).not.toHaveBeenCalled();
  });

  it('serves a cached resolution without touching the database', async () => {
    tenantRepo.findOne.mockResolvedValue(makeTenant());
    userRepo.findOne.mockResolvedValue(makeUser());
    agentRepo.findOne.mockResolvedValue({ id: 'agent-1' });

    // First pass populates the cache.
    await run('org_cached', 'clerk_user_cached').done;
    expect(mockGetRepository).toHaveBeenCalled();

    mockGetRepository.mockClear();

    const { req, next, done } = run('org_cached', 'clerk_user_cached');
    await done;

    expect(next).toHaveBeenCalledWith();
    expect(mockGetRepository).not.toHaveBeenCalled();
    expect(req.tenantId).toBe('tenant-1');
    expect(req.userId).toBe('user-1');
    expect(req.agentId).toBe('agent-1');
  });

  it('blocks a suspended tenant with TENANT_SUSPENDED', async () => {
    tenantRepo.findOne.mockResolvedValue(makeTenant({ status: 'suspended' }));

    const { next, done } = run('org_suspended', 'clerk_user_suspended');
    await done;

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe(ERROR_CODES.TENANT_SUSPENDED);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('returns PROVISIONING_FAILED when the tenant transaction fails', async () => {
    tenantRepo.findOne.mockResolvedValue(null);
    mockRunInTransaction.mockRejectedValue(new Error('deadlock detected'));

    const { next, done } = run('org_new', 'clerk_user_new');
    await done;

    expect(mockRunInTransaction).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe(ERROR_CODES.PROVISIONING_FAILED);
  });
});
