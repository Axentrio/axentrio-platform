/**
 * The picker asks once and then gets out of the way.
 *
 * The partner spec draws "Where do you work?" as a stored setting. It is not stored, and these
 * tests are what keep that decision from being quietly undone: the moment this control can rewrite
 * an existing catalog, the platform has two answers to one question - a column that says "on the
 * road" and services that say "customers come to me" - and every screen downstream has to pick a
 * winner.
 *
 * So the rules under test are: offer the choice ONLY on an empty catalog, create services that
 * actually produce the chosen answer, and once services exist show the derived value and nothing
 * clickable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkLocationPicker } from './WorkLocationPicker';
import type { Service } from '@/queries/useSchedulerQueries';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const onCreateService = vi.fn();

const service = (over: Partial<Service> = {}): Service =>
  ({ id: 's1', name: 'Existing', durationMin: 60, isActive: true, ...over }) as Service;

beforeEach(() => {
  vi.clearAllMocks();
  onCreateService.mockResolvedValue({});
});

describe('on an empty catalog', () => {
  it('offers all four answers', () => {
    render(
      <WorkLocationPicker workLocation="at_one_location" services={[]} onCreateService={onCreateService} />
    );
    for (const label of ['No location', 'At one location', 'On the road', 'Both']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('"On the road" creates a service that REQUIRES the customer address', async () => {
    // The field that decides everything downstream: address collection, the travel gate,
    // service-area checks and the calendar invite. If this is false, nothing else matters.
    render(
      <WorkLocationPicker workLocation="no_location" services={[]} onCreateService={onCreateService} />
    );
    await userEvent.click(screen.getByRole('button', { name: /On the road/i }));

    await waitFor(() => expect(onCreateService).toHaveBeenCalledTimes(1));
    expect(onCreateService.mock.calls[0][0]).toMatchObject({ customerAddressRequired: true });
  });

  it('"At one location" creates one that does NOT', async () => {
    render(
      <WorkLocationPicker workLocation="no_location" services={[]} onCreateService={onCreateService} />
    );
    await userEvent.click(screen.getByRole('button', { name: /At one location/i }));

    await waitFor(() => expect(onCreateService).toHaveBeenCalledTimes(1));
    expect(onCreateService.mock.calls[0][0]).toMatchObject({ customerAddressRequired: false });
  });

  it('"Both" creates TWO services, one of each kind', async () => {
    // The case that must be named rather than left to the reader. `both` is DERIVED from having
    // services of both kinds, so a picker that said Both and made one service would be lying
    // about what it did - the screen would then show a different answer than the one clicked.
    render(
      <WorkLocationPicker workLocation="no_location" services={[]} onCreateService={onCreateService} />
    );
    await userEvent.click(screen.getByRole('button', { name: /Both/i }));

    await waitFor(() => expect(onCreateService).toHaveBeenCalledTimes(2));
    const flags = onCreateService.mock.calls.map((c) => c[0].customerAddressRequired);
    expect(flags).toEqual([false, true]);
  });

  it('"No location" creates nothing at all', async () => {
    // There is no service shape that means "we do not go anywhere", so the honest answer is to
    // create nothing rather than invent a placeholder the owner then has to delete.
    render(
      <WorkLocationPicker workLocation="at_one_location" services={[]} onCreateService={onCreateService} />
    );
    await userEvent.click(screen.getByRole('button', { name: /No location/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /No location/i })).toBeEnabled());
    expect(onCreateService).not.toHaveBeenCalled();
  });
});

describe('once services exist', () => {
  it('shows the derived answer and offers NOTHING to click', async () => {
    // The whole point. This control may never rewrite a catalog that already answers the question.
    render(
      <WorkLocationPicker
        workLocation="on_the_road"
        services={[service()]}
        onCreateService={onCreateService}
      />
    );

    expect(screen.getByText(/You travel to your customers/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says WHY it cannot be changed here, rather than just disabling itself', async () => {
    // A control that silently goes read-only reads as broken. This one explains that the services
    // are the source of truth, which is also the instruction for changing it.
    render(
      <WorkLocationPicker workLocation="both" services={[service()]} onCreateService={onCreateService} />
    );
    expect(screen.getByText(/follows your services/i)).toBeInTheDocument();
  });
});
