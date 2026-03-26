import { z } from 'zod';

export const widgetAuthSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
