import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Initialize the real i18n instance for tests so components render real
// English strings rather than raw translation keys. We force the language
// to 'en' explicitly — bypassing the browser language detector — to keep
// test assertions deterministic regardless of host locale.
import i18n from '../i18n';
if (i18n.language !== 'en') i18n.changeLanguage('en');

afterEach(() => {
  cleanup();
});

// jsdom doesn't implement these — Radix and shadcn primitives sometimes touch them.
const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
if (!proto.scrollIntoView) {
  proto.scrollIntoView = () => {};
}
if (!('hasPointerCapture' in proto)) {
  proto.hasPointerCapture = () => false;
}
if (!('releasePointerCapture' in proto)) {
  proto.releasePointerCapture = () => {};
}

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.ResizeObserver === 'undefined') {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof g.IntersectionObserver === 'undefined') {
  g.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}
if (!window.matchMedia) {
  (window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
