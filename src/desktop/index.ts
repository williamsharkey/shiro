/**
 * The desktop shell for the Unix edition: menu bar, dock, windows
 * (src/desktop/wm.ts) and the built-in apps. main.ts boots it instead of the
 * full-page terminal when `uiMode()` says 'desktop' (src/ui-mode.ts).
 *
 * Only the window manager, the menu bar, the dock and the Terminal app load
 * with the page; Files, Settings and Activity are separate chunks loaded on
 * first launch.
 */

// Inlined into this chunk and injected at boot: one request fewer than a CSS file
import desktopCss from './desktop.css?inline';
import iconsetsCss from './iconsets.css?inline';
import { appIconIn, ensureIconDefs, glyphClassicTile, glyphFor, iconSet, setAppGlyph, loadLiveEngine, paintPixelTiles, savedIconSet, saveIconSet, type IconSetId, type LiveIconEngine } from './iconsets';
import type { FileSystem } from '../filesystem';
import type { Shell } from '../shell';
import { ShiroTerminal } from '../terminal';
import type { Kernel } from '../kernel/kernel';
import { WindowManager, isDesktopShortcut, type DockGroup, type AppDescriptor, type DesktopWindow, type MenuSpec, type MenuItem, type Geometry } from './wm';
import { ICONS, GLYPHS, appIcon } from './icons';
import { TerminalView, takeParkedMain, hasParkedMain, applyTerminalTheme, useMonoFont, allTerminalViews, terminalTheme, TERMINAL_FONT } from './terminal-app';
import { initNetwork } from './network';
import { loadSession, place, restoreSession, trackSession } from './session';
import { maybeShowTour, showTour } from './tour';
import { BRAND } from '../brand';
import { DEV_GROUPS, DEV_TOOLS, TOOL_PATH, launchScript, type DevTool } from './devtools';
import { setClaudeSignInUI } from '../claude-signin-ui';
import { setPreviewUI } from '../preview-ui';
import { iframeServer } from '../iframe-server';
import { flushStorage, reloadAfterFlush } from '../storage';

export interface DesktopDeps {
  fs: FileSystem;
  shell: Shell;
  kernel: Kernel;
  makeShell: () => Shell;
  /** The #terminal element the main ShiroTerminal is (or will be) created in */
  terminalEl: HTMLElement;
}

/** What lazily loaded apps get */
export interface AppContext {
  wm: WindowManager;
  fs: FileSystem;
  shell: Shell;
  kernel: Kernel;
  openTerminal: (opts?: { command?: string; cwd?: string; title?: string; appId?: string }) => DesktopWindow | null;
  /** The dock's icon set (iconsets.ts) */
  iconSet(): IconSetId;
  /** Switch icon sets: no layout change, a 0.3 s crossfade; resolves once shown */
  setIconSet(id: IconSetId): Promise<void>;
  /** Called after each icon set change */
  onIconSet(cb: (id: IconSetId) => void): () => void;
  /** A menu at a point (the menu bar's look), for apps' own pop-up menus */
  openMenu?: (spec: MenuSpec, x: number, y: number, above?: boolean) => void;
}

/** Phone layout inputs (src/desktop/mobile.ts sets them from the visual viewport) */
export interface DesktopLayout {
  /** Height of the extra-keys bar at the bottom (0 when hidden) */
  keybarH: number;
  /** The dock hides while the on-screen keyboard is open */
  dockHidden: boolean;
  /** env(safe-area-inset-top): the menu bar grows by it (home-screen web app) */
  topInset: number;
  /** Visible height (visualViewport), or null for window.innerHeight */
  viewportH: number | null;
  relayout(): void;
}

export interface Desktop {
  wm: WindowManager;
  /** Hand over the main terminal once main.ts has created it in terminalEl */
  attachMainTerminal(term: ShiroTerminal): void;
  /**
   * Keep the desktop hidden until `p` settles (at most REVEAL_CAP_MS after
   * attach): the first frame shows the final layout. No-op once revealed.
   */
  holdReveal(p: Promise<unknown>): void;
  ctx: AppContext;
}

/** The longest the desktop stays hidden waiting for fonts, the dock's contents and the session */
const REVEAL_CAP_MS = 1500;

/** Programs shown in the dock as terminal apps (installed or one click from it); editors and agents are in devtools.ts */
const FEATURED_PACKAGES: { pkg: string; cmd: string; name: string }[] = [
  { pkg: 'htop', cmd: 'htop', name: 'htop' },
  { pkg: 'python3', cmd: 'python3', name: 'Python' },
];
/** Shown too once installed */
const OPTIONAL_PACKAGES: { pkg: string; cmd: string; name: string }[] = [
  { pkg: 'lua', cmd: 'lua', name: 'Lua' },
  { pkg: 'sqlite', cmd: 'sqlite3', name: 'SQLite' },
];
const PKG_STATUS = '/var/lib/pkg/status.json';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** Inter + JetBrains Mono, self-hosted (public/fonts, SIL OFL). Only the desktop uses them. */
function injectFonts(): void {
  if (document.getElementById('sd-fonts')) return;
  const style = el('style');
  style.id = 'sd-fonts';
  style.textContent = `
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; font-display: block; src: url('/fonts/inter-latin-wght.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 100 800; font-display: block; src: url('/fonts/jetbrains-mono-latin-wght.woff2') format('woff2'); }`;
  document.head.appendChild(style);
}

export function bootDesktop(deps: DesktopDeps): Desktop {
  const style = el('style');
  style.id = 'sd-style';
  style.textContent = desktopCss + iconsetsCss;
  document.head.appendChild(style);
  injectFonts();
  document.body.classList.add('sd-active');
  // One theme-color meta, set from the desktop's theme (an explicit Light/Dark
  // choice overrides the system's, which media-attributed metas could not follow)
  document.querySelectorAll('meta[name="theme-color"][media]').forEach(m => m.remove());
  const meta = document.querySelector('meta[name="theme-color"]');
  const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');

  const root = el('div', 'sd-desktop sd-booting');
  root.id = 'shiro-desktop';
  // Until the reveal: the dock's contents, fonts and the session settle out of sight
  const holds: Promise<unknown>[] = [];
  let revealed = false;
  const hold = (p: Promise<unknown>) => { if (!revealed) holds.push(p.catch(() => {})); };
  const fontsAtBoot = typeof document.fonts?.check === 'function' && document.fonts.check('14px "JetBrains Mono"');
  root.append(el('div', 'sd-wallpaper'));
  const wordmark = el('div', 'sd-wordmark', BRAND.name);
  document.title = BRAND.name;

  // ── Menu bar ──
  const menubar = el('div', 'sd-menubar');
  menubar.setAttribute('role', 'menubar');
  const logoBtn = el('button', 'sd-mb-item sd-mb-logo', ICONS.logo);
  logoBtn.setAttribute('aria-label', 'System menu');
  const appBtn = el('button', 'sd-mb-item sd-mb-app', 'Terminal');
  const menusEl = el('div', 'sd-mb-menus');
  const spacer = el('div', 'sd-mb-spacer');
  const searchBtn = el('button', 'sd-mb-item sd-mb-status', GLYPHS.search);
  searchBtn.title = 'Search apps, commands and files (Ctrl+Space)';
  searchBtn.setAttribute('aria-label', 'Search');
  const themeBtn = el('button', 'sd-mb-item sd-mb-status');
  const netBtn = el('button', 'sd-mb-item sd-mb-status');
  netBtn.classList.add('sd-mb-net');
  const clock = el('div', 'sd-mb-item sd-mb-clock');
  menubar.append(logoBtn, appBtn, menusEl, spacer, searchBtn, themeBtn, netBtn, clock);

  // ── Dock ──
  const dockWrap = el('div', 'sd-dock-wrap');
  const dock = el('nav', 'sd-dock');
  dock.dataset.iconset = savedIconSet();
  ensureIconDefs();
  dock.setAttribute('aria-label', 'Dock');
  dockWrap.append(dock);
  // The menu bar and dock join the page right after the main terminal is created
  // (attachMainTerminal): xterm's first measurement then lays out only the window

  // The page's terminal-first layout stays in the DOM (hidden): #terminal moves into a window
  document.body.appendChild(root);

  // From the CSS sizes (--sd-menubar-h, --sd-dock-h, --sd-dock-gap), not layout reads:
  // measuring here would force a full style and layout pass before the terminal exists
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const layout: DesktopLayout = { keybarH: 0, dockHidden: false, topInset: 0, viewportH: null, relayout: () => {} };
  const workArea = (): Geometry => {
    const compact = window.innerWidth <= 640;
    const top = (compact ? 34 : 30) + layout.topInset;
    const gap = compact ? 6 : 8;
    // The key bar (mobile.ts) sits at the very bottom; the dock goes above it
    const kb = layout.keybarH;
    dockWrap.style.bottom = kb ? `${kb + gap}px` : '';
    const dockSpace = layout.dockHidden ? 4 : (compact ? 58 : 68) + gap + 8;
    const h = layout.viewportH ?? window.innerHeight;
    const bottom = Math.max(top + 120, h - kb - dockSpace);
    return { x: 0, y: top, width: window.innerWidth, height: bottom - top };
  };
  const wm = new WindowManager(root, { workArea });
  wm.relayout();
  (globalThis as any).__shiroDesktop = wm;

  // ── Terminal ──
  const termDeps = { makeShell: deps.makeShell, mainShell: deps.shell };
  let mainTerm: ShiroTerminal | null = null;
  wm.registerContentKind('terminal', (win, content, body) => {
    const view = new TerminalView(win, wm, termDeps, body);
    const c = content as { command?: string; cwd?: string; adoptMain?: boolean; title?: string };
    if (c.title) view.fixedTitle = c.title;
    const parked = c.adoptMain ? takeParkedMain() : null;
    if (parked) view.adoptMain(parked.pane, parked.term);
    else view.newTab({ command: c.command, cwd: c.cwd });
    return view;
  });

  const openTerminal = (opts: { command?: string; cwd?: string; title?: string; appId?: string } = {}): DesktopWindow => {
    const wa = wm.workArea();
    const width = Math.min(820, Math.max(320, wa.width - 80));
    const height = Math.min(500, Math.max(200, wa.height - 120));
    const adoptMain = !opts.command && !opts.cwd;
    return wm.createWindow({
      // The window holding the main terminal is /dom/windows/terminal (when that id is free)
      ...(adoptMain && hasParkedMain() ? { id: 'terminal' } : {}),
      appId: opts.appId ?? 'terminal', title: opts.title ?? 'Terminal', width, height,
      content: { kind: 'terminal', command: opts.command, cwd: opts.cwd, adoptMain, title: opts.title },
    });
  };
  // Icon sets: the dock's attribute picks the material; a live set's engine draws behind the glyphs
  let iconSetId: IconSetId = savedIconSet();
  let liveEngine: LiveIconEngine | null = null;
  const iconSetListeners = new Set<(id: IconSetId) => void>();
  const ctx: AppContext = {
    wm, fs: deps.fs, shell: deps.shell, kernel: deps.kernel, openTerminal,
    iconSet: () => iconSetId,
    setIconSet: (id) => switchIconSet(id),
    onIconSet: (cb) => { iconSetListeners.add(cb); return () => { iconSetListeners.delete(cb); }; },
  };
  // Tests and the console: the app context (icon sets: __shiroDesktopCtx.setIconSet('pearl'))
  (globalThis as any).__shiroDesktopCtx = ctx;

  // Terminals start in the desktop's palette and font (no re-theme, re-measure later)
  ShiroTerminal.optionOverrides = { theme: terminalTheme(wm.theme()), fontFamily: TERMINAL_FONT };

  // The first window: the main terminal, front and center (or where it was last time)
  const session = wm.compact ? [] : loadSession();
  const first = (() => {
    const wa = wm.workArea();
    const width = Math.min(860, Math.max(320, wa.width - 100));
    const height = Math.min(520, Math.max(220, wa.height - 140));
    const win = wm.createWindow({
      id: 'terminal', appId: 'terminal', title: 'Terminal', width, height,
      x: Math.round((wa.width - width) / 2), y: Math.max(8, Math.round((wa.height - height - 38) / 2.4)),
      content: { kind: 'dom' },
    });
    const view = new TerminalView(win, wm, termDeps, win.body);
    (win as { content?: unknown }).content = view;
    view.adoptMain(deps.terminalEl, null);
    const saved = session.find(s => s.id === 'terminal');
    if (saved) place(win, saved, wa);
    return { win, view };
  })();

  // ── Apps ──
  const lazy = (load: () => Promise<{ open: (ctx: AppContext, args?: Record<string, unknown>) => DesktopWindow | null }>) =>
    async (args?: Record<string, unknown>) => (await load()).open(ctx, args);
  const focusOrLaunch = (appId: string, launch: (args?: Record<string, unknown>) => Promise<DesktopWindow | null> | DesktopWindow | null) =>
    (args?: Record<string, unknown>) => {
      const existing = wm.visibleOrder().find(w => w.appId === appId);
      if (existing && !args?.newWindow) { existing.focus(); if (args) (existing as any).content?.navigate?.(args); return existing; }
      return launch(args);
    };
  const apps: AppDescriptor[] = [
    { id: 'terminal', name: 'Terminal', icon: ICONS.terminal, order: 0, launch: (args) => openTerminal(args as { command?: string; cwd?: string }) },
    { id: 'files', name: 'Files', icon: ICONS.files, order: 1, launch: lazy(() => import('./apps/files')) },
    { id: 'settings', name: 'Settings', icon: ICONS.settings, order: 2, group: 'system', launch: focusOrLaunch('settings', lazy(() => import('./apps/settings'))) },
    { id: 'browser', name: 'Browser', icon: ICONS.browser, order: 4, launch: focusOrLaunch('browser', lazy(() => import('./apps/browser'))) },
    { id: 'activity', name: 'Activity', icon: ICONS.activity, order: 3, group: 'system', launch: focusOrLaunch('activity', lazy(() => import('./apps/activity'))) },
    { id: 'about', name: 'About This Computer', icon: ICONS.about, order: 90, dock: false, launch: focusOrLaunch('about', lazy(() => import('./apps/about'))) },
  ];
  for (const a of apps) wm.registerApp(a);

  // Terminal programs as apps
  let installed = new Set<string>();
  const registerPackages = () => {
    const list = [...FEATURED_PACKAGES, ...OPTIONAL_PACKAGES.filter(p => installed.has(p.pkg))];
    list.forEach((p, i) => wm.registerApp({
      id: p.pkg, name: p.name, icon: appIcon(p.pkg), order: 20 + i,
      // htop stays loose (the live demo); the rest stack as Programs when crowded
      group: p.pkg === 'htop' ? undefined : 'programs',
      launch: () => openTerminal({
        title: p.name, appId: p.pkg,
        command: installed.has(p.pkg) ? p.cmd : `apt install ${p.pkg} && clear && ${p.cmd}`,
      }),
    }));
  };
  const refreshInstalled = async () => {
    try {
      const status = JSON.parse(await deps.fs.readFile(PKG_STATUS, 'utf8') as string);
      installed = new Set(Object.keys(status ?? {}));
    } catch { installed = new Set(); }
    registerPackages();
  };
  registerPackages();
  hold(refreshInstalled());
  deps.fs.onChange((_ev, path) => { if (path === PKG_STATUS) void refreshInstalled(); });

  // Developer and AI agents stacks (devtools.ts): install on first use, in a Terminal window
  const toolMissing = new Set<string>();
  const toolInstalling = new Set<string>();
  const toolInstalled = async (t: DevTool) => {
    if (!t.install || !t.bins.length) return true;
    for (const dir of TOOL_PATH) for (const b of t.bins) if (await deps.fs.exists(`${dir}/${b}`).catch(() => false)) return true;
    return false;
  };
  const refreshTools = async () => {
    let changed = false;
    for (const t of DEV_TOOLS) {
      const missing = !(await toolInstalled(t));
      if (missing !== toolMissing.has(t.id)) { changed = true; if (missing) toolMissing.add(t.id); else toolMissing.delete(t.id); }
      if (!missing && toolInstalling.delete(t.id)) changed = true;
    }
    if (changed) queueDock();
  };
  const launchTool = (t: DevTool) => {
    if (t.window) {
      // A builtin that opens its own window (code): run it without a Terminal
      const sh = deps.makeShell();
      sh.cwd = '/home/user';
      void sh.execute(t.run, () => {}, () => {});
      return null;
    }
    if (toolMissing.has(t.id)) { toolInstalling.add(t.id); queueDock(); }
    const win = openTerminal({ title: t.name, appId: t.id, cwd: '/home/user', command: launchScript(t) });
    win?.on?.('close', () => { if (toolInstalling.delete(t.id)) queueDock(); });
    return win;
  };
  for (const g of DEV_GROUPS) wm.registerGroup({ id: g.id, name: g.name, order: g.order, maxLoose: g.maxLoose, loose: [...g.loose] });
  const openGit = focusOrLaunch('git', lazy(() => import('./apps/git')));
  for (const t of DEV_TOOLS) {
    // Classic: the existing art where there is one (vim), else the glyph on a tile in the group's colors
    const icon = ICONS[t.id] ?? glyphClassicTile(t.id, ...(t.group === 'agents' ? ['#e08a5f', '#a24a2a'] : ['#4b5468', '#1e2330']) as [string, string]);
    wm.registerApp({ id: t.id, name: t.name, icon, order: t.order, group: t.group, launch: t.id === 'git' ? openGit : () => launchTool(t) });
  }
  hold(refreshTools());
  // pkg, npm -g and the install scripts write executables into TOOL_PATH (debounced: an install writes many files)
  let toolTimer: ReturnType<typeof setTimeout> | null = null;
  deps.fs.onChange((_ev, path) => {
    if (path !== PKG_STATUS && !TOOL_PATH.some(d => path.startsWith(d + '/'))) return;
    if (toolTimer) clearTimeout(toolTimer);
    toolTimer = setTimeout(() => { toolTimer = null; void refreshTools(); }, 400);
  });

  // ── Dock rendering ──
  // Dock stacks (wm.registerGroup): these stay loose so the best demos are one tap away
  wm.registerGroup({ id: 'system', name: 'System', order: 10 });
  wm.registerGroup({ id: 'programs', name: 'Programs', order: 30 });
  wm.registerGroup({ id: 'debian', name: 'Debian apps', order: 60, maxLoose: 4 });
  /** An app's stack: its own `group`, else Debian GUI apps (order ≥ 60, registered by src/gui) */
  const groupOf = (a: AppDescriptor): string | undefined => a.group ?? ((a.order ?? 0) >= 60 ? 'debian' : undefined);
  let openStackEl: HTMLElement | null = null;
  const closeStack = () => { openStackEl?.remove(); openStackEl = null; };
  const renderDock = () => {
    dock.textContent = '';
    closeStack();
    const running = new Set(wm.windows().filter(w => w.state !== 'closed' && !w.options.override && !w.options.skipTaskbar).map(w => w.appId));
    const all = wm.apps();
    for (const a of all) setAppGlyph(a.id, a.glyph);
    const docked = all.filter(a => a.dock !== false);
    const extra = [...running].filter(id => id && !all.some(a => a.id === id && a.dock !== false));
    // Each dock tile's place in the row (sets whose hue or sky runs along the dock)
    let tileN = 0;
    const iconHtml = (id: string, name: string, icon: string | undefined, i = tileN) => appIconIn(iconSetId, id, name, icon, i, wm.app(id)?.glyph);
    const activate = (id: string, launch: () => void, b?: HTMLElement) => {
      const wins = wm.visibleOrder().filter(w => w.appId === id);
      if (wins.length) {
        const top = wins.find(w => w.state !== 'minimized') ?? wins[0];
        if (wm.focused() === top && wins.length === 1 && id !== 'terminal') top.minimize();
        else top.focus();
        return;
      }
      if (b && !prefersReducedMotion()) { b.classList.add('sd-launching'); setTimeout(() => b.classList.remove('sd-launching'), 900); }
      launch();
    };
    const add = (id: string, name: string, icon: string | undefined, launch: () => void) => {
      const b = el('button', 'sd-dock-item');
      b.dataset.app = id;
      b.setAttribute('aria-label', name);
      b.innerHTML = iconHtml(id, name, icon) + `<span class="sd-dock-tip">${name}</span>`;
      tileN++;
      if (running.has(id)) b.classList.add('sd-running');
      if (toolInstalling.has(id)) {
        b.classList.add('sd-installing');
        b.querySelector('.sd-dock-tip')!.textContent = `${name} — installing…`;
      } else if (toolMissing.has(id)) {
        b.classList.add('sd-not-installed');
        const t = DEV_TOOLS.find(x => x.id === id);
        b.querySelector('.sd-dock-tip')!.textContent = `${name} — click to install${t?.time ? ` (${t.time})` : ''}`;
      } else if (FEATURED_PACKAGES.some(p => p.pkg === id) && !installed.has(id)) {
        b.classList.add('sd-not-installed');
        b.querySelector('.sd-dock-tip')!.textContent = `${name} — click to install`;
      }
      b.addEventListener('click', () => activate(id, launch, b));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const wins = wm.visibleOrder().filter(w => w.appId === id);
        const r = b.getBoundingClientRect();
        openMenu({ title: name, items: [
          ...wins.map(w => ({ label: w.title || name, checked: wm.focused() === w, action: () => w.focus() })),
          ...(wins.length ? ['separator' as const] : []),
          { label: 'New Window', action: () => void wm.openApp(id, { newWindow: true }) },
          ...(wins.length ? [{ label: wins.length > 1 ? 'Close All' : 'Close', action: () => wins.forEach(w => w.close()) }] : []),
        ] }, r.left, r.top - 6, true);
      });
      dock.append(b);
    };
    const addStack = (g: DockGroup, members: AppDescriptor[]) => {
      const b = el('button', 'sd-dock-item sd-stack-tile');
      b.dataset.group = g.id;
      b.setAttribute('aria-label', `${g.name} (${members.length})`);
      b.setAttribute('aria-haspopup', 'true');
      b.innerHTML = `<span class="sd-stack-grid">${members.slice(0, 4).map((m, k) => `<span>${iconHtml(m.id, m.name, m.icon, tileN + k / 4)}</span>`).join('')}</span><span class="sd-dock-tip">${g.name}</span>`;
      if (members.some(m => running.has(m.id))) b.classList.add('sd-running');
      tileN++;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (openStackEl?.dataset.group === g.id) { closeStack(); return; }
        closeStack();
        const pop = el('div', 'sd-stack');
        pop.dataset.group = g.id;
        pop.dataset.iconset = iconSetId;
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', g.name);
        pop.innerHTML = `<div class="sd-stack-title">${g.name}</div><div class="sd-stack-items"></div>`;
        const items = pop.querySelector<HTMLElement>('.sd-stack-items')!;
        items.style.setProperty('--sd-stack-cols', String(Math.min(4, members.length)));
        for (const m of members) {
          const it = el('button', 'sd-stack-item');
          it.innerHTML = `<span class="sd-stack-icon">${iconHtml(m.id, m.name, m.icon, members.indexOf(m))}</span><span class="sd-stack-name"></span>`;
          it.querySelector('.sd-stack-name')!.textContent = m.name;
          if (running.has(m.id)) it.classList.add('sd-running');
          it.addEventListener('click', () => { closeStack(); activate(m.id, () => void wm.openApp(m.id)); });
          items.append(it);
        }
        root.append(pop);
        if (iconSetId === 'pixel') paintPixelTiles(pop, wm.theme(), appName);
        const r = b.getBoundingClientRect();
        const w = pop.offsetWidth;
        pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
        pop.style.bottom = `${Math.max(8, root.getBoundingClientRect().bottom - r.top + 10)}px`;
        openStackEl = pop;
      });
      dock.append(b);
    };
    // Stack groups when the dock would not fit, or a group outgrew maxLoose
    const groups = new Map((wm.groups?.() ?? []).map(g => [g.id, g]));
    const perItem = wm.compact ? 50 : 56;
    const bigGroup = (gid: string) => {
      const g = groups.get(gid)!;
      return g.collapse === 'always' || docked.filter(a => groupOf(a) === gid).length > (g.maxLoose ?? 4);
    };
    // Crowded: even with the usual stacks (big groups stacked, their `loose` members beside them),
    // the dock wouldn't fit: then every group stacks (phones)
    const usualTiles = new Set(docked.map(a => {
      const gid = groupOf(a);
      const g = gid ? groups.get(gid) : undefined;
      return g && bigGroup(gid!) && !g.loose?.includes(a.id) ? `group:${gid}` : a.id;
    })).size;
    const crowded = (usualTiles + 2) * perItem > window.innerWidth - 32;
    const stacked = (gid: string | undefined) => {
      const g = gid ? groups.get(gid) : undefined;
      if (!g) return false;
      return crowded || bigGroup(gid!);
    };
    const emitted = new Set<string>();
    let lastSide: 'core' | 'rest' | null = null;
    for (const a of docked) {
      const side = (a.order ?? 100) < 20 ? 'core' : 'rest';
      if (lastSide && side !== lastSide) dock.append(el('div', 'sd-dock-sep'));
      lastSide = side;
      const gid = groupOf(a);
      // A stacked group's `loose` members keep their own tiles (not on a crowded phone dock)
      const keepLoose = (x: AppDescriptor) => !crowded && !!groups.get(groupOf(x) ?? '')?.loose?.includes(x.id);
      if (gid && stacked(gid) && !keepLoose(a)) {
        if (emitted.has(gid)) continue;
        emitted.add(gid);
        const rest = docked.filter(x => groupOf(x) === gid && !keepLoose(x));
        if (rest.length > 1) addStack(groups.get(gid)!, rest);
        else add(a.id, a.name, a.icon, () => void wm.openApp(a.id));
      } else add(a.id, a.name, a.icon, () => void wm.openApp(a.id));
    }
    if (extra.length) {
      dock.append(el('div', 'sd-dock-sep'));
      for (const id of extra) {
        const w = wm.visibleOrder().find(x => x.appId === id);
        add(id!, w?.title || id!, w?.options.icon, () => w?.focus());
      }
    }
    dock.style.setProperty('--n', String(Math.max(2, tileN)));
    if (iconSetId === 'pixel') paintPixelTiles(dock, wm.theme(), appName);
    liveEngine?.attach([...dock.querySelectorAll<HTMLElement>(':scope > .sd-dock-item > .sd-ic')]);
  };
  const appName = (id: string) => wm.app(id)?.name ?? id;

  /** Swap the icon set: one attribute on the dock, crossfaded (live sets: once their first frame is drawn) */
  let swapping: Promise<void> = Promise.resolve();
  const switchIconSet = (id: IconSetId): Promise<void> => (swapping = swapping.then(async () => {
    const next = iconSet(id);
    const upgrade = next.kind === 'live' && !liveEngine; // a live set shown as its still (at boot)
    if (next.id === iconSetId && !upgrade) return;
    // A live set's chunk and first frame are ready before anything on screen changes
    const engine = next.kind === 'live' ? await loadLiveEngine(next.id, dock, wm.theme()).catch((e) => { console.warn('[iconset]', e); return null; }) : null;
    // Its first frame, for the apps the dock shows, is drawn before the crossfade starts
    engine?.prepare([...dock.querySelectorAll<HTMLElement>(':scope > .sd-dock-item:not(.sd-stack-tile)')]
      .map(b => ({ id: b.dataset.app ?? '', name: b.getAttribute('aria-label') ?? '' })));
    // The outgoing live set holds its last frame through the crossfade, and is released after it
    const outgoing = liveEngine;
    outgoing?.freeze();
    engine?.hold(true);
    // Preparation ends here: let the browser paint before the crossfade begins
    if (engine) await new Promise(r => setTimeout(r));
    const apply = () => {
      liveEngine = engine;
      iconSetId = next.id;
      dock.dataset.iconset = next.id;
      saveIconSet(next.id);
      renderDock();
    };
    await crossfadeDock(apply);
    engine?.hold(false);
    outgoing?.dispose();
    for (const cb of iconSetListeners) cb(next.id);
  }));
  /**
   * Run `fn` under a 0.3 s crossfade of the dock: a copy of the old dock, in
   * place over the new one, fades out (opacity only: the compositor's work, no
   * layout or paint per frame; a View Transition's capture cost 60–80 ms frames
   * without a GPU). Instant with reduced motion.
   */
  const crossfadeDock = async (fn: () => void): Promise<void> => {
    performance.mark('shiro:iconset:swap-start');
    if (prefersReducedMotion() || !revealed) { fn(); performance.mark('shiro:iconset:swap-end'); return; }
    const r = dock.getBoundingClientRect(), rr = root.getBoundingClientRect();
    const ghost = dock.cloneNode(true) as HTMLElement;
    ghost.classList.add('sd-dock-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.removeAttribute('aria-label');
    ghost.style.cssText = `left:${r.left - rr.left}px;top:${r.top - rr.top}px;width:${r.width}px;height:${r.height}px`;
    // A live set's tiles: canvas pixels don't clone
    const from = dock.querySelectorAll('canvas'), to = ghost.querySelectorAll('canvas');
    from.forEach((c, i) => { try { to[i]?.getContext('2d')?.drawImage(c, 0, 0); } catch {} });
    root.append(ghost);
    fn();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    ghost.classList.add('sd-out');
    await new Promise<void>(r => { ghost.addEventListener('transitionend', () => r(), { once: true }); setTimeout(r, 400); });
    ghost.remove();
    performance.mark('shiro:iconset:swap-end');
  };
  document.addEventListener('pointerdown', (e) => {
    if (openStackEl && !openStackEl.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.sd-stack-tile')) closeStack();
  }, true);
  window.addEventListener('resize', () => queueDock());
  let dockQueued = false;
  const queueDock = () => {
    if (dockQueued) return;
    dockQueued = true;
    queueMicrotask(() => { dockQueued = false; renderDock(); });
  };
  wm.on('apps-changed', queueDock);
  wm.on('window-created', queueDock);
  wm.on('window-closed', queueDock);
  renderDock();
  layout.relayout = () => { wm.relayout(); queueDock(); };

  // ── Touch devices: the extra-keys bar and visual-viewport layout (own chunk) ──
  if (coarse) {
    const keysBtn = el('button', 'sd-mb-item sd-mb-status sd-mb-keys', GLYPHS.keyboard);
    keysBtn.title = 'Extra keys';
    menubar.insertBefore(keysBtn, searchBtn);
    hold(import('./mobile').then((m) => {
      const paint = (mode: string) => {
        keysBtn.classList.toggle('sd-on', mode !== 'off');
        keysBtn.setAttribute('aria-pressed', String(mode !== 'off'));
        keysBtn.setAttribute('aria-label', mode === 'off' ? 'Show extra keys' : 'Hide extra keys');
      };
      // Off ↔ the last "on" mode (Auto, or Always from Settings)
      let lastOn = m.keybarMode() === 'pinned' ? 'pinned' as const : 'auto' as const;
      keysBtn.addEventListener('click', () => {
        const cur = m.keybarMode();
        if (cur !== 'off') lastOn = cur;
        m.setKeybarMode(cur === 'off' ? lastOn : 'off');
      });
      m.onKeybarMode(paint);
      paint(m.keybarMode());
      m.initMobile(ctx, layout);
    }));
  }

  // ── Menu bar behaviour ──
  const focusedApp = () => wm.app(wm.focused()?.appId);
  const updateAppName = () => {
    const w = wm.focused();
    appBtn.textContent = focusedApp()?.name ?? (w ? (w.title || 'App') : 'Desktop');
  };
  wm.on('focus-changed', updateAppName);
  updateAppName();

  const systemMenu = (): MenuSpec => ({ title: 'System', items: [
    { label: 'About This Computer', action: () => void wm.openApp('about') },
    'separator',
    { label: 'Settings…', shortcut: 'Alt+Shift+,', action: () => void wm.openApp('settings') },
    { label: 'Activity', action: () => void wm.openApp('activity') },
    'separator',
    { label: 'Classic Terminal', action: () => { try { localStorage.setItem('tabcomputer-ui', 'terminal'); } catch {} reloadAfterFlush(); } },
    { label: 'Restart', action: () => reloadAfterFlush() },
    { label: 'Hard Restart', action: () => void hardRestart() },
  ] });
  const termView = (): TerminalView | null => {
    const c = (wm.focused() as { content?: unknown } | null)?.content;
    return c instanceof TerminalView ? c : null;
  };
  const menus = (): MenuSpec[] => {
    const w = wm.focused();
    const file: MenuSpec = { title: 'File', items: [
      { label: 'New Terminal Window', shortcut: 'Alt+Shift+Enter', action: () => openTerminal({ cwd: '/home/user' }) },
      { label: 'New Tab', shortcut: 'Alt+Shift+T', disabled: !termView(), action: () => termView()?.newTab() },
      { label: 'New Files Window', shortcut: 'Alt+Shift+F', action: () => void wm.openApp('files') },
      'separator',
      { label: 'Clone Repository…', action: () => void import('./gitsheets').then(m => m.openCloneSheet(ctx)) },
      { label: 'Git', action: () => void wm.openApp('git') },
      'separator',
      { label: 'Close Window', shortcut: 'Alt+Shift+W', disabled: !w, action: () => w?.close() },
    ] };
    const edit: MenuSpec = { title: 'Edit', items: [
      { label: 'Copy', action: () => { const t = termView()?.activeTerminal(); const s = t?.term.getSelection() || String(getSelection() ?? ''); if (s) navigator.clipboard?.writeText(s).catch(() => {}); } },
      { label: 'Paste', disabled: !termView(), action: () => { const t = termView()?.activeTerminal(); navigator.clipboard?.readText().then(s => t?.term.paste(s)).catch(() => {}); } },
      { label: 'Select All', disabled: !termView(), action: () => termView()?.activeTerminal()?.term.selectAll() },
    ] };
    const pref = wm.themePreference();
    const view: MenuSpec = { title: 'View', items: [
      { label: 'Light', checked: pref === 'light', action: () => wm.setTheme('light') },
      { label: 'Dark', checked: pref === 'dark', action: () => wm.setTheme('dark') },
      { label: 'Match System', checked: pref === 'system', action: () => wm.setTheme('system') },
    ] };
    const windowMenu: MenuSpec = { title: 'Window', items: [
      { label: 'Minimize', shortcut: 'Alt+Shift+M', disabled: !w, action: () => w?.minimize() },
      { label: 'Zoom', shortcut: 'Alt+Shift+↑', disabled: !w, action: () => w?.zoom() },
      { label: 'Tile Left', shortcut: 'Alt+Shift+←', disabled: !w, action: () => w?.snap('left') },
      { label: 'Tile Right', shortcut: 'Alt+Shift+→', disabled: !w, action: () => w?.snap('right') },
      { label: 'Top Left Quarter', shortcut: 'Ctrl+Alt+U', disabled: !w, action: () => w?.snap('top-left') },
      { label: 'Top Right Quarter', shortcut: 'Ctrl+Alt+I', disabled: !w, action: () => w?.snap('top-right') },
      { label: 'Bottom Left Quarter', shortcut: 'Ctrl+Alt+J', disabled: !w, action: () => w?.snap('bottom-left') },
      { label: 'Bottom Right Quarter', shortcut: 'Ctrl+Alt+K', disabled: !w, action: () => w?.snap('bottom-right') },
      { label: 'Cycle Windows', shortcut: 'Alt+`', action: () => wm.cycle() },
      'separator',
      ...wm.visibleOrder().map(x => ({ label: x.title || x.appId || x.id, checked: x === w, action: () => x.focus() })),
    ] };
    const help: MenuSpec = { title: 'Help', items: [
      { label: 'Search…', shortcut: 'Ctrl+Space', action: () => openSpotlight() },
      { label: 'Welcome Tour', action: () => showTour(ctx) },
      { label: 'Getting Started', action: () => openTerminal({ command: 'help' }) },
      { label: 'Keyboard Shortcuts', action: () => showToast(root, SHORTCUTS_HTML, 9000) },
      { label: 'Desktop & /dom docs', action: () => window.open('https://github.com/williamsharkey/tabcomputer/blob/main/docs/DESKTOP.md', '_blank', 'noopener') },
    ] };
    return [file, edit, view, windowMenu, ...(focusedApp()?.menus?.() ?? []), help];
  };
  const renderMenus = () => {
    menusEl.textContent = '';
    for (const m of menus()) {
      const b = el('button', 'sd-mb-item', m.title);
      b.addEventListener('click', (e) => { e.stopPropagation(); toggleBarMenu(b, () => menus().find(x => x.title === m.title) ?? m); });
      b.addEventListener('pointerenter', () => { if (openBarButton && openBarButton !== b) toggleBarMenu(b, () => menus().find(x => x.title === m.title) ?? m); });
      menusEl.append(b);
    }
  };
  let openBarButton: HTMLElement | null = null;
  const toggleBarMenu = (b: HTMLElement, spec: () => MenuSpec) => {
    if (openBarButton === b) { closeMenu(); return; }
    const r = b.getBoundingClientRect();
    openMenu(spec(), r.left, r.bottom + 4);
    openBarButton = b;
    b.classList.add('sd-open');
  };
  logoBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleBarMenu(logoBtn, systemMenu); });
  logoBtn.addEventListener('pointerenter', () => { if (openBarButton && openBarButton !== logoBtn) toggleBarMenu(logoBtn, systemMenu); });
  appBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const a = focusedApp();
    toggleBarMenu(appBtn, () => ({ title: a?.name ?? 'Desktop', items: [
      { label: `About ${a?.name ?? 'This Computer'}`, action: () => void wm.openApp('about') },
      'separator',
      { label: `Hide ${a?.name ?? 'Windows'}`, disabled: !a, action: () => wm.visibleOrder().filter(w => w.appId === a?.id).forEach(w => w.minimize()) },
      { label: `Quit ${a?.name ?? ''}`.trim(), disabled: !a, action: () => wm.visibleOrder().filter(w => w.appId === a?.id).forEach(w => w.close()) },
    ] }));
  });
  wm.on('focus-changed', renderMenus);
  renderMenus();

  // Menus (shared by menu bar and dock)
  let menuEl: HTMLElement | null = null;
  const closeMenu = () => {
    menuEl?.remove();
    menuEl = null;
    openBarButton?.classList.remove('sd-open');
    openBarButton = null;
  };
  const openMenu = ctx.openMenu = (spec: MenuSpec, x: number, y: number, above = false) => {
    closeMenu();
    const m = el('div', 'sd-menu');
    m.setAttribute('role', 'menu');
    for (const it of spec.items) {
      if (it === 'separator') { m.append(el('div', 'sd-menu-sep')); continue; }
      const item = it as MenuItem;
      const b = el('button', 'sd-menu-item');
      b.setAttribute('role', 'menuitem');
      b.disabled = !!item.disabled;
      b.innerHTML = `<span class="sd-check">${item.checked ? '✓' : ''}</span><span class="sd-label"></span>${item.shortcut ? `<span class="sd-shortcut">${item.shortcut}</span>` : ''}`;
      b.querySelector('.sd-label')!.textContent = item.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); item.action?.(); });
      m.append(b);
    }
    m.addEventListener('keydown', (e) => {
      const items = [...m.querySelectorAll<HTMLButtonElement>('.sd-menu-item:not(:disabled)')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    });
    root.append(m);
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = `${Math.max(6, Math.min(x, window.innerWidth - w - 6))}px`;
    m.style.top = `${Math.max(6, above ? y - h : y)}px`;
    menuEl = m;
  };
  document.addEventListener('pointerdown', (e) => {
    if (menuEl && !menuEl.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.sd-mb-item')) closeMenu();
  }, true);

  // ── Clock ──
  // Formatted by hand: creating Intl formatters costs ~10 ms on the boot path
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const tick = () => {
    const d = new Date();
    const h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
    const time = `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
    clock.textContent = wm.compact ? time : `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}  ${time}`;
  };
  tick();
  setTimeout(() => { tick(); setInterval(tick, 60_000); }, 60_000 - (Date.now() % 60_000));
  clock.addEventListener('pointerenter', () => { clock.title = new Date().toLocaleDateString(undefined, { dateStyle: 'full' }); }, { once: true });

  // ── Theme ──
  const paintTheme = () => {
    const t = wm.theme();
    themeBtn.innerHTML = t === 'dark' ? GLYPHS.moon : GLYPHS.sun;
    themeBtn.title = t === 'dark' ? 'Dark appearance (click for light)' : 'Light appearance (click for dark)';
    themeBtn.setAttribute('aria-label', themeBtn.title);
    // The browser chrome and status bar match the (solid, on phones) menu bar
    meta?.setAttribute('content', t === 'dark' ? THEME_COLOR.dark : THEME_COLOR.light);
    // The page behind the desktop (seen before it appears) matches too
    document.documentElement.classList.toggle('sd-theme-light', t === 'light');
    statusBarMeta?.setAttribute('content', t === 'dark' ? 'black-translucent' : 'default');
    applyTerminalTheme(t, mainTerm ? [mainTerm] : []);
    // One-bit's bitmaps carry their ink; a live set redraws in the new palette
    if (iconSetId === 'pixel') queueDock();
    liveEngine?.setTheme(t);
  };
  themeBtn.addEventListener('click', () => wm.setTheme(wm.theme() === 'dark' ? 'light' : 'dark'));
  wm.on('theme-changed', paintTheme);
  paintTheme();

  // ── Network ──
  initNetwork(wm, deps.fs, netBtn, deps.kernel);
  // Claude Code's sign-in shows as a desktop sheet (accounts.ts, loaded when asked for)
  setClaudeSignInUI((o) => import('./accounts').then(m => m.openClaudeSheet(wm, deps.fs, o)));
  // Previews of in-tab servers are Preview windows (preview.ts, loaded when asked for); in the dock while open
  wm.registerApp({ id: 'preview', name: 'Preview', icon: ICONS.browser, glyph: glyphFor('browser') ?? undefined, order: 89, dock: false, launch: () => wm.visibleOrder().find(w => w.appId === 'preview') ?? null });
  setPreviewUI({
    open: (port, path, title) => import('./preview').then(m => m.openPreview(ctx, port, path, title)).then(() => {}),
    listening: (port, title) => void import('./preview').then(m => m.notifyListening(ctx, port, title)),
  });
  // Any server that stays up a second gets the offer: in-page node, node workers, emulated
  // programs (python3 -m http.server) all publish their ports on the page's port table
  iframeServer.onPortChange((port, up) => {
    if (!up || !revealed) return;
    setTimeout(() => { if (iframeServer.isPortInUse(port)) void import('./preview').then(m => m.notifyListening(ctx, port)); }, 1000);
  });

  // ── Keyboard shortcuts (capture: before xterm sees them) ──
  window.addEventListener('keydown', (e) => {
    if (!isDesktopShortcut(e)) return;
    const w = wm.focused();
    let handled = true;
    if (e.code === 'Backquote') wm.cycle(e.shiftKey);
    else if (e.code === 'Space') openSpotlight();
    else if (e.metaKey) {
      if (e.code === 'KeyN') openTerminal({ cwd: '/home/user' });
      else if (e.code === 'KeyW') w?.close();
      else handled = false;
    } else if (e.ctrlKey && e.altKey) {
      const q = ({ KeyU: 'top-left', KeyI: 'top-right', KeyJ: 'bottom-left', KeyK: 'bottom-right' } as const)[e.code as 'KeyU'];
      if (q) w?.snap(q); else handled = false;
    } else switch (e.code) {
      case 'Enter': openTerminal({ cwd: '/home/user' }); break;
      case 'KeyT': termView() ? termView()!.newTab() : openTerminal({ cwd: '/home/user' }); break;
      case 'KeyW': w?.close(); break;
      case 'KeyM': w?.minimize(); break;
      case 'KeyF': void wm.openApp('files'); break;
      case 'Comma': void wm.openApp('settings'); break;
      case 'ArrowUp': w?.zoom(); break;
      case 'ArrowDown': if (w?.state === 'maximized' || w?.state?.startsWith('snapped')) w.restore(); else w?.minimize(); break;
      case 'ArrowLeft': w?.snap('left'); break;
      case 'ArrowRight': w?.snap('right'); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  window.addEventListener('resize', () => { tick(); });

  // The launcher is its own chunk, loaded on first use
  const openSpotlight = () => { void import('./spotlight').then(m => m.toggleSpotlight(ctx)); };
  searchBtn.addEventListener('click', (e) => { e.stopPropagation(); openSpotlight(); });

  deps.fs.onStorageFull((full) => {
    if (full) showToast(root, '<b>Storage is full</b><div class="sd-small">The browser refused to save more. Delete files (or apt clean) to free space; Settings → Storage shows usage.</div>', 12000);
  });

  return {
    wm,
    ctx,
    attachMainTerminal(term: ShiroTerminal) {
      root.append(wordmark, menubar, dockWrap);
      mainTerm = term;
      term.banner = (t) => drawWelcome(t);
      first.view.attachMain(term);
      // One draw: the desktop stays hidden (the page's boot mark shows) until
      // the fonts, the dock's contents, the phone layer and last session's
      // windows are in place, then appears in a single frame. Nothing moves after.
      const terms = () => [...new Set([term, ...allTerminalViews().flatMap(v => v.terminals())])];
      if (document.fonts?.load) {
        hold(Promise.all([document.fonts.load('13px Inter'), document.fonts.load('14px "JetBrains Mono"')])
          // xterm measured the fallback if the font arrived after it was created
          .then(() => fontsAtBoot ? undefined : useMonoFont(terms)));
      }
      hold(restoreSession(wm, session, openTerminal).finally(() => {
        // The main terminal keeps focus (and the menu bar its app name)
        first.win.focus();
        trackSession(wm);
      }));
      const reveal = () => {
        if (revealed) return;
        revealed = true;
        // Windows opened while hidden appear in place, without their open animation
        for (const w of root.querySelectorAll('.sd-opening')) w.classList.remove('sd-opening');
        void root.offsetHeight; // settle those styles while transitions are still off
        root.classList.remove('sd-booting');
        document.getElementById('boot-mark')?.remove();
        term.term.focus();
        performance.mark('shiro:desktop:revealed');
        // A first visit gets the tour
        setTimeout(() => maybeShowTour(ctx), 1200);
        // A live icon set showed its still so far: bring it to life (crossfaded)
        if (iconSet(iconSetId).kind === 'live') void switchIconSet(iconSetId);
      };
      const cap = new Promise<void>(r => setTimeout(r, REVEAL_CAP_MS));
      // holds can add holds (a restored window loading its app): wait until they stop growing
      const settle = async (): Promise<void> => {
        const n = holds.length;
        await Promise.all(holds);
        if (holds.length !== n) return settle();
      };
      void Promise.race([settle(), cap]).then(() => requestAnimationFrame(reveal));
    },
    holdReveal: hold,
  };
}

/** Solid menu bar colors on phones (desktop.css .sd-compact .sd-menubar), also the theme-color */
const THEME_COLOR = { dark: '#161824', light: '#f4f4f8' };

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const SHORTCUTS_HTML = `<b>Keyboard shortcuts</b><div class="sd-small sd-muted" style="margin-top:6px;line-height:1.7">
Alt+Shift+Enter — new terminal window<br>Alt+Shift+T — new tab<br>Alt+Shift+W — close window<br>
Alt+Shift+M — minimize · Alt+Shift+↑ zoom<br>Alt+Shift+← / → — tile left / right<br>Ctrl+Alt+U / I / J / K — quarters<br>Alt+\` — cycle windows<br>
Ctrl+Space — search · Alt+Shift+F — Files · Alt+Shift+, — Settings<br>Cmd+N, Cmd+W, Cmd+\` too, where the browser lets them through</div>`;

export function showToast(root: HTMLElement, html: string, ms = 5000): void {
  const t = el('div', 'sd-toast', html);
  t.setAttribute('role', 'status');
  root.append(t);
  const close = () => t.remove();
  t.addEventListener('click', close);
  setTimeout(close, ms);
}

/** The terminal's first words on the desktop: short, with something to try. */
function drawWelcome(t: ShiroTerminal): void {
  const link = (text: string, cmd = text) => `\x1b]8;;shiro://cmd/${encodeURIComponent(cmd)}\x07\x1b[38;5;117m${text}\x1b[0m\x1b]8;;\x07`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const narrow = t.term.cols < 72;
  t.term.write(`\x1b[1m${BRAND.domain}\x1b[0m ${dim(narrow ? '— Unix in a browser tab.' : `— ${BRAND.tagline}. Real shell, real packages.`)}\r\n`);
  t.term.write(`${dim('try:')} ${link('apt install cowsay', `apt install cowsay && cowsay hello from ${BRAND.domain}`)} ${dim('·')} ${link('htop', 'apt install htop && htop')} ${dim('·')} ${link('python3', 'apt install python3 && python3')} ${dim('·')} ${link('ls /dom')} ${dim('·')} ${link('help')}\r\n\r\n`);
}

/**
 * Restart past the browser's HTTP cache (DevTools' "Hard Reload"): fetch the
 * page fresh, then load it with a one-off query so nothing in between serves
 * an old copy. Only cached downloads of the page itself are skipped: files,
 * settings, installed packages (IndexedDB) and the Debian/app download caches
 * (Cache Storage) are untouched.
 */
export async function hardRestart(): Promise<void> {
  // Files written so far reach storage first (close doesn't wait for IndexedDB)
  await Promise.all([flushStorage(), fetch(location.href, { cache: 'reload' }).catch(() => { /* offline: reload anyway */ })]);
  const url = new URL(location.href);
  url.searchParams.set('reload', Date.now().toString(36));
  location.replace(url.toString());
}
