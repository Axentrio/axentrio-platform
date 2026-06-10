import { clerkClient } from '@clerk/express';
import { logger } from '../utils/logger';
import { config } from '../config/environment';

/**
 * Thin wrapper around Clerk API calls for tenant/user lifecycle operations.
 * All methods are non-throwing — they log errors and return success/failure.
 */

/**
 * Where an invited user should land after accepting a Clerk org invite.
 *
 * Without an explicit `redirectUrl`, Clerk falls back to the instance's
 * configured Home URL — which points at the marketing site (axentrio.com),
 * not the portal. Invitees would sign up, join the org, then get dumped on
 * the marketing page, never hitting the portal where `autoProvision` runs —
 * so their `PendingInvite` never clears and they stay stuck as "pending".
 *
 * `config.cors.origin` is the portal origin in every environment (the SPA
 * must be a CORS origin to call the API), so it's the correct landing URL.
 */
function portalRedirectUrl(): string | undefined {
  const origin = config.cors.origin;
  if (origin === '*') return undefined;
  return origin[0]?.trim() || undefined;
}

export async function createClerkOrganization(name: string): Promise<{ id: string } | null> {
  try {
    const org = await clerkClient.organizations.createOrganization({ name });
    logger.info('Created Clerk organization', { clerkOrgId: org.id, name });
    return { id: org.id };
  } catch (error) {
    logger.error('Failed to create Clerk organization', { error, name });
    return null;
  }
}

export async function inviteToClerkOrganization(
  clerkOrgId: string,
  email: string,
  inviterClerkUserId?: string
): Promise<boolean> {
  try {
    await clerkClient.organizations.createOrganizationInvitation({
      organizationId: clerkOrgId,
      emailAddress: email,
      role: 'org:member', // Always org:member — DB owns authorization
      inviterUserId: inviterClerkUserId || undefined,
      redirectUrl: portalRedirectUrl(),
    });
    logger.info('Sent Clerk organization invite', { clerkOrgId, email });
    return true;
  } catch (error) {
    logger.error('Failed to send Clerk invite', { error, clerkOrgId, email });
    return false;
  }
}

export type ResendResult = { ok: true } | { ok: false; code: 'already_member' | 'error'; message: string };

export async function revokeAndResendClerkInvitation(
  clerkOrgId: string,
  email: string,
  inviterClerkUserId?: string
): Promise<ResendResult> {
  try {
    const invitations = await clerkClient.organizations.getOrganizationInvitationList({
      organizationId: clerkOrgId,
      status: ['pending'],
    });

    const existing = invitations.data.find(
      (inv: any) => inv.emailAddress.toLowerCase() === email.toLowerCase()
    );

    if (existing && inviterClerkUserId) {
      try {
        await clerkClient.organizations.revokeOrganizationInvitation({
          organizationId: clerkOrgId,
          invitationId: existing.id,
          requestingUserId: inviterClerkUserId,
        });
        logger.info('Revoked existing Clerk invite before resend', { clerkOrgId, email, invitationId: existing.id });
      } catch (revokeErr) {
        logger.warn('Could not revoke existing invite, will try creating anyway', { revokeErr, clerkOrgId, email });
      }
    }

    await clerkClient.organizations.createOrganizationInvitation({
      organizationId: clerkOrgId,
      emailAddress: email,
      role: 'org:member',
      inviterUserId: inviterClerkUserId || undefined,
      redirectUrl: portalRedirectUrl(),
    });
    logger.info('Resent Clerk organization invite', { clerkOrgId, email });
    return { ok: true };
  } catch (error: any) {
    const clerkCode = error?.errors?.[0]?.code;
    if (clerkCode === 'already_a_member_in_organization') {
      logger.info('User is already a Clerk org member, cleaning up stale invite', { clerkOrgId, email });
      return { ok: false, code: 'already_member', message: 'User has already joined the organization' };
    }
    logger.error('Failed to revoke/resend Clerk invite', {
      error: error?.message || error,
      status: error?.status,
      clerkErrors: error?.errors,
      clerkOrgId,
      email,
    });
    return { ok: false, code: 'error', message: 'Failed to resend Clerk invitation' };
  }
}

/**
 * Revoke a pending Clerk org invitation by email. Used when cancelling an invite
 * so the email's accept link stops working (deleting only our local row would
 * leave the Clerk invitation live and still acceptable).
 *
 * Returns true if there is no longer a live invitation (revoked, or none was
 * pending). Returns false on a genuine failure, so the caller can surface it
 * instead of falsely reporting the invite cancelled.
 */
export async function revokeClerkInvitation(
  clerkOrgId: string,
  email: string,
  requestingUserId?: string
): Promise<boolean> {
  try {
    const invitations = await clerkClient.organizations.getOrganizationInvitationList({
      organizationId: clerkOrgId,
      status: ['pending'],
    });
    const existing = invitations.data.find(
      (inv: any) => inv.emailAddress.toLowerCase() === email.toLowerCase()
    );
    if (!existing) return true; // nothing pending to revoke — already accepted/revoked/expired

    if (!requestingUserId) {
      logger.warn('Cannot revoke Clerk invite without requestingUserId', { clerkOrgId, email });
      return false;
    }

    await clerkClient.organizations.revokeOrganizationInvitation({
      organizationId: clerkOrgId,
      invitationId: existing.id,
      requestingUserId,
    });
    logger.info('Revoked Clerk organization invite', { clerkOrgId, email, invitationId: existing.id });
    return true;
  } catch (error: any) {
    logger.error('Failed to revoke Clerk invite', { error: error?.message || error, clerkOrgId, email });
    return false;
  }
}

export async function addMemberToClerkOrganization(
  clerkOrgId: string,
  clerkUserId: string,
  role: string = 'org:admin'
): Promise<boolean> {
  try {
    await clerkClient.organizations.createOrganizationMembership({
      organizationId: clerkOrgId,
      userId: clerkUserId,
      role,
    });
    logger.info('Added member to Clerk organization', { clerkOrgId, clerkUserId, role });
    return true;
  } catch (error) {
    logger.error('Failed to add member to Clerk org', { error, clerkOrgId, clerkUserId });
    return false;
  }
}

export async function removeFromClerkOrganization(
  clerkOrgId: string,
  clerkUserId: string
): Promise<boolean> {
  try {
    await clerkClient.organizations.deleteOrganizationMembership({
      organizationId: clerkOrgId,
      userId: clerkUserId,
    });
    logger.info('Removed user from Clerk organization', { clerkOrgId, clerkUserId });
    return true;
  } catch (error) {
    logger.error('Failed to remove from Clerk org', { error, clerkOrgId, clerkUserId });
    return false;
  }
}

export async function updateClerkOrganization(
  clerkOrgId: string,
  updates: { name?: string; publicMetadata?: Record<string, unknown> }
): Promise<boolean> {
  try {
    await clerkClient.organizations.updateOrganization(clerkOrgId, updates);
    logger.info('Updated Clerk organization', { clerkOrgId, updates: Object.keys(updates) });
    return true;
  } catch (error) {
    logger.error('Failed to update Clerk organization', { error, clerkOrgId });
    return false;
  }
}

export async function deleteClerkOrganization(clerkOrgId: string): Promise<boolean> {
  try {
    await clerkClient.organizations.deleteOrganization(clerkOrgId);
    logger.info('Deleted Clerk organization', { clerkOrgId });
    return true;
  } catch (error) {
    logger.error('Failed to delete Clerk organization', { error, clerkOrgId });
    return false;
  }
}
