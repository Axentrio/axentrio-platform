import { z } from 'zod';
import { parseBelgianVat } from '../integrations/company-lookup/vat-number';

const requiredText = (max: number) =>
  z.string().trim().min(1).max(max);

export const invoiceAddressSchema = z.object({
  street: requiredText(255),
  postalCode: requiredText(16),
  city: requiredText(120),
  country: z.string().trim().length(2).default('BE'),
});

export const accountInformationWriteSchema = z.object({
  officialBusinessName: requiredText(255),
  vatNumber: z
    .string()
    .trim()
    .min(1)
    .transform((raw, ctx) => {
      const parsed = parseBelgianVat(raw);
      if (!parsed) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Belgian VAT / enterprise number' });
        return z.NEVER;
      }
      return parsed.vatNumber;
    }),
  contactPerson: requiredText(255),
  invoiceAddress: invoiceAddressSchema,
  invoiceEmail: z.string().trim().email().max(255),
  phone: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export type AccountInformationWrite = z.infer<typeof accountInformationWriteSchema>;
