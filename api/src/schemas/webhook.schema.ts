import { z } from 'zod';

export const webhookConfigSchema = z.object({
  url: z.string().url('Webhook URL must be a valid URL'),
  secret: z.string().optional(),
  events: z.array(z.string()).optional(),
});
