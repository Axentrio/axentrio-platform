import { z } from 'zod';

export const updateAiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['openai', 'anthropic']).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional().nullable(),
  brandVoice: z.object({
    name: z.string().min(1).max(100),
    tone: z.string().min(1).max(50),
    customInstructions: z.string().max(2000),
  }).optional(),
  guardrails: z.object({
    topicsToAvoid: z.array(z.string()).max(50),
    escalationKeywords: z.array(z.string()).max(100),
    confidenceThreshold: z.number().min(0).max(1),
    maxResponseLength: z.number().min(50).max(5000),
    greetingMessage: z.string().max(1000),
    fallbackMessage: z.string().max(1000),
    offHoursMessage: z.string().max(1000),
  }).optional(),
});

export const testAiSettingsSchema = z.object({
  question: z.string().min(1).max(1000),
  provider: z.enum(['openai', 'anthropic']).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});

export const testChatSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).max(50).default([]),
  useKnowledgeBase: z.boolean().default(false),
});
