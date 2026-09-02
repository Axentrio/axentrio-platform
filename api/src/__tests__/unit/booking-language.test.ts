import { describe, it, expect, vi, beforeEach } from 'vitest';

const { userGetOne, tenantFindOne, userQueryBuilder } = vi.hoisted(() => {
  const userGetOne = vi.fn();
  const tenantFindOne = vi.fn();
  function userQueryBuilder() {
    const terminal = {
      getOne: userGetOne,
      orderBy: () => terminal,
      limit: () => terminal,
      andWhere: () => terminal,
    };
    return {
      where: () => terminal,
      ...terminal,
    };
  }
  return { userGetOne, tenantFindOne, userQueryBuilder };
});

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name?: string }) => {
      if (entity?.name === 'Tenant') {
        return { findOne: tenantFindOne };
      }
      return { createQueryBuilder: userQueryBuilder };
    },
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  normalizeLanguageCode,
  customerLanguageFor,
  resolveOwnerLanguage,
} from '../../booking/booking-language';

describe('normalizeLanguageCode', () => {
  it('normalizes regional tags to base codes', () => {
    expect(normalizeLanguageCode('nl-BE')).toBe('nl');
    expect(normalizeLanguageCode('FR')).toBe('fr');
    expect(normalizeLanguageCode('en_US')).toBe('en');
    expect(normalizeLanguageCode('  fr-CA  ')).toBe('fr');
  });

  it('accepts three-letter ISO codes', () => {
    expect(normalizeLanguageCode('eng')).toBe('eng');
    expect(normalizeLanguageCode('DEU')).toBe('deu');
  });

  it('returns null for invalid values', () => {
    expect(normalizeLanguageCode(null)).toBeNull();
    expect(normalizeLanguageCode(undefined)).toBeNull();
    expect(normalizeLanguageCode('')).toBeNull();
    expect(normalizeLanguageCode('   ')).toBeNull();
    expect(normalizeLanguageCode('english')).toBeNull();
    expect(normalizeLanguageCode('123')).toBeNull();
    expect(normalizeLanguageCode('en-US-extra')).toBe('en');
    expect(normalizeLanguageCode('a')).toBeNull();
    expect(normalizeLanguageCode('toolong')).toBeNull();
    expect(normalizeLanguageCode(42)).toBeNull();
    expect(normalizeLanguageCode({ lang: 'nl' })).toBeNull();
  });

  it('rejects junk that matches the 2-3 letter shape but is not a real language', () => {
    expect(normalizeLanguageCode('not-real')).toBeNull();
    expect(normalizeLanguageCode('xx')).toBeNull();
    expect(normalizeLanguageCode('bogus')).toBeNull();
  });
});

describe('customerLanguageFor', () => {
  it('prefers the stored booking language', () => {
    expect(customerLanguageFor({ customerLanguage: 'nl' }, { ai: { language: 'fr' } } as any)).toBe('nl');
    expect(customerLanguageFor({ customerLanguage: 'nl-BE' }, { ai: { language: 'fr' } } as any)).toBe('nl');
  });

  it('falls back to the bot default', () => {
    expect(customerLanguageFor({}, { ai: { language: 'fr' } } as any)).toBe('fr');
    expect(customerLanguageFor({ customerLanguage: null }, { ai: { language: 'nl' } } as any)).toBe('nl');
  });

  it('ignores junk regional tags and uses the bot default', () => {
    expect(
      customerLanguageFor({ customerLanguage: 'not-real' }, { ai: { language: 'fr' } } as any),
    ).toBe('fr');
  });

  it('ignores invalid stored values and uses the bot default', () => {
    expect(customerLanguageFor({ customerLanguage: 'english' }, { ai: { language: 'fr' } } as any)).toBe('fr');
    expect(customerLanguageFor({ customerLanguage: '   ' }, { ai: {} } as any)).toBe('en');
  });

  it('returns English when neither stored nor bot language is valid', () => {
    expect(customerLanguageFor({ customerLanguage: 'bogus' }, { ai: { language: 'de' } } as any)).toBe('en');
  });
});

describe('resolveOwnerLanguage', () => {
  let userLookups: Array<{ locale?: string } | null>;

  beforeEach(() => {
    vi.clearAllMocks();
    userLookups = [];
    userGetOne.mockReset();
    tenantFindOne.mockReset();
    userGetOne.mockImplementation(async () => userLookups.shift() ?? null);
  });

  it('uses the support-email user locale when present', async () => {
    userLookups = [{ locale: 'nl' }];
    await expect(resolveOwnerLanguage('ten-1', 'owner@example.com')).resolves.toBe('nl');
    expect(userGetOne).toHaveBeenCalledOnce();
  });

  it('falls back to English when nothing matches', async () => {
    userLookups = [null, null];
    tenantFindOne.mockResolvedValue({ settings: {} });
    await expect(resolveOwnerLanguage('ten-1', 'owner@example.com')).resolves.toBe('en');
  });

  it('skips unsupported support-email locales and uses admin locale', async () => {
    userLookups = [{ locale: 'de' }, { locale: 'fr' }];
    await expect(resolveOwnerLanguage('ten-1', 'owner@example.com')).resolves.toBe('fr');
  });

  it('uses tenant onboarding language when users have no locale', async () => {
    userLookups = [null, null];
    tenantFindOne.mockResolvedValue({ settings: { onboarding: { language: 'nl' } } });
    await expect(resolveOwnerLanguage('ten-1', 'owner@example.com')).resolves.toBe('nl');
  });

  it('resolves without support email (admin path only)', async () => {
    userLookups = [{ locale: 'nl' }];
    await expect(resolveOwnerLanguage('ten-1', null)).resolves.toBe('nl');
    expect(userGetOne).toHaveBeenCalledOnce();
  });

  it('returns English when the database throws', async () => {
    userGetOne.mockImplementationOnce(async () => {
      throw new Error('db down');
    });
    await expect(resolveOwnerLanguage('ten-1', 'owner@example.com')).resolves.toBe('en');
  });

  it('ignores unsupported onboarding language', async () => {
    userLookups = [null, null];
    tenantFindOne.mockResolvedValue({ settings: { onboarding: { language: 'de' } } });
    await expect(resolveOwnerLanguage('ten-1', undefined)).resolves.toBe('en');
  });
});
