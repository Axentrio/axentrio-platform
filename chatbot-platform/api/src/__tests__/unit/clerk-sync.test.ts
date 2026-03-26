import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Clerk SDK before importing the service
vi.mock('@clerk/express', () => ({
  clerkClient: {
    organizations: {
      createOrganization: vi.fn(),
      createOrganizationInvitation: vi.fn(),
      createOrganizationMembership: vi.fn(),
    },
  },
}));

import { clerkClient } from '@clerk/express';
import {
  createClerkOrganization,
  inviteToClerkOrganization,
  addMemberToClerkOrganization,
} from '../../services/clerk-sync.service';

const mockOrgs = vi.mocked(clerkClient.organizations);

describe('Clerk Sync Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createClerkOrganization', () => {
    it('should return org id on success', async () => {
      mockOrgs.createOrganization.mockResolvedValue({ id: 'org_123' } as any);

      const result = await createClerkOrganization('Test Org');

      expect(result).toEqual({ id: 'org_123' });
      expect(mockOrgs.createOrganization).toHaveBeenCalledWith({ name: 'Test Org' });
    });

    it('should return null on failure', async () => {
      mockOrgs.createOrganization.mockRejectedValue(new Error('API error'));

      const result = await createClerkOrganization('Fail Org');

      expect(result).toBeNull();
    });
  });

  describe('inviteToClerkOrganization', () => {
    it('should return true on success', async () => {
      mockOrgs.createOrganizationInvitation.mockResolvedValue({} as any);

      const result = await inviteToClerkOrganization('org_1', 'user@test.com');

      expect(result).toBe(true);
      expect(mockOrgs.createOrganizationInvitation).toHaveBeenCalledWith({
        organizationId: 'org_1',
        emailAddress: 'user@test.com',
        role: 'org:member',
        inviterUserId: undefined,
      });
    });

    it('should return false on failure', async () => {
      mockOrgs.createOrganizationInvitation.mockRejectedValue(new Error('fail'));

      expect(await inviteToClerkOrganization('org_1', 'user@test.com')).toBe(false);
    });
  });

  describe('addMemberToClerkOrganization', () => {
    it('should return true on success', async () => {
      mockOrgs.createOrganizationMembership.mockResolvedValue({} as any);

      const result = await addMemberToClerkOrganization('org_1', 'user_1');

      expect(result).toBe(true);
      expect(mockOrgs.createOrganizationMembership).toHaveBeenCalledWith({
        organizationId: 'org_1',
        userId: 'user_1',
        role: 'org:admin',
      });
    });

    it('should return false on failure', async () => {
      mockOrgs.createOrganizationMembership.mockRejectedValue(new Error('fail'));

      expect(await addMemberToClerkOrganization('org_1', 'user_1')).toBe(false);
    });
  });
});
