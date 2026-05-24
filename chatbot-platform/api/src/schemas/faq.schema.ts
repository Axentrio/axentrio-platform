import { z } from 'zod';

// Slug/id pattern mirrors the CHECK constraints in the DB migration.
const KEBAB = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

const kebabId = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(KEBAB, 'Must be kebab-case: lowercase letters, digits, and hyphens');

const translation = (max: number) =>
  z.object({
    en: z.string().min(1, 'English is required').max(max),
    nl: z.string().max(max).optional(),
    fr: z.string().max(max).optional(),
  });

const TITLE_MAX = 200;
const QUESTION_MAX = 500;
const ANSWER_MAX = 5000;

export const faqTitleSchema = translation(TITLE_MAX);
export const faqQuestionSchema = translation(QUESTION_MAX);
export const faqAnswerSchema = translation(ANSWER_MAX);

export const createFaqSectionSchema = z.object({
  id: kebabId(64),
  titles: faqTitleSchema,
});

export const updateFaqSectionSchema = z
  .object({
    titles: faqTitleSchema,
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const createFaqItemSchema = z.object({
  slug: kebabId(80),
  question: faqQuestionSchema,
  answer: faqAnswerSchema,
});

export const updateFaqItemSchema = z
  .object({
    slug: kebabId(80),
    sectionId: kebabId(64),
    question: faqQuestionSchema,
    answer: faqAnswerSchema,
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const reorderFaqSchema = z
  .object({
    sections: z.array(z.object({ id: kebabId(64), position: z.number().int().min(0) })).optional(),
    items: z
      .array(
        z.object({
          id: z.string().uuid(),
          sectionId: kebabId(64),
          position: z.number().int().min(0),
        })
      )
      .optional(),
  })
  .refine((data) => (data.sections?.length ?? 0) + (data.items?.length ?? 0) > 0, {
    message: 'Provide at least one section or item to reorder',
  });

export type CreateFaqSectionInput = z.infer<typeof createFaqSectionSchema>;
export type UpdateFaqSectionInput = z.infer<typeof updateFaqSectionSchema>;
export type CreateFaqItemInput = z.infer<typeof createFaqItemSchema>;
export type UpdateFaqItemInput = z.infer<typeof updateFaqItemSchema>;
export type ReorderFaqInput = z.infer<typeof reorderFaqSchema>;
