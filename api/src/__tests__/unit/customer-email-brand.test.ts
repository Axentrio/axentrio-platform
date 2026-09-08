/**
 * Customer confirmation brand: Clerk https logo + Booking-settings venue.
 * No Clerk, no DB — repos and organizationImageUrl are doubled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const bsFindOne = vi.fn();
const tenantFindOne = vi.fn();
const organizationImageUrl = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name?: string }) => {
      if (entity?.name === 'Tenant') return { findOne: tenantFindOne };
      return { findOne: bsFindOne };
    },
  },
}));

vi.mock('../../services/clerk-sync.service', () => ({
  organizationImageUrl: (...a: unknown[]) => organizationImageUrl(...a),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { loadCustomerEmailBrand } from '../../booking/booking-providers/customer-email-brand';

describe('loadCustomerEmailBrand', () => {
  beforeEach(() => {
    bsFindOne.mockReset();
    tenantFindOne.mockReset();
    organizationImageUrl.mockReset();
    bsFindOne.mockResolvedValue(null);
    tenantFindOne.mockResolvedValue(null);
    organizationImageUrl.mockResolvedValue(null);
  });

  it('returns both null when nothing is configured', async () => {
    expect(await loadCustomerEmailBrand('bot-1', 'ten-1')).toEqual({ logoUrl: null, venueLine: null });
    expect(organizationImageUrl).not.toHaveBeenCalled();
  });

  it('returns the venue line without a logo', async () => {
    bsFindOne.mockResolvedValue({
      venueStreet: 'Grote Markt 1',
      venuePostalCode: '9300',
      venueCity: 'Aalst',
      venueCountry: null,
    });
    expect(await loadCustomerEmailBrand('bot-1', 'ten-1')).toEqual({
      logoUrl: null,
      venueLine: 'Grote Markt 1, 9300 Aalst',
    });
    expect(organizationImageUrl).not.toHaveBeenCalled();
  });

  it('returns an https Clerk logo without a venue', async () => {
    tenantFindOne.mockResolvedValue({ id: 'ten-1', clerkOrgId: 'org_1' });
    organizationImageUrl.mockResolvedValue('https://img.clerk.example/logo.png');
    expect(await loadCustomerEmailBrand('bot-1', 'ten-1')).toEqual({
      logoUrl: 'https://img.clerk.example/logo.png',
      venueLine: null,
    });
    expect(organizationImageUrl).toHaveBeenCalledWith('org_1');
  });

  it('keeps the venue when the logo helper returns null', async () => {

    tenantFindOne.mockResolvedValue({ id: 'ten-1', clerkOrgId: 'org_1' });
    organizationImageUrl.mockResolvedValue(null);
    bsFindOne.mockResolvedValue({
      venueStreet: 'Grote Markt 1',
      venuePostalCode: '9300',
      venueCity: 'Aalst',
      venueCountry: null,
    });
    expect(await loadCustomerEmailBrand('bot-1', 'ten-1')).toEqual({
      logoUrl: null,
      venueLine: 'Grote Markt 1, 9300 Aalst',
    });
  });

});
