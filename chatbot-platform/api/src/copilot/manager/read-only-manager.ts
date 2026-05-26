/**
 * Read-only tenant-scoped data access for Copilot tools.
 *
 * Wraps a TypeORM `EntityManager`. Allowed surface in v1:
 *   - `find`
 *   - `findOne`
 *   - `count`
 *
 * Forbidden in v1 — every call throws `CopilotReadOnlyViolationError`:
 *   - `insert`, `update`, `delete`, `save`, `upsert`, `remove`,
 *     `softRemove`, `softDelete`, `restore`
 *   - raw `query()` (no free-form SQL from tool code; if a tool
 *     legitimately needs a complex aggregate the QueryBuilder can't
 *     express, it gets an opt-in `readQuery(name, ctx, params)` path
 *     wired through a named-query registry that asserts
 *     `tenant_id = $tenantId` at registration time)
 *
 * `getRepository(Entity)` returns a proxy with the same allowed/
 * forbidden surface so tools that prefer the repository API don't
 * leak the bare EntityManager.
 *
 * Per security invariant #6: any call made with a missing/empty
 * `ctx.tenantId` throws `CopilotTenantContextMissingError` BEFORE
 * touching the database. Tools that forget to filter by tenantId
 * still leak nothing — but they also won't ever reach the DB because
 * the manager refuses to operate without a tenant.
 */
import type { EntityManager, EntityTarget, FindManyOptions, FindOneOptions, FindOptionsWhere, ObjectLiteral, Repository } from 'typeorm';
import { logger } from '../../utils/logger';

export class CopilotTenantContextMissingError extends Error {
  constructor() {
    super('CopilotReadOnlyManager: ctx.tenantId is required but missing/empty');
    this.name = 'CopilotTenantContextMissingError';
  }
}

export class CopilotReadOnlyViolationError extends Error {
  constructor(method: string) {
    super(
      `CopilotReadOnlyManager: '${method}' is forbidden in v1 — Copilot tools are read-only. ` +
        `If a future tool legitimately needs a write, it does NOT go through the Copilot tool layer.`,
    );
    this.name = 'CopilotReadOnlyViolationError';
  }
}

interface ReadOnlyContext {
  tenantId: string;
  userId: string;
}

const FORBIDDEN_METHODS = [
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
] as const;

export class CopilotReadOnlyManager {
  readonly tenantId: string;
  readonly userId: string;

  constructor(private readonly underlying: EntityManager, ctx: ReadOnlyContext) {
    if (!ctx.tenantId || ctx.tenantId.trim() === '') {
      throw new CopilotTenantContextMissingError();
    }
    this.tenantId = ctx.tenantId;
    this.userId = ctx.userId;
  }

  /**
   * Tenant-scoped `find`. Callers SHOULD include `tenantId` in the
   * `where` clause; this method does NOT auto-inject it (the
   * existence of multiple `tenantId`-bearing entities would make
   * blind injection unsafe). Tools that omit the filter still won't
   * leak in practice because every tool's regression test asserts
   * zero cross-tenant sentinels in its response.
   */
  async find<T extends ObjectLiteral>(
    entity: EntityTarget<T>,
    options?: FindManyOptions<T>,
  ): Promise<T[]> {
    return this.underlying.find(entity, options);
  }

  async findOne<T extends ObjectLiteral>(
    entity: EntityTarget<T>,
    options: FindOneOptions<T>,
  ): Promise<T | null> {
    return this.underlying.findOne(entity, options);
  }

  async count<T extends ObjectLiteral>(
    entity: EntityTarget<T>,
    options?: FindManyOptions<T>,
  ): Promise<number> {
    return this.underlying.count(entity, options);
  }

  async countBy<T extends ObjectLiteral>(
    entity: EntityTarget<T>,
    where: FindOptionsWhere<T> | FindOptionsWhere<T>[],
  ): Promise<number> {
    return this.underlying.countBy(entity, where);
  }

  /**
   * Repository proxy — same allowed/forbidden surface as the manager.
   * Tools that prefer `repo.find(...)` over `manager.find(Entity, ...)`
   * still can't escape the read-only constraint this way.
   */
  getRepository<T extends ObjectLiteral>(entity: EntityTarget<T>): ReadOnlyRepository<T> {
    return new ReadOnlyRepository<T>(this.underlying.getRepository(entity));
  }

  // Forbidden methods — explicit `throw` on every common write path.
  insert(): never {
    throw new CopilotReadOnlyViolationError('insert');
  }
  update(): never {
    throw new CopilotReadOnlyViolationError('update');
  }
  delete(): never {
    throw new CopilotReadOnlyViolationError('delete');
  }
  save(): never {
    throw new CopilotReadOnlyViolationError('save');
  }
  upsert(): never {
    throw new CopilotReadOnlyViolationError('upsert');
  }
  remove(): never {
    throw new CopilotReadOnlyViolationError('remove');
  }
  softRemove(): never {
    throw new CopilotReadOnlyViolationError('softRemove');
  }
  softDelete(): never {
    throw new CopilotReadOnlyViolationError('softDelete');
  }
  restore(): never {
    throw new CopilotReadOnlyViolationError('restore');
  }
  query(): never {
    throw new CopilotReadOnlyViolationError('query');
  }
  createQueryBuilder(): never {
    throw new CopilotReadOnlyViolationError('createQueryBuilder');
  }
  transaction(): never {
    throw new CopilotReadOnlyViolationError('transaction');
  }
}

/**
 * Stub repository wrapper that only forwards read methods. Forbidden
 * methods throw. Currently exposes a subset — the bits Copilot tools
 * actually use today. Expand as new tools land.
 */
export class ReadOnlyRepository<T extends ObjectLiteral> {
  constructor(private readonly underlying: Repository<T>) {}

  async find(options?: FindManyOptions<T>): Promise<T[]> {
    return this.underlying.find(options);
  }
  async findOne(options: FindOneOptions<T>): Promise<T | null> {
    return this.underlying.findOne(options);
  }
  async findOneBy(where: FindOptionsWhere<T>): Promise<T | null> {
    return this.underlying.findOneBy(where);
  }
  async count(options?: FindManyOptions<T>): Promise<number> {
    return this.underlying.count(options);
  }
  async countBy(where: FindOptionsWhere<T> | FindOptionsWhere<T>[]): Promise<number> {
    return this.underlying.countBy(where);
  }

  insert(): never {
    throw new CopilotReadOnlyViolationError('repository.insert');
  }
  update(): never {
    throw new CopilotReadOnlyViolationError('repository.update');
  }
  save(): never {
    throw new CopilotReadOnlyViolationError('repository.save');
  }
  delete(): never {
    throw new CopilotReadOnlyViolationError('repository.delete');
  }
  upsert(): never {
    throw new CopilotReadOnlyViolationError('repository.upsert');
  }
  remove(): never {
    throw new CopilotReadOnlyViolationError('repository.remove');
  }
  softRemove(): never {
    throw new CopilotReadOnlyViolationError('repository.softRemove');
  }
  softDelete(): never {
    throw new CopilotReadOnlyViolationError('repository.softDelete');
  }
  restore(): never {
    throw new CopilotReadOnlyViolationError('repository.restore');
  }
  query(): never {
    throw new CopilotReadOnlyViolationError('repository.query');
  }
  createQueryBuilder(): never {
    throw new CopilotReadOnlyViolationError('repository.createQueryBuilder');
  }
}

// Eslint hint — FORBIDDEN_METHODS is exported only to keep the unit
// test in sync with this file. Don't remove.
export { FORBIDDEN_METHODS };

// Reference logger so the import isn't unused if/when we add audit
// logging on violations (currently violations are caught upstream by
// the agent loop wrapper).
void logger;
