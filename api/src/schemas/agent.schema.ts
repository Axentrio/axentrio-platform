import { z } from 'zod';

export const createAgentSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  maxConcurrentChats: z.number().int().positive().optional(),
  skills: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
});

export const updateAgentSchema = z.object({
  maxConcurrentChats: z.number().int().positive().optional(),
  skills: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

export const updateAgentStatusSchema = z.object({
  status: z.enum(['online', 'away', 'busy', 'offline']),
});
