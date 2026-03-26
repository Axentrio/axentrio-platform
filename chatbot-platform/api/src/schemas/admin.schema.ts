import { z } from 'zod';

export const createTenantSchema = z.object({
  name: z.string().min(1, 'Tenant name is required'),
  slug: z.string().min(1, 'Slug is required'),
  tier: z.enum(['free', 'starter', 'professional', 'enterprise']).default('free'),
  ownerEmail: z.string().email('Valid owner email is required'),
  ownerName: z.string().min(1, 'Owner name is required'),
});

export const updateUserRoleSchema = z.object({
  role: z.enum(['admin', 'supervisor', 'agent']),
});

export const adminUpdateUserSchema = z.object({
  role: z.enum(['admin', 'supervisor', 'agent']).optional(),
  isActive: z.boolean().optional(),
});
