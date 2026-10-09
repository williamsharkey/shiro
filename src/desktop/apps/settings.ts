/**
 * Settings: Appearance (theme), Network (connection status, Sign in with
 * GitHub, other ways to connect), and About.
 */

import { keybarMode, setKeybarMode, type KeybarMode } from '../mobile';
import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { GLYPHS } from '../icons';
import { networkCredential, networkStatus, onNetworkStatus, ownRelay, setOwnRelay } from '../../net-signin';
import { openSignIn, probeRelay, signedInAccount, signOut, statusText, testOwnRelay } from '../network';
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

  let current: PaneId = 'appearance';
  function show(id: PaneId): void {
    current = id;
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
    const touch = matchMedia('(pointer: coarse)').matches;
    panel.innerHTML = `
      <h2>Appearance</h2><p class="sd-muted">Light, dark, or follow your system.</p>
      <h3>Theme</h3>
      <div class="sd-card"><div class="sd-row"><span class="sd-grow">Appearance</span>
        <div class="sd-seg" role="radiogroup">
          <button data-theme="light" role="radio">Light</button><button data-theme="dark" role="radio">Dark</button><button data-theme="system" role="radio">System</button>
        </div></div></div>
      <h3>Interface</h3>
      ${touch ? `<div class="sd-card" style="margin-bottom:10px"><div class="sd-row"><span class="sd-grow">Extra keys<div class="sd-small sd-muted">Esc, Tab, Ctrl, arrows… above the dock. Auto hides them while the keyboard is open.</div></span>
        <div class="sd-seg" role="radiogroup" aria-label="Extra keys">
          <button data-keybar="off" role="radio">Off</button><button data-keybar="auto" role="radio">Auto</button><button data-keybar="pinned" role="radio">Always</button>
        </div></div></div>` : ''}
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
    const kb = keybarMode();
    for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-keybar]')) {
      const on = b.dataset.keybar === kb;
      b.classList.toggle('sd-active', on);
      b.setAttribute('aria-checked', String(on));
      b.addEventListener('click', () => { setKeybarMode(b.dataset.keybar as KeybarMode); appearance(); });
    }
    panel.querySelector('[data-act=classic]')!.addEventListener('click', () => {
      try { localStorage.setItem('shiro-ui', 'terminal'); } catch {}
      location.href = location.pathname + '?ui=terminal';
    });
  }

  function network(): void {
    let account: string | null = null;
    /** Relay form state survives re-renders (status changes) while editing */
    let mode: 'site' | 'own' = ownRelay() ? 'own' : 'site';
    let draft = { url: ownRelay()?.url ?? '', tokenUrl: ownRelay()?.tokenUrl ?? '' };
    let relayMsg = '', relayCls = '';
    const render = () => {
      const s = networkStatus();
      const own = ownRelay();
      const signed = !!networkCredential();
      const dot = s === 'signed-in' || s === 'online' ? 'ok' : s === 'needs-sign-in' ? 'warn' : 'off';
      panel.innerHTML = `
        <h2>Network</h2><p class="sd-muted">Programs reach the internet through a relay: this site's, or one you run. Downloads from this site — packages, the npm registry proxy — always work.</p>
        <h3>Status</h3>
        <div class="sd-card">
          <div class="sd-row"><span class="sd-dot ${dot}"></span><span class="sd-grow">${esc(statusText(s))}${own ? ` <span class="sd-small sd-muted">· your relay</span>` : ''}</span><button class="sd-btn" data-act="check">Check</button></div>
          <div class="sd-row sd-small sd-muted"><span class="sd-grow">Browser connection</span>${navigator.onLine ? 'online' : 'offline'}</div>
          <div class="sd-row sd-small sd-muted"><span class="sd-grow">Cross-origin isolated (threads, x86)</span>${(globalThis as any).crossOriginIsolated ? 'yes' : 'no'}</div>
        </div>
        <h3>Connection</h3>
        <div class="sd-card">
          <div class="sd-row"><span class="sd-grow">Use my own connection<div class="sd-small sd-muted">Send programs' connections through a TCP relay you run instead of this site's.</div></span>
            <div class="sd-seg" role="radiogroup" aria-label="Relay">
              <button data-mode="site" role="radio" class="${mode === 'site' ? 'sd-active' : ''}" aria-checked="${mode === 'site'}">This site</button>
              <button data-mode="own" role="radio" class="${mode === 'own' ? 'sd-active' : ''}" aria-checked="${mode === 'own'}">My relay</button>
            </div></div>
          ${mode === 'own' ? `
          <div class="sd-row" style="flex-direction:column;align-items:stretch;gap:6px;padding-top:8px">
            <label class="sd-small sd-muted" for="sd-relay-url">Relay URL</label>
            <input id="sd-relay-url" class="sd-input" type="url" spellcheck="false" placeholder="wss://relay.example.com/tcp" value="${esc(draft.url)}">
            <label class="sd-small sd-muted" for="sd-relay-token">Token URL <span>(optional, if your relay issues tokens)</span></label>
            <input id="sd-relay-token" class="sd-input" type="url" spellcheck="false" placeholder="https://relay.example.com/tcp/token" value="${esc(draft.tokenUrl)}">
            <div class="sd-row" style="gap:8px;border:0;padding:4px 0 0"><span class="sd-grow sd-small ${relayCls === 'err' ? '' : 'sd-muted'}" style="${relayCls === 'err' ? 'color:#ff5a52' : relayCls === 'ok' ? 'color:#2fb457' : ''}">${esc(relayMsg)}</span>
              <button class="sd-btn" data-act="test">Test</button><button class="sd-btn sd-primary" data-act="save">${own ? 'Update' : 'Use this relay'}</button></div>
            <div class="sd-small sd-muted">Any relay speaking Shiro's protocol works — <code>SHIRO_TCP_RELAY=1 node server.mjs</code> from the repository, with this site in <code>SHIRO_TCP_ORIGINS</code>. Your GitHub sign-in is never sent to it.</div>
          </div>` : ''}
        </div>
        <h3>Account</h3>
        <div class="sd-card">
          <div class="sd-row"><span class="sd-grow">${signed ? (account ? `Signed in with GitHub as <b>@${esc(account)}</b>` : 'Signed in with GitHub') : 'Not signed in'}
            <div class="sd-small sd-muted">${signed ? "Programs connect through this site's relay without asking. git and gh use the same sign-in." : "When this site's relay needs a sign-in you'll be asked once; later visits connect silently."}</div></span>
            ${signed ? '<button class="sd-btn" data-act="signout">Sign out</button>' : '<button class="sd-btn sd-primary" data-act="signin">Sign in with GitHub</button>'}
          </div>
        </div>`;
    };
    const readDraft = () => {
      draft = {
        url: panel.querySelector<HTMLInputElement>('#sd-relay-url')?.value.trim() ?? draft.url,
        tokenUrl: panel.querySelector<HTMLInputElement>('#sd-relay-token')?.value.trim() ?? draft.tokenUrl,
      };
    };
    render();
    cleanup = onNetworkStatus(() => { readDraft(); render(); });
    panel.onclick = async (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act], [data-mode]');
      if (!el) return;
      readDraft();
      if (el.dataset.mode === 'site') { mode = 'site'; relayMsg = ''; if (ownRelay()) setOwnRelay(null); render(); return; }
      if (el.dataset.mode === 'own') { mode = 'own'; render(); panel.querySelector<HTMLInputElement>('#sd-relay-url')?.focus(); return; }
      const act = el.dataset.act;
      if (act === 'signin') { await openSignIn(); account = await signedInAccount(); render(); }
      if (act === 'signout') { signOut(); account = null; render(); }
      if (act === 'check') { await probeRelay(); render(); }
      if (act === 'test' || act === 'save') {
        if (!/^wss?:\/\/[^/\s]+/.test(draft.url)) { relayMsg = 'The relay URL must start with ws:// or wss://'; relayCls = 'err'; render(); return; }
        relayMsg = 'Testing…'; relayCls = ''; render();
        const err = await testOwnRelay(draft.url, draft.tokenUrl || undefined);
        if (err) { relayMsg = `Can't reach it: ${err}`; relayCls = 'err'; render(); return; }
        if (act === 'save') {
          try { setOwnRelay({ url: draft.url, ...(draft.tokenUrl ? { tokenUrl: draft.tokenUrl } : {}) }); }
          catch (er) { relayMsg = (er as Error).message; relayCls = 'err'; render(); return; }
          relayMsg = 'Connected. Programs now use your relay.';
        } else relayMsg = 'Reachable.';
        relayCls = 'ok';
        render();
      }
    };
    void signedInAccount().then(a => { account = a; readDraft(); render(); });
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
  (win as { content?: unknown }).content = { navigate: (a: Record<string, unknown>) => { if (typeof a.pane === 'string' && PANES.some(p => p.id === a.pane)) show(a.pane as PaneId); }, pane: () => current };
  const first = typeof args?.pane === 'string' && PANES.some(p => p.id === args.pane) ? args.pane as PaneId : 'appearance';
  show(first);
  return win;
}
