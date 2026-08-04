/**
 * Link rendering in assistant replies.
 *
 * The text here is model-authored, so this is a trust boundary as much as a formatting
 * one: the cases that matter are the ones where a plausible-looking link should NOT
 * become a clickable element.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssistantText } from './AssistantText';

const show = (text: string) =>
  render(
    <MemoryRouter>
      <AssistantText text={text} />
    </MemoryRouter>,
  );

describe('AssistantText', () => {
  it('turns a portal path into in-app navigation', () => {
    show('Switch it on under [Settings → Features](/settings/features).');
    const link = screen.getByRole('link', { name: 'Settings → Features' });
    expect(link).toHaveAttribute('href', '/settings/features');
    expect(link).not.toHaveAttribute('target');
  });

  it('opens an external link in a new tab, without handing over the opener', () => {
    show('Check [our status page](https://status.axentrio.com).');
    const link = screen.getByRole('link', { name: 'our status page' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('still links when the model pads the parentheses', () => {
    // Observed in production: the assistant wrote "[AI & Content]( /ai)". Under the
    // strict pattern that rendered as literal brackets and a path to retype, which
    // is exactly what this component exists to prevent.
    show('Go to [AI & Content]( /ai) now');
    const link = screen.getByRole('link', { name: 'AI & Content' });
    expect(link).toHaveAttribute('href', '/ai');
  });

  it('does not let padding smuggle an unsafe target past the checks', () => {
    // Tolerating whitespace must not widen what counts as a valid destination.
    show('Click [here]( javascript:alert(1) ) now');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('refuses to render a script target as a link', () => {
    // Model-authored text is untrusted input. A `javascript:` target is not a link.
    show('Click [here](javascript:alert(1)) now');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/\[here\]\(javascript:alert\(1\)\)/)).toBeInTheDocument();
  });

  it('refuses a data: target too', () => {
    show('Open [this](data:text/html,<script>x</script>)');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not treat a protocol-relative URL as an internal path', () => {
    // `//evil.example` is external despite the leading slash.
    show('Go [away](//evil.example/steal)');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps the surrounding words and renders several links in one reply', () => {
    show('Upload under [AI & Content](/ai), then connect [Channels](/channels).');
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByText(/Upload under/)).toBeInTheDocument();
    expect(screen.getByText(/, then connect/)).toBeInTheDocument();
  });

  it('leaves a reply with no links completely alone', () => {
    show('Your bot answered 12 conversations yesterday.');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Your bot answered 12 conversations yesterday.')).toBeInTheDocument();
  });

  it('does not mangle brackets that are not a link', () => {
    show('Use the [brackets] key and (parentheses) freely.');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/Use the \[brackets\] key/)).toBeInTheDocument();
  });
});
