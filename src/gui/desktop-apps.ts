/**
 * Debian GUI apps in the desktop's dock (src/gui/apps.ts). The first click
 * installs the app with a progress window, then starts it; its X windows
 * carry the app's id, so later clicks focus them.
 */
import type { DesktopAPI, DesktopWindow } from '../desktop/wm';
import type { FileSystem } from '../filesystem';
import type { Kernel } from '../kernel/kernel';

/** id, name, in the dock (apps checked in Chromium), icon glyph */
const APPS: [string, string, boolean, string][] = [
  ['xterm', 'XTerm', true, 'X'],
  ['l3afpad', 'L3afpad', true, '✎'],
  ['ristretto', 'Ristretto', false, '▣'],
  ['featherpad', 'FeatherPad', true, '✐'],
  ['lximage-qt', 'LXImage-Qt', false, '▤'],
  ['mousepad', 'Mousepad', false, '✎'],
  ['gpicview', 'GPicView', true, '▣'],
  ['xeyes', 'xeyes', true, '◉'],
  ['xclock', 'xclock', false, '◷'],
  ['xcalc', 'xcalc', false, '±'],
  ['xedit', 'xedit', false, '✎'],
];

function icon(glyph: string, hue: number): string {
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="40" height="40" rx="10" fill="hsl(${hue} 45% 42%)"/>` +
    `<text x="24" y="31" font-size="20" text-anchor="middle" fill="#fff" font-family="sans-serif">${glyph}</text></svg>`;
}

export function registerGuiApps(wm: DesktopAPI, fs: FileSystem, kernel: Kernel): void {
  APPS.forEach(([id, name, dock, glyph], i) => {
    wm.registerApp({
      id, name, dock, order: 60 + i, icon: icon(glyph, (i * 47) % 360),
      launch: () => launch(wm, fs, kernel, id, name),
    });
  });
}

async function launch(wm: DesktopAPI, fs: FileSystem, kernel: Kernel, id: string, name: string): Promise<DesktopWindow | null> {
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
