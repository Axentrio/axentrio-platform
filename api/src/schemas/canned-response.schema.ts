import { z } from 'zod';

export const createCannedResponseSchema = z.object({
  title: z.string().min(1, 'Title is required').max(100),
  shortcut: z.string().min(1, 'Shortcut is required').max(20).regex(
    /^[a-zA-Z0-9_-]+$/,
    'Shortcut can only contain letters, numbers, hyphens, and underscores'
  ),
  content: z.string().min(1, 'Content is required').max(5000),
  category: z.string().max(50).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  scope: z.enum(['shared', 'personal']).default('personal'),
});

export const updateCannedResponseSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  shortcut: z.string().min(1).max(20).regex(
    /^[a-zA-Z0-9_-]+$/,
    'Shortcut can only contain letters, numbers, hyphens, and underscores'
  ).optional(),
  content: z.string().min(1).max(5000).optional(),
  category: z.string().max(50).nullable().optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
});

export const listCannedResponsesSchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  scope: z.enum(['shared', 'personal']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const useCannedResponseSchema = z.object({
  variables: z.record(z.string()).optional(),
});
