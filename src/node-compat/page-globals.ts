// The page's own fetch and timers, captured at boot (main.ts imports this
// eagerly) so they are the originals even though node-compat itself loads
// lazily, after `serve` or a bundle may have replaced the globals.
export const PAGE_FETCH = globalThis.fetch.bind(globalThis);
const PAGE_SET_TIMEOUT_RAW = globalThis.setTimeout;
const PAGE_CLEAR_TIMEOUT_RAW = globalThis.clearTimeout;
export const PAGE_SET_TIMEOUT = globalThis.setTimeout.bind(globalThis) as typeof setTimeout;
export const PAGE_CLEAR_TIMEOUT = globalThis.clearTimeout.bind(globalThis) as typeof clearTimeout;
export const PAGE_SET_INTERVAL = globalThis.setInterval.bind(globalThis) as typeof setInterval;
export const PAGE_CLEAR_INTERVAL = globalThis.clearInterval.bind(globalThis) as typeof clearInterval;

/**
 * Run page code with the page's own timers as the globals. A node script's
 * setTimeout replaces the global while it runs and cancels the timers it
 * counted when it exits; page code that scheduled through the global in that
 * window lost its timer.
 */
export function withPageTimers<T>(fn: () => T): T {
  const st = globalThis.setTimeout, ct = globalThis.clearTimeout;
  if (st === PAGE_SET_TIMEOUT_RAW && ct === PAGE_CLEAR_TIMEOUT_RAW) return fn();
  globalThis.setTimeout = PAGE_SET_TIMEOUT_RAW;
  globalThis.clearTimeout = PAGE_CLEAR_TIMEOUT_RAW;
  try { return fn(); } finally { globalThis.setTimeout = st; globalThis.clearTimeout = ct; }
}

/**
 * xterm's write buffer schedules its parsing with the global setTimeout. A
 * script that wrote to the terminal and then called process.exit() from a
 * timer (Gemini CLI's -p, codex's npm launcher) cancelled that timer, and the
 * terminal never drew again. Its writes run with the page's timers.
 */
export function pinTerminalTimers(term: unknown): void {
  const wb = (term as any)?._core?._writeBuffer;
  if (!wb) return;
  for (const name of ['write', '_innerWrite']) {
    const orig = wb[name];
    if (typeof orig !== 'function') continue;
    wb[name] = function (this: unknown, ...args: unknown[]) { return withPageTimers(() => orig.apply(this, args)); };
  }
}

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
