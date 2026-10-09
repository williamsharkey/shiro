/**
 * Debian GUI apps on the desktop (src/gui/apps.ts). The dock's "Apps" entry
 * opens the Apps window (apps-sheet.ts), which lists them with sizes and
 * installs them; installed apps get their own dock icons. Opening an app
 * that isn't installed (`openApp`) installs it with a progress window first.
 * Its X windows carry the app's id, so later clicks focus them.
 */
import type { DesktopAPI, DesktopWindow } from '../desktop/wm';
import type { FileSystem } from '../filesystem';
import type { Kernel } from '../kernel/kernel';
import type { SheetApp } from './apps-sheet';

/** id, name, icon (public/gui/icons/, from the package: gen-apps.py) or a glyph, listed in the Apps window, note */
const APPS: [string, string, string, boolean, string?][] = [
  ['l3afpad', 'L3afpad', 'gui/icons/l3afpad.png', true],
  ['mousepad', 'Mousepad', 'gui/icons/mousepad.png', true],
  ['featherpad', 'FeatherPad', 'gui/icons/featherpad.svg', true],
  ['ristretto', 'Ristretto', 'gui/icons/ristretto.png', true],
  ['gpicview', 'GPicView', 'gui/icons/gpicview.png', true],
  ['gimp', 'GIMP', 'gui/icons/gimp.png', true, 'first start takes a few minutes'],
  ['inkscape', 'Inkscape', 'gui/icons/inkscape.svg', true, 'first start takes a few minutes'],
  ['dillo', 'Dillo', 'gui/icons/dillo.png', true],
  ['netsurf', 'NetSurf', 'gui/icons/netsurf.png', true],
  ['xterm', 'XTerm', 'gui/icons/xterm.svg', true],
  ['xeyes', 'xeyes', '◉', true],
  ['xclock', 'xclock', '◷', true],
  ['xcalc', 'xcalc', '±', true],
  ['xedit', 'xedit', '✎', true],
  // exits at once without a D-Bus session bus (docs/GUI.md)
  ['lximage-qt', 'LXImage-Qt', 'gui/icons/lximage-qt.png', false],
];

function glyphIcon(glyph: string, hue: number): string {
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="40" height="40" rx="10" fill="hsl(${hue} 45% 42%)"/>` +
    `<text x="24" y="31" font-size="20" text-anchor="middle" fill="#fff" font-family="sans-serif">${glyph}</text></svg>`;
}

/** The Apps entry: a tile like the desktop's own icons (icons.ts) with a grid of apps */
const APPS_ICON = `<span class="sd-tile" style="--t1:#5b8cff;--t2:#7a4dff"><svg viewBox="3 3 58 58" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
  [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => `<rect x="${15 + c * 12.5}" y="${15 + r * 12.5}" width="9" height="9" rx="2.6" fill="#fff" fill-opacity="${r === 1 && c === 1 ? 1 : 0.86}"/>`)).join('') +
  `</svg></span>`;

/** Registers the apps; resolves once the installed ones are in the dock */
export function registerGuiApps(wm: DesktopAPI, fs: FileSystem, kernel: Kernel): Promise<void> {
  const icons = APPS.map(([, , icon], i) => icon.includes('/') ? icon : glyphIcon(icon, (i * 47) % 360));
  const register = (installed: Set<string>) => APPS.forEach(([id, name], i) => {
    wm.registerApp({
      id, name, dock: installed.has(id), order: 60 + i, icon: icons[i],
      launch: () => launch(wm, fs, kernel, id, name, refresh),
    });
  });
  const refresh = async () => {
    // nothing installed yet (no GUI app status, no dpkg): no need to load the installer
    if (!(await fs.exists('/var/lib/shiro-gui/status.json').catch(() => false)) && !(await fs.exists('/var/lib/dpkg/status').catch(() => false))) return register(new Set());
    const apps = await import('./apps');
    const installed = new Set<string>();
    for (const [id] of APPS) if (await apps.isAppInstalled(fs, id).catch(() => false)) installed.add(id);
    register(installed);
  };
  const sheet: SheetApp[] = APPS.filter((a) => a[3]).map(([id, name, , , note]) => ({ id, name, icon: icons[APPS.findIndex((a) => a[0] === id)], note }));
  wm.registerApp({
    id: 'apps', name: 'Apps', icon: APPS_ICON, order: 19,
    launch: async () => (await import('./apps-sheet')).openAppsSheet(wm, fs, kernel, sheet, () => void refresh()),
  });
  register(new Set());
  // installs from the shell (`gui install`) too
  fs.onChange((_ev, path) => { if (path === '/var/lib/shiro-gui/status.json') void refresh(); });
  return refresh();
}

async function launch(wm: DesktopAPI, fs: FileSystem, kernel: Kernel, id: string, name: string, installed: () => void): Promise<DesktopWindow | null> {
  const apps = await import('./apps');
  let progress: DesktopWindow | null = null;
  if (!(await apps.isAppInstalled(fs, id))) {
    const body = document.createElement('div');
    body.style.cssText = 'padding:18px;font:13px system-ui,sans-serif;display:flex;flex-direction:column;gap:10px';
    const label = document.createElement('div');
    label.textContent = `Downloading ${name} from Debian…`;
    const bar = document.createElement('progress');
    bar.max = 1; bar.value = 0; bar.style.width = '100%';
    body.append(label, bar);
    progress = wm.createWindow({ title: `Installing ${name}`, appId: id, width: 360, height: 90, resizable: false, content: { kind: 'dom', element: body } });
    try {
      await apps.installApp(fs, kernel, id, (p) => {
        if (p.phase === 'triggers') { label.textContent = `Setting up ${name}…`; bar.removeAttribute('value'); return; }
        bar.value = p.totalBytes ? p.bytes / p.totalBytes : p.done / Math.max(1, p.total);
        label.textContent = `Downloading ${name} from Debian… ${p.done}/${p.total} packages, ${(p.bytes / 1e6).toFixed(1)} of ${(p.totalBytes / 1e6).toFixed(1)} MB`;
      });
    } catch (e) {
      label.textContent = `Could not install ${name}: ${(e as Error).message}`;
      return progress;
    }
    installed();
    label.textContent = `Starting ${name}…`;
  }
  const p = await apps.launchApp(kernel, id);
  if (progress) {
    // close the progress window when the app's first window appears (or it exits)
    const done = () => { off(); progress?.close(true); };
    const off = wm.on('window-created', (w) => { if (w && w.appId === id && w !== progress) done(); });
    void p.exited.then(done);
  }
  return progress;
}
