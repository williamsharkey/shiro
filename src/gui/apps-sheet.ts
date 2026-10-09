/**
 * The desktop's "Apps" window: the Debian GUI apps (public/gui/apps.json)
 * with their icons and download sizes; one click installs an app with
 * progress, and installed apps open from here or from their dock icon.
 */
import type { DesktopAPI, DesktopWindow } from '../desktop/wm';
import type { FileSystem } from '../filesystem';
import type { Kernel } from '../kernel/kernel';
import type { InstallProgress } from './apps';

export interface SheetApp { id: string; name: string; icon: string; note?: string }

const mb = (b: number) => b >= 10e6 ? `${Math.round(b / 1e6)} MB` : `${(b / 1e6).toFixed(1)} MB`;
const TOOLKIT: Record<string, string> = { gtk3: 'GTK 3', gtk2: 'GTK 2', qt5: 'Qt 5', fltk: 'FLTK', x11: 'X11' };

const CSS = `
.sg-sheet { overflow: auto; padding: 18px 20px 20px; gap: 14px; }
.sg-head h2 { font-size: 19px; font-weight: 700; letter-spacing: -.01em; }
.sg-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.sg-app { display: grid; grid-template-columns: 52px 1fr auto; gap: 4px 12px; align-items: center; padding: 12px; border-radius: 12px; background: var(--sd-field); }
.sg-icon { width: 52px; height: 52px; grid-row: span 2; display: flex; align-items: center; justify-content: center; }
.sg-icon img, .sg-icon svg, .sg-icon .sd-tile { width: 48px; height: 48px; object-fit: contain; }
.sg-name { font-weight: 600; font-size: 14px; }
.sg-desc { grid-column: 2 / 4; font-size: 12px; color: var(--sd-text-2); line-height: 1.35; }
.sg-meta { grid-column: 2 / 4; font-size: 11.5px; color: var(--sd-text-3); display: flex; gap: 8px; align-items: center; min-height: 16px; }
.sg-meta progress { flex: 1; height: 6px; }
.sg-app .sd-btn { min-width: 64px; justify-content: center; }
`;

export function openAppsSheet(wm: DesktopAPI, fs: FileSystem, kernel: Kernel, list: SheetApp[], onInstalled: (id: string) => void): DesktopWindow {
  const existing = wm.windows().find((w) => w.appId === 'apps');
  if (existing) { existing.focus(); return existing; }
  const root = document.createElement('div');
  root.className = 'sd-app sg-sheet';
  root.tabIndex = -1;
  root.innerHTML = `<style>${CSS}</style>
    <div class="sg-head"><h2>Apps</h2>
    <div class="sd-small sd-muted">Linux desktop apps from Debian 12, running in this tab. Downloads are cached in your browser and shared between apps.</div></div>
    <div class="sg-list"><div class="sd-small sd-muted">Loading…</div></div>`;
  const listEl = root.querySelector('.sg-list')!;
  const win = wm.createWindow({ appId: 'apps', title: 'Apps', width: 660, height: 640, content: { kind: 'dom', element: root } });
  const unsubs: (() => void)[] = [];
  const offClose = wm.on('window-closed', (w) => { if (w === win) { unsubs.forEach((u) => u()); offClose(); } });
  void render();
  return win;

  async function render(): Promise<void> {
    const apps = await import('./apps');
    let m;
    try { m = await apps.guiManifest(); } catch (e) {
      listEl.innerHTML = '';
      listEl.append(Object.assign(document.createElement('div'), { className: 'sd-small sd-muted', textContent: `Could not load the app list: ${(e as Error).message}` }));
      return;
    }
    listEl.textContent = '';
    // after any install, every card's download size can shrink (shared packages)
    const refreshers: (() => Promise<void>)[] = [];
    const refreshAll = () => { for (const r of refreshers) void r(); };
    for (const a of list) {
      const info = m.apps[a.id];
      if (!info) continue;
      const card = document.createElement('div');
      card.className = 'sg-app';
      card.dataset.app = a.id;
      const icon = document.createElement('div');
      icon.className = 'sg-icon';
      icon.innerHTML = a.icon.trim().startsWith('<') ? a.icon : `<img src="${a.icon}" alt="">`;
      const name = Object.assign(document.createElement('div'), { className: 'sg-name', textContent: a.name });
      const btn = Object.assign(document.createElement('button'), { className: 'sd-btn' });
      const desc = Object.assign(document.createElement('div'), { className: 'sg-desc', textContent: info.description });
      const meta = Object.assign(document.createElement('div'), { className: 'sg-meta' });
      card.append(icon, name, btn, desc, meta);
      listEl.append(card);

      const showProgress = (p: InstallProgress) => {
        btn.disabled = true;
        btn.textContent = 'Installing';
        meta.textContent = '';
        const bar = document.createElement('progress');
        bar.max = 1;
        if (p.phase === 'triggers' || p.phase === 'done') bar.removeAttribute('value');
        else bar.value = p.totalBytes ? p.bytes / p.totalBytes : p.done / Math.max(1, p.total);
        const text = p.phase === 'triggers' || p.phase === 'done' ? 'Setting up…' : `${mb(p.bytes)} of ${mb(p.totalBytes)}`;
        meta.append(bar, text);
      };
      const showState = async () => {
        const installed = await apps.isAppInstalled(fs, a.id);
        btn.disabled = false;
        meta.textContent = '';
        const facts = [TOOLKIT[info.toolkit] ?? info.toolkit];
        if (installed) {
          btn.textContent = 'Open';
          btn.classList.remove('sd-primary');
          facts.push('Installed');
        } else {
          const { bytes } = await apps.pendingDownload(fs, a.id);
          btn.textContent = 'Get';
          btn.classList.add('sd-primary');
          facts.push(bytes < info.size ? `${mb(bytes)} download (shares ${mb(info.size - bytes)} with your apps)` : `${mb(bytes)} download`);
        }
        if (a.note) facts.push(a.note);
        meta.textContent = facts.join(' · ');
      };
      refreshers.push(async () => { if (!apps.installInProgress(a.id)) await showState(); });
      unsubs.push(apps.watchInstall(a.id, (p) => { showProgress(p); if (p.phase === 'done') setTimeout(refreshAll, 0); }));
      const running = apps.installInProgress(a.id);
      if (running) void running.then(showState, showState); else void showState();

      btn.addEventListener('click', async () => {
        if (btn.textContent === 'Open') { void wm.openApp(a.id); return; }
        btn.disabled = true;
        try {
          await apps.installApp(fs, kernel, a.id);
          onInstalled(a.id);
          refreshAll();
        } catch (e) {
          btn.disabled = false;
          meta.textContent = `Could not install: ${(e as Error).message}`;
        }
      });
    }
  }
}
