/**
 * The desktop window manager API (src/desktop/wm.ts, docs/DESKTOP.md), on
 * linkedom: window lifecycle, geometry and states, focus and stacking,
 * transients, override windows, content kinds, apps, events, UI mode choice.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { WindowManager, isDesktopShortcut, type DesktopWindow } from '@shiro/desktop/wm';
import { uiMode } from '@shiro/ui-mode';

let wm: WindowManager;

// Node has no localStorage; the desktop keeps its theme and UI choice there
if (!(globalThis as any).localStorage) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  wm = new WindowManager(root, { workArea: () => ({ x: 0, y: 30, width: 1000, height: 600 }) });
});

describe('window manager', () => {
  it('creates windows with ids, titles, frames and geometry', () => {
    const w = wm.createWindow({ title: 'One', appId: 'a', x: 10, y: 20, width: 300, height: 200 });
    expect(w.id).toMatch(/^w\d+$/);
    expect(w.kind).toBe('dom');
    expect(w.geometry()).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(w.element.querySelector('.sd-title')!.textContent).toBe('One');
    expect(w.element.querySelectorAll('.sd-light').length).toBe(3);
    expect(w.element.style.left).toBe('10px');
    expect(w.element.style.top).toBe('50px'); // work area starts at y=30
    expect(w.element.style.height).toBe('238px'); // + 38px title bar
    const named = wm.createWindow({ id: 'term', title: 'T' });
    expect(named.id).toBe('term');
    expect(wm.createWindow({ id: 'term' }).id).not.toBe('term'); // ids are unique
    expect(wm.get('term')).toBe(named);
  });

  it('focus raises; closing focuses the next window; events fire', () => {
    const seen: string[] = [];
    wm.on('window-created', (w) => seen.push(`created ${w!.id}`));
    wm.on('window-closed', (w) => seen.push(`closed ${w!.id}`));
    const a = wm.createWindow({ id: 'a' });
    const b = wm.createWindow({ id: 'b' });
    expect(wm.focused()).toBe(b);
    const blurred: string[] = [];
    b.on('blur', () => blurred.push('b'));
    a.focus();
    expect(wm.focused()).toBe(a);
    expect(blurred).toEqual(['b']);
    expect(Number(a.element.style.zIndex)).toBeGreaterThan(Number(b.element.style.zIndex));
    expect(wm.windows().map((w) => w.id)).toEqual(['b', 'a']);
    a.close();
    expect(a.state).toBe('closed');
    expect(wm.focused()).toBe(b);
    expect(seen).toEqual(['created a', 'created b', 'closed a']);
  });

  it('maximize, snap, restore and zoom', () => {
    const w = wm.createWindow({ x: 100, y: 100, width: 400, height: 300 });
    w.maximize();
    expect(w.state).toBe('maximized');
    expect(w.geometry()).toEqual({ x: 6, y: 6, width: 988, height: 588 - 38 });
    w.restore();
    expect(w.geometry()).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    w.snap('left');
    expect(w.state).toBe('snapped-left');
    expect(w.geometry().x).toBe(6);
    w.snap('right');
    expect(w.geometry().x).toBeGreaterThan(400);
    w.zoom();
    expect(w.state).toBe('maximized');
    w.zoom();
    expect(w.state).toBe('normal');
    w.move(5, 6);
    w.resize(10, 10); // clamped to the minimum size
    expect(w.geometry()).toEqual({ x: 5, y: 6, width: 220, height: 120 });
  });

  it('onClose can veto; close(true) forces', () => {
    let allow = false;
    const w = wm.createWindow({ onClose: () => allow });
    expect(w.close()).toBe(false);
    expect(w.state).toBe('normal');
    allow = true;
    expect(w.close()).toBe(true);
    const v = wm.createWindow({ onClose: () => false });
    expect(v.close(true)).toBe(true);
  });

  it('transients stay above their parent and close with it; override windows never take focus', () => {
    const parent = wm.createWindow({ id: 'p' });
    const dialog = wm.createWindow({ id: 'd', transientFor: 'p' });
    parent.focus();
    expect(Number(dialog.element.style.zIndex)).toBeGreaterThan(Number(parent.element.style.zIndex));
    const menu = wm.createWindow({ id: 'm', override: true, x: 50, y: 60, width: 120, height: 80 });
    expect(wm.focused()).toBe(parent);
    expect(menu.titlebarExtra).toBeNull();
    expect(menu.element.querySelector('.sd-titlebar')).toBeNull();
    expect(menu.geometry()).toEqual({ x: 50, y: 60, width: 120, height: 80 });
    expect(Number(menu.element.style.zIndex)).toBeGreaterThan(Number(dialog.element.style.zIndex));
    parent.close();
    expect(dialog.state).toBe('closed');
  });

  it('content kinds: dom element, iframe, surface, and registered kinds', () => {
    const el = document.createElement('p');
    el.textContent = 'hi';
    const d = wm.createWindow({ content: { kind: 'dom', element: el } });
    expect(d.body.firstChild).toBe(el);
    const f = wm.createWindow({ content: { kind: 'iframe', srcdoc: '<b>x</b>', sandbox: '' } });
    expect(f.iframe!.tagName).toBe('IFRAME');
    expect(f.iframe!.getAttribute('sandbox')).toBe('');
    const s = wm.createWindow({ width: 100, height: 50, content: { kind: 'surface', bufferWidth: 200, bufferHeight: 100, scale: 2 } });
    expect(s.surface!.canvas.tagName).toBe('CANVAS');
    expect([s.surface!.width, s.surface!.height, s.surface!.scale]).toEqual([200, 100, 2]);
    const events: string[] = [];
    s.surface!.onInput((e) => events.push(`${e.type}:${e.key}`));
    const kd = new (window as any).Event('keydown');
    Object.assign(kd, { key: 'a', code: 'KeyA', keyCode: 65 });
    s.surface!.canvas.dispatchEvent(kd);
    expect(events).toEqual(['keydown:a']);
    wm.registerContentKind('hello', (_w, c, body) => { body.textContent = `hello ${(c as any).who}`; return 'made'; });
    const h = wm.createWindow({ content: { kind: 'hello', who: 'gui' } });
    expect(h.body.textContent).toBe('hello gui');
    expect(h.content).toBe('made');
    expect(() => wm.createWindow({ content: { kind: 'nope' } })).toThrow(/no content kind/);
  });

  it('apps: register, list in order, open', async () => {
    let made: DesktopWindow | null = null;
    wm.registerApp({ id: 'b', name: 'B', order: 2, launch: () => null });
    wm.registerApp({ id: 'a', name: 'A', order: 1, launch: () => (made = wm.createWindow({ appId: 'a' })) });
    expect(wm.apps().map((a) => a.id)).toEqual(['a', 'b']);
    const w = await wm.openApp('a');
    expect(w).toBe(made);
    expect(await wm.openApp('zzz')).toBeNull();
  });

  it('theme preference persists and fires theme-changed', () => {
    let n = 0;
    wm.on('theme-changed', () => n++);
    wm.setTheme('light');
    expect(wm.theme()).toBe('light');
    expect(wm.root.dataset.theme).toBe('light');
    expect(localStorage.getItem('shiro-desktop-theme')).toBe('light');
    wm.setTheme('dark');
    expect(wm.theme()).toBe('dark');
    expect(n).toBe(2);
  });

  it('desktop shortcuts are Alt+Shift combos and Alt+`', () => {
    const k = (code: string, mods: Partial<KeyboardEvent> = {}) => ({ code, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods }) as KeyboardEvent;
    expect(isDesktopShortcut(k('KeyW', { altKey: true, shiftKey: true }))).toBe(true);
    expect(isDesktopShortcut(k('Backquote', { altKey: true }))).toBe(true);
    expect(isDesktopShortcut(k('KeyW', { ctrlKey: true }))).toBe(false);
    expect(isDesktopShortcut(k('KeyB', { altKey: true }))).toBe(false); // readline's M-b stays with the terminal
  });
});

describe('uiMode', () => {
  const loc = (search: string, hostname: string) => ({ search, hostname });
  beforeEach(() => localStorage.removeItem('shiro-ui'));

  it('shiro.computer keeps the terminal; other hosts get the desktop', () => {
    expect(uiMode(loc('', 'shiro.computer'), false)).toBe('terminal');
    expect(uiMode(loc('', 'music.shiro.computer'), false)).toBe('terminal');
    expect(uiMode(loc('', 'unix.computer'), false)).toBe('desktop');
    expect(uiMode(loc('', 'localhost'), false)).toBe('desktop');
  });

  it('?ui= chooses and is remembered; embedded pages and demos use the terminal', () => {
    expect(uiMode(loc('?ui=desktop', 'shiro.computer'), false)).toBe('desktop');
    expect(uiMode(loc('', 'shiro.computer'), false)).toBe('desktop');
    expect(uiMode(loc('?ui=terminal', 'unix.computer'), false)).toBe('terminal');
    expect(uiMode(loc('', 'unix.computer'), false)).toBe('terminal');
    localStorage.removeItem('shiro-ui');
    expect(uiMode(loc('', 'unix.computer'), true)).toBe('terminal');
    expect(uiMode(loc('?demo=1', 'unix.computer'), false)).toBe('terminal');
  });
});

describe('brand (profiles/tabcomputer/profile.json)', () => {
  it('server.mjs titles the app shell and adds meta tags, except on shiro.computer', async () => {
    const { execFileSync } = await import('node:child_process');
    // Plain Node (vitest's polyfilled modules can't load server.mjs)
    const server = new URL('../../../server.mjs', import.meta.url).href;
    const out = execFileSync('node', ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(server)}); const h = '<head><title>shiro</title></head>';
       console.log(JSON.stringify([m.brandAppShell(h, 'tabcomputer.com'), m.brandAppShell(h, 'localhost:5173'), m.brandAppShell(h, 'shiro.computer'), m.brandAppShell(h, 'x.shiro.computer')])); process.exit(0);`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const [tab, local, shiro, sub] = JSON.parse(out.trim().split('\n').pop()!);
    expect(tab).toContain('<title>tabcomputer</title>');
    expect(tab).toContain('<meta property="og:url" content="https://tabcomputer.com/" />');
    expect(tab).toMatch(/<meta name="description" content="[^"]+"/);
    expect(local).toContain('<title>tabcomputer</title>');
    expect(shiro).toBe('<head><title>shiro</title></head>');
    expect(sub).toBe('<head><title>shiro</title></head>');
  });
});

describe('"Use my own connection" (net-signin)', () => {
  it('stores the relay, validates it, and maps it to NetStack settings without credentials', async () => {
    const ns = await import('@shiro/net-signin');
    const loc = { protocol: 'https:', host: 'tabcomputer.com' };
    ns.setOwnRelay(null);
    expect(ns.relayNetConfig(loc)).toEqual({ relayUrl: 'wss://tabcomputer.com/tcp', tokenUrl: 'https://tabcomputer.com/tcp/token', credentials: true });
    const seen: unknown[] = [];
    const off = ns.onOwnRelayChange((r) => seen.push(r));
    ns.setOwnRelay({ url: 'wss://relay.example.com/tcp' });
    expect(ns.ownRelay()).toEqual({ url: 'wss://relay.example.com/tcp' });
    expect(ns.relayNetConfig(loc)).toEqual({ relayUrl: 'wss://relay.example.com/tcp', tokenUrl: null, credentials: false });
    ns.setOwnRelay({ url: 'ws://10.0.0.2:3000/tcp', tokenUrl: 'http://10.0.0.2:3000/tcp/token' });
    expect(ns.relayNetConfig(loc).tokenUrl).toBe('http://10.0.0.2:3000/tcp/token');
    expect(() => ns.setOwnRelay({ url: 'https://not-a-websocket' })).toThrow(/ws:\/\//);
    expect(() => ns.setOwnRelay({ url: 'wss://r.example', tokenUrl: 'ftp://x' })).toThrow(/http/);
    ns.setOwnRelay(null);
    expect(ns.ownRelay()).toBeNull();
    expect(seen.length).toBe(3);
    off();
  });
});

describe('quarters, launcher matching, session', () => {
  it('snap() takes quarters; drags to corners pick them', async () => {
    const { snapZone } = await import('@shiro/desktop/wm');
    const w = wm.createWindow({ x: 100, y: 100, width: 400, height: 300 });
    w.snap('bottom-right');
    expect(w.state).toBe('snapped-bottom-right');
    const g = w.geometry();
    expect(g.x).toBeGreaterThan(400);
    expect(g.y + g.height + 38).toBeLessThanOrEqual(600);
    w.snap('top-left');
    expect(w.geometry().x).toBe(6);
    expect(w.geometry().y).toBe(6);
    expect(snapZone(1, 10, 1000, 600)).toBe('snapped-top-left');
    expect(snapZone(999, 590, 1000, 600)).toBe('snapped-bottom-right');
    expect(snapZone(500, 1, 1000, 600)).toBe('maximized');
    expect(snapZone(1, 300, 1000, 600)).toBe('snapped-left');
    expect(snapZone(500, 300, 1000, 600)).toBeNull();
  });

  it('fuzzy matching ranks exact, prefix, substring, then subsequence', async () => {
    const { fuzzyScore } = await import('@shiro/desktop/spotlight');
    expect(fuzzyScore('vim', 'vim')).toBeGreaterThan(fuzzyScore('vim', 'vimdiff'));
    expect(fuzzyScore('vim', 'vimdiff')).toBeGreaterThan(fuzzyScore('vim', 'nvim'));
    expect(fuzzyScore('set', 'Settings')).toBeGreaterThan(fuzzyScore('set', 'reset-terminal'));
    expect(fuzzyScore('gco', 'git checkout')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'git checkout')).toBe(-1);
  });

  it('saves restorable windows and puts them back', async () => {
    const s = await import('@shiro/desktop/session');
    localStorage.removeItem(s.SESSION_KEY);
    const stop = s.trackSession(wm);
    const t = wm.createWindow({ id: 'terminal', appId: 'terminal', title: 'Terminal', x: 20, y: 30, width: 500, height: 300 });
    (t as any).content = { cwd: () => '/home/user/src' };
    const f = wm.createWindow({ appId: 'files', x: 40, y: 50, width: 400, height: 250 });
    (f as any).content = { path: () => '/usr/bin' };
    f.snap('right');
    wm.createWindow({ appId: 'vim', title: 'Vim' }); // a program: not restored
    await new Promise(r => setTimeout(r, 500));
    stop();
    const saved = s.loadSession();
    expect(saved.map(w => w.app)).toEqual(['terminal', 'files']);
    expect(saved[0]).toMatchObject({ id: 'terminal', cwd: '/home/user/src', g: { x: 20, y: 30, width: 500, height: 300 } });
    expect(saved[1]).toMatchObject({ app: 'files', path: '/usr/bin', state: 'snapped-right' });
    const opened: unknown[] = [];
    wm.registerApp({ id: 'files', name: 'Files', launch: (a) => { opened.push(a); return wm.createWindow({ appId: 'files' }); } });
    await s.restoreSession(wm, saved, () => null);
    expect(opened).toEqual([{ newWindow: true, path: '/usr/bin' }]);
    expect(wm.windows().filter(w => w.appId === 'files').pop()!.state).toBe('snapped-right');
  });
});

describe('dock stacks and the touch key bar (v1.2)', () => {
  it('registerGroup() lists groups by order and announces apps-changed', () => {
    let changed = 0;
    wm.on('apps-changed', () => { changed++; });
    wm.registerGroup({ id: 'b', name: 'B', order: 30 });
    wm.registerGroup({ id: 'a', name: 'A', order: 10, maxLoose: 2 });
    expect(wm.groups().map(g => g.id)).toEqual(['a', 'b']);
    expect(changed).toBe(2);
    wm.registerGroup({ id: 'b', name: 'B2', order: 5 }); // same id: replaced
    expect(wm.groups().map(g => g.name)).toEqual(['B2', 'A']);
    wm.registerApp({ id: 'x', name: 'X', group: 'a', launch: () => null });
    expect(wm.app('x')!.group).toBe('a');
  });

  it('ctrlChar() maps letters to control characters', async () => {
    const { ctrlChar } = await import('@shiro/desktop/mobile');
    expect(ctrlChar('c')).toBe('\x03');
    expect(ctrlChar('C')).toBe('\x03');
    expect(ctrlChar('[')).toBe('\x1b');
    expect(ctrlChar(' ')).toBe('\x00');
    expect(ctrlChar('?')).toBe('\x7f');
    expect(ctrlChar('1')).toBe('1');
  });

  it('key bar mode is remembered and announced', async () => {
    const m = await import('@shiro/desktop/mobile');
    localStorage.removeItem(m.KEYBAR_KEY);
    expect(m.keybarMode()).toBe('auto');
    const seen: string[] = [];
    const off = m.onKeybarMode((x) => seen.push(x));
    m.setKeybarMode('pinned');
    expect(m.keybarMode()).toBe('pinned');
    m.setKeybarMode('off');
    off();
    m.setKeybarMode('auto');
    expect(seen).toEqual(['pinned', 'off']);
    // Two rows of nine fit a 375 px phone
    expect(m.KEY_ROWS.map(r => r.length)).toEqual([9, 9]);
  });
});
