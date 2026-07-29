import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Contract for the widget's "New conversation" control — the durable fix for
 * "the bot still acts as its previous specialty". A widget session is resumed
 * from localStorage on every load, so its transcript keeps being replayed to
 * the model; a fresh conversation is what surfaces bot config changes (new
 * specialty, removed services/docs). This asserts the public surface exists;
 * behaviour is verified by running the widget.
 */
const widgetSrc = readFileSync(
  path.resolve(__dirname, '../../../public/widget.js'),
  'utf8',
);

/** The chunk of source starting at the first match of `marker`. */
function from(marker: string): string {
  const i = widgetSrc.indexOf(marker);
  expect(i, `expected widget.js to contain ${marker}`).toBeGreaterThan(-1);
  return widgetSrc.slice(i);
}

describe('widget.js — New conversation control', () => {
  it('exposes newConversation() on the embeddable public API', () => {
    expect(widgetSrc).toMatch(/newConversation\s*\(\s*\)\s*\{/);
  });

  it('accepts a "newConversation" postMessage command', () => {
    const allowlist = from('POSTMESSAGE_ALLOWED_TYPES').slice(0, 200);
    expect(allowlist).toContain("'newConversation'");
  });

  it('renders a New-conversation header button with an accessible label', () => {
    expect(widgetSrc).toContain('cb-header__new');
    expect(widgetSrc).toContain('aria-label="New conversation"');
  });

  it('implements startNewConversation(): forgets the stored session and re-inits a fresh one', () => {
    const method = from('startNewConversation() {').slice(0, 2600);
    expect(method).toContain('clearStoredSession()');
    expect(method).toMatch(/_initSession\(/);
    // the transcript must be cleared so old turns stop being replayed
    expect(method).toMatch(/this\.messages\s*=\s*\[\]/);
  });

  it('resets the flags that would otherwise corrupt the fresh session (review fixes)', () => {
    const method = from('startNewConversation() {').slice(0, 2600);
    // _joinedOnce=false → the fresh join skips syncHistory (no double greeting)
    expect(method).toMatch(/this\._joinedOnce\s*=\s*false/);
    // pendingMessages cleared → old queued messages don't leak into the new session
    expect(method).toMatch(/this\.pendingMessages\s*=\s*\[\]/);
    // bumps the session epoch so a concurrent init bails (no leaked live socket)
    expect(method).toMatch(/\+\+this\._sessionEpoch/);
  });

  it('guards the socket connect + init against a stale (superseded) epoch', () => {
    // _connectSocketIO and _initSession must bail when their epoch is stale.
    expect(widgetSrc).toMatch(/_connectSocketIO\(epoch\)/);
    expect(widgetSrc).toMatch(/epoch\s*!==\s*this\._sessionEpoch/);
  });

  it('wires the header button to startNewConversation', () => {
    expect(widgetSrc).toMatch(/headerNewBtn[\s\S]{0,120}startNewConversation\(\)/);
  });
});
