/**
 * Clerk Authentication & Auto-Provisioning Middleware
 * Replaces custom JWT auth for portal-facing routes.
 * Widget routes continue using API key auth (unchanged).
 */
import { Request, Response, NextFunction } from 'express';
import type { Repository } from 'typeorm';
import { getAuth } from '@clerk/express';
import { clerkClient } from '@clerk/express';
import crypto from 'crypto';
import { AppDataSource, runInTransaction } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { Agent } from '../database/entities/Agent';
import { ensureSharedKbAttached } from '../knowledge/attach-shared-kb';
import { PendingInvite } from '../database/entities/PendingInvite';
import { config } from '../config/environment';
import { DEFAULT_SKILLS } from '../config/default-skills';
import { DEFAULT_ESCALATION_KEYWORDS } from '../config/default-bot-settings';
import { ensureAnchorBot } from '../services/bot-config.service';
import { logger } from '../utils/logger';
import type { RequestUser, UserRole } from '../types';
import {
  ApiError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
} from './error-handler';
import { ERROR_CODES } from './error-codes';
import { grantOnboardingProTrial } from '../billing/service';

export interface ProvisionedRequest extends Request {
  clerkUserId?: string;
  clerkOrgId?: string;
  tenantId?: string;
  userId?: string;
  agentId?: string;
  userRole?: UserRole;
  tenantName?: string;
  user?: RequestUser;
}

/** Role a freshly provisioned member can receive (never `super_admin`). */
type ProvisionedRole = 'admin' | 'supervisor' | 'agent';

// --- In-memory cache ---

interface CachedIds {
  tenantId: string;
  userId: string;
  agentId: string;
  userRole: UserRole;
  userName: string;
  tenantName: string;
  email: string;
  cachedAt: number;
}

const idCache = new Map<string, CachedIds>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(orgId: string, userId: string): CachedIds | null {
  const key = `${orgId}:${userId}`;
  const cached = idCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;
  if (cached) idCache.delete(key);
  return null;
}

function setCache(orgId: string, userId: string, ids: Omit<CachedIds, 'cachedAt'>) {
  idCache.set(`${orgId}:${userId}`, { ...ids, cachedAt: Date.now() });
}

// --- Middleware: requireClerkAuth ---

export function requireClerkAuth(req: Request, _res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  logger.debug('Clerk auth check', {
    hasAuth: !!auth,
    userId: auth?.userId || null,
    orgId: auth?.orgId || null,
    path: req.path,
    hasAuthHeader: !!req.headers.authorization,
  });
  if (!auth?.userId) {
    return next(new UnauthorizedError('Clerk: Unauthorized - no userId in auth'));
  }
  if (!auth.orgId) {
    return next(new ForbiddenError('Organization required. Select an organization in the portal.'));
  }
  next();
}

// --- Middleware: autoProvision ---

export async function autoProvision(req: ProvisionedRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = getAuth(req);
    const clerkUserId = auth.userId!;
    const clerkOrgId = auth.orgId;

    logger.info('[AutoProvision] Starting', { clerkUserId, clerkOrgId: clerkOrgId || 'NONE' });

    if (!clerkOrgId) {
      logger.warn('[AutoProvision] No orgId in auth token — user may not have selected an organization');
      return next(new BadRequestError('No organization selected. Please select or create an organization.'));
    }

    // Check cache first
    const cached = getCached(clerkOrgId, clerkUserId);
    if (cached) {
      attachToRequest(req, clerkUserId, clerkOrgId, cached);
      return next();
    }

    const tenantRepo = AppDataSource.getRepository(Tenant);
    const userRepo = AppDataSource.getRepository(User);
    const agentRepo = AppDataSource.getRepository(Agent);

    // --- Resolve Tenant ---
    let tenant = await tenantRepo.findOne({ where: { clerkOrgId } });

    if (!tenant) {
      tenant = await provisionTenant(clerkOrgId, tenantRepo);
      if (!tenant) {
        return next(new ApiError('Failed to provision tenant', 500, ERROR_CODES.PROVISIONING_FAILED));
      }
    }

    // --- Block suspended tenants ---
    if (tenant.status === 'suspended') {
      // Use ApiError (not ForbiddenError) because we need a custom `code`;
      // ForbiddenError's constructor has no code parameter. (plan §2.2)
      return next(new ApiError('Organization suspended', 403, ERROR_CODES.TENANT_SUSPENDED));
    }

    // --- Resolve User ---
    let user = await userRepo.findOne({ where: { clerkUserId } });

    if (!user) {
      user = await provisionUser(tenant, clerkOrgId, clerkUserId, userRepo);
      if (!user) {
        return next(new ApiError('Failed to provision user', 500, ERROR_CODES.PROVISIONING_FAILED));
      }
    }

    await syncEmailVerification(user, clerkUserId, userRepo);
    await promoteSuperAdmin(user, userRepo);

    // --- Resolve Agent ---
    const agent = await provisionAgent(tenant.id, user.id, agentRepo);
    if (!agent) {
      return next(new ApiError('Failed to provision agent', 500, ERROR_CODES.PROVISIONING_FAILED));
    }

    // Cache and attach
    const ids = {
      tenantId: tenant.id,
      userId: user.id,
      agentId: agent.id,
      userRole: user.role,
      userName: user.name || user.email?.split('@')[0] || '',
      tenantName: tenant.name,
      email: user.email,
    };
    setCache(clerkOrgId, clerkUserId, ids);
    attachToRequest(req, clerkUserId, clerkOrgId, ids);
    next();
  } catch (error) {
    logger.error('Auto-provisioning error', { error });
    return next(error as Error);
  }
}

// --- Tenant provisioning ---

async function fetchClerkOrgName(clerkOrgId: string): Promise<string> {
  try {
    const org = await clerkClient.organizations.getOrganization({ organizationId: clerkOrgId });
    logger.info('[AutoProvision] Fetched org name from Clerk', { orgName: org.name });
    return org.name;
  } catch (err) {
    // `as Error` keeps the original `err?.message` read; Clerk throws Errors.
    logger.warn('[AutoProvision] Could not fetch Clerk org name', { clerkOrgId, error: (err as Error | undefined)?.message });
    return 'Organization';
  }
}

// ON CONFLICT(clerk_org_id) DO NOTHING makes concurrent autoProvision
// requests race-safe.
async function insertTenantAndBootstrap(
  clerkOrgId: string,
  orgName: string,
  slug: string,
  apiKey: string,
): Promise<Tenant> {
  const result = await runInTransaction(async (manager) => {
    await manager
      .createQueryBuilder()
      .insert()
      .into(Tenant)
      .values({
        name: orgName,
        slug,
        apiKey,
        clerkOrgId,
        tier: 'free',
        status: 'active',
        settings: {
          ai: {
            enabled: true,
            provider: 'openai',
            model: 'gpt-4o-mini',
            brandVoice: {
              name: `${orgName} Assistant`,
              tone: 'friendly',
            },
            guardrails: {
              topicsToAvoid: [],
              escalationKeywords: [...DEFAULT_ESCALATION_KEYWORDS],
              confidenceThreshold: 0.7,
              maxResponseLength: 500,
              greetingMessage: 'Welcome! How can I help you today?',
              fallbackMessage: 'Let me connect you with our team.',
              offHoursMessage: "We're currently outside business hours. We'll get back to you soon.",
            },
          },
          skills: [...DEFAULT_SKILLS],
        },
      })
      .orIgnore() // ON CONFLICT (clerk_org_id) DO NOTHING — race-safe
      .execute();

    // Re-read under the same tx so we see the winning row whether we
    // inserted it or someone else did.
    const t = await manager.findOne(Tenant, { where: { clerkOrgId } });
    if (!t) {
      throw new Error('autoProvision: tenant not found after insert');
    }

    if (config.onboarding.grantProTrial) {
      await grantOnboardingProTrial(t.id, manager);
      t.tier = 'pro';
    }

    const anchor = await ensureAnchorBot(t.id, manager);
    await ensureSharedKbAttached(manager, t.id, anchor.id);

    return { tenant: t };
  });
  return result.tenant;
}

/** Returns the provisioned tenant, or null when the provisioning tx failed. */
async function provisionTenant(clerkOrgId: string, tenantRepo: Repository<Tenant>): Promise<Tenant | null> {
  logger.info('[AutoProvision] Tenant not found, creating...', { clerkOrgId });
  const orgName = await fetchClerkOrgName(clerkOrgId);

  const slug = await ensureUniqueSlug(orgName, tenantRepo);
  const apiKey = crypto.randomBytes(32).toString('hex');

  try {
    const tenant = await insertTenantAndBootstrap(clerkOrgId, orgName, slug, apiKey);
    logger.info('[AutoProvision] Tenant committed', { tenantId: tenant.id });
    logger.info('Auto-provisioned tenant', { tenantId: tenant.id, orgName });
    return tenant;
  } catch (provisionErr) {
    logger.error('[AutoProvision] Tenant provisioning tx FAILED', {
      clerkOrgId,
      // `as Error` keeps the original `provisionErr?.message` read.
      error: (provisionErr as Error | undefined)?.message,
    });
    return null;
  }
}

// --- User provisioning ---

interface ClerkUserProfile {
  email: string;
  name: string;
  /** Verified Clerk emails, lowercased. Used to match PendingInvite rows. */
  clerkEmails: string[];
}

async function fetchClerkUserProfile(clerkUserId: string): Promise<ClerkUserProfile> {
  let email = 'unknown@user.local';
  let name = 'User';
  let clerkEmails: string[] = [];
  try {
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    email = clerkUser.emailAddresses?.[0]?.emailAddress || email;
    name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || name;
    clerkEmails = (clerkUser.emailAddresses || [])
      .filter(e => e.verification?.status === 'verified')
      .map(e => e.emailAddress.toLowerCase());
  } catch {
    logger.warn('Could not fetch Clerk user info', { clerkUserId });
  }
  if (clerkEmails.length === 0) clerkEmails = [email.toLowerCase()];
  return { email, name, clerkEmails };
}

/** Backwards compat: fall back to Clerk membership role for Clerk Dashboard invites. */
async function fetchClerkMembershipRole(clerkOrgId: string, clerkUserId: string): Promise<ProvisionedRole> {
  try {
    const memberships = await clerkClient.organizations.getOrganizationMembershipList({
      organizationId: clerkOrgId,
      limit: 100,
    });
    const membership = memberships.data?.find((m) => m.publicUserData?.userId === clerkUserId);
    if (membership?.role === 'org:admin') return 'admin';
    if (membership?.role === 'org:supervisor') return 'supervisor';
  } catch {
    logger.warn('Could not fetch Clerk membership role', { clerkUserId, clerkOrgId });
  }
  return 'agent';
}

/** PendingInvite bridges invite→signup role assignment. */
async function resolveInviteeRole(
  tenantId: string,
  clerkOrgId: string,
  clerkUserId: string,
  profile: ClerkUserProfile,
): Promise<ProvisionedRole> {
  const pendingInviteRepo = AppDataSource.getRepository(PendingInvite);
  const pendingInvite = await pendingInviteRepo
    .createQueryBuilder('pi')
    .where('pi.tenantId = :tenantId', { tenantId })
    .andWhere('pi.email IN (:...emails)', { emails: profile.clerkEmails })
    .andWhere('pi.expiresAt > NOW()')
    .getOne();

  if (!pendingInvite) return fetchClerkMembershipRole(clerkOrgId, clerkUserId);

  const role = pendingInvite.role as ProvisionedRole;
  await pendingInviteRepo.remove(pendingInvite);
  logger.info('Used PendingInvite for role assignment', {
    email: profile.email, tenantId, role, invitedBy: pendingInvite.invitedBy,
  });
  return role;
}

async function linkExistingUserToClerk(
  existingByEmail: User,
  clerkUserId: string,
  tenantId: string,
  profile: ClerkUserProfile,
  userRepo: Repository<User>,
): Promise<User> {
  existingByEmail.clerkUserId = clerkUserId;
  await userRepo.save(existingByEmail);
  // Clear any pending invite for this email — they're a provisioned member now.
  // (The new-user branch already does this; mirror it here so a re-invited
  // existing user doesn't leave a stale "pending" row.)
  const stalePendingRepo = AppDataSource.getRepository(PendingInvite);
  const stale = await stalePendingRepo
    .createQueryBuilder('pi')
    .where('pi.tenantId = :tenantId', { tenantId })
    .andWhere('pi.email IN (:...emails)', { emails: profile.clerkEmails })
    .getMany();
  if (stale.length > 0) await stalePendingRepo.remove(stale);
  logger.info('Linked existing user to Clerk', { userId: existingByEmail.id, email: profile.email });
  return existingByEmail;
}

/** Returns the provisioned user, or null when the insert produced no row. */
async function provisionUser(
  tenant: Tenant,
  clerkOrgId: string,
  clerkUserId: string,
  userRepo: Repository<User>,
): Promise<User | null> {
  // Clerk user info is reused for email, name, and PendingInvite matching
  const profile = await fetchClerkUserProfile(clerkUserId);

  // Check for existing user by email (migration)
  const existingByEmail = await userRepo.findOne({ where: { email: profile.email, tenantId: tenant.id } });
  if (existingByEmail) {
    return linkExistingUserToClerk(existingByEmail, clerkUserId, tenant.id, profile, userRepo);
  }

  const role = await resolveInviteeRole(tenant.id, clerkOrgId, clerkUserId, profile);

  // Upsert user
  await userRepo
    .createQueryBuilder()
    .insert()
    .into(User)
    .values({
      tenantId: tenant.id,
      clerkUserId,
      email: profile.email,
      name: profile.name,
      role,
      isActive: true,
    })
    .orIgnore()
    .execute();

  const user = await userRepo.findOne({ where: { clerkUserId } });
  if (!user) return null;
  logger.info('Auto-provisioned user', { userId: user.id, email: profile.email, role });
  return user;
}

/** Sync email verification from Clerk if not yet verified. */
async function syncEmailVerification(user: User, clerkUserId: string, userRepo: Repository<User>): Promise<void> {
  if (user.emailVerified) return;
  try {
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    const isVerified = clerkUser.emailAddresses?.some(
      (e) => e.verification?.status === 'verified'
    );
    if (isVerified) {
      user.emailVerified = true;
      await userRepo.save(user);
      logger.info('Synced email verification from Clerk on login', { clerkUserId });
    }
  } catch (err) {
    logger.warn('Failed to sync email verification from Clerk', { error: err });
  }
}

async function promoteSuperAdmin(user: User, userRepo: Repository<User>): Promise<void> {
  if (!config.superAdmin.emails.includes(user.email.toLowerCase())) return;
  if (user.role === 'super_admin') return;
  user.role = 'super_admin';
  await userRepo.save(user);
  logger.info('Promoted user to super_admin via SUPER_ADMIN_EMAILS', { email: user.email });
}

/** Returns the agent for this user, or null when the insert produced no row. */
async function provisionAgent(tenantId: string, userId: string, agentRepo: Repository<Agent>): Promise<Agent | null> {
  const existing = await agentRepo.findOne({ where: { userId } });
  if (existing) return existing;

  await agentRepo
    .createQueryBuilder()
    .insert()
    .into(Agent)
    .values({
      tenantId,
      userId,
      status: 'online',
      maxConcurrentChats: 5,
      skills: [],
      languages: ['en'],
    })
    .orIgnore()
    .execute();

  const agent = await agentRepo.findOne({ where: { userId } });
  if (!agent) return null;
  logger.info('Auto-provisioned agent', { agentId: agent.id, userId });
  return agent;
}

// --- Helpers ---

function attachToRequest(req: ProvisionedRequest, clerkUserId: string, clerkOrgId: string, ids: Omit<CachedIds, 'cachedAt'>) {
  req.clerkUserId = clerkUserId;
  req.clerkOrgId = clerkOrgId;
  req.tenantId = ids.tenantId;
  req.userId = ids.userId;
  req.agentId = ids.agentId;
  req.userRole = ids.userRole;
  req.tenantName = ids.tenantName;

  // Backward compat for existing route handlers
  req.user = {
    id: ids.agentId,
    email: ids.email,
    role: ids.userRole,
    tenantId: ids.tenantId,
    clerkUserId,
    type: 'agent',
  };
}

export function invalidateProvisionCache(orgId: string, userId: string): void {
  idCache.delete(`${orgId}:${userId}`);
}

async function ensureUniqueSlug(name: string, tenantRepo: { findOne(options: { where: { slug: string } }): Promise<{ slug: string } | null> }): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'org';
  let slug = base;
  let attempt = 0;
  while (true) {
    const existing = await tenantRepo.findOne({ where: { slug } });
    if (!existing) return slug;
    attempt++;
    slug = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    if (attempt > 5) throw new Error('Failed to generate unique slug');
  }
}

// --- Exported for WebSocket auth ---

export async function resolveClerkIds(clerkUserId: string, clerkOrgId: string): Promise<CachedIds | null> {
  const cached = getCached(clerkOrgId, clerkUserId);
  if (cached) return cached;

  const tenantRepo = AppDataSource.getRepository(Tenant);
  const userRepo = AppDataSource.getRepository(User);
  const agentRepo = AppDataSource.getRepository(Agent);

  const tenant = await tenantRepo.findOne({ where: { clerkOrgId } });
  if (!tenant) return null;

  const user = await userRepo.findOne({ where: { clerkUserId } });
  if (!user) return null;

  const agent = await agentRepo.findOne({ where: { userId: user.id } });
  if (!agent) return null;

  const ids = {
    tenantId: tenant.id,
    userId: user.id,
    agentId: agent.id,
    userRole: user.role,
    userName: user.name || user.email?.split('@')[0] || '',
    tenantName: tenant.name,
    email: user.email,
  };
  setCache(clerkOrgId, clerkUserId, ids);
  return { ...ids, cachedAt: Date.now() };
}
