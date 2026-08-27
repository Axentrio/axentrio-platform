import { z } from "zod";
import { normalizeWebsiteUrl } from "../knowledge/website-url";

export const updateKnowledgeBaseSchema = z.object({
  chunkSize: z.number().min(100).max(5000).optional(),
  chunkOverlap: z.number().min(0).max(1000).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const createDocumentSchema = z.object({
  type: z.enum(["text", "faq", "pdf", "docx"]),
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

const websiteUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .transform((value, ctx) => {
    try {
      return normalizeWebsiteUrl(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid website URL",
      });
      return z.NEVER;
    }
  });

export const importWebsiteSchema = z.object({
  url: websiteUrl,
  followLinks: z.boolean().optional().default(true),
  maxPages: z.number().int().min(1).max(50).optional(),
  kbId: z.string().uuid().optional(),
  extraUrls: z.array(websiteUrl).max(20).optional(),
});

export const discoverWebsiteSchema = z.object({
  url: websiteUrl,
});

export const listDocumentsSchema = z.object({
  status: z.enum(["pending", "processing", "indexed", "failed"]).optional(),
  type: z.enum(["text", "faq", "pdf", "docx", "url"]).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});
