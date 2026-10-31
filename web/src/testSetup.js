import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);

class RO { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= RO;
globalThis.DOMMatrixReadOnly ??= class { constructor() { this.m22 = 1; } };
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = RO;
window.scrollTo = () => {}; // jsdom does not implement it
