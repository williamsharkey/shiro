// The page's own fetch and timers, captured at boot (main.ts imports this
// eagerly) so they are the originals even though node-compat itself loads
// lazily, after `serve` or a bundle may have replaced the globals.
export const PAGE_FETCH = globalThis.fetch.bind(globalThis);
export const PAGE_SET_TIMEOUT = globalThis.setTimeout.bind(globalThis) as typeof setTimeout;
export const PAGE_CLEAR_TIMEOUT = globalThis.clearTimeout.bind(globalThis) as typeof clearTimeout;
export const PAGE_SET_INTERVAL = globalThis.setInterval.bind(globalThis) as typeof setInterval;
export const PAGE_CLEAR_INTERVAL = globalThis.clearInterval.bind(globalThis) as typeof clearInterval;
