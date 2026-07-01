/**
 * Module authoring service — super-admin CRUD for authored Modules and their
 * immutable versions (composable-templates Phase 4). Mirrors the BotTemplate
 * version lifecycle (template-admin.service): a Module is the catalog row; its
 * editable prose lives in ModuleVersion rows that go draft → published →
 * unpublished and are frozen once published.
 *
 * A Module binds engineered skills (v1: exactly 1) and carries prose only —
 * validateModuleProse rejects tool-availability claims at the authoring layer.
 */
import { AppDataSource } from '../database/data-source';
import { Module } from '../database/entities/Module';
import { ModuleVersion } from '../database/entities/ModuleVersion';
import { getModule as getSkill } from '../modules';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/error-handler';
import { validateModuleProse } from './template-admin.service';

/** Validates the skill bindings: one or more known catalog ids (deduped). */
export function validateSkillIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ValidationError('skillIds must be an array of skill ids');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || !id.trim()) throw new ValidationError('skillIds entries must be non-empty strings');
    if (!getSkill(id)) throw new ValidationError(`skillIds: unknown skill id "${id}"`);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  if (out.length === 0) throw new ValidationError('a module must bind at least one skill');
  return out;
}

function validateName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('module name is required');
  if (value.length > 200) throw new ValidationError('module name exceeds 200 characters');
  return value.trim();
}

/** Create a Module catalog row plus its first draft version (version 1). */
export async function createModule(input: {
  name: unknown;
  description?: unknown;
  skillIds: unknown;
  prose?: unknown;
}): Promise<{ module: Module; version: ModuleVersion }> {
  const name = validateName(input.name);
  const skillIds = validateSkillIds(input.skillIds);
  const description =
    input.description == null ? null : typeof input.description === 'string' ? input.description.trim() : (() => { throw new ValidationError('description must be a string'); })();
  const prose = input.prose === undefined ? '' : validateModuleProse(input.prose);

  return AppDataSource.transaction(async (manager) => {
    const module = await manager.getRepository(Module).save(
      manager.getRepository(Module).create({ name, description, skillIds }),
    );
    const version = await manager.getRepository(ModuleVersion).save(
      manager.getRepository(ModuleVersion).create({ moduleId: module.id, version: 1, prose, status: 'draft', lockVersion: 0 }),
    );
    return { module, version };
  });
}

/** Edit a Module's catalog fields (name/description/skill bindings). */
export async function editModule(
  moduleId: string,
  input: { name?: unknown; description?: unknown; skillIds?: unknown },
): Promise<Module> {
  const repo = AppDataSource.getRepository(Module);
  const row = await repo.findOne({ where: { id: moduleId } });
  if (!row) throw new NotFoundError('Module not found');
  if (input.name !== undefined) row.name = validateName(input.name);
  if (input.description !== undefined) {
    row.description = input.description == null ? null : typeof input.description === 'string' ? input.description.trim() : (() => { throw new ValidationError('description must be a string'); })();
  }
  if (input.skillIds !== undefined) row.skillIds = validateSkillIds(input.skillIds);
  return repo.save(row);
}

/** Create a new draft version with a row-locked, transactionally-allocated number. */
export async function createModuleDraftVersion(
  moduleId: string,
  input: { prose?: unknown },
): Promise<ModuleVersion> {
  const prose = input.prose === undefined ? '' : validateModuleProse(input.prose);
  return AppDataSource.transaction(async (manager) => {
    const locked = await manager
      .getRepository(Module)
      .createQueryBuilder('m')
      .setLock('pessimistic_write')
      .where('m.id = :id', { id: moduleId })
      .getOne();
    if (!locked) throw new NotFoundError('Module not found');

    const max = await manager
      .getRepository(ModuleVersion)
      .createQueryBuilder('v')
      .select('COALESCE(MAX(v.version), 0)', 'max')
      .where('v.moduleId = :moduleId', { moduleId })
      .getRawOne<{ max: number }>();
    const version = Number(max?.max ?? 0) + 1;

    const repo = manager.getRepository(ModuleVersion);
    return repo.save(repo.create({ moduleId, version, prose, status: 'draft', lockVersion: 0 }));
  });
}

/** Edit a DRAFT version. Published/unpublished versions are immutable (409). */
export async function editModuleDraftVersion(
  moduleId: string,
  version: number,
  input: { prose?: unknown; lockVersion?: number },
): Promise<ModuleVersion> {
  return AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(ModuleVersion);
    const row = await repo.findOne({ where: { moduleId, version } });
    if (!row) throw new NotFoundError('Module version not found');
    if (row.status !== 'draft') {
      throw new ConflictError('Only draft versions are editable; published versions are immutable', { status: row.status });
    }
    if (input.lockVersion !== undefined && input.lockVersion !== row.lockVersion) {
      throw new ConflictError('Draft was modified by someone else — reload and retry', {
        expected: row.lockVersion,
        got: input.lockVersion,
      });
    }
    if (input.prose !== undefined) row.prose = validateModuleProse(input.prose);
    row.lockVersion += 1;
    return repo.save(row);
  });
}

/** Publish a draft (draft → published, frozen). */
export async function publishModuleVersion(
  moduleId: string,
  version: number,
  publishedBy: string,
): Promise<ModuleVersion> {
  const repo = AppDataSource.getRepository(ModuleVersion);
  const row = await repo.findOne({ where: { moduleId, version } });
  if (!row) throw new NotFoundError('Module version not found');
  if (row.status !== 'draft') {
    throw new ConflictError(`Only a draft can be published (this version is ${row.status})`, { status: row.status });
  }
  row.status = 'published';
  row.publishedAt = new Date();
  row.publishedBy = publishedBy;
  return repo.save(row);
}

/** All modules with their version rows (super-admin authoring list). */
export async function listModules(): Promise<Array<{ module: Module; versions: ModuleVersion[] }>> {
  const modules = await AppDataSource.getRepository(Module).find({ order: { createdAt: 'DESC' } });
  if (modules.length === 0) return [];
  const versions = await AppDataSource.getRepository(ModuleVersion).find({ order: { version: 'ASC' } });
  const byModule = new Map<string, ModuleVersion[]>();
  for (const v of versions) {
    const list = byModule.get(v.moduleId) ?? [];
    list.push(v);
    byModule.set(v.moduleId, list);
  }
  return modules.map((module) => ({ module, versions: byModule.get(module.id) ?? [] }));
}
