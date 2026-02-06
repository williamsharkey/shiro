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

globalThis.window = window as any;
globalThis.document = document as any;
