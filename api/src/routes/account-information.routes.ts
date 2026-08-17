/**
 * Account Information — GET/PUT /tenants/me/account (#148).
 *
 * Tenant invoice identity. Distinct from Profile (Clerk user) and from the
 * bot's quoted address (#153). Admin-only writes.
 */
import { Router, Request, Response } from 'express';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { requireAdmin, asyncHandler, NotFoundError } from '../middleware';
import { validate } from '../middleware/validate';
import { sendSuccess } from '../utils/response';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { accountInformationWriteSchema } from '../schemas/account-information.schema';
import {
  prefillAccountInformation,
  type AccountInformation,
  type InvoiceAddress,
} from '../account/account-information';
import { lookupCompanyByVat } from '../integrations/company-lookup/company-lookup.service';

const router = Router();

router.use(requireClerkAuth, autoProvision);

function storedAccount(tenant: Tenant): AccountInformation | null {
  if (!tenant.officialBusinessName && !tenant.vatNumber && !tenant.invoiceEmail && !tenant.contactPerson) {
    return null;
  }
  return {
    officialBusinessName: tenant.officialBusinessName ?? '',
    vatNumber: tenant.vatNumber ?? '',
    contactPerson: tenant.contactPerson ?? '',
    invoiceAddress: tenant.invoiceAddress ?? { street: '', postalCode: '', city: '', country: 'BE' },
    invoiceEmail: tenant.invoiceEmail ?? '',
    phone: tenant.accountPhone ?? null,
    vatVerified: tenant.vatVerified === true,
  };
}

function readAccount(tenant: Tenant): AccountInformation {
  const saved = storedAccount(tenant);
  if (saved) return saved;
  return prefillAccountInformation({
    company: tenant.settings?.onboarding?.company ?? null,
    billingEmail: tenant.billingInfo?.billingEmail ?? null,
    tenantName: tenant.name,
  });
}

router.get(
  '/account',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');
    sendSuccess(res, readAccount(tenant));
  }),
);

router.put(
  '/account',
  requireAdmin,
  validate(accountInformationWriteSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const body = req.body as {
      officialBusinessName: string;
      vatNumber: string;
      contactPerson: string;
      invoiceAddress: InvoiceAddress;
      invoiceEmail: string;
      phone: string | null;
    };

    let vatVerified = tenant.vatNumber === body.vatNumber ? tenant.vatVerified : false;
    const looksBelgian = /^BE/.test(body.vatNumber) || /^\d+$/.test(body.vatNumber);
    if (tenant.vatNumber !== body.vatNumber && looksBelgian) {
      const lookup = await lookupCompanyByVat(body.vatNumber);
      vatVerified = lookup.status === 'found';
    }

    tenant.officialBusinessName = body.officialBusinessName;
    tenant.vatNumber = body.vatNumber;
    tenant.contactPerson = body.contactPerson;
    tenant.invoiceAddress = body.invoiceAddress;
    tenant.invoiceEmail = body.invoiceEmail;
    tenant.accountPhone = body.phone;
    tenant.vatVerified = vatVerified;
    await repo.save(tenant);

    sendSuccess(res, readAccount(tenant));
  }),
);

export default router;
