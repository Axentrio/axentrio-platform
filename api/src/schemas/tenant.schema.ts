import { z } from 'zod';

export const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  webhookUrl: z.string().url().optional().or(z.literal('')),
  settings: z.record(z.unknown()).optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email('Valid email is required'),
  // name is not used by the invite handlers (the member's name comes from Clerk on
  // provisioning); kept optional so callers may omit it.
  name: z.string().min(1, 'Name is required').optional(),
  role: z.enum(['admin', 'supervisor', 'agent']),
});
