/**
 * VAT ID schema — EU-only acceptance, GB rejected post-Brexit.
 *
 * M0 acceptance criterion: `GB123456789` returns 400. v1 of the billing
 * integration relies on Stripe Tax's VIES validation, which covers EU
 * member states only. UK customers go through a sales-led path.
 */
import { describe, it, expect } from 'vitest';
import { updateVatIdSchema } from '../../schemas/billing.schema';

describe('updateVatIdSchema', () => {
  it('accepts a well-formed Belgian VAT ID', () => {
    const result = updateVatIdSchema.safeParse({ vatId: 'BE0123456789' });
    expect(result.success).toBe(true);
  });

  it('accepts Spanish and Irish IDs that include letters', () => {
    expect(updateVatIdSchema.safeParse({ vatId: 'ESA12345674' }).success).toBe(true);
    expect(updateVatIdSchema.safeParse({ vatId: 'IE1234567T' }).success).toBe(true);
  });

  it('accepts null and empty string as a "clear VAT ID" signal', () => {
    expect(updateVatIdSchema.safeParse({ vatId: null }).success).toBe(true);
    expect(updateVatIdSchema.safeParse({ vatId: '' }).success).toBe(true);
  });

  it('rejects GB-prefixed VAT IDs (M0 EU-only acceptance criterion)', () => {
    const result = updateVatIdSchema.safeParse({ vatId: 'GB123456789' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/UK|GB|EU-only/);
    }
  });

  it('rejects strings that fail the country-code regex', () => {
    expect(updateVatIdSchema.safeParse({ vatId: 'notavatid' }).success).toBe(false);
    expect(updateVatIdSchema.safeParse({ vatId: '123' }).success).toBe(false);
    expect(updateVatIdSchema.safeParse({ vatId: 'be0123456789' }).success).toBe(false); // lowercase
  });
});
