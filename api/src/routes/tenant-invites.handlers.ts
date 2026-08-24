/**
 * Tenant invite handlers
 *
 * Send, list, resend and cancel Clerk organization invites, plus the
 * already-a-member provisioning fallback the send and resend paths share.
 * Registered by routes/tenants.ts.
 */

import { type Request, type Response } from "express";
import { clerkClient } from "@clerk/express";
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
  ApiError,
} from "../middleware";
import { ERROR_CODES } from "../middleware/error-codes";
import { sendSuccess } from "../utils/response";
import {
  inviteToClerkOrganization,
  revokeAndResendClerkInvitation,
  revokeClerkInvitation,
  getAllOrgMemberships,
} from "../services/clerk-sync.service";
import { logger } from "../utils/logger";
import { logAudit } from "../utils/audit";

/**
 * Ensure a user who is already a member of the tenant's Clerk org is provisioned
 * in our DB. Returns true if the email belongs to a current Clerk org member
 * (provisioning them if needed, no-op if already in our DB); false if they are
 * NOT a member — i.e. an invite failure was something other than "already a member".
 */
async function provisionExistingOrgMember(
  tenantId: string,
  clerkOrgId: string,
  email: string,
  role: "admin" | "supervisor" | "agent",
): Promise<boolean> {
  email = email.toLowerCase(); // emails can be stored mixed-case (e.g. POST /me/users); match consistently
  let memberships: any[];
  try {
    memberships = await getAllOrgMemberships(clerkOrgId);
  } catch (err: any) {
    logger.warn("Could not check Clerk org membership", {
      email,
      error: err?.message,
    });
    return false;
  }

  const membership = memberships.find(
    (m: any) =>
      m.publicUserData?.identifier?.toLowerCase() === email.toLowerCase(),
  );
  if (!membership?.publicUserData?.userId) return false; // not a member — real failure

  const userRepo = AppDataSource.getRepository(User);
  const existing = await userRepo.findOne({ where: { email, tenantId } });
  if (existing) return true; // already synced

  const clerkUserId = membership.publicUserData.userId;
  let name = email.split("@")[0];
  try {
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    name =
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
      name;
  } catch {
    /* use fallback name */
  }

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
    logger.info("Provisioned already-member user", {
      email,
      userId: newUser.id,
    });
  }
  return true;
}

/**
 * Invite user to tenant
 * POST /api/v1/tenants/me/invite
 */
export const inviteTenantUser = asyncHandler(
  async (req: Request, res: Response) => {
    const { email, role } = req.body;
    if (!email || !role) {
      throw new ValidationError("Email and role are required");
    }

    if (!["admin", "supervisor", "agent"].includes(role)) {
      throw new ValidationError("Invalid role");
    }

    const tenantId = req.user!.tenantId;
    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({ where: { id: tenantId } });

    if (!tenant?.clerkOrgId) {
      throw new ValidationError("No Clerk organization linked");
    }

    const invited = await inviteToClerkOrganization(
      tenant.clerkOrgId,
      email,
      req.user!.clerkUserId,
    );
    if (!invited) {
      // The most common cause is the invitee already being a member of the org
      // (e.g. they accepted an earlier invite but never logged into the portal,
      // so they never got provisioned into our DB). In that case, sync them into
      // the members list instead of erroring. Only a genuine Clerk failure 502s.
      const alreadyMember = await provisionExistingOrgMember(
        tenant.id,
        tenant.clerkOrgId,
        email.toLowerCase(),
        role,
      );
      if (alreadyMember) {
        await logAudit(
          req.userId!,
          "invite.cleaned",
          "invite",
          tenant.id,
          tenantId,
          { email, role, reason: "already_member" },
        );
        sendSuccess(res, {
          message: "User has already joined — synced to members list",
        });
        return;
      }
      throw new ApiError(
        "Failed to send invite via Clerk",
        502,
        ERROR_CODES.CLERK_UPSTREAM_FAILED,
      );
    }

    const inviteRepo = AppDataSource.getRepository(PendingInvite);
    await inviteRepo
      .createQueryBuilder()
      .insert()
      .into(PendingInvite)
      .values({
        tenantId: tenant.id,
        email: email.toLowerCase(),
        role,
        invitedBy: req.userId!,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .orUpdate(
        ["role", "invited_by", "created_at", "expires_at"],
        ["tenant_id", "email"],
      )
      .execute();

    // Fetch the saved invite to get its ID for the audit log
    const savedInvite = await inviteRepo.findOne({
      where: { tenantId: tenant.id, email: email.toLowerCase() },
    });
    await logAudit(
      req.userId!,
      "invite.sent",
      "invite",
      savedInvite?.id ?? tenant.id,
      tenantId,
      { email, role },
    );

    sendSuccess(res, { message: "Invitation sent" });
  },
);

/**
 * List pending invites for current tenant
 * GET /api/v1/tenants/me/pending-invites
 */
export const listPendingInvites = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const inviteRepo = AppDataSource.getRepository(PendingInvite);
    let invites = await inviteRepo.find({
      where: { tenantId },
      order: { createdAt: "DESC" },
    });

    // Reconcile against Clerk: drop invites whose invitee already joined the org.
    // The pending row otherwise only clears when the invitee logs into the portal
    // (autoProvision), so an invite accepted via the Clerk dashboard — or before the
    // redirectUrl fix — lingers as a stale "pending" row. One membership-list call,
    // fail-open if Clerk is slow/down so the page still renders.
    if (invites.length > 0) {
      try {
        const tenant = await AppDataSource.getRepository(Tenant).findOne({
          where: { id: tenantId },
        });
        if (tenant?.clerkOrgId) {
          const memberships = await getAllOrgMemberships(tenant.clerkOrgId);
          const memberEmails = new Set(
            memberships
              .map((m: any) => m.publicUserData?.identifier?.toLowerCase())
              .filter(Boolean),
          );
          const accepted = invites.filter((inv) =>
            memberEmails.has(inv.email.toLowerCase()),
          );
          if (accepted.length > 0) {
            await inviteRepo.remove(accepted);
            invites = invites.filter(
              (inv) => !memberEmails.has(inv.email.toLowerCase()),
            );
            logger.info("Cleared stale pending invites (already org members)", {
              tenantId,
              count: accepted.length,
            });
          }
        }
      } catch (err) {
        logger.warn(
          "Pending-invite reconcile against Clerk failed; returning DB list",
          { tenantId, err },
        );
      }
    }

    // Resolve inviter names
    const inviterIds = [
      ...new Set(invites.map((i) => i.invitedBy).filter(Boolean)),
    ] as string[];
    const inviters =
      inviterIds.length > 0
        ? await AppDataSource.getRepository(User)
            .createQueryBuilder("u")
            .select(["u.id", "u.name", "u.email"])
            .where("u.id IN (:...ids)", { ids: inviterIds })
            .getMany()
        : [];
    const inviterMap = new Map(
      inviters.map((u) => [u.id, { name: u.name, email: u.email }]),
    );

    const data = invites.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      invitedBy: inv.invitedBy ? (inviterMap.get(inv.invitedBy) ?? null) : null,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      isExpired: new Date() > inv.expiresAt,
    }));

    sendSuccess(res, data);
  },
);

/**
 * Resend a pending invite
 * POST /api/v1/tenants/me/pending-invites/:id/resend
 */
export const resendPendingInvite = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const inviteRepo = AppDataSource.getRepository(PendingInvite);

    const invite = await inviteRepo.findOne({
      where: { id: req.params.id, tenantId },
    });

    if (!invite) {
      throw new NotFoundError("Invite not found");
    }

    // Re-send Clerk invitation
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
    });
    if (!tenant?.clerkOrgId) {
      throw new BadRequestError("Tenant has no Clerk organization linked");
    }

    const result = await revokeAndResendClerkInvitation(
      tenant.clerkOrgId,
      invite.email,
      req.user?.clerkUserId,
    );

    if (!result.ok && result.code === "already_member") {
      // Already in the Clerk org — sync them into our DB (best-effort) and drop the invite.
      await provisionExistingOrgMember(
        tenantId,
        tenant.clerkOrgId,
        invite.email,
        invite.role as "admin" | "supervisor" | "agent",
      );

      await inviteRepo.remove(invite);
      await logAudit(
        req.userId!,
        "invite.cleaned",
        "invite",
        invite.id,
        tenantId,
        { email: invite.email, reason: "already_member" },
      );
      sendSuccess(res, {
        message: "User has already joined — synced to members list",
      });
      return;
    }

    if (!result.ok) {
      throw new ApiError(result.message, 502, ERROR_CODES.CLERK_UPSTREAM_FAILED);
    }

    invite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await inviteRepo.save(invite);

    await logAudit(
      req.userId!,
      "invite.resent",
      "invite",
      invite.id,
      tenantId,
      { email: invite.email },
    );

    sendSuccess(res, { message: "Invite resent" });
  },
);

/**
 * Cancel a pending invite
 * DELETE /api/v1/tenants/me/pending-invites/:id
 */
export const cancelPendingInvite = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const inviteRepo = AppDataSource.getRepository(PendingInvite);

    const invite = await inviteRepo.findOne({
      where: { id: req.params.id, tenantId },
    });

    if (!invite) {
      throw new NotFoundError("Invite not found");
    }

    // Revoke the Clerk-side invitation too — otherwise its email link stays live
    // and the recipient could still accept after we delete our local row. Only
    // report success once Clerk confirms there's no longer a live invitation.
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
    });
    if (tenant?.clerkOrgId) {
      const revoked = await revokeClerkInvitation(
        tenant.clerkOrgId,
        invite.email,
        req.user?.clerkUserId,
      );
      if (!revoked) {
        throw new ApiError(
          "Failed to revoke invite via Clerk",
          502,
          ERROR_CODES.CLERK_UPSTREAM_FAILED,
        );
      }
    }

    await logAudit(
      req.userId!,
      "invite.cancelled",
      "invite",
      invite.id,
      tenantId,
      { email: invite.email },
    );

    await inviteRepo.remove(invite);

    sendSuccess(res, { message: "Invite cancelled" });
  },
);
