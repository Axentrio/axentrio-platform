import { z } from 'zod';

export const updateKnowledgeBaseSchema = z.object({
  chunkSize: z.number().min(100).max(5000).optional(),
  chunkOverlap: z.number().min(0).max(1000).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const createDocumentSchema = z.object({
  type: z.enum(['text', 'faq', 'pdf', 'docx']),
  title: z.string().min(1).max(255),
  sourceContent: z.string().max(500000).optional(),
  uploadToken: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateDocumentSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  sourceContent: z.string().max(500000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const listDocumentsSchema = z.object({
  status: z.enum(['pending', 'processing', 'indexed', 'failed']).optional(),
  type: z.enum(['text', 'faq', 'pdf', 'docx']).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});
