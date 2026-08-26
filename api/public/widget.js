/**
 * Chatbot Widget - Embeddable Chat Client
 * White-label Chatbot Platform
 * 
 * Features:
 * - Zero dependencies, vanilla JavaScript
 * - Shadow DOM for CSS isolation
 * - Mobile-first responsive design (320px to 4K)
 * - Drag & drop file upload with progress
 * - Camera capture for mobile
 * - WebSocket client integration
 * - CSP-compliant, XSS protected
 * - Configurable via data attributes
 * 
 * @version 1.0.0
 * @license MIT
 */

// Capture before UMD wrapper — document.currentScript is null inside factory()
var _cbCurrentScript = typeof document !== 'undefined' ? document.currentScript : null;

(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined'
    ? module.exports = factory()
    : typeof define === 'function' && define.amd
    ? define(factory)
    : (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.ChatbotWidget = factory());
})(this, function () {
  'use strict';

  // ==========================================================================
  // Default Configuration
  // ==========================================================================
  const DEFAULT_CONFIG = {
    // API Configuration
    apiUrl: '', // Auto-detected from script src
    wsUrl: '',  // Auto-detected from apiUrl
    tenantId: null,
    botId: 'default',
    apiKey: null,
    
    // Widget Appearance
    position: 'right',
    primaryColor: '#4F46E5',
    secondaryColor: '#10B981',
    backgroundColor: '',      // legacy, unused by editorial theme
    textColor: '',            // legacy, unused by editorial theme
    fontFamily: '',           // empty = use built-in Fraunces + Inter Tight stack
    borderRadius: '20px',
    theme: 'light',

    // Widget Behavior
    title: 'Chat Support',
    subtitle: 'Usually replies in a few minutes',
    launcherLabel: 'Chat with us',
    placeholder: 'Write a message…',
    greetingMessage: 'Hello — how can we help you today?',
    showTimestamp: true,
    showAvatar: true,
    enableTypingIndicator: true,
    enableFileUpload: true,
    enableVoiceInput: false,
    enableCamera: true,
    // "New conversation" header button. DEFAULT OFF: mid-conversation reset is a
    // testing affordance, not something a real visitor should see. Opt in per
    // embed with data-show-new-chat="true", or per browser with the team
    // override key below (works on sites the team doesn't control).
    showNewChat: false,
    maxFileSize: 25 * 1024 * 1024, // 25MB
    // Mirrors the server allowlist (DEFAULT_UPLOAD_CONFIG.allowedMimeTypes). The old
    // wildcard list let svg, webm and legacy .doc through the picker only to be rejected
    // server-side after the customer had already waited for the upload.
    allowedFileTypes: [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/quicktime',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ],
    
    // Privacy & Compliance
    gdprCompliance: true,
    privacyMessage: 'By using this chat, you agree to our privacy policy.',
    showPrivacyNotice: true,
    dataRetentionDays: 30,
    
    // Performance
    lazyLoad: true,
    preloadAssets: false,
    cacheMessages: true,
    maxCachedMessages: 100,
    
    // Mobile
    mobileBreakpoint: 768,
    fullScreenOnMobile: true,
    
    // Advanced
    debug: false,
    reconnectAttempts: 5,
    reconnectDelay: 3000,
    heartbeatInterval: 30000,

    // postMessage bridge — comma-separated list of origins that may control
    // the widget via window.postMessage({source:'chatbot-widget',type:...}).
    // The widget's own origin (window.location.origin) is always allowed;
    // this list is for ADDITIONAL cross-origin callers (e.g., the parent
    // page when the widget is embedded inside a cross-origin iframe).
    // Set via data-postmessage-origins="https://acme.com,https://app.acme.com".
    postmessageOrigins: [],
  };

  let widgetInstance = null;
  const pendingApiCalls = [];

  function dispatchGlobalEvent(eventName, detail) {
    const event = new CustomEvent(eventName, { detail });

    if (typeof document !== 'undefined') {
      document.dispatchEvent(event);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
  }

  function enqueueOrRun(action) {
    if (widgetInstance) {
      action(widgetInstance);
      return true;
    }

    pendingApiCalls.push(action);
    return false;
  }

  function flushPendingApiCalls() {
    if (!widgetInstance || pendingApiCalls.length === 0) return;

    while (pendingApiCalls.length > 0) {
      const action = pendingApiCalls.shift();
      action(widgetInstance);
    }
  }

  const chatbotWidgetApi = {
    open() {
      return enqueueOrRun(widget => widget.open());
    },

    close() {
      return enqueueOrRun(widget => widget.close());
    },

    toggle() {
      return enqueueOrRun(widget => widget.toggle());
    },

    sendMessage(text) {
      return enqueueOrRun(widget => widget.sendMessage(text));
    },

    // Start a fresh conversation (new session against the bot's current config).
    newConversation() {
      return enqueueOrRun(widget => widget.startNewConversation());
    },

    isReady() {
      return !!widgetInstance;
    },

    getInstance() {
      return widgetInstance;
    },

    // Tear down the widget: disconnects socket, removes window listeners,
    // detaches the host DOM, and resets the module-level instance reference
    // so isReady() returns false and any later enqueued API calls queue up
    // for a future widget instance instead of firing on the dead one.
    destroy() {
      if (!widgetInstance) return false;
      const inst = widgetInstance;
      widgetInstance = null;
      pendingApiCalls.length = 0;
      try { inst.destroy(); } catch (err) { /* best effort */ }
      return true;
    },
  };

  if (typeof window !== 'undefined') {
    window.ChatbotWidgetAPI = chatbotWidgetApi;
  }

  // ==========================================================================
  // postMessage bridge — lets CTAs in iframe-separated window contexts control
  // the widget via window.postMessage.
  //
  // Security model:
  //   * event.origin MUST be in the allowlist (window.location.origin is
  //     always allowed; additional origins come from config.postmessageOrigins)
  //   * event.data MUST be an object with source === 'chatbot-widget'
  //   * event.data.type MUST be one of a fixed whitelist
  //
  // Inbound message schema:
  //   { source: 'chatbot-widget', type: 'open' | 'close' | 'toggle'
  //                             | 'sendMessage' | 'destroy' | 'ping',
  //     payload: { text?: string } }
  //
  // Response to 'ping' (posted back to event.source with targetOrigin =
  //   event.origin):
  //   { source: 'chatbot-widget', type: 'pong', isReady: boolean }
  //
  // On widget creation the bridge also broadcasts one ready event to
  //   window.parent (targetOrigin '*') so a parent frame can enable its CTA
  //   button: { source: 'chatbot-widget', type: 'ready' }
  // ==========================================================================
  const POSTMESSAGE_SOURCE = 'chatbot-widget';
  const POSTMESSAGE_ALLOWED_TYPES = new Set([
    'open', 'close', 'toggle', 'sendMessage', 'newConversation', 'destroy', 'ping',
  ]);
  let postMessageBridgeInstalled = false;

  function installPostMessageBridge() {
    if (postMessageBridgeInstalled || typeof window === 'undefined') return;
    postMessageBridgeInstalled = true;

    window.addEventListener('message', (event) => {
      const data = event.data;

      // Shape check first (cheap) — ignore anything that isn't ours
      if (!data || typeof data !== 'object' || data.source !== POSTMESSAGE_SOURCE) return;
      if (!POSTMESSAGE_ALLOWED_TYPES.has(data.type)) return;

      // Origin allowlist: window.location.origin is always allowed; any
      // additional origins come from the live widget instance config.
      const extra = (widgetInstance && Array.isArray(widgetInstance.config.postmessageOrigins))
        ? widgetInstance.config.postmessageOrigins
        : [];
      const allowed = new Set([window.location.origin, ...extra]);
      if (!allowed.has(event.origin)) {
        // Silently ignore — don't log, don't respond. Probes get nothing.
        return;
      }

      // Dispatch
      switch (data.type) {
        case 'open':
          chatbotWidgetApi.open();
          break;
        case 'close':
          chatbotWidgetApi.close();
          break;
        case 'toggle':
          chatbotWidgetApi.toggle();
          break;
        case 'sendMessage':
          if (data.payload && typeof data.payload.text === 'string') {
            chatbotWidgetApi.sendMessage(data.payload.text);
          }
          break;
        case 'newConversation':
          chatbotWidgetApi.newConversation();
          break;
        case 'destroy':
          chatbotWidgetApi.destroy();
          break;
        case 'ping':
          // Reply to the sender with current readiness. targetOrigin is the
          // sender's own origin, which we just validated — safe.
          if (event.source && typeof event.source.postMessage === 'function') {
            try {
              event.source.postMessage(
                { source: POSTMESSAGE_SOURCE, type: 'pong', isReady: chatbotWidgetApi.isReady() },
                event.origin,
              );
            } catch (_) { /* best effort */ }
          }
          break;
      }
    });
  }

  function broadcastReadyToParent() {
    if (typeof window === 'undefined') return;
    if (window.parent === window) return; // not in an iframe — nothing to tell
    try {
      // targetOrigin '*' is OK here because the payload contains no secrets;
      // any listener matching our source marker is welcome to learn we're up.
      window.parent.postMessage({ source: POSTMESSAGE_SOURCE, type: 'ready' }, '*');
    } catch (_) { /* best effort */ }
  }

  const LEGACY_STORAGE_KEY = 'cb_session_v2';
  const STORAGE_KEY_PREFIX = 'cb_session_v3_';
  // Durable customer identity, SEPARATE from the replaceable session blob.
  // Survives session recovery and "new conversation" - the server uses it to
  // resolve the same conversation for a returning visitor.
  const VISITOR_KEY_PREFIX = 'cb_visitor_v1_';
  // Per-browser team override that reveals the "New conversation" header
  // button without editing the embed: localStorage.setItem('cb_show_new_chat', '1').
  // Presentational gate only - the newConversation() API and postMessage
  // command stay available, and the action only ever replaces the visitor's
  // OWN session (a visitor could get the same effect by clearing storage).
  const SHOW_NEW_CHAT_OVERRIDE_KEY = 'cb_show_new_chat';
  const CONNECTION_STATUS = {
    connecting: {
      label: 'Connecting...',
      dotClass: 'cb-header__status-dot--connecting',
    },
    connected: {
      label: 'Online',
      dotClass: 'cb-header__status-dot--connected',
    },
    offline: {
      label: 'Offline',
      dotClass: 'cb-header__status-dot--offline',
    },
  };

  // ==========================================================================
  // CSS Styles (Injected into Shadow DOM)
  // ==========================================================================
  const WIDGET_STYLES = `
    /* ============================================================
       Chat widget — single-family clean SaaS pass (Plus Jakarta Sans)
       ============================================================ */
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');

    :host {
      /* ---- Brand (tenant-configurable via applyThemeTokens) ---- */
      --cb-primary:       #4F46E5;
      --cb-primary-hover: color-mix(in oklch, var(--cb-primary) 88%, #000);
      --cb-primary-ink:   #FFFFFF;
      --cb-secondary:     #22C55E;

      /* ---- Slate neutral system (shadcn / Linear territory) ---- */
      --cb-ink:       #0F172A;   /* slate-900 */
      --cb-ink-soft:  #334155;   /* slate-700 */
      --cb-ink-muted: #64748B;   /* slate-500 */
      --cb-ink-faint: #94A3B8;   /* slate-400 */
      --cb-paper:        #F8FAFC;  /* slate-50 */
      --cb-paper-raised: #FFFFFF;
      --cb-paper-sunk:   #F1F5F9;  /* slate-100 */
      --cb-bot-bubble:   #F1F5F9;  /* slate-100 — neutral bot bg */
      --cb-hairline:      #E2E8F0; /* slate-200 */
      --cb-hairline-soft: #EDF1F6;

      /* ---- Type ---- */
      --cb-sans: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;

      /* ---- Motion ---- */
      --cb-ease: cubic-bezier(0.16, 1, 0.3, 1);

      /* ---- Elevation — restrained ---- */
      --cb-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.06);
      --cb-shadow-lg:
        0 1px 2px rgba(15, 23, 42, 0.06),
        0 24px 48px -20px rgba(15, 23, 42, 0.18);

      /* ---- Legacy aliases kept so external CSS hooks still work ---- */
      --cb-bg: var(--cb-paper-raised);
      --cb-text: var(--cb-ink);
      --cb-text-secondary: var(--cb-ink-muted);
      --cb-border: var(--cb-hairline);
      --cb-radius: 16px;
      --cb-font: var(--cb-sans);
      --cb-shadow: var(--cb-shadow-lg);

      all: initial;
      font-family: var(--cb-sans);
      color: var(--cb-ink);
      box-sizing: border-box;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    *, *::before, *::after { box-sizing: border-box; }

    /* ============================================================
       Widget shell
       ============================================================ */
    .cb-widget {
      position: fixed;
      z-index: 2147483000;
      font-family: var(--cb-sans);
      color: var(--cb-ink);
    }

    .cb-widget--right { right: clamp(16px, 2.4vw, 24px); bottom: clamp(16px, 2.4vw, 24px); }
    .cb-widget--left  { left:  clamp(16px, 2.4vw, 24px); bottom: clamp(16px, 2.4vw, 24px); }

    /* ============================================================
       Launcher — simple 56px circular button, brand filled
       ============================================================ */
    .cb-launcher {
      width: 56px;
      height: 56px;
      padding: 0;
      border: none;
      border-radius: 999px;
      background: var(--cb-primary);
      color: var(--cb-primary-ink);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow:
        0 4px 14px -4px rgba(15, 23, 42, 0.30),
        0 1px 2px rgba(15, 23, 42, 0.08);
      transition:
        transform 260ms var(--cb-ease),
        box-shadow 260ms var(--cb-ease),
        background 180ms var(--cb-ease);
    }
    .cb-launcher:hover {
      transform: translateY(-1px);
      background: var(--cb-primary-hover);
      box-shadow:
        0 10px 24px -6px rgba(15, 23, 42, 0.34),
        0 1px 2px rgba(15, 23, 42, 0.08);
    }
    .cb-launcher:active { transform: translateY(0); }
    .cb-launcher:focus-visible {
      outline: 2px solid color-mix(in oklch, var(--cb-primary) 55%, transparent);
      outline-offset: 3px;
    }

    /* Old editorial markup (indicator + label) is hidden — simple icon only. */
    .cb-launcher__indicator,
    .cb-launcher__label { display: none; }

    .cb-launcher__icon {
      width: 24px;
      height: 24px;
      color: currentColor;
      display: none;
    }
    .cb-launcher__icon svg { width: 100%; height: 100%; }
    .cb-launcher__icon svg path { stroke-width: 1.75; }
    .cb-launcher__icon--open  { display: block; }
    .cb-launcher__icon--close { display: none; }
    .cb-launcher--open .cb-launcher__icon--open  { display: none; }
    .cb-launcher--open .cb-launcher__icon--close { display: block; }

    /* ============================================================
       Chat window
       ============================================================ */
    .cb-chat {
      position: absolute;
      bottom: 76px;
      width: min(384px, calc(100vw - 48px));
      height: min(604px, calc(100vh - 140px));
      background: var(--cb-paper-raised);
      border: 1px solid var(--cb-hairline);
      border-radius: var(--cb-radius);
      box-shadow: var(--cb-shadow-lg);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      opacity: 0;
      visibility: hidden;
      transform: translateY(12px) scale(0.99);
      transform-origin: bottom right;
      transition:
        opacity 260ms var(--cb-ease),
        transform 320ms var(--cb-ease),
        visibility 320ms var(--cb-ease);
    }
    .cb-widget--right .cb-chat { right: 0; }
    .cb-widget--left  .cb-chat { left: 0; transform-origin: bottom left; }
    .cb-chat--open { opacity: 1; visibility: visible; transform: translateY(0) scale(1); }

    /* ============================================================
       Header — compact, all-sans, clear hierarchy
       ============================================================ */
    .cb-header {
      position: relative;
      padding: 14px 12px 13px 18px;
      background: var(--cb-paper-raised);
      display: grid;
      /* avatar | info(1fr) | status | new-conversation | close */
      grid-template-columns: auto 1fr auto auto auto;
      align-items: center;
      column-gap: 10px;
      flex-shrink: 0;
    }
    /* Header without the new-conversation button: drop its grid column so the
       status and close buttons don't pick up a phantom gap. */
    .cb-header--no-new {
      /* avatar | info(1fr) | status | close */
      grid-template-columns: auto 1fr auto auto;
    }
    .cb-header::after {
      content: "";
      position: absolute;
      left: 18px;
      right: 18px;
      bottom: 0;
      height: 1px;
      background: var(--cb-hairline);
    }

    /* Header close button — the primary dismiss affordance. Styled as a
       neutral ghost button to match the other icon buttons in the input row;
       uses the brand color only on focus-visible so it doesn't compete with
       the send button for primary-action attention. */
    .cb-header__close {
      width: 44px;
      height: 44px;
      border: none;
      background: transparent;
      color: var(--cb-ink-muted);
      border-radius: 9px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition:
        background 180ms var(--cb-ease),
        color 180ms var(--cb-ease),
        transform 260ms var(--cb-ease);
    }
    .cb-header__close:hover {
      background: var(--cb-paper-sunk);
      color: var(--cb-ink);
    }
    .cb-header__close:active { transform: scale(0.96); }
    .cb-header__close:focus-visible {
      outline: 2px solid color-mix(in oklch, var(--cb-primary) 50%, transparent);
      outline-offset: 2px;
    }
    .cb-header__close svg { width: 18px; height: 18px; }
    .cb-header__close svg path { stroke-width: 1.75; }
    /* "New conversation" — same affordance as close, sits to its left. */
    .cb-header__new {
      width: 44px;
      height: 44px;
      border: none;
      background: transparent;
      color: var(--cb-ink-muted);
      border-radius: 9px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition:
        background 180ms var(--cb-ease),
        color 180ms var(--cb-ease),
        transform 260ms var(--cb-ease);
    }
    .cb-header__new:hover {
      background: var(--cb-paper-sunk);
      color: var(--cb-ink);
    }
    .cb-header__new:active { transform: scale(0.96); }
    .cb-header__new:focus-visible {
      outline: 2px solid color-mix(in oklch, var(--cb-primary) 50%, transparent);
      outline-offset: 2px;
    }
    .cb-header__new svg { width: 18px; height: 18px; }
    .cb-header__new svg path { stroke-width: 1.75; }

    .cb-header__avatar {
      width: 36px;
      height: 36px;
      border-radius: 999px;
      background: color-mix(in oklch, var(--cb-primary) 10%, var(--cb-paper-raised));
      border: 1px solid color-mix(in oklch, var(--cb-primary) 22%, var(--cb-hairline));
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--cb-primary);
    }
    .cb-header__avatar svg { width: 18px; height: 18px; }
    .cb-header__avatar svg path { stroke-width: 1.75; }

    .cb-header__info { min-width: 0; display: flex; flex-direction: column; gap: 2px; }

    .cb-header__title {
      font-family: var(--cb-sans);
      font-size: 14.5px;
      font-weight: 600;
      line-height: 1.2;
      margin: 0;
      color: var(--cb-ink);
      letter-spacing: -0.005em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cb-header__subtitle {
      font-family: var(--cb-sans);
      font-size: 12.5px;
      font-weight: 400;
      line-height: 1.35;
      margin: 0;
      color: var(--cb-ink-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .cb-header__status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--cb-sans);
      font-size: 11.5px;
      font-weight: 500;
      color: var(--cb-ink-muted);
      padding-left: 2px;
    }
    .cb-header__status-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--cb-ink-faint);
      flex-shrink: 0;
      transition: background 200ms var(--cb-ease);
    }
    .cb-header__status-dot--connecting { background: #EAB308; animation: cbPulseAmber 1800ms var(--cb-ease) infinite; }
    .cb-header__status-dot--connected  { background: var(--cb-secondary); animation: cbPulseGreen 2600ms var(--cb-ease) infinite; }
    .cb-header__status-dot--offline    { background: #EF4444; }

    @keyframes cbPulseAmber {
      0%, 100% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.45); }
      60%      { box-shadow: 0 0 0 5px rgba(234, 179, 8, 0);    }
    }
    @keyframes cbPulseGreen {
      0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.45); }
      60%      { box-shadow: 0 0 0 5px rgba(34, 197, 94, 0);    }
    }

    /* ============================================================
       Messages — symmetric bubbles (bot slate, user brand)
       ============================================================ */
    .cb-messages {
      flex: 1;
      overflow-y: auto;
      padding: 18px 18px 8px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scroll-behavior: smooth;
      background: var(--cb-paper-raised);
      scrollbar-width: thin;
      scrollbar-color: var(--cb-hairline) transparent;
    }
    .cb-messages::-webkit-scrollbar { width: 6px; }
    .cb-messages::-webkit-scrollbar-track { background: transparent; }
    .cb-messages::-webkit-scrollbar-thumb { background: var(--cb-hairline); border-radius: 3px; }
    .cb-messages::-webkit-scrollbar-thumb:hover { background: var(--cb-ink-faint); }

    .cb-message {
      display: flex;
      gap: 0;
      max-width: 100%;
      animation: cbMsgIn 320ms var(--cb-ease) both;
    }
    @keyframes cbMsgIn {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0);   }
    }

    .cb-message--user { justify-content: flex-end; }
    .cb-message--bot  { justify-content: flex-start; }

    /* Per-message avatars hidden — header carries identity */
    .cb-message__avatar { display: none; }

    .cb-message__content {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: min(82%, 48ch);
      min-width: 0;
    }
    .cb-message--user .cb-message__content { align-items: flex-end; }
    .cb-message--bot  .cb-message__content { align-items: flex-start; }

    /* Symmetric bubbles: same shape, different fills */
    .cb-message__bubble {
      font-family: var(--cb-sans);
      font-size: 14px;
      font-weight: 450;
      line-height: 1.5;
      letter-spacing: 0.002em;
      padding: 10px 14px;
      border-radius: 14px;
      word-wrap: break-word;
      max-width: 100%;
    }
    .cb-message--bot .cb-message__bubble {
      background: var(--cb-bot-bubble);
      color: var(--cb-ink);
      border-top-left-radius: 4px;
    }
    .cb-message--user .cb-message__bubble {
      background: var(--cb-primary);
      color: var(--cb-primary-ink);
      font-weight: 500;
      border-top-right-radius: 4px;
    }

    .cb-message__chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .cb-slot-chip {
      font-family: var(--cb-sans);
      font-size: 13px;
      font-weight: 500;
      padding: 7px 12px;
      border-radius: 16px;
      border: 1px solid var(--cb-primary);
      background: transparent;
      color: var(--cb-primary);
      cursor: pointer;
      transition: background 150ms var(--cb-ease), color 150ms var(--cb-ease);
    }
    .cb-slot-chip:hover {
      background: var(--cb-primary);
      color: var(--cb-primary-ink);
    }
    .cb-slot-chip:active { transform: scale(0.97); }

    /* Address picker. Deliberately NOT chip-shaped: a chip sends a sentence, this opens a
       control whose result the server owns. Looking different is the honest signal. */
    .cb-addr {
      margin-top: 8px;
      padding: 10px;
      border: 1px solid var(--cb-border);
      border-radius: 10px;
      background: var(--cb-paper-raised);
    }
    .cb-addr__label {
      font-family: var(--cb-sans);
      font-size: 12px;
      margin: 0 0 6px;
      color: var(--cb-ink-muted);
    }
    .cb-addr__input {
      font-family: var(--cb-sans);
      font-size: 14px;
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid var(--cb-border);
      border-radius: 8px;
      background: var(--cb-paper);
      color: var(--cb-ink);
    }
    .cb-addr__input:focus {
      outline: none;
      border-color: var(--cb-primary);
    }
    .cb-addr__list { display: flex; flex-direction: column; margin-top: 6px; }
    .cb-addr__row {
      font-family: var(--cb-sans);
      font-size: 13px;
      text-align: left;
      padding: 8px 10px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--cb-ink);
      cursor: pointer;
    }
    .cb-addr__row:hover { background: var(--cb-primary); color: var(--cb-primary-ink); }
    .cb-addr__chosen {
      font-family: var(--cb-sans);
      font-size: 13px;
      margin: 0;
      color: var(--cb-ink);
    }

    .cb-message__time {
      font-family: var(--cb-sans);
      font-size: 11px;
      font-weight: 500;
      color: var(--cb-ink-faint);
      letter-spacing: 0.005em;
      padding: 0 2px;
    }
    .cb-message--user .cb-message__time { text-align: right; }

    /* File attachment */
    .cb-message__file {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      background: var(--cb-paper-raised);
      border: 1px solid var(--cb-hairline);
      border-radius: 12px;
    }
    .cb-message__file-icon {
      width: 36px;
      height: 36px;
      background: color-mix(in oklch, var(--cb-primary) 10%, var(--cb-paper-raised));
      color: var(--cb-primary);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .cb-message__file-icon svg { width: 18px; height: 18px; }
    .cb-message__file-icon svg path { stroke-width: 1.75; }
    .cb-message__file-info { flex: 1; min-width: 0; }
    .cb-message__file-name {
      font-family: var(--cb-sans);
      font-size: 13px;
      font-weight: 500;
      color: var(--cb-ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cb-message__file-size {
      font-family: var(--cb-sans);
      font-size: 11.5px;
      font-weight: 450;
      color: var(--cb-ink-muted);
    }
    .cb-message__image {
      max-width: 100%;
      border-radius: 12px;
      border: 1px solid var(--cb-hairline);
      cursor: pointer;
      transition: transform 260ms var(--cb-ease);
    }
    .cb-message__image:hover { transform: scale(1.01); }

    /* ============================================================
       Connection banner — slides in when disconnected / reconnecting
       ============================================================ */
    .cb-conn-banner {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 14px;
      font-family: var(--cb-sans);
      font-size: 12px;
      font-weight: 500;
      color: #92400E;
      background: #FEF3C7;
      border-bottom: 1px solid #FDE68A;
      flex-shrink: 0;
    }
    .cb-conn-banner--visible { display: flex; }
    .cb-conn-banner--offline { color: #991B1B; background: #FEE2E2; border-bottom-color: #FECACA; }
    .cb-conn-banner__dot {
      width: 6px; height: 6px; border-radius: 999px;
      background: currentColor;
      animation: cbPulseAmber 1800ms var(--cb-ease) infinite;
    }
    .cb-conn-banner--offline .cb-conn-banner__dot { animation: none; }

    /* ============================================================
       Loading spinner — shown while session initialises
       ============================================================ */
    .cb-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      gap: 10px;
      color: var(--cb-ink-muted);
      font-family: var(--cb-sans);
      font-size: 13px;
    }
    .cb-loading__spinner {
      width: 28px; height: 28px;
      border: 2.5px solid var(--cb-hairline);
      border-top-color: var(--cb-primary);
      border-radius: 999px;
      animation: cbSpin 700ms linear infinite;
    }
    @keyframes cbSpin { to { transform: rotate(360deg); } }

    /* ============================================================
       Empty state — prompt to start chatting
       ============================================================ */
    .cb-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      gap: 6px;
      padding: 24px;
      text-align: center;
      color: var(--cb-ink-muted);
      font-family: var(--cb-sans);
    }
    .cb-empty__icon { opacity: 0.4; }
    .cb-empty__text { font-size: 13px; font-weight: 500; }

    /* ============================================================
       System messages — agent joined/left notifications
       ============================================================ */
    .cb-system-msg {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 0;
      font-family: var(--cb-sans);
      font-size: 11px;
      font-weight: 500;
      color: var(--cb-ink-muted);
    }
    .cb-system-msg__dot {
      width: 5px; height: 5px;
      border-radius: 999px;
    }
    .cb-system-msg__dot--joined { background: var(--cb-secondary); }
    .cb-system-msg__dot--left { background: var(--cb-ink-faint); }

    /* ============================================================
       Typing indicator — classic three-dot pulse inside a bot bubble
       ============================================================ */
    .cb-typing {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 10px 14px;
      margin: 0 18px 10px;
      align-self: flex-start;
      background: var(--cb-bot-bubble);
      border-radius: 14px 14px 14px 4px;
      width: fit-content;
    }
    .cb-typing__dot {
      display: block;
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--cb-ink-muted);
      animation: cbTypingDot 1200ms var(--cb-ease) infinite both;
    }
    .cb-typing__dot:nth-child(1) { animation-delay: -0.32s; }
    .cb-typing__dot:nth-child(2) { animation-delay: -0.16s; }
    @keyframes cbTypingDot {
      0%, 80%, 100% { transform: scale(0.45); opacity: 0.3; }
      40%           { transform: scale(1);    opacity: 1;   }
    }

    /* ============================================================
       Input area
       ============================================================ */
    .cb-input-area {
      padding: 12px 16px 14px;
      border-top: 1px solid var(--cb-hairline);
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
      background: var(--cb-paper-raised);
    }
    .cb-input-area__privacy {
      font-family: var(--cb-sans);
      font-size: 11px;
      font-weight: 400;
      color: var(--cb-ink-muted);
      text-align: center;
      line-height: 1.4;
      margin: 0;
      padding: 0 4px;
    }
    .cb-input-area__privacy a {
      color: var(--cb-primary);
      text-decoration: underline;
      text-underline-offset: 2px;
      font-weight: 500;
    }
    .cb-input-area__privacy a:hover { color: var(--cb-primary-hover); }

    /* D33: "Powered by Axentrio" watermark on Essential. Hidden for Pro+ via
       config.attribution.hide from /widget/config. */
    .cb-attribution {
      font-family: var(--cb-sans);
      font-size: 10px;
      font-weight: 500;
      color: var(--cb-ink-muted);
      text-align: center;
      text-decoration: none;
      letter-spacing: 0.02em;
      padding: 4px 0 0;
      opacity: 0.7;
      transition: opacity 120ms ease;
    }
    .cb-attribution:hover { opacity: 1; color: var(--cb-primary); }
    .cb-attribution[hidden] { display: none; }

    .cb-input-wrapper {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      background: var(--cb-paper-raised);
      border: 1px solid var(--cb-hairline);
      border-radius: 12px;
      padding: 8px 6px 8px 14px;
      transition:
        border-color 180ms var(--cb-ease),
        box-shadow 180ms var(--cb-ease);
    }
    .cb-input-wrapper:focus-within {
      border-color: color-mix(in oklch, var(--cb-primary) 55%, var(--cb-hairline));
      box-shadow: 0 0 0 3px color-mix(in oklch, var(--cb-primary) 10%, transparent);
    }

    .cb-input {
      flex: 1;
      border: none;
      background: transparent;
      font-family: var(--cb-sans);
      font-size: 14px;
      font-weight: 450;
      line-height: 1.5;
      color: var(--cb-ink);
      resize: none;
      max-height: 120px;
      min-height: 22px;
      outline: none;
      letter-spacing: 0.002em;
      padding: 2px 0;
    }
    .cb-input::placeholder {
      color: var(--cb-ink-faint);
      font-family: var(--cb-sans);
      font-weight: 450;
    }

    .cb-input-actions {
      display: flex;
      gap: 2px;
      align-items: center;
      padding-left: 2px;
    }
    .cb-btn {
      width: 44px;
      height: 44px;
      border-radius: 9px;
      border: none;
      background: transparent;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--cb-ink-muted);
      transition:
        background 180ms var(--cb-ease),
        color 180ms var(--cb-ease),
        transform 260ms var(--cb-ease);
    }
    .cb-btn:hover {
      background: var(--cb-paper-sunk);
      color: var(--cb-ink-soft);
    }
    .cb-btn:active { transform: scale(0.96); }
    .cb-btn:focus-visible {
      outline: 2px solid color-mix(in oklch, var(--cb-primary) 50%, transparent);
      outline-offset: 2px;
    }

    .cb-btn--primary {
      background: var(--cb-primary);
      color: var(--cb-primary-ink);
      box-shadow: 0 1px 2px color-mix(in oklch, var(--cb-primary) 26%, transparent);
    }
    .cb-btn--primary:hover {
      background: var(--cb-primary-hover);
      color: var(--cb-primary-ink);
    }

    .cb-btn svg { width: 18px; height: 18px; }
    .cb-btn svg path { stroke-width: 1.75; }

    /* ============================================================
       Upload overlay
       ============================================================ */
    .cb-upload-overlay {
      position: absolute;
      inset: 10px;
      background: color-mix(in oklch, var(--cb-primary) 5%, var(--cb-paper-raised));
      border: 1.5px dashed color-mix(in oklch, var(--cb-primary) 40%, var(--cb-hairline));
      border-radius: calc(var(--cb-radius) - 4px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: var(--cb-primary);
      opacity: 0;
      visibility: hidden;
      transition:
        opacity 260ms var(--cb-ease),
        visibility 260ms var(--cb-ease);
      z-index: 10;
      pointer-events: none;
    }
    .cb-upload-overlay--active { opacity: 1; visibility: visible; }
    .cb-upload-overlay svg { width: 40px; height: 40px; }
    .cb-upload-overlay svg path { stroke-width: 1.5; }
    .cb-upload-overlay__text {
      font-family: var(--cb-sans);
      font-size: 14px;
      font-weight: 600;
      color: var(--cb-ink);
      letter-spacing: -0.002em;
    }

    /* ============================================================
       Progress bar (file upload)
       ============================================================ */
    .cb-progress {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: transparent;
      overflow: hidden;
      z-index: 11;
    }
    .cb-progress__bar {
      height: 100%;
      background: var(--cb-primary);
      transition: width 260ms var(--cb-ease);
    }

    /* ============================================================
       Narrow widths (small phones, tight embeds) — drop the status
       label to keep the 5-column header from wrapping.
       ============================================================ */
    @media (max-width: 420px) {
      .cb-header { column-gap: 8px; padding-right: 10px; }
      .cb-header__status-text { display: none; }
    }

    /* ============================================================
       Mobile — chat becomes full-screen; header close button is the
       only way to dismiss (launcher is hidden in this state).
       ============================================================ */
    @media (max-width: 768px) {
      .cb-widget {
        right: 16px !important;
        bottom: 16px;
      }
      .cb-widget--left { left: 16px; right: auto !important; }
      .cb-chat {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100dvh;
        max-height: none;
        border: none;
        border-radius: 0;
      }
      .cb-chat--open + .cb-launcher { display: none; }
      .cb-header {
        padding: 14px 12px 13px 16px;
        /* Extra top padding on devices with a notch / dynamic island */
        padding-top: max(14px, env(safe-area-inset-top));
      }
      .cb-header::after { left: 16px; right: 16px; }
      .cb-messages { padding: 18px 18px 6px; gap: 12px; }
      .cb-input-area {
        padding: 10px 14px;
        padding-bottom: max(10px, env(safe-area-inset-bottom));
      }
    }

    /* ============================================================
       Dark theme — slate inversion, matching SaaS dark conventions
       ============================================================ */
    :host([data-theme="dark"]) {
      --cb-ink:       #F8FAFC;
      --cb-ink-soft:  #CBD5E1;
      --cb-ink-muted: #94A3B8;
      --cb-ink-faint: #64748B;
      --cb-paper:        #0B1220;
      --cb-paper-raised: #0F172A;
      --cb-paper-sunk:   #1E293B;
      --cb-bot-bubble:   #1E293B;
      --cb-hairline:      #1E293B;
      --cb-hairline-soft: #172033;
      --cb-shadow-lg:
        0 1px 2px rgba(0, 0, 0, 0.4),
        0 24px 48px -16px rgba(0, 0, 0, 0.7);
      --cb-shadow: var(--cb-shadow-lg);
    }
    :host([data-theme="dark"]) .cb-header__avatar {
      background: color-mix(in oklch, var(--cb-primary) 14%, var(--cb-paper-sunk));
      border-color: color-mix(in oklch, var(--cb-primary) 30%, var(--cb-hairline));
    }

    /* ============================================================
       Motion preference
       ============================================================ */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }

    /* ============================================================
       Print
       ============================================================ */
    @media print {
      .cb-widget { display: none !important; }
    }

    /* ============================================================
       Appearance overrides (additive — applied only when config sets them)
       ============================================================ */
    .cb-launcher--pill {
      width: auto;
      height: auto;
      padding: 10px 16px;
      border-radius: 999px;
      gap: 8px;
    }
    .cb-launcher--pill .cb-launcher__text {
      font-size: 14px;
      font-weight: 500;
      color: white;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cb-bot-avatar-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 50%;
    }
  `;

  // ==========================================================================
  // SVG Icons
  // ==========================================================================
  const ICONS = {
    chat: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>',
    close: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>',
    newChat: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>',
    send: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 6l6 6-6 6" /></svg>',
    attach: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>',
    camera: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>',
    mic: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>',
    file: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>',
    image: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>',
    upload: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>',
    bot: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>',
    user: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>',
  };

  // ==========================================================================
  // Utility Functions
  // ==========================================================================
  const utils = {
    generateId: () => Math.random().toString(36).substr(2, 9),

    // Cryptographically strong 128-bit id (hex). Used for the durable visitorId so
    // it cannot be guessed, predicted, or enumerated - Math.random is neither
    // high-entropy nor unpredictable, and the visitorId is the identity a widget
    // session token is minted against (#21 hardening). Falls back to the weak
    // generator only where WebCrypto is unavailable.
    strongId: () => {
      try {
        const c = typeof window !== 'undefined' && (window.crypto || window.msCrypto);
        if (c && c.getRandomValues) {
          const a = new Uint8Array(16);
          c.getRandomValues(a);
          return Array.prototype.map.call(a, (b) => ('0' + b.toString(16)).slice(-2)).join('');
        }
      } catch (e) {
        /* fall through to the weak generator */
      }
      return utils.generateId() + utils.generateId();
    },

    hashString: (value = '') => {
      let hash = 0;

      for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) - hash) + value.charCodeAt(i);
        hash |= 0;
      }

      return (hash >>> 0).toString(36);
    },
    
    formatTime: (date) => {
      const d = date instanceof Date ? date : new Date(date);
      if (isNaN(d.getTime())) return '';
      return new Intl.DateTimeFormat('default', {
        hour: 'numeric',
        minute: 'numeric',
      }).format(d);
    },
    
    formatFileSize: (bytes) => {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },
    
    escapeHtml: (text) => {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    },

    /**
     * For a value going inside an HTML ATTRIBUTE, where escapeHtml is not enough.
     *
     * `escapeHtml` round-trips through `textContent`, which escapes & < > and leaves QUOTES
     * alone - correct for element text, unsafe the moment the result lands inside `attr="..."`.
     * A value containing a double quote closes the attribute and everything after it is parsed as
     * more attributes, so `" autofocus onfocus="alert(1)` in an address field executes.
     *
     * Found by a test probe on 2026-08-13: the escaping was present, the payload still ran. The
     * XSS assertion that had "passed" used a payload with no quote in it, so it could not break
     * out and held just as well with the escaping deleted.
     */
    escapeAttr: (text) => String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
    
    debounce: (fn, delay) => {
      let timeoutId;
      return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
      };
    },
    
    isMobile: () => window.innerWidth <= 768,
    
    supportsWebSocket: () => 'WebSocket' in window,
    
    supportsFileAPI: () => 'FileReader' in window,
    
    getMimeTypeIcon: (mimeType) => {
      if (mimeType.startsWith('image/')) return 'image';
      if (mimeType.startsWith('video/')) return 'video';
      return 'file';
    },
  };

  // ==========================================================================
  // Bot avatar render helper
  // ==========================================================================
  function botAvatarHtml(avatarUrl, { eager = false } = {}) {
    if (avatarUrl) {
      // ESCAPED ONCE. This had its own inline escaper, and the attribute sweep wrapped that in
      // `escapeAttr` as well - so `&` became `&amp;amp;` and a signed avatar URL lost its query
      // string. Two correct escapers compose into a wrong one; the sweep has to replace them, not
      // stack on top.
      const loading = eager ? 'eager' : 'lazy';
      return `<img src="${utils.escapeAttr(avatarUrl)}" alt="" loading="${loading}" class="cb-bot-avatar-img" />`;
    }
    return ICONS.bot;
  }

  // ==========================================================================
  // Fetch with timeout helper
  // ==========================================================================
  function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  // ==========================================================================
  // ChatbotWidget Class
  // ==========================================================================
  // Socket.IO CDN URL
  const SOCKET_IO_CDN = 'https://cdn.socket.io/4.7.5/socket.io.min.js';

  // Load Socket.IO client from CDN (returns a promise)
  function loadSocketIO() {
    if (window.io) return Promise.resolve(window.io);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SOCKET_IO_CDN;
      script.onload = () => resolve(window.io);
      script.onerror = () => reject(new Error('Failed to load Socket.IO client'));
      document.head.appendChild(script);
    });
  }

  class ChatbotWidget {
    constructor(config = {}) {
      this.config = { ...DEFAULT_CONFIG, ...config };
      this.isOpen = false;
      this.messages = [];
      this.socket = null;
      this.reconnectAttempts = 0;
      this.typingTimeout = null;
      this.uploadQueue = [];
      this.sessionId = null;
      this.tenantId = null;
      this.visitorId = null;
      // Owner opt-in for file uploads, answered by /widget/config. Starts FALSE so the
      // attach button stays hidden until the server says otherwise — the previous default
      // showed it on every embed and every upload then failed.
      this.serverFileUploadEnabled = false;
      this.pendingMessages = [];
      this.storageKey = this.getStorageKey();
      this.visitorKey = this.getVisitorKey();
      this._connected = false;
      this._hasEverConnected = false;
      // Monotonic session-lifecycle counter. Bumped whenever a NEW session
      // lifecycle starts (recovery, new-conversation). Each async init path
      // captures the epoch at its start; a stale path (superseded by a newer
      // one) checks `epoch !== this._sessionEpoch` and bails before it assigns
      // this.socket / this.sessionId — so a click during the initial connect or
      // a reconnect can't leak a second live socket (duplicate bot messages).
      this._sessionEpoch = 0;
      this._agent = null; // { name, lastActive }
      this._agentActivityTimer = null;
      this.appearance = (this.config && this.config.appearance) || {};

      // "New conversation" visibility (see DEFAULT_CONFIG.showNewChat): hidden
      // from real visitors; shown for embeds that opt in or browsers that
      // carry the team override. Computed once here, BEFORE render().
      this.canNewChat = false;
      try {
        this.canNewChat = !!this.config.showNewChat ||
          localStorage.getItem(SHOW_NEW_CHAT_OVERRIDE_KEY) === '1';
      } catch (err) { /* storage blocked - stays hidden */ }

      // Render immediately, connect async
      this.loadSession();
      // Resolve the durable visitorId AFTER loadSession: the stored blob is
      // the adoption source for installs that predate the durable key.
      this._ensureVisitorId();
      // A blob written for ANOTHER identity (a stale cached script minted a
      // random id while the durable key holds ours) must never be resumed.
      this._reconcileStoredIdentity();
      this.createShadowDOM();
      this.render();
      this.attachEventListeners();
      this.setConnectionState('connecting');

      // Show greeting only for new sessions (no cached messages)
      if (this.config.greetingMessage && this.messages.length === 0) {
        this.addMessage({
          id: utils.generateId(),
          text: this.config.greetingMessage,
          sender: 'bot',
          timestamp: new Date(),
          isGreeting: true,
        });
      }

      this.log('Widget initialized');

      // Async: load Socket.IO → init session → connect
      this._initConnection();

      // Async: load tenant-configured appearance (color, avatar, launcher).
      // Fire-and-forget; falls back to defaults on failure/timeout.
      // Note: this causes a brief flash if appearance differs from defaults —
      // the launcher renders synchronously with script-tag config, then this
      // fetch re-applies the saved appearance once it resolves. MVP tradeoff.
      this._loadAppearanceConfig();
    }

    // One hash per embed triple (api origin + key + bot) - shared by the
    // session-blob key and the durable visitor key so they always pair up.
    _embedHash() {
      const identity = [
        this.config.apiUrl || 'default-api',
        this.config.apiKey || 'public',
        this.config.botId || 'default',
      ].join('|');

      return utils.hashString(identity);
    }

    getStorageKey() {
      return STORAGE_KEY_PREFIX + this._embedHash();
    }

    getVisitorKey() {
      return VISITOR_KEY_PREFIX + this._embedHash();
    }

    // Resolve the durable visitorId. Order: (a) the durable key; else
    // (b) ADOPT the visitorId from the stored session blob (returning
    // installs keep their server-side conversation); else (c) mint one.
    // NEVER regenerated after this - recovery and "new conversation" keep it.
    _ensureVisitorId() {
      let durable = null;
      try {
        durable = localStorage.getItem(this.visitorKey);
      } catch (err) {
        this.log('Failed to read visitor id:', err && err.message);
      }
      if (durable && typeof durable === 'string') {
        this.visitorId = durable;
        return;
      }
      if (!this.visitorId) {
        // loadSession may not have found a blob yet (or was skipped) - check.
        const stored = this.readStoredSession();
        if (stored && stored.session && typeof stored.session.visitorId === 'string') {
          this.visitorId = stored.session.visitorId;
        }
      }
      if (!this.visitorId) {
        // #21: crypto-strong so a visitorId cannot be guessed or enumerated.
        this.visitorId = 'widget-' + utils.strongId();
      }
      try {
        localStorage.setItem(this.visitorKey, this.visitorId);
      } catch (err) {
        // Storage unavailable (private mode/quota): keep the in-memory id -
        // this load behaves like today's per-session identity.
        this.log('Failed to persist visitor id:', err && err.message);
      }
    }

    // Discard a stored session blob that belongs to a DIFFERENT visitorId
    // than the durable identity (S2). Resuming it would put this customer in
    // another identity's conversation. The in-memory state loadSession copied
    // from that blob is dropped too; _initSession then resolves the durable
    // identity's own session server-side.
    _reconcileStoredIdentity() {
      const stored = this.readStoredSession();
      if (!stored || !stored.session) return;
      const blobVisitorId = stored.session.visitorId;
      if (!blobVisitorId || !this.visitorId || blobVisitorId === this.visitorId) return;
      this.log('Discarding stored session for a different visitor id');
      this.clearStoredSession();
      this.sessionId = null;
      this.tenantId = null;
      this.token = null;
      this.messages = [];
    }

    readStoredSession() {
      const storageKeys = [this.storageKey, LEGACY_STORAGE_KEY];

      for (const key of storageKeys) {
        try {
          const stored = localStorage.getItem(key);
          if (!stored) continue;

          const session = JSON.parse(stored);
          if (session && typeof session === 'object') {
            return { key, session };
          }
        } catch (err) {
          this.log('Failed to read cached session:', err.message);
        }
      }

      return null;
    }

    writeStoredSession(sessionData) {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(sessionData));
        return true;
      } catch (err) {
        this.log('Failed to persist session cache:', err.message);
        return false;
      }
    }

    clearStoredSession() {
      try {
        localStorage.removeItem(this.storageKey);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch (err) {
        this.log('Failed to clear cached session:', err.message);
      }
    }

    setConnectionState(state) {
      const nextState = CONNECTION_STATUS[state] || CONNECTION_STATUS.connecting;

      if (!this.statusDot || !this.statusText) return;

      this.statusDot.classList.remove(
        CONNECTION_STATUS.connecting.dotClass,
        CONNECTION_STATUS.connected.dotClass,
        CONNECTION_STATUS.offline.dotClass,
      );
      this.statusDot.classList.add(nextState.dotClass);
      this.statusText.textContent = nextState.label;

      // Connection banner: only show after a prior successful connection (not on cold open)
      if (this.connBanner) {
        if (state === 'connected') {
          this._hasEverConnected = true;
          this.connBanner.classList.remove('cb-conn-banner--visible', 'cb-conn-banner--offline');
        } else if (this._hasEverConnected) {
          this.connBanner.classList.add('cb-conn-banner--visible');
          this.connBanner.classList.toggle('cb-conn-banner--offline', state === 'offline');
          if (this.connBannerText) {
            this.connBannerText.textContent = state === 'offline' ? 'Connection lost' : 'Reconnecting…';
          }
        }
      }

      // Swap loading spinner once connection settles
      if (this.loadingEl) {
        const onlyGreeting = this.messages.length === 0 ||
          (this.messages.length === 1 && this.messages[0].isGreeting);

        if (state === 'connected' && onlyGreeting) {
          // Connected with no real messages — show empty-state prompt
          this.loadingEl.outerHTML = `
            <div class="cb-empty">
              <span class="cb-empty__icon">${ICONS.chat}</span>
              <span class="cb-empty__text">Ask us anything</span>
            </div>`;
          this.loadingEl = null;
        } else if (state === 'connected') {
          // Connected with cached messages already rendered — just remove spinner
          this.loadingEl.remove();
          this.loadingEl = null;
        } else if (state === 'offline') {
          // Never connected — swap spinner for a "can't connect" message
          this.loadingEl.outerHTML = `
            <div class="cb-empty">
              <span class="cb-empty__icon">${ICONS.bot}</span>
              <span class="cb-empty__text">Unable to connect — please try again later</span>
            </div>`;
          this.loadingEl = null;
        }
      }
    }

    canSendMessages() {
      return Boolean(this.sessionId && this.socket && this._connected);
    }

    emitOutboundMessage(message) {
      if (!this.canSendMessages()) return false;

      this.socket.emit('message:send', {
        sessionId: this.sessionId,
        content: message.text,
        type: 'text',
      });

      return true;
    }

    flushPendingMessages() {
      if (!this.canSendMessages() || this.pendingMessages.length === 0) return;

      const queuedMessages = this.pendingMessages.slice();
      this.pendingMessages = [];

      queuedMessages.forEach(message => this.emitOutboundMessage(message));
      this.showTypingIndicator();
      this.log('Flushed queued messages:', queuedMessages.length);
    }

    async _loadAppearanceConfig() {
      if (!this.config.apiKey || !this.config.apiUrl) return;
      try {
        const url = `${this.config.apiUrl}/api/v1/widget/config?apiKey=${encodeURIComponent(this.config.apiKey)}`;
        const resp = await fetchWithTimeout(url, { method: 'GET' }, 5000);
        if (!resp.ok) {
          this.log('Appearance config fetch returned status', resp.status);
          return;
        }
        const body = await resp.json();
        const data = body && body.data ? body.data : body;
        if (!data || typeof data !== 'object') return;
        if (data.appearance && typeof data.appearance === 'object') {
          this.appearance = data.appearance;
        }
        // D33/D34: tier-driven attribution. Default rendering is visible
        // (Essential semantics); Pro+ flips the element hidden once config
        // lands. Stored on `this.appearance` so _applyAppearance can act on it.
        if (data.attribution && typeof data.attribution === 'object') {
          this.appearance.hideAttribution = data.attribution.hide === true;
        }
        // The attach button is gated on the SERVER's answer, which defaults to false. The
        // embed option alone defaulted to true, so every widget on every site rendered an
        // attach button whose uploads then 404'd. Owner opt-in decides this, not the embed.
        this.serverFileUploadEnabled = data.features ? data.features.fileUploadEnabled === true : false;
        this._applyAppearance();
      } catch (err) {
        this.log('Appearance config fetch failed:', err && err.message);
      }
    }

    _applyAppearance() {
      if (!this.launcher) return;
      // Launcher position — toggle the wrapper class. The .cb-widget wrapper
      // owns the fixed-positioning; .cb-launcher itself is position:static
      // inside the wrapper, so a class on the launcher cannot move it.
      if (this.container) {
        const isBottomLeft = this.appearance.launcherPosition === 'bottom-left';
        this.container.classList.toggle('cb-widget--left', isBottomLeft);
        this.container.classList.toggle('cb-widget--right', !isBottomLeft);
      }
      // Launcher label / pill mode
      const hasLabel = !!this.appearance.launcherLabel;
      this.launcher.classList.toggle('cb-launcher--pill', hasLabel);
      const textEl = this.launcher.querySelector('.cb-launcher__text');
      if (textEl) {
        textEl.textContent = hasLabel ? this.appearance.launcherLabel : '';
      }
      // Header avatar (eager-load — visible the moment the panel opens)
      if (this.shadow) {
        const headerAvatar = this.shadow.querySelector('.cb-header__avatar');
        if (headerAvatar) {
          headerAvatar.innerHTML = botAvatarHtml(this.appearance.avatarUrl, { eager: true });
        }
        // D33/D34: hide the "Powered by Axentrio" footer for entitled tiers.
        const attribution = this.shadow.querySelector('.cb-attribution');
        if (attribution) {
          if (this.appearance.hideAttribution) {
            attribution.setAttribute('hidden', '');
          } else {
            attribution.removeAttribute('hidden');
          }
        }
      }
      // Note: already-rendered message-bubble avatars keep their original
      // render. New bot messages pick up this.appearance.avatarUrl via the
      // message template (line ~1801).
    }

    async _initConnection() {
      if (!this.config.apiKey) {
        if (!this._missingApiKeyWarned) {
          this._missingApiKeyWarned = true;
          // eslint-disable-next-line no-console
          console.warn(
            '[axentrio-widget] Missing data-api-key attribute on the embed script. ' +
            'The widget will render but cannot connect to the chat backend. ' +
            'Add data-api-key="<your-tenant-api-key>" to your <script> tag.',
          );
        }
        this.setConnectionState('offline');
        return;
      }
      const epoch = this._sessionEpoch;
      try {
        await loadSocketIO();
        await this._initSession(epoch);
        this._connectSocketIO(epoch);
      } catch (err) {
        this.setConnectionState('offline');
        this.log('Connection init failed:', err.message);
      }
    }

    async _initSession(epoch) {
      // Try to restore existing session
      const storedSession = this.readStoredSession();
      if (storedSession) {
        const { key, session } = storedSession;

        if (session.sessionId && session.tenantId &&
            // Never resume a blob written for ANOTHER identity (S2) - a stale
            // cached script may have rewritten it since the constructor check.
            (!session.visitorId || !this.visitorId || session.visitorId === this.visitorId)) {
          this.sessionId = session.sessionId;
          this.tenantId = session.tenantId;
          // The durable visitorId owns identity - only fall back to the blob's
          // when the durable one is missing (storage-unavailable loads).
          if (!this.visitorId) this.visitorId = session.visitorId;
          this.token = session.token;
          // Restored (not brand-new) session — backfill missed messages on join.
          this._isNewSession = false;

          if (key !== this.storageKey) {
            this.writeStoredSession(session);
          }

          this.log('Restored session:', this.sessionId);
          return;
        }
      }

      // Resolve-or-create via API with the DURABLE visitorId - never a fresh
      // one. The server resolves the visitor's open session (isNew:false) or
      // creates one; identity is stable across loads, recovery and reconnects.
      if (!this.visitorId) this._ensureVisitorId();
      const resp = await fetchWithTimeout(`${this.config.apiUrl}/api/v1/widget/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: this.config.apiKey,
          visitorId: this.visitorId,
        }),
      }, 15000);

      if (!resp.ok) throw new Error(`Widget init failed: ${resp.status}`);

      const { data } = await resp.json();
      // Superseded by a newer session lifecycle (e.g. the user hit "New
      // conversation" while this init was in flight) — don't clobber the newer
      // session's state. The server session we just created is abandoned and
      // idle-closes on its own.
      if (epoch !== undefined && epoch !== this._sessionEpoch) {
        this.log('Stale _initSession discarded (epoch', epoch, '!=', this._sessionEpoch, ')');
        return;
      }
      this.sessionId = data.session.id;
      this.tenantId = data.session.tenantId || data.tenantId;
      // Widget JWT — needed to call /widget/history for reconnect backfill.
      this.token = data.token;
      // Brand-new session (isNew): nothing to backfill on the first join
      // (avoids re-rendering the server-side greeting on top of the client
      // greeting). A RESOLVED session (isNew:false - the server matched our
      // durable visitorId) must backfill its transcript on join instead.
      this._isNewSession = data.isNew !== false;

      // Clear old messages from previous session
      this.messages = [];
      if (this.messagesContainer) {
        while (this.messagesContainer.firstChild) {
          this.messagesContainer.removeChild(this.messagesContainer.firstChild);
        }
      }

      this.log(this._isNewSession ? 'New session created:' : 'Session resolved:', this.sessionId);
      this._saveSession();
      this.flushPendingMessages();
    }

    // One-shot recovery: tear down the socket, re-init the session (the DURABLE
    // visitorId survives - /widget/init resolves the SAME non-closed session →
    // fresh token), then reconnect with the new token. The bound session is fixed
    // at the handshake, so a new token needs a new socket - never a re-emit. #19.
    _recoverWidgetSession(reason) {
      if (this._recovering) return; // one-shot — avoid init/connect loops
      this._recovering = true;
      const epoch = ++this._sessionEpoch;
      this.log('Recovering widget session:', reason);
      try {
        if (this.socket) { this.socket.removeAllListeners(); this.socket.disconnect(); }
      } catch (e) { /* ignore */ }
      this.socket = null;
      this.clearStoredSession();
      this.token = null;
      this.setConnectionState('connecting');
      this._initSession(epoch)
        .then(() => { this._connectSocketIO(epoch); })
        .catch((err) => {
          // Reset the one-shot guard on FAILURE only (not .finally — on success
          // the 'connect' handler clears it; clearing here would drop the guard
          // mid-connect and let a second recovery race). A rejected init would
          // otherwise leave _recovering stuck true, blocking all future recovery.
          this._recovering = false;
          this.log('Session recovery failed:', err && err.message);
        });
    }

    // Start a brand-new conversation for the SAME durable visitorId. This is
    // a SERVER command now (POST /widget/new-conversation): in one server
    // transaction the current session is closed and a fresh one is opened
    // against the CURRENT bot config. A client-only localStorage clear cannot
    // do this any more - with a stable visitorId, /widget/init would simply
    // resolve the old session again. Nothing is torn down until the server
    // confirms, so a failed call leaves the current conversation working.
    startNewConversation() {
      if (this._startingNew) return; // guard against concurrent double-taps
      // Light throttle: each new conversation replaces the server session, so
      // ignore rapid repeats (fat-fingers, or a scripted newConversation loop)
      // on top of the in-flight guard. The server also rate-limits the endpoint.
      const now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
      if (now && this._lastNewConversationAt && (now - this._lastNewConversationAt) < 1500) return;
      this._lastNewConversationAt = now;
      this._startingNew = true;

      if (!this.token) {
        // Never connected - there is no server session to swap. The normal
        // connect path owns retries; nothing to do here.
        this._startingNew = false;
        this.log('New conversation skipped: no session token yet');
        return;
      }

      fetchWithTimeout(`${this.config.apiUrl}/api/v1/widget/new-conversation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.token,
        },
        body: JSON.stringify({}),
      }, 15000)
        .then((resp) => {
          if (!resp.ok) {
            const err = new Error('new-conversation failed: ' + resp.status);
            err.status = resp.status;
            throw err;
          }
          return resp.json();
        })
        .then((body) => {
          const data = body && body.data;
          if (!data || !data.session || !data.session.id || !data.token) {
            throw new Error('new-conversation: malformed response');
          }
          this._adoptNewConversation(data);
        })
        .catch((err) => {
          // The current conversation was NOT torn down - it keeps working.
          if (err && err.status === 401) {
            // Expired token: recover (re-init resolves the SAME session with a
            // fresh token); the user can tap "New chat" again after.
            this._recoverWidgetSession('new_conversation_auth');
          }
          this.log('New conversation failed:', err && err.message);
        })
        .finally(() => { this._startingNew = false; });
    }

    // Swap to the server-issued replacement session (same durable visitorId).
    _adoptNewConversation(data) {
      // A fresh session lifecycle: bump the epoch so any in-flight init (the
      // initial connect, or a reconnect recovery) bails before it assigns a
      // socket, and clear the recovery guard it may have left set.
      const epoch = ++this._sessionEpoch;
      this._recovering = false;

      // Tear down the socket bound to the old session.
      try {
        if (this.socket) { this.socket.removeAllListeners(); this.socket.disconnect(); }
      } catch (e) { /* ignore */ }
      this.socket = null;

      this.sessionId = data.session.id;
      this.tenantId = data.session.tenantId || this.tenantId;
      this.token = data.token;
      // Brand-new session: skip the first-join backfill (avoids re-rendering
      // the server-persisted greeting on top of the client greeting), and drop
      // the old session's queued messages so they aren't flushed into it.
      this._isNewSession = true;
      this._joinedOnce = false;
      this.pendingMessages = [];

      // Clear the transcript for responsive feedback. (We do NOT call render()
      // here - it would rebuild the DOM and drop bound refs.)
      this.messages = [];
      if (this.messagesContainer) {
        while (this.messagesContainer.firstChild) {
          this.messagesContainer.removeChild(this.messagesContainer.firstChild);
        }
      }
      this._saveSession();

      // Re-show the client greeting exactly like a first load.
      if (this.config.greetingMessage) {
        this.addMessage({
          id: utils.generateId(),
          text: this.config.greetingMessage,
          sender: 'bot',
          timestamp: new Date(),
          isGreeting: true,
        });
      }

      this.setConnectionState('connecting');
      this._connectSocketIO(epoch);
    }

    _connectSocketIO(epoch) {
      // Superseded by a newer session lifecycle — never connect a stale socket
      // (that's what leaks a second live socket → duplicate bot messages).
      if (epoch !== undefined && epoch !== this._sessionEpoch) {
        this.log('Stale _connectSocketIO skipped (epoch', epoch, '!=', this._sessionEpoch, ')');
        return;
      }
      if (!window.io) {
        this.log('Socket.IO not loaded');
        return;
      }
      // The socket must carry the session-bound widget JWT (issue #19): without
      // it the server leaves the socket unbound and rejects session ops. The
      // token is set by _initSession before this runs; if it's missing, defer.
      if (!this.token) {
        this.log('No widget token yet; deferring socket connect');
        return;
      }

      // Defensive: never leave a previous socket connected (it would keep
      // receiving message:receive for the old session). Belt-and-braces with
      // the epoch guard above.
      if (this.socket) {
        try { this.socket.removeAllListeners(); this.socket.disconnect(); } catch (e) { /* ignore */ }
        this.socket = null;
      }

      this.socket = window.io(this.config.apiUrl, {
        transports: ['websocket', 'polling'],
        auth: {
          widgetToken: this.token,
        },
        query: {
          apiKey: this.config.apiKey,
          visitorId: this.visitorId,
        },
        reconnection: true,
        // Keep retrying indefinitely — a capped retry that exhausts leaves the
        // widget permanently offline (and silently missing bot replies).
        reconnectionAttempts: Infinity,
        reconnectionDelay: this.config.reconnectDelay,
      });

      this.socket.on('connect', () => {
        this.log('Socket.IO connected');
        this._connected = true;
        this._recovering = false; // successful connect clears the one-shot guard
        this.setConnectionState('connected');
        this.emit('connected');

        // Join session room
        this.socket.emit('session:join', { sessionId: this.sessionId });
        this.flushPendingMessages();
      });

      // Server denied a session op (bound session ≠ requested) — recover once.
      this.socket.on('error', (data) => {
        if (data && data.code === 'FORBIDDEN') {
          this._recoverWidgetSession('forbidden');
        }
      });

      this.socket.on('session:joined', (data) => {
        this.log('Joined session room:', data.sessionId);
        this.flushPendingMessages();
        // Reconcile messages missed while disconnected. Replies are room-emitted
        // with no replay, so a bot/agent reply sent during a disconnect would be
        // lost from the UI. Backfill on every reconnect, and on the first join of
        // a restored (not brand-new) session. Skipped for a brand-new session's
        // first join to avoid duplicating the greeting.
        if (this._joinedOnce || !this._isNewSession) {
          this.syncHistory();
        }
        this._joinedOnce = true;
      });

      this.socket.on('session:join:error', () => {
        // Session expired/invalid — recover (new token requires a new socket, not
        // a re-emit, since the bound session is fixed at the handshake). Issue #19.
        this.log('Session join error, re-initializing...');
        this._recoverWidgetSession('session_join_error');
      });

      this.socket.on('connection:ack', (data) => {
        this.log('Connection acknowledged:', data);
      });

      this.socket.on('message:receive', (data) => {
        this.log('Message received:', data);
        // Only show messages from bot/agent, not our own echoes
        if (data.senderType !== 'user') {
          this.hideTypingIndicator();
          this.addMessage({
            id: data.id || utils.generateId(),
            text: data.content,
            sender: 'bot',
            timestamp: new Date(data.timestamp || data.createdAt),
            quickReplies: data.metadata && Array.isArray(data.metadata.quickReplies) ? data.metadata.quickReplies : undefined,
            // A control the SERVER asked us to offer. Unlike a chip, its result does not go back
            // as a customer message — it goes to an endpoint the server owns, which is the only
            // kind of evidence allowed to decide which address this conversation is about.
            affordance: data.metadata && data.metadata.affordance ? data.metadata.affordance : undefined,
          });
        }
      });

      this.socket.on('typing:indicator', (data) => {
        if (data.senderType !== 'user') {
          if (data.isTyping) {
            this.showTypingIndicator();
          } else {
            this.hideTypingIndicator();
          }
          // Track agent activity
          if (this._agent) {
            this._agent.lastActive = Date.now();
            this.updateAgentPresence();
          }
        }
      });

      this.socket.on('agent:joined', (data) => {
        this.log('Agent joined:', data);
        this._agent = { name: data.agentName || 'Agent', lastActive: Date.now() };
        this.addSystemMessage(`${this._agent.name} joined the conversation`);
        this.updateAgentPresence();
        this.startAgentActivityTimer();
      });

      this.socket.on('agent:left', (data) => {
        this.log('Agent left:', data);
        const name = this._agent?.name || data.agentName || 'Agent';
        this._agent = null;
        this.addSystemMessage(`${name} left the conversation`);
        this.updateAgentPresence();
        this.stopAgentActivityTimer();
      });

      this.socket.on('error', (data) => {
        this.log('Server error:', data);
        if (data.message) this.showError(data.message);
      });

      this.socket.on('disconnect', (reason) => {
        this.log('Socket.IO disconnected:', reason);
        this._connected = false;
        this.setConnectionState('connecting');
        this.emit('disconnected');
      });

      this.socket.on('connect_error', (err) => {
        var code = err && err.data && err.data.code;
        this.log('Socket.IO connect error:', err.message, code || '');
        if (code === 'WIDGET_TOKEN_EXPIRED') {
          // Expired token — re-init (same visitorId resumes the session) + reconnect.
          this._recoverWidgetSession('token_expired');
          return;
        }
        if (code === 'WIDGET_TOKEN_INVALID') {
          // A bad/forged token won't fix itself — stop retrying, go offline.
          try { this.socket.disconnect(); } catch (e) { /* ignore */ }
          this.setConnectionState('offline');
          return;
        }
        this.setConnectionState('connecting'); // transient — socket.io keeps retrying
      });
    }

    loadSession() {
      const storedSession = this.readStoredSession();
      if (storedSession) {
        const { key, session } = storedSession;

        this.sessionId = session.sessionId;
        this.tenantId = session.tenantId;
        this.visitorId = session.visitorId;
        this.messages = session.messages || [];

        if (key !== this.storageKey) {
          this.writeStoredSession(session);
        }
      }
    }

    _saveSession() {
      if (this.config.cacheMessages) {
        this.writeStoredSession({
          sessionId: this.sessionId,
          tenantId: this.tenantId,
          visitorId: this.visitorId,
          token: this.token,
          messages: this.messages.slice(-this.config.maxCachedMessages),
        });
      }
    }

    saveSession() {
      this._saveSession();
    }

    // Reconcile the local transcript with the server after a (re)connect.
    // Fetches /widget/history and renders any messages newer than the last one
    // we've shown — recovering bot/agent replies emitted while the socket was
    // disconnected (which are otherwise lost: replies are room-emitted with no
    // replay). Dedupes by message id and by timestamp to avoid double-rendering.
    async syncHistory() {
      if (!this.token || !this.sessionId) return;
      try {
        const resp = await fetchWithTimeout(`${this.config.apiUrl}/api/v1/widget/history`, {
          headers: { 'Authorization': 'Bearer ' + this.token },
        }, 15000);
        if (!resp.ok) return;
        const { data } = await resp.json();
        if (!Array.isArray(data)) return;

        const shownIds = new Set(this.messages.map((m) => m.id));
        let lastTs = 0;
        for (const m of this.messages) {
          const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
          if (t > lastTs) lastTs = t;
        }

        for (const msg of data) {
          if (!msg || shownIds.has(msg.id)) continue;
          const ts = new Date(msg.createdAt).getTime();
          // Only backfill messages newer than what we've already shown — avoids
          // re-adding the greeting and previously-seen history.
          if (lastTs && ts <= lastTs) continue;
          const senderType = msg.sender && msg.sender.type;
          this.hideTypingIndicator();
          this.addMessage({
            id: msg.id,
            text: msg.content,
            sender: senderType === 'user' ? 'user' : 'bot',
            timestamp: new Date(msg.createdAt),
            // Backfilled messages used to arrive stripped of their metadata, so a reconnect or a
            // reload silently dropped the chips a reply had offered. Harmless for slot chips - the
            // customer can type the time - but not for the address picker: it is the only way to
            // verify an address, so losing it on a refresh means losing the ability entirely.
            // `GET /widget/history` returns `metadata` verbatim, so it was only ever discarded here.
            quickReplies: msg.metadata && Array.isArray(msg.metadata.quickReplies) ? msg.metadata.quickReplies : undefined,
            affordance: msg.metadata && msg.metadata.affordance ? msg.metadata.affordance : undefined,
          });
        }
      } catch (err) {
        this.log('History sync failed:', err && err.message);
      }
    }
    
    createShadowDOM() {
      this.host = document.createElement('div');
      this.host.id = 'chatbot-widget-' + utils.generateId();
      this.host.setAttribute('data-theme', this.config.theme);

      this.shadow = this.host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = WIDGET_STYLES;

      this.container = document.createElement('div');
      this.container.className = 'cb-widget cb-widget--' + this.config.position;

      this.shadow.appendChild(style);
      this.shadow.appendChild(this.container);

      // Flow tenant-configurable tokens through to CSS custom properties.
      // :host is the shadow host element itself — setting CSS vars here
      // cascades to every selector inside the shadow root. Empty/missing
      // values fall back to the defaults declared in WIDGET_STYLES.
      this.applyThemeTokens();

      document.body.appendChild(this.host);
    }

    applyThemeTokens() {
      if (!this.host) return;
      const set = (name, value) => {
        if (value !== undefined && value !== null && value !== '') {
          this.host.style.setProperty(name, String(value));
        }
      };

      set('--cb-primary',   this.config.primaryColor);
      set('--cb-secondary', this.config.secondaryColor);
      set('--cb-radius',    this.config.borderRadius);

      // Tenants can opt out of the editorial type stack by passing their own
      // fontFamily — otherwise we keep Fraunces + Inter Tight (see :host).
      if (this.config.fontFamily) {
        this.host.style.setProperty('--cb-font', this.config.fontFamily);
        this.host.style.setProperty('--cb-sans', this.config.fontFamily);
      }

      // Legacy knobs: some tenants still pass these; map them onto the new
      // token names so their overrides don't silently drop on the floor.
      set('--cb-bg',   this.config.backgroundColor);
      set('--cb-text', this.config.textColor);
      set('--cb-paper-raised', this.config.backgroundColor);
      set('--cb-ink',          this.config.textColor);
    }
    
    render() {
      this.container.innerHTML = `
        <div class="cb-chat" role="dialog" aria-label="Chat window" aria-hidden="true">
          <div class="cb-progress" style="display: none;">
            <div class="cb-progress__bar" style="width: 0%"></div>
          </div>
          
          <div class="cb-upload-overlay">
            ${ICONS.upload}
            <span class="cb-upload-overlay__text">Drop files here to upload</span>
          </div>
          
          <header class="cb-header${this.canNewChat ? '' : ' cb-header--no-new'}">
            <div class="cb-header__avatar">
              ${botAvatarHtml(this.appearance.avatarUrl, { eager: true })}
            </div>
            <div class="cb-header__info">
              <h3 class="cb-header__title">${utils.escapeHtml(this.config.title)}</h3>
              <p class="cb-header__subtitle">${utils.escapeHtml(this.config.subtitle)}</p>
            </div>
            <div class="cb-header__status">
              <span class="cb-header__status-dot"></span>
              <span class="cb-header__status-text">Connecting...</span>
            </div>
            ${this.canNewChat ? `
            <button class="cb-header__new" type="button" aria-label="New conversation" title="New conversation">
              ${ICONS.newChat}
            </button>` : ''}
            <button class="cb-header__close" type="button" aria-label="Close chat" title="Close chat">
              ${ICONS.close}
            </button>
          </header>

          <div class="cb-conn-banner" role="status" aria-live="polite">
            <span class="cb-conn-banner__dot"></span>
            <span class="cb-conn-banner__text">Reconnecting…</span>
          </div>

          <div class="cb-messages" role="log" aria-live="polite" aria-label="Chat messages">
            ${this.messages.length === 0 ? `
              <div class="cb-loading">
                <div class="cb-loading__spinner"></div>
                <span>Starting chat…</span>
              </div>
            ` : this.messages.map(msg => this.renderMessage(msg)).join('')}
          </div>
          
          <div class="cb-typing" style="display: none;" aria-hidden="true">
            <div class="cb-typing__dot"></div>
            <div class="cb-typing__dot"></div>
            <div class="cb-typing__dot"></div>
          </div>
          
          <div class="cb-input-area">
            ${this.config.showPrivacyNotice ? `
              <p class="cb-input-area__privacy">
                ${utils.escapeHtml(this.config.privacyMessage)}
              </p>
            ` : ''}
            <div class="cb-input-wrapper">
              <textarea 
                class="cb-input" 
                placeholder="${utils.escapeAttr(this.config.placeholder)}"
                rows="1"
                aria-label="Type your message"
              ></textarea>
              <div class="cb-input-actions">
                ${this.config.enableFileUpload && this.serverFileUploadEnabled ? `
                  <button class="cb-btn cb-btn--attach" type="button" aria-label="Attach file" title="Attach file">
                    ${ICONS.attach}
                  </button>
                ` : ''}
                ${this.config.enableCamera ? `
                  <button class="cb-btn cb-btn--camera" type="button" aria-label="Take photo" title="Take photo">
                    ${ICONS.camera}
                  </button>
                ` : ''}
                <button class="cb-btn cb-btn--primary cb-btn--send" type="button" aria-label="Send message" title="Send message">
                  ${ICONS.send}
                </button>
              </div>
            </div>
            <a class="cb-attribution" href="https://axentrio.com" target="_blank" rel="noopener noreferrer">Powered by Axentrio</a>
          </div>
        </div>

        <button class="cb-launcher" type="button" aria-label="Open chat" aria-expanded="false">
          <span class="cb-launcher__icon cb-launcher__icon--open" aria-hidden="true">${ICONS.chat}</span>
          <span class="cb-launcher__icon cb-launcher__icon--close" aria-hidden="true">${ICONS.close}</span>
          <span class="cb-launcher__text"></span>
        </button>
      `;
      
      this.cacheElements();
    }
    
    cacheElements() {
      this.chatWindow = this.container.querySelector('.cb-chat');
      this.launcher = this.container.querySelector('.cb-launcher');
      if (this.launcher && this.appearance.launcherPosition === 'bottom-left') {
        this.launcher.classList.add('cb-launcher--bottom-left');
      }
      if (this.launcher && this.appearance.launcherLabel) {
        this.launcher.classList.add('cb-launcher--pill');
        const textEl = this.launcher.querySelector('.cb-launcher__text');
        if (textEl) {
          textEl.textContent = this.appearance.launcherLabel;
        }
      }
      this.headerCloseBtn = this.container.querySelector('.cb-header__close');
      this.headerNewBtn = this.container.querySelector('.cb-header__new');
      this.messagesContainer = this.container.querySelector('.cb-messages');
      this.input = this.container.querySelector('.cb-input');
      this.sendBtn = this.container.querySelector('.cb-btn--send');
      this.attachBtn = this.container.querySelector('.cb-btn--attach');
      this.cameraBtn = this.container.querySelector('.cb-btn--camera');
      this.typingIndicator = this.container.querySelector('.cb-typing');
      this.uploadOverlay = this.container.querySelector('.cb-upload-overlay');
      this.progressBar = this.container.querySelector('.cb-progress');
      this.progressBarInner = this.container.querySelector('.cb-progress__bar');
      this.statusDot = this.container.querySelector('.cb-header__status-dot');
      this.statusText = this.container.querySelector('.cb-header__status-text');
      this.connBanner = this.container.querySelector('.cb-conn-banner');
      this.connBannerText = this.container.querySelector('.cb-conn-banner__text');
      this.loadingEl = this.container.querySelector('.cb-loading');
    }
    
    renderMessage(message) {
      const isUser = message.sender === 'user';
      const time = this.config.showTimestamp ? utils.formatTime(message.timestamp) : '';
      
      let content = '';
      
      if (message.file) {
        if (message.file.type.startsWith('image/')) {
          content = `<img class="cb-message__image" src="${utils.escapeAttr(message.file.url)}" alt="${utils.escapeAttr(message.file.name)}" loading="lazy">`;
        } else {
          content = `
            <div class="cb-message__file">
              <div class="cb-message__file-icon">${ICONS.file}</div>
              <div class="cb-message__file-info">
                <div class="cb-message__file-name">${utils.escapeHtml(message.file.name)}</div>
                <div class="cb-message__file-size">${utils.formatFileSize(message.file.size)}</div>
              </div>
            </div>
          `;
        }
      } else {
        content = `<div class="cb-message__bubble">${utils.escapeHtml(message.text)}</div>`;
      }

      // Tappable quick-reply chips (e.g. appointment slots). Bot messages only.
      let chipsHtml = '';
      if (!isUser && Array.isArray(message.quickReplies) && message.quickReplies.length) {
        const chips = message.quickReplies
          .map((qr) => {
            const title = typeof qr === 'string' ? qr : qr.title || qr.value || '';
            const value = typeof qr === 'string' ? qr : qr.value || qr.title || '';
            if (!title) return '';
            return `<button type="button" class="cb-slot-chip" data-value="${utils.escapeAttr(value)}">${utils.escapeHtml(title)}</button>`;
          })
          .join('');
        if (chips) chipsHtml = `<div class="cb-message__chips">${chips}</div>`;
      }

      // An address picker the server asked for. Bot messages only, and never on a user echo.
      //
      // Rendered as a CONTROL rather than as chips on purpose. A chip sends its value back as an
      // ordinary customer message, so an address chosen that way would arrive as text the model
      // then reconstructs — which is the exact thing the address binding exists to prevent. This
      // posts to /places/select instead, and the server binds the identity Google returned.
      let pickerHtml = '';
      if (!isUser && message.affordance && message.affordance.kind === 'address_picker') {
        const prefill = utils.escapeAttr(message.affordance.query || '');
        const vague = message.affordance.reason === 'too_vague';
        pickerHtml = `
          <div class="cb-addr" data-addr-picker="1">
            <p class="cb-addr__label">${vague
              ? 'We could only find your town. Pick your exact address so we can confirm a time:'
              : 'Pick your address so we get the right door:'}</p>
            <input type="text" class="cb-addr__input" value="${prefill}"
              placeholder="Start typing your address" autocomplete="off" spellcheck="false" />
            <div class="cb-addr__list"></div>
          </div>`;
      }

      // The correction question (#95). TWO buttons, both labelled by the server from the two
      // stored addresses.
      //
      // The customer's answer used to be typed, which meant it reached the server through the
      // model - and a model can report agreement after silence or after a refusal. That is why
      // "yes, Kerkstraat 12 is correct" changed nothing and the booking went to the other address.
      // A tap posts the proposalId the SERVER issued, which is evidence the server observed.
      if (!isUser && message.affordance && message.affordance.kind === 'address_confirm') {
        const a = message.affordance;
        pickerHtml = `
          <div class="cb-addr" data-addr-confirm="${utils.escapeAttr(a.proposalId)}">
            <p class="cb-addr__label">Which address should we use?</p>
            <button type="button" class="cb-addr__row" data-confirm="1">Use ${utils.escapeHtml(a.proposed)}</button>
            <button type="button" class="cb-addr__row" data-confirm="0">Keep ${utils.escapeHtml(a.bound)}</button>
          </div>`;
      }

      return `
        <div class="cb-message cb-message--${message.sender}" data-id="${message.id}">
          <div class="cb-message__avatar">${isUser ? ICONS.user : botAvatarHtml(this.appearance.avatarUrl)}</div>
          <div class="cb-message__content">
            ${content}
            ${chipsHtml}
            ${pickerHtml}
            ${time ? `<span class="cb-message__time">${time}</span>` : ''}
          </div>
        </div>
      `;
    }
    
    // ==========================================================================
    // Address picker
    // ==========================================================================

    /**
     * Ask for suggestions. FAILS SILENT: an unavailable Google returns an empty list and a 200,
     * and anything worse should look the same to the customer — they can always type their
     * address as they always have. An error banner here would turn a degraded feature into a
     * broken-looking one.
     */
    async lookupAddress(picker, query) {
      if (!picker || !this.token) return;
      try {
        const res = await fetchWithTimeout(`${this.config.apiUrl}/api/v1/widget/places/autocomplete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
          body: JSON.stringify({ query }),
        }, 8000);
        if (!res.ok) return this.renderAddressSuggestions(picker, []);
        const body = await res.json();
        const suggestions = (body && body.data && body.data.suggestions) || [];
        this.renderAddressSuggestions(picker, suggestions);
      } catch (err) {
        this.renderAddressSuggestions(picker, []);
      }
    }

    renderAddressSuggestions(picker, suggestions) {
      const list = picker && picker.querySelector('.cb-addr__list');
      if (!list) return;
      list.innerHTML = (suggestions || [])
        .slice(0, 5)
        .map((s) => {
          // Raw, because it is only a presence check - the escaping happens at each use site, and
          // the two contexts need different escapers: the id lands in an attribute, the text in
          // element content.
          const id = s.placeId || '';
          // `text` is what the endpoint returns - see AddressSuggestion. This read
          // `description || formattedAddress`, neither of which exists on the payload, so every
          // row evaluated to '' and was dropped by the guard below: the picker fired the request,
          // received five suggestions, and rendered nothing. Invisible to REST tests, which never
          // reach this function, and to the jsdom tests, which covered the controls either side of
          // it. Found only by driving the real widget in a browser.
          const text = utils.escapeHtml(s.text || s.description || s.formattedAddress || '');
          if (!id || !text) return '';
          return `<button type="button" class="cb-addr__row" data-place-id="${utils.escapeAttr(id)}">${text}</button>`;
        })
        .join('');
    }

    /**
     * The customer picked one.
     *
     * The server resolves the id, binds it to the session, and speaks the address into the
     * conversation itself — so this does NOT send a message. Doing both would put the address in
     * twice, and the second copy would arrive as text the model reconstructs.
     *
     * The control is replaced by the chosen address rather than removed, so the customer can see
     * what they picked. A 503 means Google could not resolve it right now, which is never
     * something the customer did wrong: say so and leave the box open so they can type instead.
     */
    async selectAddress(picker, placeId, label) {
      if (!picker || !placeId || !this.token) return;
      const list = picker.querySelector('.cb-addr__list');
      if (list) list.innerHTML = '';
      try {
        const res = await fetchWithTimeout(`${this.config.apiUrl}/api/v1/widget/places/select`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
          body: JSON.stringify({ placeId }),
        }, 10000);
        if (!res.ok) {
          const note = picker.querySelector('.cb-addr__label');
          if (note) note.textContent = 'That address could not be confirmed right now — please type it instead.';
          return;
        }
        picker.innerHTML = `<p class="cb-addr__chosen">${utils.escapeHtml(label || '')}</p>`;
      } catch (err) {
        const note = picker.querySelector('.cb-addr__label');
        if (note) note.textContent = 'That address could not be confirmed right now — please type it instead.';
      }
    }

    /**
     * The customer answered "which address is right?" (#95).
     *
     * Sends the proposalId the server issued and a boolean, and NOTHING ELSE - deliberately no
     * address. The server already knows what it asked, and a client naming a place here would be
     * an unverified claim wearing the customer's authority, which is the whole thing the binding
     * refuses.
     *
     * `applied: false` is not an error and is not the customer's fault: the question may have been
     * superseded or expired while the buttons sat on their screen. The response carries whatever
     * IS outstanding, so the stale control is replaced by the live one rather than by nothing -
     * and never re-rendered as it was, which would invite a second tap on a dead question.
     */
    async answerAddressQuestion(box, proposalId, confirmed) {
      if (!box || !proposalId || !this.token) return;
      try {
        const res = await fetchWithTimeout(`${this.config.apiUrl}/api/v1/widget/address/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
          body: JSON.stringify({ proposalId, confirmed }),
        }, 10000);
        if (!res.ok) return;
        const body = await res.json();
        const data = (body && body.data) || {};

        if (data.applied) {
          // The server speaks the resulting address into the conversation itself, so this says
          // only what was settled and sends no message of its own.
          box.innerHTML = `<p class="cb-addr__chosen">${utils.escapeHtml(data.address || 'Address confirmed')}</p>`;
          return;
        }

        const current = data.current || {};
        if (!current.proposalId) {
          box.innerHTML = '<p class="cb-addr__chosen">That question expired or was already settled. Please send the address you want us to use.</p>';
          return;
        }
        box.setAttribute('data-addr-confirm', current.proposalId);
        box.innerHTML =
          '<p class="cb-addr__label">Which address should we use?</p>' +
          `<button type="button" class="cb-addr__row" data-confirm="1">Use ${utils.escapeHtml(current.proposed || '')}</button>` +
          `<button type="button" class="cb-addr__row" data-confirm="0">Keep ${utils.escapeHtml(current.bound || '')}</button>`;
      } catch (err) {
        this.log('Address answer failed:', err && err.message);
      }
    }

    attachEventListeners() {
      // Launcher click
      this.launcher.addEventListener('click', () => this.toggle());

      // Header close button — primary dismiss affordance inside the chat
      // window. The launcher also closes (it becomes an X when open) but on
      // mobile the launcher is hidden while the chat is open, so this button
      // is the only reliable way to dismiss on narrow viewports.
      if (this.headerCloseBtn) {
        this.headerCloseBtn.addEventListener('click', () => this.close());
      }

      // Header "new conversation" button — start a fresh session so the CURRENT
      // bot config takes effect (a restored session keeps replaying old turns).
      if (this.headerNewBtn) {
        this.headerNewBtn.addEventListener('click', () => this.startNewConversation());
      }

      // Quick-reply / slot chips — delegated so it covers chips added later.
      if (this.messagesContainer) {
        this.messagesContainer.addEventListener('click', (e) => {
          const chip = e.target.closest && e.target.closest('.cb-slot-chip');
          if (!chip) return;
          const value = chip.getAttribute('data-value');
          if (!value) return;
          // Consume the offer: remove the whole chip row so it can't be re-tapped.
          const row = chip.closest('.cb-message__chips');
          if (row) row.remove();
          this.sendMessage(value);
        });

        // ── Address picker ───────────────────────────────────────────────
        // Delegated like the chips above, so a picker rendered by a later reply works without
        // rebinding. Both handlers are scoped to their own picker element: two of them can be on
        // screen at once (one per reply that asked), and typing in one must not fill the other.

        // Typing → suggestions. DEBOUNCED and length-gated because each call is billed and the
        // endpoint is rate-limited; the server also refuses under 3 characters, so firing sooner
        // spends a request to be told nothing.
        this.messagesContainer.addEventListener('input', (e) => {
          const input = e.target.closest && e.target.closest('.cb-addr__input');
          if (!input) return;
          const picker = input.closest('.cb-addr');
          clearTimeout(this._addrDebounce);
          const query = input.value.trim();
          if (query.length < 3) {
            this.renderAddressSuggestions(picker, []);
            return;
          }
          this._addrDebounce = setTimeout(() => this.lookupAddress(picker, query), 400);
        });

        // Picking one, or answering the correction question. Both are the same gesture from the
        // customer's side and the same kind of evidence from the server's: an event it observed.
        this.messagesContainer.addEventListener('click', (e) => {
          const row = e.target.closest && e.target.closest('.cb-addr__row');
          if (!row) return;
          const box = row.closest('.cb-addr');
          const proposalId = box && box.getAttribute('data-addr-confirm');
          if (proposalId) {
            this.answerAddressQuestion(box, proposalId, row.getAttribute('data-confirm') === '1');
            return;
          }
          this.selectAddress(box, row.getAttribute('data-place-id'), row.textContent);
        });
      }

      // Send message
      this.sendBtn.addEventListener('click', () => this.sendMessage());
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });
      
      // Auto-resize textarea
      this.input.addEventListener('input', () => {
        this.input.style.height = 'auto';
        this.input.style.height = Math.min(this.input.scrollHeight, 120) + 'px';
      });
      
      // File upload
      if (this.attachBtn) {
        this.attachBtn.addEventListener('click', () => this.openFilePicker());
      }
      
      // Camera
      if (this.cameraBtn) {
        this.cameraBtn.addEventListener('click', () => this.openCamera());
      }
      
      // Drag and drop
      this.chatWindow.addEventListener('dragover', (e) => this.handleDragOver(e));
      this.chatWindow.addEventListener('dragleave', (e) => this.handleDragLeave(e));
      this.chatWindow.addEventListener('drop', (e) => this.handleDrop(e));
      
      // ESC to close dialog + focus trap (Tab/Shift+Tab stays inside widget)
      this._onKeyDown = (e) => {
        if (!this.isOpen) return;

        if (e.key === 'Escape') {
          if (e.isComposing) return; // let IME dismiss first
          e.preventDefault();
          this.close();
          this.launcher.focus();
          return;
        }

        if (e.key === 'Tab') {
          const focusable = this.chatWindow.querySelectorAll(
            'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
          );
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];

          if (e.shiftKey && this.shadow.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && this.shadow.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      };
      this.shadow.addEventListener('keydown', this._onKeyDown);

      // Window resize — stored as a named ref so destroy() can remove it
      this._onWindowResize = utils.debounce(() => {
        if (utils.isMobile() && this.isOpen && this.config.fullScreenOnMobile) {
          this.chatWindow.style.height = '100%';
        }
      }, 100);
      window.addEventListener('resize', this._onWindowResize);

      // Before unload — stored as a named ref so destroy() can remove it
      this._onBeforeUnload = () => {
        this.saveSession();
        this.disconnectWebSocket();
      };
      window.addEventListener('beforeunload', this._onBeforeUnload);
    }
    
    // ========================================================================
    // Public Methods
    // ========================================================================
    
    open() {
      if (this.isOpen) return;
      
      this.isOpen = true;
      this.chatWindow.classList.add('cb-chat--open');
      this.chatWindow.setAttribute('aria-hidden', 'false');
      this.launcher.classList.add('cb-launcher--open');
      this.launcher.setAttribute('aria-expanded', 'true');
      this.launcher.setAttribute('aria-label', 'Close chat');
      
      this.scrollToBottom();
      this.input.focus();
      
      this.emit('open');
    }
    
    close() {
      if (!this.isOpen) return;
      
      this.isOpen = false;
      this.chatWindow.classList.remove('cb-chat--open');
      this.chatWindow.setAttribute('aria-hidden', 'true');
      this.launcher.classList.remove('cb-launcher--open');
      this.launcher.setAttribute('aria-expanded', 'false');
      this.launcher.setAttribute('aria-label', 'Open chat');
      
      this.saveSession();
      
      this.emit('close');
    }
    
    toggle() {
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    }
    
    sendMessage(text = null) {
      const rawText = typeof text === 'string' ? text : this.input.value;
      const messageText = rawText.trim();
      if (!messageText) return;

      const message = {
        id: utils.generateId(),
        text: messageText,
        sender: 'user',
        timestamp: new Date(),
      };

      this.addMessage(message);
      this.input.value = '';
      this.input.style.height = 'auto';

      if (this.emitOutboundMessage(message)) {
        this.showTypingIndicator();
      } else {
        this.pendingMessages.push(message);
        this.setConnectionState('connecting');
        this.log('Queued message until chat connection is ready');
      }

      this.emit('message', message);
    }
    
    addMessage(message) {
      this.messages.push(message);

      // Clear loading spinner or empty state on first message
      if (this.loadingEl) { this.loadingEl.remove(); this.loadingEl = null; }
      const emptyEl = this.messagesContainer?.querySelector('.cb-empty');
      if (emptyEl) emptyEl.remove();

      const messageEl = document.createElement('div');
      messageEl.innerHTML = this.renderMessage(message);
      this.messagesContainer.appendChild(messageEl.firstElementChild);

      this.scrollToBottom();
      this.saveSession();

      // Also track agent activity from incoming messages
      if (message.sender !== 'user' && this._agent) {
        this._agent.lastActive = Date.now();
        this.updateAgentPresence();
      }
    }

    addSystemMessage(text) {
      const el = document.createElement('div');
      const isJoined = text.includes('joined');
      el.innerHTML = `<div class="cb-system-msg">
        <span class="cb-system-msg__dot cb-system-msg__dot--${isJoined ? 'joined' : 'left'}"></span>
        ${utils.escapeHtml(text)}
      </div>`;
      this.messagesContainer.appendChild(el.firstElementChild);
      this.scrollToBottom();
    }

    updateAgentPresence() {
      if (!this.statusText) return;
      if (!this._agent) {
        this.statusText.textContent = this._connected ? 'Online' : 'Connecting...';
        return;
      }
      const elapsed = Date.now() - this._agent.lastActive;
      if (elapsed < 60_000) {
        this.statusText.textContent = `Chatting with ${this._agent.name}`;
      } else {
        const mins = Math.floor(elapsed / 60_000);
        this.statusText.textContent = `${this._agent.name} · ${mins}m ago`;
      }
    }

    startAgentActivityTimer() {
      this.stopAgentActivityTimer();
      this._agentActivityTimer = setInterval(() => this.updateAgentPresence(), 30_000);
    }

    stopAgentActivityTimer() {
      if (this._agentActivityTimer) {
        clearInterval(this._agentActivityTimer);
        this._agentActivityTimer = null;
      }
    }

    showTypingIndicator() {
      this.typingIndicator.style.display = 'flex';
      this.scrollToBottom();
    }
    
    hideTypingIndicator() {
      this.typingIndicator.style.display = 'none';
    }
    
    // ========================================================================
    // File Upload
    // ========================================================================
    
    openFilePicker() {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = this.config.allowedFileTypes.join(',');
      input.addEventListener('change', (e) => {
        this.handleFiles(e.target.files);
      });
      input.click();
    }
    
    openCamera() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.addEventListener('change', (e) => {
        this.handleFiles(e.target.files);
      });
      input.click();
    }
    
    handleDragOver(e) {
      e.preventDefault();
      e.stopPropagation();
      this.uploadOverlay.classList.add('cb-upload-overlay--active');
    }
    
    handleDragLeave(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.relatedTarget && !this.chatWindow.contains(e.relatedTarget)) {
        this.uploadOverlay.classList.remove('cb-upload-overlay--active');
      }
    }
    
    handleDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      this.uploadOverlay.classList.remove('cb-upload-overlay--active');
      
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        this.handleFiles(files);
      }
    }
    
    handleFiles(files) {
      Array.from(files).forEach(file => {
        if (file.size > this.config.maxFileSize) {
          this.showError(`File "${file.name}" is too large. Maximum size is ${utils.formatFileSize(this.config.maxFileSize)}.`);
          return;
        }
        
        this.uploadFile(file);
      });
    }
    
    async uploadFile(file) {
      // The server derives tenant AND chat session from the widget token, so the token is
      // the real precondition — it used to send tenantId/chatSessionId as body fields, which
      // is exactly the client-supplied binding the endpoint refuses.
      if (!this.sessionId || !this.token) {
        this.showError('Chat is still connecting. Please wait a moment and try again.');
        return;
      }

      this.showProgress(0);

      try {
        // Widget-scoped upload. The old call went to /api/v1/uploads/presigned-url, which is
        // not mounted — every upload 404'd. The real endpoint has existed since the booking
        // file-upload work; the widget was simply never rewired to it.
        const response = await fetchWithTimeout(`${this.config.apiUrl}/api/v1/widget/files/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.token,
          },
          body: JSON.stringify({
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type,
          }),
        }, 15000);

        if (response.status === 402) {
          this.hideProgress();
          this.showError('File uploads are not available on this plan.');
          return;
        }
        if (!response.ok) throw new Error('Failed to get upload URL (' + response.status + ')');

        const { data } = await response.json();
        const upload = data && data.upload;
        if (!upload || !upload.uploadUrl || !upload.sessionId) throw new Error('Malformed upload response');

        await this.uploadToS3(file, upload.uploadUrl, (progress) => {
          this.showProgress(progress);
        });

        // WITHOUT THIS the row stays status='pending' forever and every consumer — including
        // the booking flow, which only reads ready sessions — never sees the file. This call
        // is the difference between "404s" and "appears to work but silently loses the file".
        const done = await fetchWithTimeout(
          `${this.config.apiUrl}/api/v1/widget/files/${encodeURIComponent(upload.sessionId)}/upload-complete`,
          { method: 'POST', headers: { 'Authorization': 'Bearer ' + this.token } },
          20000
        );
        if (!done.ok) throw new Error('Upload could not be finalised (' + done.status + ')');
        const completed = (await done.json()).data || {};

        if (completed.status !== 'ready') {
          // Quarantined or still processing. Never surface scan details to the visitor.
          this.hideProgress();
          this.showError("That file couldn't be accepted. Please try a different one.");
          return;
        }

        this.addMessage({
          id: utils.generateId(),
          text: '',
          sender: 'user',
          timestamp: new Date(),
          // No url: the endpoint deliberately returns no public link, and an uploaded file
          // must not be linkable before it has cleared scanning.
          file: { name: file.name, size: file.size, type: file.type },
        });

        this.hideProgress();

      } catch (error) {
        this.hideProgress();
        this.showError('Failed to upload file. Please try again.');
        this.log('Upload error:', error);
      }
    }
    
    uploadToS3(file, url, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const progress = Math.round((e.loaded / e.total) * 100);
            onProgress(progress);
          }
        });
        
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        });
        
        xhr.addEventListener('error', () => reject(new Error('Upload failed')));
        xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
        
        xhr.open('PUT', url);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.send(file);
      });
    }
    
    showProgress(percent) {
      this.progressBar.style.display = 'block';
      this.progressBarInner.style.width = percent + '%';
    }
    
    hideProgress() {
      this.progressBar.style.display = 'none';
      this.progressBarInner.style.width = '0%';
    }
    
    // ========================================================================
    // Connection Management
    // ========================================================================

    disconnectWebSocket() {
      if (this.socket) {
        this.socket.disconnect();
        this.socket = null;
      }
      this._connected = false;
    }
    
    // ========================================================================
    // Utility Methods
    // ========================================================================
    
    scrollToBottom() {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }
    
    showError(message) {
      // Simple error display - could be enhanced
      console.error('[ChatbotWidget]', message);
      
      // Add error message to chat
      this.addMessage({
        id: utils.generateId(),
        text: `Error: ${message}`,
        sender: 'bot',
        timestamp: new Date(),
      });
    }
    
    log(...args) {
      if (this.config.debug) {
        console.log('[ChatbotWidget]', ...args);
      }
    }
    
    // ========================================================================
    // Event Emitter
    // ========================================================================
    
    emit(event, data) {
      const eventName = 'chatbot:' + event;
      document.dispatchEvent(new CustomEvent(eventName, { detail: data }));
    }
    
    on(event, callback) {
      const eventName = 'chatbot:' + event;
      document.addEventListener(eventName, (e) => callback(e.detail));
    }
    
    // ========================================================================
    // Destroy
    // ========================================================================
    
    destroy() {
      // Idempotent — double-destroy must be a no-op
      if (this._destroyed) return;
      this._destroyed = true;

      // 1. Timers
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      if (this.typingTimeout) {
        clearTimeout(this.typingTimeout);
        this.typingTimeout = null;
      }

      // 2. Agent presence timer
      this.stopAgentActivityTimer();

      // 3. Connection
      this.disconnectWebSocket();

      // 3. Window listeners — the whole point of the unmount pass.
      //    These were added via addEventListener in attachEventListeners;
      //    removing them here prevents leaks on SPAs that mount/unmount the widget.
      if (this._onWindowResize) {
        window.removeEventListener('resize', this._onWindowResize);
        this._onWindowResize = null;
      }
      if (this._onBeforeUnload) {
        window.removeEventListener('beforeunload', this._onBeforeUnload);
        this._onBeforeUnload = null;
      }
      if (this._onKeyDown && this.shadow) {
        this.shadow.removeEventListener('keydown', this._onKeyDown);
        this._onKeyDown = null;
      }

      // 4. Persist any in-flight session state + notify subscribers before DOM removal
      try { this.saveSession(); } catch (_) { /* ignore */ }
      this.emit('destroy');

      // 5. DOM teardown
      if (this.host && this.host.parentNode) {
        this.host.parentNode.removeChild(this.host);
      }

      // 6. Clear in-memory queues so stale references can be GC'd
      this.pendingMessages = [];
      this.messages = [];
    }
  }

  // ==========================================================================
  // Auto-initialization from data attributes
  // ==========================================================================
  function autoInit() {
    const script = _cbCurrentScript || document.querySelector('script[src*="widget.js"][data-api-key]');
    
    if (script) {
      const config = {};
      
      // Auto-detect API URL from script src (e.g. https://api.example.com/widget.js → https://api.example.com)
      if (script.src) {
        try {
          const scriptUrl = new URL(script.src);
          config.apiUrl = scriptUrl.origin;
          const wsProtocol = scriptUrl.protocol === 'https:' ? 'wss:' : 'ws:';
          config.wsUrl = `${wsProtocol}//${scriptUrl.host}`;
        } catch (e) { /* ignore */ }
      }

      // Parse data attributes (overrides auto-detected values)
      Object.keys(DEFAULT_CONFIG).forEach(key => {
        const dataAttr = script.getAttribute('data-' + key.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
        if (dataAttr !== null) {
          // Try to parse as JSON, fallback to string
          try {
            config[key] = JSON.parse(dataAttr);
          } catch {
            config[key] = dataAttr;
          }
        }
      });

      // postmessageOrigins is authored as a comma-separated list in the data
      // attribute (data-postmessage-origins="https://a.com,https://b.com"),
      // which isn't valid JSON. Normalise whatever the generic parser left
      // behind into a real array of trimmed non-empty origin strings.
      if (typeof config.postmessageOrigins === 'string') {
        config.postmessageOrigins = config.postmessageOrigins
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
      } else if (!Array.isArray(config.postmessageOrigins)) {
        config.postmessageOrigins = [];
      }

      // Initialize widget
      const widget = new ChatbotWidget(config);
      widgetInstance = widget;
      flushPendingApiCalls();
      dispatchGlobalEvent('chatbot:ready', {
        api: chatbotWidgetApi,
        widget,
      });

      // Install the cross-window postMessage bridge and announce readiness
      // to any parent frame that might be waiting to enable its CTA button.
      installPostMessageBridge();
      broadcastReadyToParent();

      // Expose to global for debugging
      if (config.debug) {
        window.chatbotWidget = widget;
      }
    }
  }

  // Auto-initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  // Expose ChatbotWidget class
  return ChatbotWidget;
});
