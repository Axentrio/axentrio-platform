import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware';
import { sendSuccess, sendCreated } from '../utils/response';
import { ToolRegistry } from '../agent/tool-registry';
import { listActiveModules } from '../modules';

const router = Router();
const toolRegistry = new ToolRegistry();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

interface SkillInput {
  name: string;
  displayName?: string;
  description?: string;
  trigger: string;
  tools: string[];
  instructions: string;
  maxSteps?: number;
  enabled?: boolean;
}

interface Skill extends SkillInput {
  maxSteps: number;
  enabled: boolean;
}

const NAME_REGEX = /^[a-zA-Z0-9_]{1,50}$/;
const MAX_SKILLS = 20;

export function validateSkill(input: Partial<SkillInput>): { valid: boolean; error?: string } {
  if (!input.name || !NAME_REGEX.test(input.name)) {
    return { valid: false, error: 'name must be 1-50 alphanumeric characters or underscores' };
  }
  if (input.displayName != null) {
    if (typeof input.displayName !== 'string' || input.displayName.length > 100) {
      return { valid: false, error: 'displayName must be a string with max 100 chars' };
    }
  }
  if (input.description != null) {
    if (typeof input.description !== 'string' || input.description.length > 500) {
      return { valid: false, error: 'description must be a string with max 500 chars' };
    }
  }
  if (!input.trigger || input.trigger.length > 500) {
    return { valid: false, error: 'trigger is required (max 500 chars)' };
  }
  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    return { valid: false, error: 'tools must be a non-empty array' };
  }
  if (!input.instructions || input.instructions.length > 2000) {
    return { valid: false, error: 'instructions is required (max 2000 chars)' };
  }
  if (input.maxSteps !== undefined && (input.maxSteps < 1 || input.maxSteps > 20)) {
    return { valid: false, error: 'maxSteps must be 1-20' };
  }
  return { valid: true };
}

export function validateToolNames(tools: string[]): { valid: boolean; invalidTools?: string[] } {
  const known = toolRegistry.getBuiltinToolNames();
  const invalid = tools.filter((t) => !known.includes(t));
  return invalid.length > 0 ? { valid: false, invalidTools: invalid } : { valid: true };
}

/**
 * Tenant-aware tool validation for skill WRITES: a new/updated skill may only
 * reference tools the tenant's agent actually has right now (core built-ins +
 * active modules' tools). Existing saved skills referencing inactive-module
 * tools are grandfathered — filtered at prompt time, never failing a read.
 */
export async function validateToolNamesForTenant(
  tenantId: string,
  tools: string[],
): Promise<{ valid: boolean; invalidTools?: string[] }> {
  const known = new Set<string>(['kb_search', 'escalate_to_human', 'capture_lead']);
  for (const active of await listActiveModules(tenantId)) {
    for (const tool of active.module.tools) known.add(tool.name);
  }
  const invalid = tools.filter((t) => !known.has(t));
  return invalid.length > 0 ? { valid: false, invalidTools: invalid } : { valid: true };
}

// GET /api/v1/tenants/me/skills
router.get(
  '/me/skills',
  requireRole('admin', 'supervisor'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const skills: Skill[] = (tenant.settings as any)?.skills || [];
    sendSuccess(res, { skills });
  })
);

// POST /api/v1/tenants/me/skills
router.post(
  '/me/skills',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const validation = validateSkill(req.body);
    if (!validation.valid) throw new ValidationError(validation.error!);

    const toolValidation = await validateToolNamesForTenant(tenantId, req.body.tools);
    if (!toolValidation.valid) {
      throw new ValidationError(`Tools not available on your plan: ${toolValidation.invalidTools!.join(', ')}`);
    }

    const skills: Skill[] = (tenant.settings as any)?.skills || [];
    if (skills.length >= MAX_SKILLS) throw new ValidationError(`Maximum ${MAX_SKILLS} skills allowed`);
    if (skills.some((s) => s.name === req.body.name)) throw new ValidationError(`Skill "${req.body.name}" already exists`);

    const skill: Skill = {
      name: req.body.name,
      displayName: req.body.displayName || undefined,
      description: req.body.description || undefined,
      trigger: req.body.trigger,
      tools: req.body.tools,
      instructions: req.body.instructions,
      maxSteps: req.body.maxSteps || 5,
      enabled: req.body.enabled !== false,
    };

    skills.push(skill);
    tenant.settings = { ...tenant.settings, skills } as any;
    await repo.save(tenant);

    sendCreated(res, { skill });
  })
);

// PUT /api/v1/tenants/me/skills/:name
router.put(
  '/me/skills/:name',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { name } = req.params;
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const skills: Skill[] = (tenant.settings as any)?.skills || [];
    const index = skills.findIndex((s) => s.name === name);
    if (index === -1) throw new NotFoundError(`Skill "${name}" not found`);

    if (req.body.tools) {
      const toolValidation = await validateToolNamesForTenant(tenantId, req.body.tools);
      if (!toolValidation.valid) {
        throw new ValidationError(`Tools not available on your plan: ${toolValidation.invalidTools!.join(', ')}`);
      }
    }

    const updated: Skill = { ...skills[index], ...req.body, name };

    // Validate the full merged skill
    const validation = validateSkill(updated);
    if (!validation.valid) throw new ValidationError(validation.error!);

    skills[index] = updated;
    tenant.settings = { ...tenant.settings, skills } as any;
    await repo.save(tenant);

    sendSuccess(res, { skill: updated });
  })
);

// DELETE /api/v1/tenants/me/skills/:name
router.delete(
  '/me/skills/:name',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { name } = req.params;
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const skills: Skill[] = (tenant.settings as any)?.skills || [];
    const filtered = skills.filter((s) => s.name !== name);
    if (filtered.length === skills.length) throw new NotFoundError(`Skill "${name}" not found`);

    tenant.settings = { ...tenant.settings, skills: filtered } as any;
    await repo.save(tenant);

    sendSuccess(res, { message: 'Skill deleted' });
  })
);

export default router;
