import { describe, it, expect } from 'vitest';
import { updateWidgetAppearanceSchema } from '../../schemas/widget-appearance.schema';

describe('updateWidgetAppearanceSchema', () => {
  it('accepts a fully populated valid payload', () => {
    const result = updateWidgetAppearanceSchema.safeParse({
      primaryColor: '#6366f1',
      avatarUrl: 'https://example.com/avatar.png',
      launcherPosition: 'bottom-left',
      launcherLabel: 'Chat with us',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object (all fields optional)', () => {
    const result = updateWidgetAppearanceSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts empty strings for nullable fields (controller normalizes to null later)', () => {
    const result = updateWidgetAppearanceSchema.safeParse({
      avatarUrl: '',
      launcherLabel: '',
    });
    expect(result.success).toBe(true);
  });

  it('accepts null for nullable fields', () => {
    const result = updateWidgetAppearanceSchema.safeParse({
      avatarUrl: null,
      launcherLabel: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects malformed primaryColor (must be 6-digit hex)', () => {
    const result = updateWidgetAppearanceSchema.safeParse({ primaryColor: 'red' });
    expect(result.success).toBe(false);
  });

  it('rejects primaryColor as empty string (cannot be cleared)', () => {
    const result = updateWidgetAppearanceSchema.safeParse({ primaryColor: '' });
    expect(result.success).toBe(false);
  });

  it('rejects non-URL avatarUrl values', () => {
    const result = updateWidgetAppearanceSchema.safeParse({ avatarUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('rejects launcherPosition values outside the enum', () => {
    const result = updateWidgetAppearanceSchema.safeParse({ launcherPosition: 'top-right' });
    expect(result.success).toBe(false);
  });

  it('rejects launcherLabel longer than 30 characters', () => {
    const result = updateWidgetAppearanceSchema.safeParse({
      launcherLabel: 'x'.repeat(31),
    });
    expect(result.success).toBe(false);
  });

  it('rejects avatarUrl longer than 2048 characters', () => {
    const result = updateWidgetAppearanceSchema.safeParse({
      avatarUrl: 'https://example.com/' + 'a'.repeat(2050),
    });
    expect(result.success).toBe(false);
  });
});
