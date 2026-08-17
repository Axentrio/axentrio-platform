import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import AccountInformationSettings from './AccountInformationSettings';

const { get, put, extractApiErrorMessage } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  extractApiErrorMessage: vi.fn(),
}));

vi.mock('@services/apiClient', () => ({
  api: { get, put },
  extractApiErrorMessage,
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
  extractApiErrorMessage.mockReset().mockReturnValue(undefined);
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
        streetNumber: '',
        boxNumber: '',
        postalCode: '1500',
        city: 'Halle',
        country: 'BE',
      },
    });
  });

  it('renders street number, box number and country, and sends them on save', async () => {
    const user = userEvent.setup();
    render(<AccountInformationSettings />);
    await screen.findByDisplayValue('NV Colruyt Group');

    await user.type(screen.getByLabelText(/contact person/i), 'Jan Janssens');
    await user.type(screen.getByLabelText(/street number/i), '196');
    await user.type(screen.getByLabelText(/box number/i), '2');
    const country = screen.getByLabelText(/country code/i);
    await user.clear(country);
    await user.type(country, 'nl');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1].invoiceAddress).toMatchObject({
      street: 'Edingensesteenweg 196',
      streetNumber: '196',
      boxNumber: '2',
      country: 'NL',
    });
  });

  it('surfaces the API error on save failure instead of only a generic toast', async () => {
    const user = userEvent.setup();
    extractApiErrorMessage.mockReturnValue('invoiceAddress.country: Use a 2-letter country code');
    put.mockRejectedValue(new Error('Validation failed'));
    render(<AccountInformationSettings />);
    await screen.findByDisplayValue('NV Colruyt Group');

    await user.type(screen.getByLabelText(/contact person/i), 'Jan Janssens');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('invoiceAddress.country: Use a 2-letter country code');
  });
});
