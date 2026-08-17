import { z } from 'zod';
import { normalizeAccountVat } from '../integrations/company-lookup/vat-number';

const requiredText = (max: number) =>
  z.string().trim().min(1).max(max);

const iso2Country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use a 2-letter country code');

export const invoiceAddressSchema = z.object({
  street: requiredText(255),
  streetNumber: z.string().trim().max(16).optional(),
  boxNumber: z.string().trim().max(16).optional(),
  postalCode: requiredText(16),
  city: requiredText(120),
  country: iso2Country.default('BE'),
});

export const accountInformationWriteSchema = z.object({
  officialBusinessName: requiredText(255),
  vatNumber: z
    .string()
    .trim()
    .min(1)
    .transform((raw, ctx) => {
      const parsed = normalizeAccountVat(raw);
      if (!parsed.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            parsed.reason === 'too_long'
              ? 'VAT number must be at most 16 characters'
              : 'Invalid VAT number',
        });
        return z.NEVER;
      }
      return parsed.value;
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
