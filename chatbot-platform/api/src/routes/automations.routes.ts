import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware';
import { sendSuccess } from '../utils/response';
import { logger } from '../utils/logger';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

const VALID_TYPES = ['bookingConfirmation', 'newLeadAlert', 'conversationSummary', 'followUp'] as const;
type AutomationType = typeof VALID_TYPES[number];
const RECIPIENT_REQUIRED_TYPES: AutomationType[] = ['newLeadAlert', 'conversationSummary'];

export interface AutomationUpdateInput {
  enabled?: boolean;
  subject?: string;
  body?: string;
  recipients?: string[];
}

export function validateAutomationUpdate(
  type: string,
  body: AutomationUpdateInput
): { valid: boolean; error?: string } {
  if (!VALID_TYPES.includes(type as AutomationType)) {
    return { valid: false, error: `Invalid automation type "${type}". Valid types: ${VALID_TYPES.join(', ')}` };
  }

  if (body.subject !== undefined && body.subject.length > 200) {
    return { valid: false, error: 'subject must not exceed 200 characters' };
  }

  if (body.body !== undefined && body.body.length > 5000) {
    return { valid: false, error: 'body must not exceed 5000 characters' };
  }

  const automationType = type as AutomationType;
  if (RECIPIENT_REQUIRED_TYPES.includes(automationType)) {
    if (body.enabled === true && (!Array.isArray(body.recipients) || body.recipients.length === 0)) {
      return { valid: false, error: `recipients are required when enabling "${type}"` };
    }
  }

  if (Array.isArray(body.recipients) && body.recipients.length > 0) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = body.recipients.filter((r: string) => !emailRegex.test(r));
    if (invalidEmails.length > 0) {
      return { valid: false, error: `Invalid email addresses: ${invalidEmails.join(', ')}` };
    }
  }

  return { valid: true };
}

// GET /api/v1/tenants/me/automations
router.get(
  '/me/automations',
  requireRole('admin', 'supervisor'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const automations = (tenant.settings as any)?.automations || {};
    sendSuccess(res, { automations });
  })
);

// PATCH /api/v1/tenants/me/automations/email/:type
router.patch(
  '/me/automations/email/:type',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { type } = req.params;

    const validation = validateAutomationUpdate(type, req.body);
    if (!validation.valid) throw new ValidationError(validation.error!);

    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const existing = (tenant.settings as any)?.automations || {};
    const emailNotifications = existing.emailNotifications || {};
    const current = emailNotifications[type] || {};

    const { enabled, subject, body, recipients, delayHours } = req.body;
    const updated = { ...current };
    if (enabled !== undefined) updated.enabled = enabled;
    if (subject !== undefined) updated.subject = subject;
    if (body !== undefined) updated.body = body;
    if (recipients !== undefined) updated.recipients = recipients;
    if (delayHours !== undefined) updated.delayHours = delayHours;
    tenant.settings = {
      ...tenant.settings,
      automations: {
        ...existing,
        emailNotifications: {
          ...emailNotifications,
          [type]: updated,
        },
      },
    } as any;

    await repo.save(tenant);

    logger.info('Automation updated', { tenantId, type });

    sendSuccess(res, { type, automation: updated });
  })
);

// POST /api/v1/tenants/me/automations/email/:type/test
router.post(
  '/me/automations/email/:type/test',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { type } = req.params;

    if (!VALID_TYPES.includes(type as AutomationType)) {
      throw new ValidationError(`Invalid automation type "${type}". Valid types: ${VALID_TYPES.join(', ')}`);
    }

    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const emailNotifications = (tenant.settings as any)?.automations?.emailNotifications || {};
    const automation = emailNotifications[type];

    if (!automation?.enabled) {
      throw new ValidationError(`Automation "${type}" is not enabled`);
    }

    // Stub: in production this would trigger the actual email send
    logger.info('Test email sent', { tenantId, type });

    sendSuccess(res, { message: `Test email sent for "${type}"` });
  })
);

export default router;
