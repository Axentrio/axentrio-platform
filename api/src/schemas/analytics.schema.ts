import { z } from 'zod';

export const analyticsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

// Export adds dataset + format; `validate` replaces req.query with the parsed
// object, so these must be declared here or they'd be stripped (P3 / D7).
export const analyticsExportQuerySchema = z.object({
  dataset: z.string(),
  format: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
