/**
 * Settings, laid out like a system settings app: a searchable sidebar of
 * grouped panes, the pane on the right. Appearance (theme, extra keys), Dock &
 * Icons (the icon set picker, iconsets.ts), Network (connection status, Sign in
 * with GitHub, other ways to connect), Storage (browser quota, persistence), About.
 */

import { keybarMode, setKeybarMode, type KeybarMode } from '../mobile';
import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { GLYPHS, ICONS } from '../icons';
import { ICON_SETS, appIconIn, glyphFor, paintPixelTiles, type IconSetId } from '../iconsets';
import { networkCredential, networkStatus, onNetworkStatus, ownRelay, setOwnRelay } from '../../net-signin';
import { openSignIn, probeRelay, signedInAccount, signOut, statusText, testOwnRelay } from '../network';
import { BRAND } from '../../brand';
import buildNumber from '../../../build-number.txt?raw';
import { formatBytes, storageInfo } from '../../storage';

/** A pane's sidebar icon: a white glyph (24-unit, iconsets.ts) on a colored rounded square */
const paneIcon = (d: string, color: string) =>
  `<span class="sd-set-ico" style="background:${color}"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg></span>`;
const DOCK_D = 'M3.5 17.5h17M6 14.5h3v-3H6zM10.5 14.5h3v-3h-3zM15 14.5h3v-3h-3z';
const SUN_D = 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4';
const DISK_D = 'M4 7.5h16v9H4zM7.5 12h.01M16.5 12h-4';
const INFO_D = 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 11v5.5M12 7.8h.01';

/** Panes in sidebar groups; `words` widen the search */
const PANES = [
  { id: 'appearance', label: 'Appearance', group: 0, icon: paneIcon(SUN_D, '#2b2b30'), words: 'theme light dark mode system keys keyboard motion classic terminal' },
  { id: 'dock', label: 'Dock & Icons', group: 0, icon: paneIcon(DOCK_D, '#5b4fd6'), words: 'icon icons set theme drafting classic pearl glass foil vaporwave aurora clay swiss brutalist risograph one-bit pixel paper' },
  { id: 'network', label: 'Network', group: 1, icon: paneIcon(glyphFor('browser')!, '#2f7cf6'), words: 'internet relay github sign in account connection tcp' },
  { id: 'storage', label: 'Storage', group: 1, icon: paneIcon(DISK_D, '#8e8e93'), words: 'disk quota space persistent indexeddb files' },
  { id: 'about', label: 'About', group: 2, icon: paneIcon(INFO_D, '#8e8e93'), words: 'version build processor' },
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
  root.innerHTML = `<div class="sd-app-split sd-settings"><aside class="sd-sidebar">
      <label class="sd-set-search">${GLYPHS.search}<input type="search" placeholder="Search" aria-label="Search settings" spellcheck="false"></label>
    </aside><section class="sd-main"><div class="sd-scroll"><div class="sd-panel"></div></div></section></div>`;
  const side = root.querySelector('.sd-sidebar')!;
  const panel = root.querySelector<HTMLElement>('.sd-panel')!;
  const search = root.querySelector<HTMLInputElement>('.sd-set-search input')!;
  const buttons = new Map<PaneId, HTMLButtonElement>();
  const groups: HTMLElement[] = [];
  for (const p of PANES) {
    let g = groups[p.group];
    if (!g) { g = groups[p.group] = document.createElement('div'); g.className = 'sd-set-group'; side.appendChild(g); }
    const b = document.createElement('button');
    b.className = 'sd-side-item sd-set-item';
    b.innerHTML = `${p.icon}<span>${esc(p.label)}</span>`;
    b.addEventListener('click', () => show(p.id));
    g.appendChild(b);
    buttons.set(p.id, b);
  }
  // Search: panes whose name or keywords match every word typed; Enter opens the first
  const matches = () => {
    const q = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return PANES.filter(p => q.every(w => `${p.label} ${p.words}`.toLowerCase().includes(w)));
  };
  search.addEventListener('input', () => {
    const hit = new Set(matches().map(p => p.id));
    for (const [id, b] of buttons) b.hidden = !hit.has(id);
    for (const g of groups) g.hidden = ![...g.children].some(c => !(c as HTMLElement).hidden);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const m = matches()[0]; if (m) show(m.id); }
    if (e.key === 'Escape' && search.value) { search.value = ''; search.dispatchEvent(new Event('input')); e.stopPropagation(); }
  });
  const win = wm.createWindow({ appId: 'settings', title: 'Settings', width: 720, height: 500, minWidth: 380, content: { kind: 'dom', element: root } });
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
    else if (id === 'dock') dockPane();
    else if (id === 'network') network();
    else if (id === 'storage') storage();
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
      <div class="sd-card"><div class="sd-row"><span class="sd-grow">Classic full-page terminal<div class="sd-small sd-muted">The terminal-first layout, without the desktop. Come back with <code>?ui=desktop</code>.</div></span>
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
      try { localStorage.setItem('tabcomputer-ui', 'terminal'); } catch {}
      location.href = location.pathname + '?ui=terminal';
    });
  }

  /** Dock & Icons: the icon set picker. Each card is a still mini dock (no WebGL, even for live sets) */
  function dockPane(): void {
    const PREVIEW = ['terminal', 'files', 'browser', 'settings', 'activity'];
    const apps = PREVIEW.map(id => wm.app(id) ?? { id, name: id, icon: undefined });
    const render = () => {
      const cur = ctx.iconSet();
      panel.innerHTML = `
        <h2>Dock &amp; Icons</h2><p class="sd-muted">One set of glyphs, many materials. The set follows light and dark.</p>
        <h3>Icon set</h3>
        <div class="sd-iconsets" role="radiogroup" aria-label="Icon set">${ICON_SETS.map(set => `
          <button class="sd-iconset-card${set.id === cur ? ' sd-active' : ''}" role="radio" aria-checked="${set.id === cur}" data-set="${set.id}">
            <span class="sd-iconset-mini" data-iconset="${set.id}" style="--n:${apps.length}">${apps.map((a, i) => `<span class="sd-iconset-slot">${appIconIn(set.id, a.id, a.name, a.icon, i)}</span>`).join('')}</span>
            <span class="sd-iconset-name">${esc(set.name)}${set.kind === 'live' ? '<span class="sd-iconset-live">Live</span>' : ''}<span class="sd-iconset-check" aria-hidden="true">${set.id === cur ? '✓' : ''}</span></span>
            <span class="sd-iconset-blurb">${esc(set.blurb)}</span>
          </button>`).join('')}
        </div>
        <p class="sd-small sd-muted" style="margin-top:12px">Live sets draw with WebGL and pause when the dock is hidden or motion is reduced; the others are plain SVG and CSS.</p>`;
      const px = panel.querySelector<HTMLElement>('[data-iconset=pixel]');
      if (px) paintPixelTiles(px, wm.theme(), id => wm.app(id)?.name ?? id);
      for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-set]')) {
        b.addEventListener('click', () => {
          const id = b.dataset.set as IconSetId;
          // The check moves at once; the dock crossfades when the set is ready
          for (const o of panel.querySelectorAll<HTMLButtonElement>('[data-set]')) {
            const on = o === b;
            o.classList.toggle('sd-active', on);
            o.setAttribute('aria-checked', String(on));
            o.querySelector('.sd-iconset-check')!.textContent = on ? '✓' : '';
          }
          void ctx.setIconSet(id);
        });
      }
    };
    render();
    // Theme changes repaint One-bit's bitmaps; a change made elsewhere moves the check
    const offTheme = wm.on('theme-changed', () => { const px = panel.querySelector<HTMLElement>('[data-iconset=pixel]'); if (px) paintPixelTiles(px, wm.theme(), id => wm.app(id)?.name ?? id); });
    const offSet = ctx.onIconSet(() => { if (current === 'dock') render(); });
    cleanup = () => { offTheme?.(); offSet(); };
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
            <div class="sd-small sd-muted">Any relay speaking tabcomputer's protocol works — <code>TABCOMPUTER_TCP_RELAY=1 node server.mjs</code> from the repository, with this site in <code>TABCOMPUTER_TCP_ORIGINS</code>. Your GitHub sign-in is never sent to it.</div>
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

  function storage(): void {
    panel.innerHTML = `
      <h2>Storage</h2><p class="sd-muted">Files live in this browser's storage for the site (IndexedDB). The browser sets the quota; persistent storage keeps it from clearing them when the disk runs low.</p>
      <div class="sd-card">
        <div class="sd-row"><span class="sd-grow">Used</span><span data-k="usage">…</span></div>
        <div class="sd-row"><span class="sd-grow">Quota</span><span data-k="quota">…</span></div>
        <div class="sd-row"><span class="sd-grow">Persistent</span><span data-k="persisted">…</span></div>
        <div class="sd-row"><span class="sd-grow">Status</span><span data-k="state">…</span></div>
      </div>
      <div class="sd-row" style="margin-top:14px;gap:8px"><button class="sd-btn" data-act="persist" hidden>Keep my files (persistent storage)</button></div>
      <p class="sd-small sd-muted">To free space: <code>sudo apt clean</code> drops downloaded packages; <code>du -sh /*</code> shows what is large.</p>`;
    const set = (k: string, v: string) => { const n = panel.querySelector(`[data-k=${k}]`); if (n) n.textContent = v; };
    const btn = panel.querySelector<HTMLButtonElement>('[data-act=persist]')!;
    const refresh = () => void storageInfo().then((s) => {
      set('usage', s.usage === null ? 'unknown' : formatBytes(s.usage) + (s.quota ? ` (${((s.usage / s.quota) * 100).toFixed(s.usage / s.quota < 0.1 ? 1 : 0)}%)` : ''));
      set('quota', s.quota === null ? 'unknown' : formatBytes(s.quota));
      set('persisted', s.persisted === null ? 'not supported' : s.persisted ? 'Yes' : 'No');
      set('state', ctx.fs.storageFull ? 'Full: writes fail until files are deleted' : `OK${ctx.fs.pendingWrites ? `, ${ctx.fs.pendingWrites} writes pending` : ''}`);
      btn.hidden = s.persisted !== false;
    });
    btn.addEventListener('click', () => void navigator.storage?.persist?.().catch(() => false).then(refresh));
    const off = ctx.fs.onStorageFull(refresh);
    const timer = setInterval(refresh, 5000);
    cleanup = () => { off(); clearInterval(timer); };
    refresh();
  }

  function about(): void {
    panel.onclick = null;
    panel.innerHTML = `
      <div class="sd-brand-mark" style="width:44px;margin-bottom:8px">${ICONS.logo}</div>
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
