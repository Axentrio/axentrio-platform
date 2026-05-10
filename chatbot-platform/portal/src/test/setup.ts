import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

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
