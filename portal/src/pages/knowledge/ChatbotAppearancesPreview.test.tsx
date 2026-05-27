import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatbotAppearancesPreview from './ChatbotAppearancesPreview';

vi.mock('@clerk/clerk-react', () => ({
  useOrganization: () => ({ organization: { imageUrl: 'https://clerk.example/org.png' } }),
}));

describe('ChatbotAppearancesPreview', () => {
  const baseProps = {
    primaryColor: '#6366f1',
    avatarUrl: null as string | null,
    launcherPosition: 'bottom-right' as const,
    launcherLabel: null as string | null,
    greetingMessage: '' as string,
  };

  it('renders icon-only circular launcher when launcherLabel is empty', () => {
    render(<ChatbotAppearancesPreview {...baseProps} />);
    const launcher = screen.getByTestId('preview-launcher');
    expect(launcher).not.toHaveClass('preview-launcher--pill');
  });

  it('renders pill launcher when launcherLabel is set', () => {
    render(<ChatbotAppearancesPreview {...baseProps} launcherLabel="Chat with us" />);
    const launcher = screen.getByTestId('preview-launcher');
    expect(launcher).toHaveClass('preview-launcher--pill');
    expect(launcher).toHaveTextContent('Chat with us');
  });

  it('anchors launcher to bottom-left when launcherPosition is bottom-left', () => {
    render(<ChatbotAppearancesPreview {...baseProps} launcherPosition="bottom-left" />);
    const launcher = screen.getByTestId('preview-launcher');
    expect(launcher).toHaveAttribute('data-position', 'bottom-left');
  });

  it('shows the Clerk org logo as avatar fallback when avatarUrl is null', () => {
    render(<ChatbotAppearancesPreview {...baseProps} />);
    const avatar = screen.getByTestId('preview-avatar');
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe('https://clerk.example/org.png');
  });

  it('uses avatarUrl when provided', () => {
    render(<ChatbotAppearancesPreview {...baseProps} avatarUrl="https://cdn.example/bot.png" />);
    const avatar = screen.getByTestId('preview-avatar');
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/bot.png');
  });

  it('renders greeting bubble when greetingMessage is non-empty', () => {
    render(<ChatbotAppearancesPreview {...baseProps} greetingMessage="Hello!" />);
    expect(screen.getByTestId('preview-greeting')).toHaveTextContent('Hello!');
  });

  it('does not render greeting bubble when greetingMessage is empty', () => {
    render(<ChatbotAppearancesPreview {...baseProps} />);
    expect(screen.queryByTestId('preview-greeting')).toBeNull();
  });
});
