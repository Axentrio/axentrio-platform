import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountInformationSettings from './AccountInformationSettings';

const { get, put } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}));

vi.mock('@services/apiClient', () => ({
  api: { get, put },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const PREFILL = {
  officialBusinessName: 'NV Colruyt Group',
  vatNumber: 'BE0400378485',
  contactPerson: '',
  invoiceAddress: { street: 'Edingensesteenweg 196', postalCode: '1500', city: 'Halle', country: 'BE' },
  invoiceEmail: 'accounts@colruyt.be',
  phone: null,
  vatVerified: true,
};

beforeEach(() => {
  get.mockReset().mockResolvedValue(PREFILL);
  put.mockReset().mockResolvedValue({ ...PREFILL, contactPerson: 'Jan Janssens' });
});

describe('AccountInformationSettings', () => {
  it('prefills known onboarding / billing facts', async () => {
    render(<AccountInformationSettings />);
    expect(await screen.findByDisplayValue('NV Colruyt Group')).toBeInTheDocument();
    expect(screen.getByDisplayValue('BE0400378485')).toBeInTheDocument();
    expect(screen.getByDisplayValue('accounts@colruyt.be')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Edingensesteenweg 196')).toBeInTheDocument();
  });

  it('saves the six fields including an optional phone', async () => {
    const user = userEvent.setup();
    render(<AccountInformationSettings />);
    await screen.findByDisplayValue('NV Colruyt Group');

    await user.type(screen.getByLabelText(/contact person/i), 'Jan Janssens');
    await user.type(screen.getByLabelText(/^phone/i), '+32 2 363 55 45');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][0]).toBe('/tenants/me/account');
    expect(put.mock.calls[0][1]).toMatchObject({
      officialBusinessName: 'NV Colruyt Group',
      vatNumber: 'BE0400378485',
      contactPerson: 'Jan Janssens',
      invoiceEmail: 'accounts@colruyt.be',
      phone: '+32 2 363 55 45',
      invoiceAddress: {
        street: 'Edingensesteenweg 196',
        postalCode: '1500',
        city: 'Halle',
        country: 'BE',
      },
    });
  });
});
