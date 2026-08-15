/**
 * Tests for ConnectionIndicator (B-PR3b §4): the pill reflects the REAL
 * socket connection state — connected / reconnecting / offline — and is
 * never a permanently-green decorative dot.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionIndicator } from './ConnectionIndicator';

describe('ConnectionIndicator', () => {
  it('shows Live when connected', () => {
    render(<ConnectionIndicator isConnected isConnecting={false} />);
    const pill = screen.getByTestId('connection-indicator');
    expect(pill).toHaveAttribute('data-state', 'live');
    expect(pill).toHaveTextContent('Live');
  });

  it('shows Reconnecting while the socket retries', () => {
    render(<ConnectionIndicator isConnected={false} isConnecting />);
    const pill = screen.getByTestId('connection-indicator');
    expect(pill).toHaveAttribute('data-state', 'reconnecting');
    expect(pill).toHaveTextContent('Reconnecting');
  });

  it('shows Offline when disconnected and not retrying', () => {
    render(<ConnectionIndicator isConnected={false} isConnecting={false} />);
    const pill = screen.getByTestId('connection-indicator');
    expect(pill).toHaveAttribute('data-state', 'offline');
    expect(pill).toHaveTextContent('Offline');
  });

  it('connected wins over a stale isConnecting flag', () => {
    render(<ConnectionIndicator isConnected isConnecting />);
    expect(screen.getByTestId('connection-indicator')).toHaveAttribute('data-state', 'live');
  });
});
