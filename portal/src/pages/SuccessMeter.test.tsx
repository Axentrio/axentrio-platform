import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hasFeatureMock, isEntitledMock } = vi.hoisted(() => ({
  hasFeatureMock: vi.fn(),
  isEntitledMock: vi.fn(),
}));

vi.mock('@/queries/useEntitlementsQueries', () => ({
  useHasFeature: hasFeatureMock,
  useIsEntitled: isEntitledMock,
}));
vi.mock('./Analytics', () => ({ default: () => <div>Outcomes content</div> }));
vi.mock('@/components/insights/InsightsContent', () => ({
  InsightsContent: () => <div>Insights content</div>,
}));
vi.mock('@/components/insights/AnalysisTrigger', () => ({
  AnalysisTrigger: () => <div>Analysis trigger</div>,
}));
vi.mock('@/components/insights/ExportMenu', () => ({
  ExportMenu: () => <div>Export menu</div>,
}));
vi.mock('@/components/billing/LockedPreview', () => ({
  LockedPreview: () => <div>Locked preview</div>,
}));
vi.mock('@/components/billing/FeatureDisabledNotice', () => ({
  FeatureDisabledNotice: () => <div>Success Meter disabled</div>,
}));

import SuccessMeter from './SuccessMeter';

function renderPage() {
  return render(
    <MemoryRouter>
      <SuccessMeter />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  hasFeatureMock.mockReset();
  isEntitledMock.mockReset();
});

describe('SuccessMeter feature gate', () => {
  it('hides the whole surface when the entitled feature is toggled off', () => {
    isEntitledMock.mockReturnValue(true);
    hasFeatureMock.mockReturnValue(false);

    renderPage();

    expect(screen.getByText('Success Meter disabled')).toBeInTheDocument();
    expect(screen.queryByText('Outcomes content')).not.toBeInTheDocument();
    expect(screen.queryByText('Analysis trigger')).not.toBeInTheDocument();
  });

  it('renders Outcomes when Success Meter is enabled', () => {
    isEntitledMock.mockReturnValue(true);
    hasFeatureMock.mockReturnValue(true);

    renderPage();

    expect(screen.getByText('Outcomes content')).toBeInTheDocument();
    expect(screen.queryByText('Success Meter disabled')).not.toBeInTheDocument();
  });
});
