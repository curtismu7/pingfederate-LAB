import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);

class RO { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= RO;
globalThis.DOMMatrixReadOnly ??= class { constructor() { this.m22 = 1; } };
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = RO;
window.scrollTo = () => {}; // jsdom does not implement it

// Some Node versions expose a half-working global localStorage that shadows jsdom's; use a plain in-memory one
// (the vendored floating-dialog tests clear it between tests).
if (typeof globalThis.localStorage?.clear !== 'function') {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() },
  });
}
