import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkillCoverageWarning } from './SkillCoverageWarning';

describe('SkillCoverageWarning', () => {
  it('names the PLAN feature and the missing skill, and says how to fix it', () => {
    render(
      <SkillCoverageWarning
        skills={[{ feature: 'leadCapture', skillId: 'lead_capture', skillName: 'Lead capture' }]}
      />,
    );
    // "Leads" is the plan-facing label for leadCapture (features.keys.*.label).
    expect(screen.getByRole('alert')).toHaveTextContent(/Your plan includes Leads/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/Lead capture/i);
    // The remedy must name only what a workspace admin can actually do. Editing a
    // speciality's skills is super-admin-only, so "ask your admin" would send them
    // to a screen they cannot reach.
    expect(screen.getByRole('alert')).toHaveTextContent(/Bind a speciality above that lists it/i);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/ask your workspace admin/i);
  });

  it('falls back to the skill label for a feature the settings screen does not list', () => {
    render(<SkillCoverageWarning skills={[{ feature: 'handoff', skillId: 'handoff', skillName: 'Human handoff' }]} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Your plan includes Human handoff/i);
  });

  // ONE alert listing every affected feature, not one per skill. `handoff` is entitled
  // on every paid tier, so a bot on any booking-only speciality trips at least two at
  // once; stacking a block each turned a real signal into a wall to scroll past.
  it('collapses several undelivered skills into a single alert naming them all', () => {
    render(
      <SkillCoverageWarning
        skills={[
          { feature: 'leadCapture', skillId: 'lead_capture', skillName: 'Lead capture' },
          { feature: 'handoff', skillId: 'handoff', skillName: 'Human handoff' },
        ]}
      />,
    );
    expect(screen.getAllByTestId('skill-coverage-warning')).toHaveLength(1);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Leads/i);
    expect(alert).toHaveTextContent(/Human handoff/i);
    expect(alert).toHaveTextContent(/Lead capture/i);
  });

  it('renders nothing when every entitled skill is covered', () => {
    const { container } = render(<SkillCoverageWarning skills={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the readiness query resolves', () => {
    const { container } = render(<SkillCoverageWarning skills={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
