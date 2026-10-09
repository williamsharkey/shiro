// The page's own fetch and timers, captured at boot (main.ts imports this
// eagerly) so they are the originals even though node-compat itself loads
// lazily, after `serve` or a bundle may have replaced the globals.
export const PAGE_FETCH = globalThis.fetch.bind(globalThis);
export const PAGE_SET_TIMEOUT = globalThis.setTimeout.bind(globalThis) as typeof setTimeout;
export const PAGE_CLEAR_TIMEOUT = globalThis.clearTimeout.bind(globalThis) as typeof clearTimeout;
export const PAGE_SET_INTERVAL = globalThis.setInterval.bind(globalThis) as typeof setInterval;
export const PAGE_CLEAR_INTERVAL = globalThis.clearInterval.bind(globalThis) as typeof clearInterval;

// The page's Web Crypto stays the page's: a script's `globalThis.crypto = {...}`
// (Go's wasm_exec_node.js, which esbuild-wasm runs as a child node) replaced it
// for the whole tab, and every crypto.subtle after that (the preview's
// WebSocket handshake, git, require('crypto').subtle) failed. The assignment
// is ignored; the page's crypto has the getRandomValues such polyfills want.
if (typeof window !== 'undefined' && globalThis.crypto) {
  const pageCrypto = globalThis.crypto;
  try {
    Object.defineProperty(globalThis, 'crypto', { get: () => pageCrypto, set: () => { /* kept */ }, configurable: true, enumerable: true });
  } catch { /* not configurable here */ }
}
