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
    apiUrl: 'http://localhost:4081',
    wsUrl: 'ws://localhost:4081/ws',
    tenantId: null,
    botId: 'default',
    apiKey: null,
    
    // Widget Appearance
    position: 'right',
    primaryColor: '#4F46E5',
    secondaryColor: '#10B981',
    backgroundColor: '#FFFFFF',
    textColor: '#1F2937',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    borderRadius: '12px',
    theme: 'light',
    
    // Widget Behavior
    title: 'Chat Support',
    subtitle: 'We typically reply within minutes',
    placeholder: 'Type your message...',
    greetingMessage: 'Hello! How can I help you today?',
    showTimestamp: true,
    showAvatar: true,
    enableTypingIndicator: true,
    enableFileUpload: true,
    enableVoiceInput: false,
    enableCamera: true,
    maxFileSize: 25 * 1024 * 1024, // 25MB
    allowedFileTypes: ['image/*', 'video/*', 'application/pdf', '.doc', '.docx'],
    
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

    isReady() {
      return !!widgetInstance;
    },

    getInstance() {
      return widgetInstance;
    },

    // Tear down the widget: disconnects, removes window listeners, detaches
    // the host DOM, and resets the module-level instance reference so
    // isReady() returns false and any later enqueued API calls queue up for
    // a future widget instance instead of firing on the dead one.
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
    'open', 'close', 'toggle', 'sendMessage', 'destroy', 'ping',
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
    :host {
      --cb-primary: #4F46E5;
      --cb-primary-hover: #4338CA;
      --cb-secondary: #10B981;
      --cb-bg: #FFFFFF;
      --cb-text: #1F2937;
      --cb-text-secondary: #6B7280;
      --cb-border: #E5E7EB;
      --cb-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
      --cb-radius: 12px;
      --cb-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      
      all: initial;
      font-family: var(--cb-font);
      box-sizing: border-box;
    }
    
    *, *::before, *::after {
      box-sizing: border-box;
    }
    
    /* Widget Container */
    .cb-widget {
      position: fixed;
      z-index: 999999;
      font-family: var(--cb-font);
    }
    
    .cb-widget--right {
      right: 20px;
      bottom: 20px;
    }
    
    .cb-widget--left {
      left: 20px;
      bottom: 20px;
    }
    
    /* Launcher Button */
    .cb-launcher {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--cb-primary), var(--cb-primary-hover));
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: var(--cb-shadow);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      position: relative;
    }
    
    .cb-launcher:hover {
      transform: scale(1.05);
      box-shadow: 0 20px 40px -10px rgba(79, 70, 229, 0.4);
    }
    
    .cb-launcher:active {
      transform: scale(0.95);
    }
    
    .cb-launcher__icon {
      width: 28px;
      height: 28px;
      color: white;
      transition: transform 0.3s ease;
    }
    
    .cb-launcher--open .cb-launcher__icon--open {
      display: none;
    }
    
    .cb-launcher__icon--close {
      display: none;
    }
    
    .cb-launcher--open .cb-launcher__icon--close {
      display: block;
    }
    
    /* Notification Badge */
    .cb-launcher__badge {
      position: absolute;
      top: -2px;
      right: -2px;
      width: 20px;
      height: 20px;
      background: #EF4444;
      color: white;
      border-radius: 50%;
      font-size: 11px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid white;
    }
    
    /* Chat Window */
    .cb-chat {
      position: absolute;
      bottom: 80px;
      width: 380px;
      height: 600px;
      max-height: calc(100vh - 120px);
      background: var(--cb-bg);
      border-radius: var(--cb-radius);
      box-shadow: var(--cb-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      opacity: 0;
      visibility: hidden;
      transform: translateY(20px) scale(0.95);
      transition: opacity 0.3s ease, transform 0.3s ease, visibility 0.3s ease;
    }
    
    .cb-widget--right .cb-chat {
      right: 0;
    }
    
    .cb-widget--left .cb-chat {
      left: 0;
    }
    
    .cb-chat--open {
      opacity: 1;
      visibility: visible;
      transform: translateY(0) scale(1);
    }
    
    /* Header */
    .cb-header {
      background: linear-gradient(135deg, var(--cb-primary), var(--cb-primary-hover));
      color: white;
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    
    .cb-header__avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    
    .cb-header__avatar svg {
      width: 24px;
      height: 24px;
      color: white;
    }
    
    .cb-header__info {
      flex: 1;
      min-width: 0;
    }
    
    .cb-header__title {
      font-size: 16px;
      font-weight: 600;
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .cb-header__subtitle {
      font-size: 12px;
      opacity: 0.8;
      margin: 2px 0 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .cb-header__status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    
    .cb-header__status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .cb-header__status-dot--connecting {
      background: #F59E0B;
      animation: pulse 2s infinite;
    }

    .cb-header__status-dot--connected {
      background: var(--cb-secondary);
      animation: pulse 2s infinite;
    }

    .cb-header__status-dot--offline {
      background: #EF4444;
      animation: none;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    /* Messages Area */
    .cb-messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      scroll-behavior: smooth;
    }
    
    .cb-messages::-webkit-scrollbar {
      width: 6px;
    }
    
    .cb-messages::-webkit-scrollbar-track {
      background: transparent;
    }
    
    .cb-messages::-webkit-scrollbar-thumb {
      background: var(--cb-border);
      border-radius: 3px;
    }
    
    /* Message */
    .cb-message {
      display: flex;
      gap: 10px;
      max-width: 85%;
      animation: messageIn 0.3s ease;
    }
    
    @keyframes messageIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    .cb-message--user {
      align-self: flex-end;
      flex-direction: row-reverse;
    }
    
    .cb-message--bot {
      align-self: flex-start;
    }
    
    .cb-message__avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--cb-border);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 14px;
    }
    
    .cb-message--user .cb-message__avatar {
      background: var(--cb-primary);
      color: white;
    }
    
    .cb-message__content {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    
    .cb-message__bubble {
      padding: 12px 16px;
      border-radius: 18px;
      font-size: 14px;
      line-height: 1.5;
      word-wrap: break-word;
      white-space: pre-wrap;
      max-width: 100%;
    }
    
    .cb-message--user .cb-message__bubble {
      background: var(--cb-primary);
      color: white;
      border-bottom-right-radius: 4px;
    }
    
    .cb-message--bot .cb-message__bubble {
      background: #F3F4F6;
      color: var(--cb-text);
      border-bottom-left-radius: 4px;
    }
    
    .cb-message__time {
      font-size: 11px;
      color: var(--cb-text-secondary);
      align-self: flex-end;
    }
    
    .cb-message--user .cb-message__time {
      align-self: flex-start;
    }
    
    /* File Message */
    .cb-message__file {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: rgba(0, 0, 0, 0.05);
      border-radius: 12px;
    }
    
    .cb-message__file-icon {
      width: 40px;
      height: 40px;
      background: var(--cb-primary);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      flex-shrink: 0;
    }
    
    .cb-message__file-info {
      flex: 1;
      min-width: 0;
    }
    
    .cb-message__file-name {
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .cb-message__file-size {
      font-size: 11px;
      color: var(--cb-text-secondary);
    }
    
    /* Image Message */
    .cb-message__image {
      max-width: 100%;
      border-radius: 12px;
      cursor: pointer;
      transition: transform 0.2s ease;
    }
    
    .cb-message__image:hover {
      transform: scale(1.02);
    }
    
    /* Typing Indicator */
    .cb-typing {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 16px;
    }
    
    .cb-typing__dot {
      width: 8px;
      height: 8px;
      background: var(--cb-text-secondary);
      border-radius: 50%;
      animation: typingBounce 1.4s infinite ease-in-out both;
    }
    
    .cb-typing__dot:nth-child(1) { animation-delay: -0.32s; }
    .cb-typing__dot:nth-child(2) { animation-delay: -0.16s; }
    
    @keyframes typingBounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }

    /* Quick Replies */
    .cb-quick-replies {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px 16px 12px 48px;
    }

    .cb-quick-reply {
      background: var(--cb-bg);
      border: 1.5px solid var(--cb-primary);
      color: var(--cb-primary);
      border-radius: 18px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      line-height: 1.3;
    }

    .cb-quick-reply:hover {
      background: var(--cb-primary);
      color: white;
    }

    .cb-quick-reply:active {
      transform: scale(0.96);
    }

    /* Input Area */
    .cb-input-area {
      padding: 16px 20px;
      border-top: 1px solid var(--cb-border);
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex-shrink: 0;
      background: var(--cb-bg);
    }
    
    .cb-input-area__privacy {
      font-size: 11px;
      color: var(--cb-text-secondary);
      text-align: center;
    }
    
    .cb-input-area__privacy a {
      color: var(--cb-primary);
      text-decoration: none;
    }
    
    .cb-input-area__privacy a:hover {
      text-decoration: underline;
    }
    
    .cb-input-wrapper {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      background: #F3F4F6;
      border-radius: 24px;
      padding: 8px 8px 8px 16px;
    }
    
    .cb-input {
      flex: 1;
      border: none;
      background: transparent;
      font-size: 14px;
      line-height: 1.5;
      color: var(--cb-text);
      resize: none;
      max-height: 120px;
      min-height: 24px;
      font-family: inherit;
      outline: none;
    }
    
    .cb-input::placeholder {
      color: var(--cb-text-secondary);
    }
    
    .cb-input-actions {
      display: flex;
      gap: 4px;
    }
    
    .cb-btn {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: transparent;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--cb-text-secondary);
      transition: all 0.2s ease;
    }
    
    .cb-btn:hover {
      background: rgba(0, 0, 0, 0.05);
      color: var(--cb-text);
    }
    
    .cb-btn--primary {
      background: var(--cb-primary);
      color: white;
    }
    
    .cb-btn--primary:hover {
      background: var(--cb-primary-hover);
      color: white;
    }
    
    .cb-btn svg {
      width: 20px;
      height: 20px;
    }
    
    /* File Upload Overlay */
    .cb-upload-overlay {
      position: absolute;
      inset: 0;
      background: rgba(79, 70, 229, 0.9);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      color: white;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.2s ease, visibility 0.2s ease;
      z-index: 10;
      border-radius: var(--cb-radius);
    }
    
    .cb-upload-overlay--active {
      opacity: 1;
      visibility: visible;
    }
    
    .cb-upload-overlay__icon {
      width: 64px;
      height: 64px;
    }
    
    .cb-upload-overlay__text {
      font-size: 18px;
      font-weight: 500;
    }
    
    /* Progress Bar */
    .cb-progress {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--cb-border);
      overflow: hidden;
    }
    
    .cb-progress__bar {
      height: 100%;
      background: var(--cb-primary);
      transition: width 0.3s ease;
    }
    
    /* Mobile Styles */
    @media (max-width: 768px) {
      .cb-widget {
        right: 16px !important;
        left: 16px !important;
        bottom: 16px;
      }
      
      .cb-widget--left {
        right: 16px !important;
      }
      
      .cb-chat {
        position: fixed;
        inset: 0;
        width: 100%;
        height: 100%;
        max-height: none;
        border-radius: 0;
        bottom: 0;
      }
      
      .cb-chat--open + .cb-launcher {
        display: none;
      }
      
      .cb-header {
        padding: 12px 16px;
      }
      
      .cb-messages {
        padding: 16px;
      }
      
      .cb-input-area {
        padding: 12px 16px;
        padding-bottom: max(12px, env(safe-area-inset-bottom));
      }
    }
    
    /* Dark Theme */
    :host([data-theme="dark"]) {
      --cb-bg: #1F2937;
      --cb-text: #F9FAFB;
      --cb-text-secondary: #9CA3AF;
      --cb-border: #374151;
    }
    
    :host([data-theme="dark"]) .cb-message--bot .cb-message__bubble {
      background: #374151;
      color: var(--cb-text);
    }
    
    :host([data-theme="dark"]) .cb-input-wrapper {
      background: #374151;
    }
    
    :host([data-theme="dark"]) .cb-message__file {
      background: rgba(255, 255, 255, 0.05);
    }
    
    /* Reduced Motion */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
    
    /* Print Styles */
    @media print {
      .cb-widget {
        display: none !important;
      }
    }
  `;

  // ==========================================================================
  // SVG Icons
  // ==========================================================================
  const ICONS = {
    chat: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>',
    close: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>',
    send: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>',
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

    hashString: (value = '') => {
      let hash = 0;

      for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) - hash) + value.charCodeAt(i);
        hash |= 0;
      }

      return (hash >>> 0).toString(36);
    },
    
    formatTime: (date) => {
      if (!(date instanceof Date) || isNaN(date.getTime())) return '';
      return new Intl.DateTimeFormat('default', {
        hour: 'numeric',
        minute: 'numeric',
      }).format(date);
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
  // ChatbotWidget Class
  // ==========================================================================
  class ChatbotWidget {
    constructor(config = {}) {
      this.config = { ...DEFAULT_CONFIG, ...config };
      this.isOpen = false;
      this.messages = [];
      this.ws = null;
      this.reconnectAttempts = 0;
      this.heartbeatInterval = null;
      this.typingTimeout = null;
      this.uploadQueue = [];
      this.sessionId = null;
      this.pendingMessages = [];
      this.storageKey = this.getStorageKey();

      // Constructor can't await — kick off async init chain
      this.initSession().then(() => {
        this.createShadowDOM();
        this.render();
        this.attachEventListeners();
        this.setConnectionState('connecting');
        this.connectWebSocket();
        this._initDone();
      }).catch(err => {
        console.error('[ChatbotWidget] Init failed:', err);
        // Fallback: render anyway with generated session
        this.createShadowDOM();
        this.render();
        this.attachEventListeners();
        this.setConnectionState('offline');
        this._initDone();
      });
    }

    getStorageKey() {
      const identity = [
        this.config.apiUrl || 'default-api',
        this.config.apiKey || 'public',
        this.config.botId || 'default',
      ].join('|');

      return STORAGE_KEY_PREFIX + utils.hashString(identity);
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
    }

    canSendMessages() {
      return Boolean(this.sessionId && this.ws && this.ws.connected);
    }

    emitOutboundMessage(message) {
      if (!this.canSendMessages()) return false;

      this.ws.emit('message:send', {
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

    _initDone() {

      if (this.config.greetingMessage && this.messages.length === 0) {
        this.addMessage({
          id: utils.generateId(),
          text: this.config.greetingMessage,
          sender: 'bot',
          timestamp: new Date(),
        });
      }

      this.log('Widget initialized');
    }

    init() {
      // Legacy — initialization now happens in constructor via promise chain
    }

    async initSession() {
      // Try to restore existing session
      const storedSession = this.readStoredSession();
      if (storedSession) {
        const { key, session } = storedSession;

        if (session.id && session.token) {
          this.sessionId = session.id;
          this.token = session.token;
          this.config.tenantId = session.tenantId;
          this.messages = session.messages || [];

          if (key !== this.storageKey) {
            this.writeStoredSession(session);
          }

          this.log('Restored session:', this.sessionId);
          return;
        }
      }

      // Create new session via API
      try {
        const resp = await fetch(`${this.config.apiUrl}/api/v1/widget/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: this.config.apiKey,
            visitorId: 'widget-' + utils.generateId(),
          }),
        });
        const data = await resp.json();
        const session = data.data || data;
        if (session.session?.id && session.token) {
          this.sessionId = session.session.id;
          this.token = session.token;
          // Extract tenantId from token
          try {
            const payload = JSON.parse(atob(session.token.split('.')[1]));
            this.config.tenantId = payload.tenantId;
          } catch (e) { /* ignore */ }
          this.log('Session created:', this.sessionId);
          this.saveSession();
        } else {
          this.log('Failed to init session:', data);
          this.sessionId = utils.generateId();
          this.token = null;
        }
      } catch (error) {
        this.log('Session init error:', error);
        this.sessionId = utils.generateId();
        this.token = null;
      }
    }

    loadSession() {
      // Legacy — kept for compatibility, actual loading happens in initSession
    }
    
    saveSession() {
      this.writeStoredSession({
        id: this.sessionId,
        token: this.token,
        tenantId: this.config.tenantId,
        messages: this.config.cacheMessages ? this.messages.slice(-this.config.maxCachedMessages) : [],
      });
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
      
      document.body.appendChild(this.host);
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
          
          <header class="cb-header">
            <div class="cb-header__avatar">
              ${ICONS.bot}
            </div>
            <div class="cb-header__info">
              <h3 class="cb-header__title">${utils.escapeHtml(this.config.title)}</h3>
              <p class="cb-header__subtitle">${utils.escapeHtml(this.config.subtitle)}</p>
            </div>
            <div class="cb-header__status">
              <span class="cb-header__status-dot"></span>
              <span class="cb-header__status-text">Connecting...</span>
            </div>
          </header>
          
          <div class="cb-messages" role="log" aria-live="polite" aria-label="Chat messages">
            ${this.messages.map(msg => this.renderMessage(msg)).join('')}
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
                placeholder="${utils.escapeHtml(this.config.placeholder)}"
                rows="1"
                aria-label="Type your message"
              ></textarea>
              <div class="cb-input-actions">
                ${this.config.enableFileUpload ? `
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
          </div>
        </div>
        
        <button class="cb-launcher" type="button" aria-label="Open chat" aria-expanded="false">
          <span class="cb-launcher__icon cb-launcher__icon--open">${ICONS.chat}</span>
          <span class="cb-launcher__icon cb-launcher__icon--close">${ICONS.close}</span>
        </button>
      `;
      
      this.cacheElements();
    }
    
    cacheElements() {
      this.chatWindow = this.container.querySelector('.cb-chat');
      this.launcher = this.container.querySelector('.cb-launcher');
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
    }
    
    renderMessage(message) {
      const isUser = message.sender === 'user';
      const time = this.config.showTimestamp ? utils.formatTime(message.timestamp) : '';
      
      let content = '';
      
      if (message.file) {
        if (message.file.type.startsWith('image/')) {
          content = `<img class="cb-message__image" src="${utils.escapeHtml(message.file.url)}" alt="${utils.escapeHtml(message.file.name)}" loading="lazy">`;
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

      let quickRepliesHtml = '';
      if (!isUser && message.metadata?.quickReplies?.length) {
        quickRepliesHtml = `
          <div class="cb-quick-replies">
            ${message.metadata.quickReplies.map(qr => {
              const label = typeof qr === 'string' ? qr : (qr.title || qr);
              return `<button class="cb-quick-reply" data-value="${utils.escapeHtml(String(label))}">${utils.escapeHtml(String(label))}</button>`;
            }).join('')}
          </div>
        `;
      }

      return `
        <div class="cb-message cb-message--${message.sender}" data-id="${message.id}">
          <div class="cb-message__avatar">${isUser ? ICONS.user : ICONS.bot}</div>
          <div class="cb-message__content">
            ${content}
            ${time ? `<span class="cb-message__time">${time}</span>` : ''}
          </div>
        </div>
        ${quickRepliesHtml}
      `;
    }

    attachEventListeners() {
      // Launcher click
      this.launcher.addEventListener('click', () => this.toggle());
      
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
      
      // Window resize — stored as a named ref so destroy() can remove it
      this._onWindowResize = utils.debounce(() => {
        if (utils.isMobile() && this.isOpen && this.config.fullScreenOnMobile) {
          this.chatWindow.style.height = '100%';
        }
      }, 100);
      window.addEventListener('resize', this._onWindowResize);

      // Quick reply clicks
      this.messagesContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.cb-quick-reply');
        if (btn) {
          const value = btn.dataset.value;
          if (value) {
            this.messagesContainer.querySelectorAll('.cb-quick-replies').forEach(el => el.remove());
            this.sendMessage(value);
          }
        }
      });

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
      
      const messageEl = document.createElement('div');
      messageEl.innerHTML = this.renderMessage(message);
      this.messagesContainer.appendChild(messageEl.firstElementChild);
      
      this.scrollToBottom();
      this.saveSession();
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
      if (!this.sessionId || !this.config.tenantId) {
        this.showError('Chat is still connecting. Please wait a moment and try again.');
        return;
      }

      this.showProgress(0);
      
      try {
        // Get upload URL from server
        const response = await fetch(`${this.config.apiUrl}/api/v1/uploads/presigned-url`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.config.apiKey,
          },
          body: JSON.stringify({
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type,
            chatSessionId: this.sessionId,
            tenantId: this.config.tenantId,
          }),
        });
        
        if (!response.ok) throw new Error('Failed to get upload URL');
        
        const { data } = await response.json();
        
        // Upload to S3
        await this.uploadToS3(file, data.uploadUrl, (progress) => {
          this.showProgress(progress);
        });
        
        // Add message with file
        this.addMessage({
          id: utils.generateId(),
          text: '',
          sender: 'user',
          timestamp: new Date(),
          file: {
            name: file.name,
            size: file.size,
            type: file.type,
            url: data.publicUrl,
          },
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
    // WebSocket
    // ========================================================================
    
    connectWebSocket() {
      // Use Socket.IO client (loaded dynamically)
      if (!window.io) {
        this.log('Loading Socket.IO client...');
        const script = document.createElement('script');
        script.src = this.config.apiUrl + '/socket.io/socket.io.js';
        script.onload = () => {
          this.log('Socket.IO client loaded');
          this._connectSocketIO();
        };
        script.onerror = () => {
          this.setConnectionState('offline');
          this.log('Failed to load Socket.IO client');
        };
        document.head.appendChild(script);
        return;
      }
      this._connectSocketIO();
    }

    _connectSocketIO() {
      try {
        this.ws = window.io(this.config.apiUrl, {
          query: {
            apiKey: this.config.apiKey,
            visitorId: this.sessionId,
          },
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionAttempts: this.config.reconnectAttempts,
          reconnectionDelay: this.config.reconnectDelay,
        });

        this.ws.on('connect', () => {
          this.log('Socket.IO connected');
          this.reconnectAttempts = 0;
          this.setConnectionState('connected');
          // Join the session room
          this.ws.emit('session:join', { sessionId: this.sessionId });
          this.flushPendingMessages();
          this.emit('connected');
        });

        this.ws.on('message:receive', (data) => {
          this.log('Received message:', data);
          // Ignore messages sent by the user (only show bot/agent responses)
          if (data.senderType === 'user' || data.participantType === 'user') return;
          this.handleServerMessage({ type: 'message', data: { text: data.content || data.text, metadata: data.metadata || null, ...data } });
        });

        this.ws.on('typing:start', () => {
          this.showTypingIndicator();
        });

        this.ws.on('typing:stop', () => {
          this.hideTypingIndicator();
        });

        this.ws.on('connection:ack', (data) => {
          this.log('Connection acknowledged:', data);
        });

        this.ws.on('disconnect', (reason) => {
          this.log('Socket.IO disconnected:', reason);
          this.setConnectionState('connecting');
          this.emit('disconnected');
        });

        this.ws.on('connect_error', (error) => {
          this.setConnectionState('connecting');
          this.log('Socket.IO error:', error.message);
          this.emit('error', error);
        });

      } catch (error) {
        this.setConnectionState('offline');
        this.log('Failed to connect Socket.IO:', error);
      }
    }

    disconnectWebSocket() {
      if (this.ws) {
        this.ws.disconnect();
        this.ws = null;
      }
    }

    attemptReconnect() {
      // Socket.IO handles reconnection automatically
    }

    startHeartbeat() {
      // Socket.IO handles heartbeat automatically
    }

    stopHeartbeat() {
      // Socket.IO handles heartbeat automatically
    }

    sendToServer(data) {
      if (this.ws && this.ws.connected) {
        this.ws.emit(data.type || 'message', data);
      }
    }

    handleServerMessage(message) {
      this.log('Received:', message);

      switch (message.type) {
        case 'message':
          this.hideTypingIndicator();
          this.addMessage({
            id: utils.generateId(),
            text: message.data.text,
            sender: 'bot',
            timestamp: new Date(),
            metadata: message.data.metadata || null,
          });
          break;
          
        case 'typing':
          this.showTypingIndicator();
          break;
          
        case 'stop_typing':
          this.hideTypingIndicator();
          break;
          
        case 'pong':
          // Heartbeat response
          break;
          
        case 'error':
          this.showError(message.data.message);
          break;
      }
      
      this.emit('serverMessage', message);
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

      // 2. Connection
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
    const script = document.currentScript || document.querySelector('script[data-chatbot-widget]');
    
    if (script) {
      const config = {};
      
      // Parse data attributes
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
