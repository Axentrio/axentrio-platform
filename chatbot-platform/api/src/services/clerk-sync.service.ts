import { clerkClient } from '@clerk/express';
import { logger } from '../utils/logger';

/**
 * Thin wrapper around Clerk API calls for tenant/user lifecycle operations.
 * All methods are non-throwing — they log errors and return success/failure.
 */

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
    });
    logger.info('Sent Clerk organization invite', { clerkOrgId, email });
    return true;
  } catch (error) {
    logger.error('Failed to send Clerk invite', { error, clerkOrgId, email });
    return false;
  }
}

export async function revokeAndResendClerkInvitation(
  clerkOrgId: string,
  email: string,
  inviterClerkUserId?: string
): Promise<boolean> {
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
    });
    logger.info('Resent Clerk organization invite', { clerkOrgId, email });
    return true;
  } catch (error: any) {
    logger.error('Failed to revoke/resend Clerk invite', {
      error: error?.message || error,
      status: error?.status,
      clerkErrors: error?.errors,
      clerkOrgId,
      email,
    });
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
