/**
 * Phones and tablets (coarse pointer): the desktop follows the *visual*
 * viewport, which shrinks when the on-screen keyboard opens (iOS Safari keeps
 * the layout viewport and scrolls it). Keyboard open: the dock hides, windows
 * and the terminal relayout above the keyboard, the key bar hides unless it
 * is pinned. Changes crossfade (0.3 s, View Transitions; instant with
 * prefers-reduced-motion).
 *
 * The key bar: the keys the iOS keyboard makes awkward, in two rows of nine
 * that fit a 375 px screen. Ctrl and Alt are one-shot modifiers that also
 * apply to the next letter typed on the system keyboard. Mode (localStorage
 * `tabcomputer-keybar`): 'auto' (shown, hides while the keyboard is open), 'pinned'
 * (also above the keyboard), 'off'. The menu bar's keyboard button toggles it.
 *
 * Loaded only on touch devices; the classic terminal UI keeps
 * src/mobile-input.ts.
 */

import { getActiveTerminal } from '../active-terminal';
import type { AppContext, DesktopLayout } from './index';

export type KeybarMode = 'auto' | 'pinned' | 'off';
export const KEYBAR_KEY = 'tabcomputer-keybar';
const KEYBOARD_MIN = 120; // px of viewport lost before we call it a keyboard

export function keybarMode(): KeybarMode {
  try {
    const m = localStorage.getItem(KEYBAR_KEY);
    return m === 'pinned' || m === 'off' ? m : 'auto';
  } catch { return 'auto'; }
}

const modeListeners = new Set<(m: KeybarMode) => void>();
export function setKeybarMode(m: KeybarMode): void {
  try { localStorage.setItem(KEYBAR_KEY, m); } catch {}
  for (const cb of modeListeners) cb(m);
}
export function onKeybarMode(cb: (m: KeybarMode) => void): () => void {
  modeListeners.add(cb);
  return () => { modeListeners.delete(cb); };
}

interface Key { label: string; data?: string; mod?: 'ctrl' | 'alt'; act?: 'paste' | 'hide'; aria?: string; wide?: boolean }

/** Row 1: Esc Tab Ctrl Alt | ~ `  ↑  hide.  Row 2: Paste / - $ & ;  ← ↓ → */
export const KEY_ROWS: Key[][] = [
  [
    { label: 'esc', data: '\x1b', aria: 'Escape' }, { label: 'tab', data: '\t', aria: 'Tab' },
    { label: 'ctrl', mod: 'ctrl', aria: 'Control' }, { label: 'alt', mod: 'alt', aria: 'Alt' },
    { label: '|', data: '|' }, { label: '~', data: '~' }, { label: '`', data: '`' },
    { label: '↑', data: '\x1b[A', aria: 'Up' }, { label: '⌄', act: 'hide', aria: 'Hide keys' },
  ],
  [
    { label: '⎘', act: 'paste', aria: 'Paste' }, { label: '/', data: '/' }, { label: '-', data: '-' },
    { label: '$', data: '$' }, { label: '&', data: '&' }, { label: ';', data: ';' },
    { label: '←', data: '\x1b[D', aria: 'Left' }, { label: '↓', data: '\x1b[B', aria: 'Down' }, { label: '→', data: '\x1b[C', aria: 'Right' },
  ],
];

function inject(data: string): void {
  (getActiveTerminal() ?? (globalThis as any).__shiro?.terminal)?.injectInput?.(data);
}

/** A control character for a letter (Ctrl+C → \x03); other characters unchanged. */
export function ctrlChar(ch: string): string {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
  if (ch === ' ') return '\x00';
  if (ch === '?') return '\x7f';
  return ch;
}

export function initMobile(ctx: AppContext, layout: DesktopLayout): void {
  const root = ctx.wm.root;
  root.classList.add('sd-touch');
  const vv = window.visualViewport;

  // ── Key bar ──
  const bar = document.createElement('div');
  bar.className = 'sd-keybar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Extra keys');
  let pending: 'ctrl' | 'alt' | null = null;
  const modBtns = new Map<string, HTMLButtonElement>();
  for (const row of KEY_ROWS) {
    const r = document.createElement('div');
    r.className = 'sd-keyrow';
    for (const k of row) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sd-key' + (k.mod ? ' sd-key-mod' : '') + (k.act ? ' sd-key-act' : '');
      b.textContent = k.label;
      if (k.aria) b.setAttribute('aria-label', k.aria);
      if (k.mod) modBtns.set(k.mod, b);
      // pointerdown + preventDefault: the terminal keeps focus, so the iOS keyboard stays up
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); press(k); });
      b.addEventListener('click', (e) => e.preventDefault());
      r.appendChild(b);
    }
    bar.appendChild(r);
  }
  root.appendChild(bar);

  const setPending = (m: 'ctrl' | 'alt' | null) => {
    pending = m;
    for (const [id, b] of modBtns) b.classList.toggle('sd-on', id === m);
  };
  const press = (k: Key) => {
    if (k.mod) { setPending(pending === k.mod ? null : k.mod); return; }
    if (k.act === 'hide') { setKeybarMode('off'); return; }
    if (k.act === 'paste') {
      const t = getActiveTerminal() as any;
      navigator.clipboard?.readText?.().then((s) => { if (s) t?.term?.paste?.(s); }).catch(() => {
        const s = prompt('Paste text:');
        if (s) t?.term?.paste?.(s);
      });
      return;
    }
    let data = k.data ?? '';
    if (pending === 'ctrl') data = data.length === 1 ? ctrlChar(data) : data;
    else if (pending === 'alt') data = '\x1b' + data;
    setPending(null);
    inject(data);
  };
  // Ctrl/Alt also apply to the next character typed on the system keyboard
  document.addEventListener('beforeinput', (e) => {
    if (!pending) return;
    const ie = e as InputEvent;
    const t = e.target as HTMLElement | null;
    if (!t?.classList?.contains('xterm-helper-textarea') || !ie.data || ie.data.length !== 1) return;
    e.preventDefault();
    const ch = ie.data;
    const out = pending === 'ctrl' ? ctrlChar(ch) : '\x1b' + ch;
    setPending(null);
    inject(out);
  }, true);

  // ── Layout from the visual viewport ──
  // Safe-area insets come from CSS env(): read once through a probe's padding
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top)';
  root.appendChild(probe);
  layout.topInset = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  let kbOpen = false;
  let mode = keybarMode();
  const measure = () => {
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    return { h, top, kb: window.innerHeight - h > KEYBOARD_MIN };
  };
  const apply = () => {
    const m = measure();
    kbOpen = m.kb;
    // The desktop occupies exactly what is visible
    root.style.top = `${m.top}px`;
    root.style.height = `${m.h}px`;
    root.style.bottom = 'auto';
    const showBar = mode === 'pinned' || (mode === 'auto' && !kbOpen);
    bar.hidden = !showBar;
    root.classList.toggle('sd-kb-open', kbOpen);
    layout.keybarH = showBar ? bar.offsetHeight : 0;
    layout.dockHidden = kbOpen;
    layout.viewportH = m.h;
    layout.relayout();
    // Keep the cursor line in view above the keyboard
    requestAnimationFrame(() => (getActiveTerminal() as any)?.term?.scrollToBottom?.());
  };
  // Keyboard open/close: crossfade old and new layout (0.3 s), no animated movement
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const transition = (fn: () => void) => {
    const d = document as any;
    if (typeof d.startViewTransition !== 'function' || reduced()) { fn(); return; }
    try { d.startViewTransition(fn); } catch { fn(); }
  };
  let last = measure();
  const onViewport = () => {
    const m = measure();
    if (m.kb !== last.kb) transition(apply);
    else apply();
    last = m;
  };
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', onViewport);
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
  onKeybarMode((m) => { mode = m; transition(apply); });
  apply();
}
