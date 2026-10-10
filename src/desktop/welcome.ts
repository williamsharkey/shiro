/**
 * The first-run welcome (docs/DESKTOP.md "Welcome"): a card in the corner,
 * in the Drafting style, with a few one-click demos. A demo types its command
 * into a Terminal the way you would, so you see what it does and can do it
 * again. Not modal: the desktop works around it. Dismissed once per browser
 * (localStorage `tabcomputer-desktop-welcome`); after that this module isn't
 * loaded at all (index.ts checks the key first). Help → Welcome shows it again.
 */

import type { AppContext } from './index';
import { BRAND } from '../brand';
import { glyphFor } from './iconsets';
import { iframeServer } from '../iframe-server';

export const WELCOME_KEY = 'tabcomputer-desktop-welcome';

export function welcomeSeen(): boolean {
  try { return !!localStorage.getItem(WELCOME_KEY); } catch { return true; }
}

export interface Demo {
  id: string;
  title: string;
  detail: string;
  glyph: string;
  /** Typed into a Terminal window, then Enter */
  command?: string;
  /** Or something to open */
  run?: (ctx: AppContext) => void;
}

const VITE = 'npm create vite@latest hello-vite -- --template react --no-interactive && cd hello-vite && npm i && npm run dev';

export const DEMOS: Demo[] = [
  { id: 'cowsay', title: 'Install a Debian package', detail: 'apt install cowsay', glyph: 'terminal', command: 'apt install cowsay && cowsay "Hello from a browser tab"' },
  { id: 'vite', title: 'Run a web app', detail: 'Vite + React, live reload', glyph: 'browser', command: VITE },
  { id: 'python', title: 'Write some Python', detail: 'toolchain install python', glyph: 'python3', command: `toolchain install python && python3 -c "import sys, platform; print('Python', sys.version.split()[0], 'on', platform.machine())"` },
  { id: 'claude', title: 'Code with Claude', detail: 'claude, signed in from Accounts', glyph: 'claude', command: 'claude' },
  { id: 'gui', title: 'Open a Linux GUI app', detail: 'GIMP, xeyes… from Apps', glyph: 'apps', run: (ctx) => void ctx.wm.openApp('apps') },
  { id: 'settings', title: 'Make it yours', detail: 'Icons, theme, accounts', glyph: 'settings', run: (ctx) => void ctx.wm.openApp('settings', { pane: 'dock' }) },
];

const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="sd-ic-c" d="M1.5 12h21M12 1.5v21"/><path class="sd-ic-g" d="${d}"/></svg>`;

/** Type `cmd` into a fresh Terminal window at a typing pace, then Enter */
export function typeIntoTerminal(ctx: AppContext, cmd: string, title?: string): void {
  const win = ctx.openTerminal({ cwd: '/home/user', title });
  const view = (win as { content?: { activeTerminal?: () => { injectInput(d: string): void; term: { focus(): void } } | null } } | null)?.content;
  let i = 0;
  const start = performance.now();
  const step = () => {
    const t = view?.activeTerminal?.();
    if (!t) { if (performance.now() - start < 5000) setTimeout(step, 50); return; }
    t.term.focus();
    // A few characters per frame: quick, but you can watch it
    const n = Math.min(cmd.length - i, 3);
    if (n > 0) { t.injectInput(cmd.slice(i, i + n)); i += n; setTimeout(step, 16); }
    else t.injectInput('\r');
  };
  setTimeout(step, 250);
}

let current: HTMLElement | null = null;

/** Show the welcome card (again, from the Help menu) */
export function showWelcome(ctx: AppContext): void {
  current?.remove();
  const el = document.createElement('section');
  el.className = 'sd-welcome';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `Welcome to ${BRAND.name}`);
  el.dataset.iconset = 'drafting';
  el.innerHTML = `
    <button class="sd-welcome-x" type="button" data-act="close" aria-label="Close">×</button>
    <h2>Welcome to ${BRAND.name}</h2>
    <p class="sd-welcome-lede">A Unix computer in this tab: real programs, your files kept in this browser. Try one:</p>
    <div class="sd-welcome-demos">${DEMOS.map(d => `
      <button class="sd-welcome-demo" type="button" data-demo="${d.id}">
        <span class="sd-ic" style="--i:0">${svg(glyphFor(d.glyph) ?? '')}</span>
        <span class="sd-welcome-text"><b>${d.title}</b><span>${d.detail}</span></span>
      </button>`).join('')}
    </div>
    <div class="sd-welcome-foot"><span class="sd-grow">Find anything with <kbd>Ctrl</kbd>+<kbd>Space</kbd>. Help → Welcome brings this back.</span>
      <button class="sd-btn" type="button" data-act="close">Got It</button></div>`;
  const close = () => {
    try { localStorage.setItem(WELCOME_KEY, String(Date.now())); } catch {}
    el.classList.add('sd-leaving');
    setTimeout(() => el.remove(), 200);
    if (current === el) current = null;
  };
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-act=close]')) { close(); return; }
    const id = t.closest<HTMLElement>('[data-demo]')?.dataset.demo;
    const demo = DEMOS.find(d => d.id === id);
    if (!demo) return;
    // Trying something counts as having seen this; it stays up until closed
    try { localStorage.setItem(WELCOME_KEY, String(Date.now())); } catch {}
    if (demo.run) demo.run(ctx);
    else if (demo.command) {
      typeIntoTerminal(ctx, demo.command, demo.title);
      // The web app demo opens its preview as soon as the dev server is up
      if (demo.id === 'vite') {
        const off = iframeServer.onPortChange((port, up) => {
          if (!up || port !== 5173) return;
          off();
          void import('./preview').then(m => m.openPreview(ctx, port, '/', 'hello-vite'));
        });
      }
    }
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  ctx.wm.root.appendChild(el);
  current = el;
}
