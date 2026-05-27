import { z } from 'zod';

export const requestHandoffSchema = z.object({
  sessionId: z.string().min(1, 'Session ID is required'),
  reason: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});
