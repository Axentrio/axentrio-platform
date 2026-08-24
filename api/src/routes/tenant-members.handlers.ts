/**
 * Tenant member handlers
 *
 * Member list, creation, role change, deactivation and reactivation, plus the
 * Clerk-org reconciliation the list depends on. Registered by routes/tenants.ts.
 */

import { type Request, type Response } from "express";
import { IsNull } from "typeorm";
import { AppDataSource } from "../database/data-source";
import { Tenant } from "../database/entities/Tenant";
import { User } from "../database/entities/User";
import { Agent } from "../database/entities/Agent";
import { PendingInvite } from "../database/entities/PendingInvite";
import {
  asyncHandler,
  ValidationError,
  NotFoundError,
  BadRequestError,
} from "../middleware";
import { sendSuccess, sendCreated } from "../utils/response";
import { invalidateProvisionCache } from "../middleware/clerk.middleware";
import {
  removeFromClerkOrganization,
  addMemberToClerkOrganization,
  getAllOrgMemberships,
} from "../services/clerk-sync.service";
import { logger } from "../utils/logger";
import { logAudit } from "../utils/audit";
import { parsePaginationParams, applyPagination } from "../utils/pagination";
import { releaseAgentSessions } from "../utils/releaseAgentSessions";
import { emitToSession, emitToTenantAgents } from "../websocket/socket.handler";
import { emitConversationUpsertForSession } from "../realtime/conversation-events";

/**
 * Make our User table reflect the Clerk org: provision any Clerk member missing
 * locally so "ghost members" (joined the Clerk org but never logged into the
 * portal) still appear in the members list. Role comes from a matching
 * PendingInvite if one exists (which is then consumed), else defaults to 'agent'
 * — matching what autoProvision assigns on a member's first login. Fetches the
 * full membership once (paginated). Best-effort / fail-open.
 */
async function syncOrgMembersToDb(
  tenantId: string,
  clerkOrgId: string,
): Promise<void> {
  try {
    const memberships = await getAllOrgMemberships(clerkOrgId);
    if (memberships.length === 0) return;

    const userRepo = AppDataSource.getRepository(User);
    const inviteRepo = AppDataSource.getRepository(PendingInvite);

    // withDeleted so a soft-deleted member is not resurrected as a new row.
    const existing = await userRepo.find({
      where: { tenantId },
      withDeleted: true,
    });
    const existingEmails = new Set(existing.map((u) => u.email.toLowerCase()));

    const invites = await inviteRepo.find({ where: { tenantId } });
    const inviteByEmail = new Map(
      invites.map((i) => [i.email.toLowerCase(), i]),
    );

    const consumedInviteIds: string[] = [];
    let provisioned = 0;
    for (const m of memberships) {
      const email = m.publicUserData?.identifier?.toLowerCase();
      const clerkUserId = m.publicUserData?.userId;
      if (!email || !clerkUserId || existingEmails.has(email)) continue;

      const invite = inviteByEmail.get(email);
      const role =
        (invite?.role as "admin" | "supervisor" | "agent") ?? "agent";
      const name =
        [m.publicUserData?.firstName, m.publicUserData?.lastName]
          .filter(Boolean)
          .join(" ") || email.split("@")[0];

      await userRepo
        .createQueryBuilder()
        .insert()
        .into(User)
        .values({
          tenantId,
          clerkUserId,
          email,
          name,
          role: role as any,
          isActive: true,
        })
        .orIgnore()
        .execute();

      const newUser = await userRepo.findOne({ where: { clerkUserId } });
      if (newUser) {
        await AppDataSource.getRepository(Agent)
          .createQueryBuilder()
          .insert()
          .into(Agent)
          .values({
            tenantId,
            userId: newUser.id,
            status: "offline",
            maxConcurrentChats: 5,
            skills: [],
            languages: ["en"],
          })
          .orIgnore()
          .execute();
        provisioned++;
      }
      if (invite) consumedInviteIds.push(invite.id);
    }

    if (consumedInviteIds.length > 0)
      await inviteRepo.delete(consumedInviteIds);
    if (provisioned > 0)
      logger.info("Synced Clerk org members to DB", {
        tenantId,
        provisioned,
        invitesConsumed: consumedInviteIds.length,
      });
  } catch (err: any) {
    logger.warn("syncOrgMembersToDb failed; returning members list as-is", {
      tenantId,
      error: err?.message,
    });
  }
}

/**
 * Get tenant users
 * GET /api/v1/tenants/me/users
 */
export const listTenantUsers = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const params = parsePaginationParams(req.query as Record<string, unknown>);

    // Reconcile against Clerk so members who joined the org but never logged into
    // the portal still appear here (otherwise they're invisible until first login).
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
    });
    if (tenant?.clerkOrgId) {
      await syncOrgMembersToDb(tenantId, tenant.clerkOrgId);
    }

    const userRepository = AppDataSource.getRepository(User);

    const qb = userRepository
      .createQueryBuilder("user")
      .select([
        "user.id",
        "user.email",
        "user.name",
        "user.role",
        "user.isActive",
        "user.avatarUrl",
        "user.lastLoginAt",
        "user.createdAt",
      ])
      .where("user.tenantId = :tenantId", { tenantId })
      .andWhere("user.deletedAt IS NULL");

    if (!params.sortBy) {
      qb.orderBy("user.createdAt", "DESC");
    }

    const result = await applyPagination(qb, params);

    sendSuccess(res, result.data, { pagination: result.meta });
  },
);

/**
 * Create tenant user
 * POST /api/v1/tenants/me/users
 */
export const createTenantUser = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { email, name, role, password } = req.body;

    if (!email || !name || !role) {
      throw new ValidationError("Email, name, and role are required");
    }

    const userRepository = AppDataSource.getRepository(User);

    // Check if email already exists
    const existingUser = await userRepository.findOne({
      where: { email, tenantId },
    });

    if (existingUser) {
      throw new ValidationError("User with this email already exists");
    }

    // Create user
    const user = userRepository.create({
      tenantId,
      email,
      name,
      role,
      password: password || undefined, // In production, hash the password
      isActive: true,
    });

    await userRepository.save(user);

    logger.info("Tenant user created", {
      tenantId,
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    sendCreated(res, {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
    });
  },
);

/**
 * Change user role within tenant
 * PATCH /api/v1/tenants/me/users/:userId
 */
export const updateTenantUserRole = asyncHandler(
  async (req: Request, res: Response) => {
    const { role } = req.body;

    if (!role || !["admin", "supervisor", "agent"].includes(role)) {
      throw new ValidationError("Invalid role");
    }

    const tenantId = req.user!.tenantId;
    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: req.params.userId, tenantId, deletedAt: IsNull() },
    });

    if (!user) {
      throw new NotFoundError("User not found in this tenant");
    }

    user.role = role;
    await userRepo.save(user);

    // Invalidate autoProvision cache so role change takes effect immediately
    if (user.clerkUserId) {
      const tenant = await AppDataSource.getRepository(Tenant).findOne({
        where: { id: tenantId },
      });
      if (tenant?.clerkOrgId) {
        invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
      }
    }

    logger.info("Tenant admin changed user role", {
      userId: user.id,
      newRole: role,
      changedBy: req.userId,
    });
    sendSuccess(res, { id: user.id, role: user.role });
  },
);

/**
 * Deactivate a tenant member
 * POST /api/v1/tenants/me/users/:userId/deactivate
 */
export const deactivateTenantUser = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { userId } = req.params;

    // Cannot deactivate yourself
    if (userId === req.userId) {
      throw new BadRequestError("Cannot deactivate yourself");
    }

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: userId, tenantId, deletedAt: IsNull() },
    });

    if (!user) {
      throw new NotFoundError("User not found in this tenant");
    }

    if (!user.isActive) {
      throw new BadRequestError("User is already deactivated");
    }

    // Cannot deactivate the last active admin
    if (user.role === "admin") {
      const activeAdminCount = await userRepo.count({
        where: {
          tenantId,
          role: "admin" as const,
          isActive: true,
          deletedAt: IsNull(),
        },
      });
      if (activeAdminCount <= 1) {
        throw new BadRequestError("Cannot deactivate the last active admin");
      }
    }

    // Deactivate in DB + cleanup sessions in one transaction
    let releaseResult = {
      releasedSessions: 0,
      returnedHandoffs: 0,
      affectedSessionIds: [] as string[],
    };
    await AppDataSource.transaction(async (manager) => {
      user.isActive = false;
      await manager.save(User, user);
      releaseResult = await releaseAgentSessions(user.id, tenantId, manager);
    });

    // Remove from Clerk org + invalidate cache
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
    });
    if (user.clerkUserId && tenant?.clerkOrgId) {
      await removeFromClerkOrganization(tenant.clerkOrgId, user.clerkUserId);
      invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
    }

    await logAudit(req.userId!, "user.deactivated", "user", user.id, tenantId, {
      releasedSessions: releaseResult.releasedSessions,
      returnedHandoffs: releaseResult.returnedHandoffs,
    });

    // Socket events — after transaction committed
    for (const sessionId of releaseResult.affectedSessionIds) {
      emitToSession(tenantId, sessionId, "agent:removed", {
        sessionId,
        reason: "agent_deactivated",
      });
      // B-PR3a: normalized ownership event (the release moved every affected
      // conversation back to handoff_requested).
      await emitConversationUpsertForSession(sessionId, tenantId);
    }
    if (
      releaseResult.releasedSessions > 0 ||
      releaseResult.returnedHandoffs > 0
    ) {
      emitToTenantAgents(tenantId, "handoff:queue_updated", {
        reason: "agent_deactivated",
      });
    }

    logger.info("Deactivated user", {
      userId: user.id,
      tenantId,
      deactivatedBy: req.userId,
    });
    sendSuccess(res, { message: "User deactivated" });
  },
);

/**
 * Reactivate a tenant member
 * POST /api/v1/tenants/me/users/:userId/reactivate
 */
export const reactivateTenantUser = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { userId } = req.params;

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: userId, tenantId, deletedAt: IsNull() },
    });

    if (!user) {
      throw new NotFoundError("User not found in this tenant");
    }

    if (user.isActive) {
      throw new BadRequestError("User is already active");
    }

    user.isActive = true;
    await userRepo.save(user);

    // Re-add to Clerk org
    if (user.clerkUserId) {
      const tenant = await AppDataSource.getRepository(Tenant).findOne({
        where: { id: tenantId },
      });
      if (tenant?.clerkOrgId) {
        await addMemberToClerkOrganization(
          tenant.clerkOrgId,
          user.clerkUserId,
          "org:member",
        );
      }
    }

    await logAudit(req.userId!, "user.reactivated", "user", user.id, tenantId);

    logger.info("Reactivated user", {
      userId: user.id,
      tenantId,
      reactivatedBy: req.userId,
    });
    sendSuccess(res, { message: "User reactivated" });
  },
);
