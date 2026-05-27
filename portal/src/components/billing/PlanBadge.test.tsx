/**
 * Tests for PlanBadge (M1, subscription/feature-access epic).
 *
 * - Renders the correct localized label per tier (`badges.<tier>` key).
 * - Applies the tier-specific colour class.
 * - Applies the size-specific padding/text class.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanBadge, type PlanBadgeTier } from './PlanBadge';

describe('PlanBadge — i18n labels', () => {
  const cases: Array<{ tier: PlanBadgeTier; label: string }> = [
    { tier: 'essential', label: 'Essential' },
    { tier: 'pro', label: 'Pro' },
    { tier: 'enterprise', label: 'Enterprise' },
    { tier: 'comingSoon', label: 'Coming soon' },
  ];

  cases.forEach(({ tier, label }) => {
    it(`renders the "${label}" label for tier="${tier}"`, () => {
      render(<PlanBadge tier={tier} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });
});

describe('PlanBadge — tier colour class', () => {
  // Class names are an implementation detail, but the tier→colour contract
  // (Pro = primary, Enterprise = violet) is load-bearing for visual hierarchy.
  // We check substrings, not exact CSS, so design tweaks won't break tests.
  it('uses the primary-brand class for tier="pro"', () => {
    render(<PlanBadge tier="pro" data-testid="badge" />);
    expect(screen.getByTestId('badge').className).toMatch(/bg-primary/);
  });

  it('uses the violet class for tier="enterprise"', () => {
    render(<PlanBadge tier="enterprise" data-testid="badge" />);
    expect(screen.getByTestId('badge').className).toMatch(/violet/);
  });

  it('uses a muted surface class for tier="essential"', () => {
    render(<PlanBadge tier="essential" data-testid="badge" />);
    expect(screen.getByTestId('badge').className).toMatch(/surface-3/);
  });

  it('uses a muted surface class for tier="comingSoon"', () => {
    render(<PlanBadge tier="comingSoon" data-testid="badge" />);
    expect(screen.getByTestId('badge').className).toMatch(/surface-2/);
  });
});

describe('PlanBadge — size prop', () => {
  it('defaults to size="sm" (smaller text/padding)', () => {
    render(<PlanBadge tier="pro" data-testid="badge" />);
    // SIZE_CLASSES.sm uses the explicit 11px arbitrary value.
    expect(screen.getByTestId('badge').className).toMatch(/text-\[11px\]/);
  });

  it('uses the larger preset when size="md"', () => {
    render(<PlanBadge tier="pro" size="md" data-testid="badge" />);
    // SIZE_CLASSES.md uses text-xs (not 11px) and px-2.5.
    expect(screen.getByTestId('badge').className).toMatch(/text-xs/);
    expect(screen.getByTestId('badge').className).toMatch(/px-2\.5/);
  });
});
