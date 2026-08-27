import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import AccountInformationSettings from './AccountInformationSettings';

const { get, put, post, extractApiErrorMessage, authState } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  extractApiErrorMessage: vi.fn(),
  authState: { isAdmin: false },
}));

vi.mock('@services/apiClient', () => ({
  api: { get, put, post },
  extractApiErrorMessage,
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@auth/useAppAuth', () => ({
  useAppAuth: () => ({ isRole: () => authState.isAdmin }),
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

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AccountInformationSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authState.isAdmin = false;
  get.mockReset().mockResolvedValue(PREFILL);
  put.mockReset().mockResolvedValue({ ...PREFILL, contactPerson: 'Jan Janssens' });
  post.mockReset();
  extractApiErrorMessage.mockReset().mockReturnValue(undefined);
});

describe('AccountInformationSettings', () => {
  it('prefills known onboarding / billing facts', async () => {
    renderPage();
    expect(await screen.findByDisplayValue('NV Colruyt Group')).toBeInTheDocument();
    expect(screen.getByDisplayValue('BE0400378485')).toBeInTheDocument();
    expect(screen.getByDisplayValue('accounts@colruyt.be')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Edingensesteenweg 196')).toBeInTheDocument();
  });

  it('saves the six fields including an optional phone', async () => {
    const user = userEvent.setup();
    renderPage();
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
    renderPage();
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
    renderPage();
    await screen.findByDisplayValue('NV Colruyt Group');

    await user.type(screen.getByLabelText(/contact person/i), 'Jan Janssens');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('invoiceAddress.country: Use a 2-letter country code');
  });

  it('hides setup restart from a non-admin', async () => {
    renderPage();
    await screen.findByDisplayValue('NV Colruyt Group');
    expect(screen.queryByRole('button', { name: 'Do setup again' })).not.toBeInTheDocument();
  });

  it('restarts setup after the admin confirms', async () => {
    authState.isAdmin = true;
    post.mockResolvedValue({ complete: false, nextStep: 'language', state: { steps: {} } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('NV Colruyt Group');

    await user.click(screen.getByRole('button', { name: 'Do setup again' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Do setup again?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'You will walk through every setup step from the start. Your documents, chats, and billing stay as they are. If you skip a feature in setup, the platform turns that feature off. Your team cannot use the portal until an admin finishes the steps.',
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Start setup again' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/onboarding/restart'));
  });
});
