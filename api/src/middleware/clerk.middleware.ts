/**
 * Clerk Authentication & Auto-Provisioning Middleware
 * Replaces custom JWT auth for portal-facing routes.
 * Widget routes continue using API key auth (unchanged).
 */
import { Request, Response, NextFunction } from 'express';
import { getAuth } from '@clerk/express';
import { clerkClient } from '@clerk/express';
import crypto from 'crypto';
import { AppDataSource, runInTransaction } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { Agent } from '../database/entities/Agent';
import { Bot } from '../database/entities/Bot';
import { ensureSharedKbAttached } from '../knowledge/attach-shared-kb';
import { PendingInvite } from '../database/entities/PendingInvite';
import { config } from '../config/environment';
import { DEFAULT_SKILLS } from '../config/default-skills';
import { logger } from '../utils/logger';
import type { RequestUser, UserRole } from '../types';
import {
  ApiError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
} from './error-handler';
import { ERROR_CODES } from './error-codes';

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
      logger.info('[AutoProvision] Tenant not found, creating...', { clerkOrgId });
      let orgName = 'Organization';
      try {
        const org = await clerkClient.organizations.getOrganization({ organizationId: clerkOrgId });
        orgName = org.name;
        logger.info('[AutoProvision] Fetched org name from Clerk', { orgName });
      } catch (err: any) {
        logger.warn('[AutoProvision] Could not fetch Clerk org name', { clerkOrgId, error: err?.message });
      }

      const slug = await ensureUniqueSlug(orgName, tenantRepo);
      const apiKey = crypto.randomBytes(32).toString('hex');

      // Forward-trial model (PR6/PR7): a fresh tenant starts at `tier='free'`
      // with NO billing row. The 14-day Pro trial is granted at Checkout
      // time (via Stripe `trial_period_days`) and is gated by the
      // `chatbot_tenant_trial_reservations` table for first-signup-only semantics.
      // ON CONFLICT(clerk_org_id) DO NOTHING makes concurrent autoProvision
      // requests race-safe.
      try {
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
                    customInstructions: '',
                  },
                  guardrails: {
                    topicsToAvoid: [],
                    escalationKeywords: ['speak to someone', 'human agent', 'talk to a person'],
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

          // Multi-bot: create the tenant's anchor Bot in the same tx. Its
          // public_key == the tenant's api_key so the widget resolves
          // identically; settings is the tenant's settings minus the
          // tenant-level LLM secret (ai.apiKey). Idempotent + race-safe via
          // ON CONFLICT DO NOTHING (the one-default-per-tenant partial unique
          // index catches a concurrent provision).
          const anchorSettings = JSON.parse(JSON.stringify(t.settings ?? {}));
          if (anchorSettings?.ai && 'apiKey' in anchorSettings.ai) {
            delete anchorSettings.ai.apiKey;
          }
          await manager
            .createQueryBuilder()
            .insert()
            .into(Bot)
            .values({
              tenantId: t.id,
              name: t.name,
              publicKey: t.apiKey,
              status: 'active',
              isDefault: true,
              settings: anchorSettings,
            })
            .orIgnore()
            .execute();

          // Attach the tenant's shared primary KB to the anchor within this same
          // tx (re-read the row since the insert used orIgnore and returns no id),
          // so a freshly-provisioned tenant's bot answers from shared knowledge —
          // not the empty-KB state the backfill repairs for existing tenants.
          const anchor = await manager.findOne(Bot, { where: { tenantId: t.id, isDefault: true } });
          if (anchor) {
            await ensureSharedKbAttached(manager, t.id, anchor.id);
          }

          return { tenant: t };
        });
        tenant = result.tenant;
        logger.info('[AutoProvision] Tenant committed', { tenantId: tenant.id });
      } catch (provisionErr: any) {
        logger.error('[AutoProvision] Tenant provisioning tx FAILED', {
          clerkOrgId,
          error: provisionErr?.message,
        });
        return next(new ApiError('Failed to provision tenant', 500, ERROR_CODES.PROVISIONING_FAILED));
      }

      logger.info('Auto-provisioned tenant', { tenantId: tenant.id, orgName });
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
      // Fetch Clerk user info (reused for email, name, and PendingInvite matching)
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

      // Check for existing user by email (migration)
      const existingByEmail = await userRepo.findOne({ where: { email, tenantId: tenant.id } });
      if (existingByEmail) {
        existingByEmail.clerkUserId = clerkUserId;
        await userRepo.save(existingByEmail);
        user = existingByEmail;
        logger.info('Linked existing user to Clerk', { userId: user.id, email });
      } else {
        // Check for PendingInvite — bridges invite→signup role assignment
        let role: 'admin' | 'supervisor' | 'agent' = 'agent';
        const pendingInviteRepo = AppDataSource.getRepository(PendingInvite);
        const pendingInvite = await pendingInviteRepo
          .createQueryBuilder('pi')
          .where('pi.tenantId = :tenantId', { tenantId: tenant.id })
          .andWhere('pi.email IN (:...emails)', { emails: clerkEmails })
          .andWhere('pi.expiresAt > NOW()')
          .getOne();

        if (pendingInvite) {
          role = pendingInvite.role as 'admin' | 'supervisor' | 'agent';
          await pendingInviteRepo.remove(pendingInvite);
          logger.info('Used PendingInvite for role assignment', {
            email, tenantId: tenant.id, role, invitedBy: pendingInvite.invitedBy,
          });
        } else {
          // Backwards compat: fall back to Clerk membership role for Clerk Dashboard invites
          try {
            const memberships = await clerkClient.organizations.getOrganizationMembershipList({
              organizationId: clerkOrgId,
              limit: 100,
            });
            const membership = memberships.data?.find((m) => m.publicUserData?.userId === clerkUserId);
            if (membership?.role === 'org:admin') role = 'admin';
            else if (membership?.role === 'org:supervisor') role = 'supervisor';
          } catch {
            logger.warn('Could not fetch Clerk membership role', { clerkUserId, clerkOrgId });
          }
        }

        // Upsert user
        await userRepo
          .createQueryBuilder()
          .insert()
          .into(User)
          .values({
            tenantId: tenant.id,
            clerkUserId,
            email,
            name,
            role,
            isActive: true,
          })
          .orIgnore()
          .execute();

        user = await userRepo.findOne({ where: { clerkUserId } });
        if (!user) {
          return next(new ApiError('Failed to provision user', 500, ERROR_CODES.PROVISIONING_FAILED));
        }
        logger.info('Auto-provisioned user', { userId: user.id, email, role });
      }
    }

    // --- Sync email verification from Clerk if not yet verified ---
    if (user && !user.emailVerified) {
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

    // --- Super Admin Bootstrap ---
    if (config.superAdmin.emails.includes(user.email.toLowerCase()) && user.role !== 'super_admin') {
      user.role = 'super_admin';
      await userRepo.save(user);
      logger.info('Promoted user to super_admin via SUPER_ADMIN_EMAILS', { email: user.email });
    }

    // --- Resolve Agent ---
    let agent = await agentRepo.findOne({ where: { userId: user.id } });

    if (!agent) {
      await agentRepo
        .createQueryBuilder()
        .insert()
        .into(Agent)
        .values({
          tenantId: tenant.id,
          userId: user.id,
          status: 'online',
          maxConcurrentChats: 5,
          skills: [],
          languages: ['en'],
        })
        .orIgnore()
        .execute();

      agent = await agentRepo.findOne({ where: { userId: user.id } });
      if (!agent) {
        return next(new ApiError('Failed to provision agent', 500, ERROR_CODES.PROVISIONING_FAILED));
      }
      logger.info('Auto-provisioned agent', { agentId: agent.id, userId: user.id });
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
