import 'fake-indexeddb/auto';
import { parseHTML } from 'linkedom';

// Suppress known unhandled rejections from CLI force-exit patterns running in shim.
// CLI's _J6() does: process.exit → catch → process.kill → catch → throw "unreachable"
// Both throws are caught by try/catch, so "unreachable" always fires in a deferred async
// context that becomes an unhandled rejection. Intercept before vitest's handler sees it.
const _origEmit = process.emit.bind(process);
(process as any).emit = function (event: string, ...args: any[]) {
  if (event === 'unhandledRejection') {
    const reason = args[0];
    if (reason?.message === 'unreachable' || reason?._isProcessExit) {
      return true; // Suppress — known artifact of process shim
    }
  }
  return _origEmit(event, ...args);
};

// Set up minimal window/document globals so shiro code that references
// window.location (e.g. favicon.ts) doesn't crash in Node.js tests.
const { window, document } = parseHTML('<!DOCTYPE html><html><body></body></html>');

// Patch window.location since linkedom doesn't provide it
Object.defineProperty(window, 'location', {
  value: { host: 'shiro.test', hostname: 'shiro.test', href: 'http://shiro.test/', pathname: '/', protocol: 'http:', search: '', hash: '' },
  writable: true,
});

// Polyfill browser APIs that linkedom doesn't provide but xterm.js needs
(window as any).matchMedia = (query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: () => false,
});
(window as any).requestAnimationFrame = (cb: Function) => setTimeout(cb, 16);
(window as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(window as any).ResizeObserver = class ResizeObserver {
  observe() {} unobserve() {} disconnect() {}
};
(window as any).IntersectionObserver = class IntersectionObserver {
  observe() {} unobserve() {} disconnect() {}
};
(window as any).getComputedStyle = () => new Proxy({}, {
  get: (_t, prop) => prop === 'getPropertyValue' ? () => '' : '',
});
(window as any).queueMicrotask = (cb: Function) => Promise.resolve().then(() => cb());

globalThis.window = window as any;
globalThis.document = document as any;
globalThis.self = globalThis; // xterm.js uses `self` (browser global)
