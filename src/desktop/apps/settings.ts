/**
 * Settings: Appearance (theme), Network (connection status, Sign in with
 * GitHub, other ways to connect), and About.
 */

import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { GLYPHS } from '../icons';
import { networkCredential, networkStatus, onNetworkStatus } from '../../net-signin';
import { openSignIn, probeRelay, signedInAccount, signOut, statusText } from '../network';
import { BRAND } from '../../brand';
import buildNumber from '../../../build-number.txt?raw';

const PANES = [
  { id: 'appearance', label: 'Appearance', glyph: GLYPHS.sun },
  { id: 'network', label: 'Network', glyph: GLYPHS.net },
  { id: 'about', label: 'About', glyph: GLYPHS.file },
] as const;
type PaneId = typeof PANES[number]['id'];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function open(ctx: AppContext, args?: Record<string, unknown>): DesktopWindow {
  const { wm } = ctx;
  const root = document.createElement('div');
  root.className = 'sd-app';
  root.tabIndex = -1;
  root.innerHTML = `<div class="sd-app-split"><aside class="sd-sidebar"></aside><section class="sd-main"><div class="sd-scroll"><div class="sd-panel"></div></div></section></div>`;
  const side = root.querySelector('.sd-sidebar')!;
  const panel = root.querySelector<HTMLElement>('.sd-panel')!;
  const buttons = new Map<PaneId, HTMLButtonElement>();
  for (const p of PANES) {
    const b = document.createElement('button');
    b.className = 'sd-side-item';
    b.innerHTML = `${p.glyph}<span>${p.label}</span>`;
    b.addEventListener('click', () => show(p.id));
    side.appendChild(b);
    buttons.set(p.id, b);
  }
  const win = wm.createWindow({ appId: 'settings', title: 'Settings', width: 680, height: 470, minWidth: 380, content: { kind: 'dom', element: root } });
  let cleanup: (() => void) | null = null;

  function show(id: PaneId): void {
    cleanup?.();
    cleanup = null;
    panel.onclick = null;
    for (const [k, b] of buttons) b.classList.toggle('sd-active', k === id);
    win.setTitle(`Settings — ${PANES.find(p => p.id === id)!.label}`);
    if (id === 'appearance') appearance();
    else if (id === 'network') network();
    else about();
  }

  function appearance(): void {
    const pref = wm.themePreference();
    panel.innerHTML = `
      <h2>Appearance</h2><p class="sd-muted">Light, dark, or follow your system.</p>
      <h3>Theme</h3>
      <div class="sd-card"><div class="sd-row"><span class="sd-grow">Appearance</span>
        <div class="sd-seg" role="radiogroup">
          <button data-theme="light" role="radio">Light</button><button data-theme="dark" role="radio">Dark</button><button data-theme="system" role="radio">System</button>
        </div></div></div>
      <h3>Interface</h3>
      <div class="sd-card"><div class="sd-row"><span class="sd-grow">Classic full-page terminal<div class="sd-small sd-muted">The terminal-first layout of shiro.computer. Come back with <code>?ui=desktop</code>.</div></span>
        <button class="sd-btn" data-act="classic">Switch</button></div></div>
      <h3>Motion</h3>
      <div class="sd-card sd-small sd-muted">Animations follow your system's "reduce motion" setting${matchMedia('(prefers-reduced-motion: reduce)').matches ? ' (reduced now)' : ''}.</div>`;
    for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-theme]')) {
      const on = b.dataset.theme === pref;
      b.classList.toggle('sd-active', on);
      b.setAttribute('aria-checked', String(on));
      b.addEventListener('click', () => { wm.setTheme(b.dataset.theme as 'light' | 'dark' | 'system'); appearance(); });
    }
    panel.querySelector('[data-act=classic]')!.addEventListener('click', () => {
      try { localStorage.setItem('shiro-ui', 'terminal'); } catch {}
      location.href = location.pathname + '?ui=terminal';
    });
  }

  function network(): void {
    let account: string | null = null;
    const render = () => {
      const s = networkStatus();
      const signed = !!networkCredential();
      const dot = s === 'signed-in' || s === 'online' ? 'ok' : s === 'needs-sign-in' ? 'warn' : 'off';
      panel.innerHTML = `
        <h2>Network</h2><p class="sd-muted">Programs reach the internet through this site's relay. Downloads from this site — packages, the npm registry proxy — always work.</p>
        <h3>Status</h3>
        <div class="sd-card">
          <div class="sd-row"><span class="sd-dot ${dot}"></span><span class="sd-grow">${esc(statusText(s))}</span><button class="sd-btn" data-act="check">Check</button></div>
          <div class="sd-row sd-small sd-muted"><span class="sd-grow">Browser connection</span>${navigator.onLine ? 'online' : 'offline'}</div>
          <div class="sd-row sd-small sd-muted"><span class="sd-grow">Cross-origin isolated (threads, x86)</span>${(globalThis as any).crossOriginIsolated ? 'yes' : 'no'}</div>
        </div>
        <h3>Account</h3>
        <div class="sd-card">
          <div class="sd-row"><span class="sd-grow">${signed ? (account ? `Signed in with GitHub as <b>@${esc(account)}</b>` : 'Signed in with GitHub') : 'Not signed in'}
            <div class="sd-small sd-muted">${signed ? 'Programs connect without asking. git and gh use the same sign-in.' : 'Sign in once; later visits connect silently.'}</div></span>
            ${signed ? '<button class="sd-btn" data-act="signout">Sign out</button>' : '<button class="sd-btn sd-primary" data-act="signin">Sign in with GitHub</button>'}
          </div>
          <div class="sd-row sd-small"><button class="sd-link" data-act="other">Other ways to connect</button></div>
          <div class="sd-other sd-small sd-muted" hidden style="padding:4px 0 6px">Coming soon: use your own relay, or a key from a provider you trust. Until then, GitHub is the only sign-in.</div>
        </div>`;
    };
    render();
    cleanup = onNetworkStatus(() => render());
    panel.onclick = async (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'signin') { await openSignIn(); account = await signedInAccount(); render(); }
      if (act === 'signout') { signOut(); account = null; render(); }
      if (act === 'check') { await probeRelay(); render(); }
      if (act === 'other') { const o = panel.querySelector<HTMLElement>('.sd-other'); if (o) o.hidden = !o.hidden; }
    };
    void signedInAccount().then(a => { account = a; render(); });
  }

  function about(): void {
    panel.onclick = null;
    panel.innerHTML = `
      <h2>${esc(BRAND.name)}</h2><p class="sd-muted">A Unix-like computer that runs in a browser tab: a kernel with processes, pipes, ptys and signals; WASI/WASIX and x86-64 Linux programs; a package manager.</p>
      <h3>This computer</h3>
      <div class="sd-card">
        <div class="sd-row"><span class="sd-grow">Build</span>#${esc(buildNumber.trim())}</div>
        <div class="sd-row"><span class="sd-grow">Processor threads</span>${navigator.hardwareConcurrency || '?'}</div>
        <div class="sd-row"><span class="sd-grow">Storage used</span><span data-k="storage">…</span></div>
      </div>
      <div class="sd-row" style="margin-top:14px;gap:8px"><button class="sd-btn" data-act="activity">Open Activity</button><button class="sd-btn" data-act="about">About This Computer</button></div>`;
    navigator.storage?.estimate?.().then(e => {
      const k = panel.querySelector('[data-k=storage]');
      if (k) k.textContent = `${((e.usage ?? 0) / 1048576).toFixed(1)} MB`;
    }).catch(() => {});
    panel.querySelector('[data-act=activity]')!.addEventListener('click', () => void wm.openApp('activity'));
    panel.querySelector('[data-act=about]')!.addEventListener('click', () => void wm.openApp('about'));
  }

  win.on('close', () => cleanup?.());
  (win as { content?: unknown }).content = { navigate: (a: Record<string, unknown>) => { if (typeof a.pane === 'string' && PANES.some(p => p.id === a.pane)) show(a.pane as PaneId); } };
  const first = typeof args?.pane === 'string' && PANES.some(p => p.id === args.pane) ? args.pane as PaneId : 'appearance';
  show(first);
  return win;
}
