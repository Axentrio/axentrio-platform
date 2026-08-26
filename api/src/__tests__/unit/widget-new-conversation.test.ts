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

  it('hides the New-conversation header button unless this browser opted in', () => {
    // Default OFF - a mid-conversation reset is a testing affordance, so real
    // visitors never see it. The ONLY reveal path is a personal debug flag
    // (localStorage cb_show_new_chat=1). Not a DEFAULT_CONFIG key: that would
    // auto-parse a customer-controlled data-show-new-chat attribute. Not a
    // per-tenant server flag: that would show the button to every visitor of
    // that tenant.
    expect(widgetSrc).not.toMatch(/showNewChat\s*:/);
    expect(widgetSrc).not.toContain('newChatEnabled');
    expect(widgetSrc).not.toContain('_syncNewChatButton');
    expect(widgetSrc).toContain("const SHOW_NEW_CHAT_OVERRIDE_KEY = 'cb_show_new_chat'");
    const ctor = from('constructor(config = {}) {').slice(0, 2800);
    expect(ctor).toMatch(/this\.canNewChat = false/);
    expect(ctor).toMatch(/localStorage\.getItem\(SHOW_NEW_CHAT_OVERRIDE_KEY\) === '1'/);
    // The template gates BOTH the button and the header grid class on canNewChat.
    expect(widgetSrc).toMatch(/cb-header\$\{this\.canNewChat/);
    expect(widgetSrc).toMatch(/\$\{this\.canNewChat \? `\s*<button class="cb-header__new"/);
    expect(widgetSrc).toContain('cb-header--no-new');
    expect(widgetSrc).toContain('aria-label="New conversation"');
  });

  it('implements startNewConversation(): a SERVER close-and-open, not a client clear (B-PR4a)', () => {
    const method = from('startNewConversation() {').slice(0, 2600);
    // The atomic close-and-open is the server's; the client calls the command…
    expect(method).toContain('/api/v1/widget/new-conversation');
    expect(method).toMatch(/Authorization[^\n]*Bearer/);
    // …and must NOT mint a new identity: the durable visitorId is the whole
    // point - the old client-only clear (visitorId = null) is the regression.
    expect(method).not.toMatch(/this\.visitorId\s*=\s*null/);
    expect(method).not.toContain('clearStoredSession()');
  });

  it('adopting the replacement session resets the flags that would corrupt it (review fixes)', () => {
    const method = from('_adoptNewConversation(data) {').slice(0, 2600);
    // the transcript must be cleared so old turns stop being replayed
    expect(method).toMatch(/this\.messages\s*=\s*\[\]/);
    // _joinedOnce=false → the fresh join skips syncHistory (no double greeting)
    expect(method).toMatch(/this\._joinedOnce\s*=\s*false/);
    // pendingMessages cleared → old queued messages don't leak into the new session
    expect(method).toMatch(/this\.pendingMessages\s*=\s*\[\]/);
    // bumps the session epoch so a concurrent init bails (no leaked live socket)
    expect(method).toMatch(/\+\+this\._sessionEpoch/);
    // the swapped session is persisted so a reload restores IT, not the old one
    expect(method).toMatch(/this\._saveSession\(\)/);
  });

  it('keeps a DURABLE visitorId in its own storage key, adopted from old blobs', () => {
    // The key is separate from the session blob and per embed triple.
    expect(widgetSrc).toContain("const VISITOR_KEY_PREFIX = 'cb_visitor_v1_'");
    const ensure = from('_ensureVisitorId() {').slice(0, 1600);
    // Resolution order: durable key → adopt from stored session blob → mint.
    expect(ensure).toMatch(/localStorage\.getItem\(this\.visitorKey\)/);
    expect(ensure).toMatch(/readStoredSession\(\)/);
    // #21: the durable visitorId uses the crypto-strong generator (not Math.random).
    expect(ensure).toMatch(/'widget-'\s*\+\s*utils\.strongId\(\)/);
    expect(ensure).toMatch(/localStorage\.setItem\(this\.visitorKey/);
    // _initSession must never regenerate the id (the old per-load mint).
    const initSession = from('async _initSession(epoch) {').slice(0, 3000);
    expect(initSession).not.toMatch(/this\.visitorId\s*=\s*'widget-'/);
  });

  it('discards a stored blob written for a DIFFERENT visitorId (S2 - never resume another identity)', () => {
    // Constructor-time reconciliation drops the foreign blob and its state.
    const reconcile = from('_reconcileStoredIdentity() {').slice(0, 900);
    expect(reconcile).toMatch(/clearStoredSession\(\)/);
    expect(reconcile).toMatch(/this\.messages\s*=\s*\[\]/);
    // And the restore path re-checks (a stale cached script can rewrite the
    // blob between the constructor and a later re-init).
    const initSession = from('async _initSession(epoch) {').slice(0, 3000);
    expect(initSession).toMatch(/session\.visitorId === this\.visitorId/);
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
