/**
 * Unit: CopilotReadOnlyManager — every forbidden write path throws.
 * No DB needed; we mock the underlying EntityManager.
 */
import { describe, it, expect } from 'vitest';
import {
  CopilotReadOnlyManager,
  CopilotReadOnlyViolationError,
  CopilotTenantContextMissingError,
  FORBIDDEN_METHODS,
} from '../../copilot/manager/read-only-manager';

function makeManager(): CopilotReadOnlyManager {
  const fakeUnderlying = {
    find: async () => [],
    findOne: async () => null,
    count: async () => 0,
    countBy: async () => 0,
    getRepository: () => ({
      find: async () => [],
      findOne: async () => null,
      findOneBy: async () => null,
      count: async () => 0,
      countBy: async () => 0,
    }),
  } as any;
  return new CopilotReadOnlyManager(fakeUnderlying, {
    tenantId: '00000000-0000-0000-0000-000000000001',
    userId: '00000000-0000-0000-0000-000000000002',
  });
}

describe('CopilotReadOnlyManager — construction', () => {
  it('refuses construction with an empty tenantId', () => {
    expect(() => new CopilotReadOnlyManager({} as any, { tenantId: '', userId: 'u' })).toThrow(
      CopilotTenantContextMissingError,
    );
    expect(() =>
      new CopilotReadOnlyManager({} as any, { tenantId: '   ', userId: 'u' }),
    ).toThrow(CopilotTenantContextMissingError);
  });

  it('accepts a non-empty tenantId', () => {
    expect(() => makeManager()).not.toThrow();
  });
});

describe('CopilotReadOnlyManager — allowed read methods', () => {
  it('find returns []', async () => {
    const m = makeManager();
    expect(await m.find({} as any)).toEqual([]);
  });
  it('findOne returns null', async () => {
    const m = makeManager();
    expect(await m.findOne({} as any, {})).toBeNull();
  });
  it('count returns a number', async () => {
    const m = makeManager();
    expect(await m.count({} as any)).toBe(0);
  });
});

describe('CopilotReadOnlyManager — forbidden methods throw', () => {
  // Hand-rolled list mirrors the one exported from the manager — if it
  // drifts, the test below catches the drift.
  const methodsToTest: ReadonlyArray<keyof CopilotReadOnlyManager> = [
    'insert',
    'update',
    'delete',
    'save',
    'upsert',
    'remove',
    'softRemove',
    'softDelete',
    'restore',
    'query',
    'createQueryBuilder',
    'transaction',
  ];

  it.each(methodsToTest)('%s throws CopilotReadOnlyViolationError', (method) => {
    const m = makeManager();
    expect(() => (m[method] as any).call(m)).toThrow(CopilotReadOnlyViolationError);
  });

  it('exported FORBIDDEN_METHODS contains exactly the methods tested above', () => {
    // Belt-and-suspenders: if someone adds to FORBIDDEN_METHODS but forgets
    // to add the test or vice versa, this fails.
    expect([...FORBIDDEN_METHODS].sort()).toEqual([...methodsToTest].sort());
  });
});

describe('ReadOnlyRepository — forbidden methods throw', () => {
  const writeMethods = [
    'insert',
    'update',
    'save',
    'delete',
    'upsert',
    'remove',
    'softRemove',
    'softDelete',
    'restore',
    'query',
    'createQueryBuilder',
  ] as const;

  it.each(writeMethods)('repository.%s throws', (method) => {
    const m = makeManager();
    const repo = m.getRepository({} as any) as any;
    expect(() => repo[method]()).toThrow(CopilotReadOnlyViolationError);
  });

  it('repository read methods do not throw', async () => {
    const m = makeManager();
    const repo = m.getRepository({} as any);
    await expect(repo.find()).resolves.toEqual([]);
    await expect(repo.findOne({})).resolves.toBeNull();
    await expect(repo.findOneBy({})).resolves.toBeNull();
    await expect(repo.count()).resolves.toBe(0);
    await expect(repo.countBy({})).resolves.toBe(0);
  });
});
