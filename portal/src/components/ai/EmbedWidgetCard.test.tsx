import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EmbedWidgetCard } from './EmbedWidgetCard';

const mutate = vi.fn();

vi.mock('@/queries/useBotsQueries', () => ({
  useRotateBotKey: () => ({ mutate, isPending: false }),
  useEndKeyGrace: () => ({ mutate, isPending: false }),
  useUpdateBot: () => ({ mutate, isPending: false }),
}));

function renderCard(publicKey = 'bk_test_public_widget_id_abc123') {
  return render(
    <MemoryRouter>
      <EmbedWidgetCard
        enabled
        botId="bot-1"
        publicKey={publicKey}
        allowedOrigins={[]}
      />
    </MemoryRouter>,
  );
}

describe('EmbedWidgetCard — deploy snippet', () => {
  it('renders data-widget-id in the snippet pre (not data-api-key)', () => {
    const publicKey = 'bk_test_public_widget_id_abc123';
    const { container } = renderCard(publicKey);

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();

    const snippet = pre!.textContent ?? '';
    expect(snippet).toContain(`data-widget-id="${publicKey}"`);
    expect(snippet).not.toContain('data-api-key=');
    expect(snippet).toContain('/widget.js');
  });

  it('renders nothing when publicKey is missing', () => {
    const { container } = render(
      <MemoryRouter>
        <EmbedWidgetCard enabled botId="bot-1" />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeNull();
  });
});
