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
import type { FileSystem } from '../filesystem';
import type { Shell } from '../shell';
import { ShiroTerminal } from '../terminal';
import type { Kernel } from '../kernel/kernel';
import { WindowManager, isDesktopShortcut, type AppDescriptor, type DesktopWindow, type MenuSpec, type MenuItem, type Geometry } from './wm';
import { ICONS, GLYPHS, appIcon } from './icons';
import { TerminalView, takeParkedMain, hasParkedMain, applyTerminalTheme, useMonoFont, allTerminalViews, terminalTheme, TERMINAL_FONT } from './terminal-app';
import { initNetwork } from './network';
import { BRAND } from '../brand';

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
}

export interface Desktop {
  wm: WindowManager;
  /** Hand over the main terminal once main.ts has created it in terminalEl */
  attachMainTerminal(term: ShiroTerminal): void;
  ctx: AppContext;
}

/** Programs shown in the dock as terminal apps (installed or one click from it) */
const FEATURED_PACKAGES: { pkg: string; cmd: string; name: string }[] = [
  { pkg: 'vim', cmd: 'vim', name: 'Vim' },
  { pkg: 'htop', cmd: 'htop', name: 'htop' },
  { pkg: 'python3', cmd: 'python3', name: 'Python' },
];
/** Shown too once installed */
const OPTIONAL_PACKAGES: { pkg: string; cmd: string; name: string }[] = [
  { pkg: 'neovim', cmd: 'nvim', name: 'Neovim' },
  { pkg: 'emacs', cmd: 'emacs', name: 'Emacs' },
  { pkg: 'nano', cmd: 'nano', name: 'nano' },
  { pkg: 'tmux', cmd: 'tmux', name: 'tmux' },
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
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; font-display: swap; src: url('/fonts/inter-latin-wght.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 100 800; font-display: swap; src: url('/fonts/jetbrains-mono-latin-wght.woff2') format('woff2'); }`;
  document.head.appendChild(style);
}

export function bootDesktop(deps: DesktopDeps): Desktop {
  const style = el('style');
  style.id = 'sd-style';
  style.textContent = desktopCss;
  document.head.appendChild(style);
  injectFonts();
  document.body.classList.add('sd-active');
  const meta = document.querySelector('meta[name="theme-color"]');

  const root = el('div', 'sd-desktop');
  root.id = 'shiro-desktop';
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
  const themeBtn = el('button', 'sd-mb-item sd-mb-status');
  const netBtn = el('button', 'sd-mb-item sd-mb-status');
  const clock = el('div', 'sd-mb-item sd-mb-clock');
  menubar.append(logoBtn, appBtn, menusEl, spacer, themeBtn, netBtn, clock);

  // ── Dock ──
  const dockWrap = el('div', 'sd-dock-wrap');
  const dock = el('nav', 'sd-dock');
  dock.setAttribute('aria-label', 'Dock');
  dockWrap.append(dock);
  // The menu bar and dock join the page right after the main terminal is created
  // (attachMainTerminal): xterm's first measurement then lays out only the window

  // The page's terminal-first layout stays in the DOM (hidden): #terminal moves into a window
  document.body.appendChild(root);

  // From the CSS sizes (--sd-menubar-h, --sd-dock-h, --sd-dock-gap), not layout reads:
  // measuring here would force a full style and layout pass before the terminal exists
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const workArea = (): Geometry => {
    const compact = window.innerWidth <= 640;
    const top = compact ? 34 : 30;
    // The touch toolbar (mobile-input.ts) sits at the very bottom; the dock goes above it
    const vkeys = coarse ? document.getElementById('shiro-vkeys') : null;
    const vk = vkeys ? vkeys.offsetHeight : 0;
    dockWrap.style.bottom = vk ? `${vk + 6}px` : '';
    const dockSpace = (compact ? 58 + 6 : 68 + 8) + (vk ? vk + 6 - (compact ? 6 : 8) : 0) + 8;
    const bottom = Math.max(top + 120, window.innerHeight - dockSpace);
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
  const ctx: AppContext = { wm, fs: deps.fs, shell: deps.shell, kernel: deps.kernel, openTerminal };

  // Terminals start in the desktop's palette and font (no re-theme, re-measure later)
  ShiroTerminal.optionOverrides = { theme: terminalTheme(wm.theme()), fontFamily: TERMINAL_FONT };

  // The first window: the main terminal, front and center
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
    { id: 'settings', name: 'Settings', icon: ICONS.settings, order: 2, launch: focusOrLaunch('settings', lazy(() => import('./apps/settings'))) },
    { id: 'activity', name: 'Activity', icon: ICONS.activity, order: 3, launch: focusOrLaunch('activity', lazy(() => import('./apps/activity'))) },
    { id: 'about', name: 'About This Computer', icon: ICONS.about, order: 90, dock: false, launch: focusOrLaunch('about', lazy(() => import('./apps/about'))) },
  ];
  for (const a of apps) wm.registerApp(a);

  // Terminal programs as apps
  let installed = new Set<string>();
  const registerPackages = () => {
    const list = [...FEATURED_PACKAGES, ...OPTIONAL_PACKAGES.filter(p => installed.has(p.pkg))];
    list.forEach((p, i) => wm.registerApp({
      id: p.pkg, name: p.name, icon: appIcon(p.pkg), order: 20 + i,
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
  void refreshInstalled();
  deps.fs.onChange((_ev, path) => { if (path === PKG_STATUS) void refreshInstalled(); });

  // ── Dock rendering ──
  const renderDock = () => {
    dock.textContent = '';
    const running = new Set(wm.windows().filter(w => w.state !== 'closed' && !w.options.override && !w.options.skipTaskbar).map(w => w.appId));
    const all = wm.apps();
    const core = all.filter(a => a.dock !== false && (a.order ?? 100) < 20);
    const pkgs = all.filter(a => a.dock !== false && (a.order ?? 100) >= 20);
    const extra = [...running].filter(id => id && !all.some(a => a.id === id && a.dock !== false));
    const add = (id: string, name: string, icon: string | undefined, launch: () => void) => {
      const b = el('button', 'sd-dock-item');
      b.dataset.app = id;
      b.setAttribute('aria-label', name);
      b.innerHTML = (icon?.trim().startsWith('<') ? icon : icon ? `<img src="${icon}" alt="">` : appIcon(id)) + `<span class="sd-dock-tip">${name}</span>`;
      if (running.has(id)) b.classList.add('sd-running');
      if (FEATURED_PACKAGES.some(p => p.pkg === id) && !installed.has(id)) {
        b.classList.add('sd-not-installed');
        b.querySelector('.sd-dock-tip')!.textContent = `${name} — click to install`;
      }
      b.addEventListener('click', () => {
        const wins = wm.visibleOrder().filter(w => w.appId === id);
        if (wins.length) {
          const top = wins.find(w => w.state !== 'minimized') ?? wins[0];
          if (wm.focused() === top && wins.length === 1 && id !== 'terminal') top.minimize();
          else top.focus();
          return;
        }
        if (!prefersReducedMotion()) { b.classList.add('sd-launching'); setTimeout(() => b.classList.remove('sd-launching'), 900); }
        launch();
      });
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
    for (const a of core) add(a.id, a.name, a.icon, () => void wm.openApp(a.id));
    if (pkgs.length) dock.append(el('div', 'sd-dock-sep'));
    for (const a of pkgs) add(a.id, a.name, a.icon, () => void wm.openApp(a.id));
    if (extra.length) {
      dock.append(el('div', 'sd-dock-sep'));
      for (const id of extra) {
        const w = wm.visibleOrder().find(x => x.appId === id);
        add(id!, w?.title || id!, w?.options.icon, () => w?.focus());
      }
    }
  };
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
    { label: 'Classic Terminal', action: () => { try { localStorage.setItem('shiro-ui', 'terminal'); } catch {} location.reload(); } },
    { label: 'Restart', action: () => location.reload() },
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
      { label: 'Cycle Windows', shortcut: 'Alt+`', action: () => wm.cycle() },
      'separator',
      ...wm.visibleOrder().map(x => ({ label: x.title || x.appId || x.id, checked: x === w, action: () => x.focus() })),
    ] };
    const help: MenuSpec = { title: 'Help', items: [
      { label: 'Getting Started', action: () => openTerminal({ command: 'help' }) },
      { label: 'Keyboard Shortcuts', action: () => showToast(root, SHORTCUTS_HTML, 9000) },
      { label: 'Desktop & /dom docs', action: () => window.open('https://github.com/williamsharkey/shiro/blob/main/docs/DESKTOP.md', '_blank', 'noopener') },
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
  const openMenu = (spec: MenuSpec, x: number, y: number, above = false) => {
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
    meta?.setAttribute('content', t === 'dark' ? '#0c0f1f' : '#eef0ff');
    applyTerminalTheme(t, mainTerm ? [mainTerm] : []);
  };
  themeBtn.addEventListener('click', () => wm.setTheme(wm.theme() === 'dark' ? 'light' : 'dark'));
  wm.on('theme-changed', paintTheme);
  paintTheme();

  // ── Network ──
  initNetwork(wm, deps.fs, netBtn, deps.kernel);

  // ── Keyboard shortcuts (capture: before xterm sees them) ──
  window.addEventListener('keydown', (e) => {
    if (!isDesktopShortcut(e)) return;
    const w = wm.focused();
    let handled = true;
    if (e.code === 'Backquote') wm.cycle(e.shiftKey);
    else switch (e.code) {
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

  return {
    wm,
    ctx,
    attachMainTerminal(term: ShiroTerminal) {
      root.append(wordmark, menubar, dockWrap);
      mainTerm = term;
      term.banner = (t) => drawWelcome(t);
      first.view.attachMain(term);
      // After boot settles: the swap re-measures every terminal (a forced layout)
      const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200));
      idle(() => useMonoFont(() => [...new Set([term, ...allTerminalViews().flatMap(v => v.terminals())])]), { timeout: 1500 });
      // Focusing forces a layout of the whole desktop: do it with the first frame
      requestAnimationFrame(() => term.term.focus());
    },
  };
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const SHORTCUTS_HTML = `<b>Keyboard shortcuts</b><div class="sd-small sd-muted" style="margin-top:6px;line-height:1.7">
Alt+Shift+Enter — new terminal window<br>Alt+Shift+T — new tab<br>Alt+Shift+W — close window<br>
Alt+Shift+M — minimize · Alt+Shift+↑ zoom<br>Alt+Shift+← / → — tile left / right<br>Alt+\` — cycle windows<br>
Alt+Shift+F — Files · Alt+Shift+, — Settings</div>`;

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
