import { z } from 'zod';

export const createTenantSchema = z.object({
  name: z.string().min(1, 'Tenant name is required'),
  tier: z.enum(['free', 'pro', 'enterprise']).default('free'),
  adminEmail: z.string().email('Valid admin email is required').optional(),
  settings: z.record(z.unknown()).optional(),
});

export const updateUserRoleSchema = z.object({
  role: z.enum(['admin', 'supervisor', 'agent']),
});

export const adminUpdateUserSchema = z.object({
  role: z.enum(['admin', 'supervisor', 'agent']).optional(),
  isActive: z.boolean().optional(),
});
