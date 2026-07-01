import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkillStateCard } from './SkillStateCard';

// Composable-templates Phase 6 — pure render test for the tenant skill-state badge.

describe('SkillStateCard', () => {
  it("renders an unconfigured skill as an amber badge reading 'Finish setup'", () => {
    render(
      <SkillStateCard
        skill={{ id: 'booking', name: 'Bookings', state: 'unconfigured', remedy: 'finish setup' }}
      />,
    );
    expect(screen.getByText('Bookings')).toBeInTheDocument();
    const badge = screen.getByTestId('skill-state-badge');
    expect(badge).toHaveTextContent('Finish setup');
    expect(badge.className).toContain('amber');
    expect(badge.getAttribute('data-state')).toBe('unconfigured');
  });

  it("renders an unentitled skill as 'Upgrade plan'", () => {
    render(
      <SkillStateCard skill={{ id: 'booking', name: 'Bookings', state: 'unentitled', remedy: 'upgrade' }} />,
    );
    expect(screen.getByTestId('skill-state-badge')).toHaveTextContent('Upgrade plan');
  });

  it("renders a ready skill as a green 'Ready' badge with its tool list", () => {
    render(
      <SkillStateCard
        skill={{ id: 'booking', name: 'Bookings', state: 'ready', remedy: null }}
        readyTools={['kb_search', 'create_booking', 'escalate_to_human']}
      />,
    );
    const badge = screen.getByTestId('skill-state-badge');
    expect(badge).toHaveTextContent('Ready');
    expect(badge.className).toContain('emerald');
    expect(screen.getByText('kb_search')).toBeInTheDocument();
    expect(screen.getByText('create_booking')).toBeInTheDocument();
    expect(screen.getByText('escalate_to_human')).toBeInTheDocument();
  });

  it('does not render the tool list when not ready, even if tools are passed', () => {
    render(
      <SkillStateCard
        skill={{ id: 'booking', name: 'Bookings', state: 'unconfigured', remedy: 'finish setup' }}
        readyTools={['create_booking']}
      />,
    );
    expect(screen.queryByText('create_booking')).not.toBeInTheDocument();
  });
});
