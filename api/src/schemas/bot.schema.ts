import { z } from 'zod';

export const createBotSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
});

export const updateBotSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: 'Provide at least one of: name, status',
  });
