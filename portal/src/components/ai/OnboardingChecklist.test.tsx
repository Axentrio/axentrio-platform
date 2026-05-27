import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OnboardingChecklist } from './OnboardingChecklist';

function setup(props: Partial<React.ComponentProps<typeof OnboardingChecklist>> = {}) {
  const onGoToKnowledge = vi.fn();
  const onGoToSocial = vi.fn();
  const onConfigureBot = vi.fn();
  render(
    <OnboardingChecklist
      botEnabled={false}
      hasIndexedDocs={false}
      hasConnectedChannel={false}
      onGoToKnowledge={onGoToKnowledge}
      onGoToSocial={onGoToSocial}
      onConfigureBot={onConfigureBot}
      {...props}
    />,
  );
  return { onGoToKnowledge, onGoToSocial, onConfigureBot };
}

describe('OnboardingChecklist', () => {
  it('renders all three steps when nothing is done', () => {
    setup();
    expect(screen.getByText(/Get started/i)).toBeInTheDocument();
    expect(screen.getByText(/Configure your AI bot/i)).toBeInTheDocument();
    // "Add knowledge" appears as both the step label and the action button.
    expect(screen.getAllByText(/Add knowledge/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Connect a channel/i)).toBeInTheDocument();
  });

  it('renders nothing once all three steps are done', () => {
    const { container } = render(
      <OnboardingChecklist
        botEnabled
        hasIndexedDocs
        hasConnectedChannel
        onGoToKnowledge={vi.fn()}
        onGoToSocial={vi.fn()}
        onConfigureBot={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides the action button for a completed step and shows it for an incomplete one', () => {
    setup({ botEnabled: true });
    expect(screen.queryByRole('button', { name: /^Configure/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add knowledge/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Connect/i })).toBeInTheDocument();
  });

  it('calls the matching callback when an action button is clicked', async () => {
    const user = userEvent.setup();
    const { onGoToKnowledge, onGoToSocial } = setup();
    await user.click(screen.getByRole('button', { name: /^Add knowledge/i }));
    expect(onGoToKnowledge).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /^Connect/i }));
    expect(onGoToSocial).toHaveBeenCalledOnce();
  });
});
