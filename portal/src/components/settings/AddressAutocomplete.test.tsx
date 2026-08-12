/**
 * The suggestion list renders what the server actually returned.
 *
 * It did not. The request succeeded, Google returned five suggestions, the response arrived
 * intact - and the list stayed empty, with no error on screen. Reported as "the address search
 * doesn't work", and from outside the box that is exactly what it looked like.
 *
 * The cause was a double unwrap. `api.post` already resolves to the response BODY
 * (`apiClient.ts:165` does `.then(res => res.data)`), and the response interceptor has already
 * stripped the `{ success, data }` envelope - so the promise resolves to `{ suggestions: [...] }`.
 * The component destructured `const { data } = await api.post(...)` as though it had an axios
 * response, so `data` was `undefined` and `data.suggestions` threw. The `catch` around it exists so
 * that a Google outage never looks like a broken form, and it swallowed the TypeError into an empty
 * list - turning a code defect into the exact appearance of a working-but-empty search.
 *
 * The fifth instance of this platform's recurring shape: the value arrived correctly and was
 * dropped at the last step. So these tests assert on what a person SEES, and the second one
 * hard-fails on the throw rather than letting the catch hide it again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock('../../services/apiClient', () => ({
  api: { get: vi.fn(), post: apiPost, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  extractApiErrorMessage: () => undefined,
}));

import { AddressAutocomplete } from './AddressAutocomplete';

/** EXACTLY what `api.post` resolves to in the browser, envelope already stripped twice. */
const RESOLVED = {
  suggestions: [
    { placeId: 'ChIJZ2jHc-2kw0cRpwJzeGY6i8E', text: 'Brussels, Belgium' },
    { placeId: 'ChIJucWFf-jEw0cRqJFfGhYGsqM', text: 'Brussel-Zuid, Avenue Fonsny, Brussels, Belgium' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('AddressAutocomplete', () => {
  it('shows the suggestions the server returned', async () => {
    apiPost.mockResolvedValue(RESOLVED);
    render(<AddressAutocomplete onSelect={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/search for your address/i), {
      target: { value: 'brussel' },
    });

    // What the owner is looking for on screen. Asserting on the fetch instead would have passed
    // throughout the bug: the request was always fired and always answered.
    expect(await screen.findByText('Brussels, Belgium')).toBeInTheDocument();
    expect(screen.getByText(/Brussel-Zuid/)).toBeInTheDocument();
  });

  it('passes the SELECTED address up, not an undefined wrapper', async () => {
    // The same defect on the other call site, and the more damaging one: picking a suggestion
    // filled the four fields below from `undefined`, so the shortcut silently did nothing.
    apiPost.mockResolvedValueOnce(RESOLVED).mockResolvedValueOnce({
      placeId: 'ChIJZ2jHc-2kw0cRpwJzeGY6i8E',
      formattedAddress: 'Brussels, Belgium',
      components: { street: null, postalCode: '1000', city: 'Brussels', country: 'BE' },
    });
    const onSelect = vi.fn();
    render(<AddressAutocomplete onSelect={onSelect} />);

    fireEvent.change(screen.getByLabelText(/search for your address/i), {
      target: { value: 'brussel' },
    });
    fireEvent.click(await screen.findByText('Brussels, Belgium'));

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ formattedAddress: 'Brussels, Belgium' })
      )
    );
  });

  it('stays quiet below the server minimum, so typing does not bill a request per keystroke', async () => {
    apiPost.mockResolvedValue(RESOLVED);
    render(<AddressAutocomplete onSelect={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/search for your address/i), { target: { value: 'br' } });

    await new Promise((r) => setTimeout(r, 400));
    expect(apiPost).not.toHaveBeenCalled();
  });
});
