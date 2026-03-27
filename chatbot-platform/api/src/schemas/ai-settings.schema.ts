import { z } from 'zod';

export const updateAiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['openai', 'anthropic']).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional().nullable(),
  brandVoice: z.object({
    name: z.string().min(1).max(100),
    tone: z.enum(['formal', 'casual', 'friendly', 'professional']),
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
