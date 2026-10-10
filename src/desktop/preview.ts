/**
 * Previews of in-tab servers on the desktop (docs/DESKTOP.md "Previews",
 * registered as the preview UI, src/preview-ui.ts). A Preview window shows
 * the server on a port in a real document at /__preview/<tab>/<port>/
 * (src/preview-sw-host.ts: ES modules, vite's HMR), or a srcdoc copy where
 * service workers aren't available. One window per port: asking again
 * focuses and navigates it. When the server stops the window says so, and
 * it reloads when a server is back on that port.
 *
 * A server that starts listening by itself (node's http, express, `npm run
 * dev`) gets a notification with an Open Preview button rather than a
 * window popping up over the terminal.
 */

import type { AppContext } from './index';
import type { DesktopWindow } from './wm';
import { iframeServer } from '../iframe-server';
import { previewUrl } from '../preview-sw-host';
import { PAGE_SET_TIMEOUT } from '../node-compat/page-globals';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const RELOAD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EXTERNAL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5L8 8M12 9.5v3.5H3V4h3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

interface Preview { win: DesktopWindow; port: number; navigate(path: string): Promise<void> }
const previews = new Map<number, Preview>();

/** Open (or focus and navigate) the Preview window of `port` */
export async function openPreview(ctx: AppContext, port: number, path = '/', title?: string): Promise<DesktopWindow> {
  offered.get(port)?.();
  const existing = previews.get(port);
  if (existing) {
    existing.win.focus();
    await existing.navigate(path);
    return existing.win;
  }
  const { wm } = ctx;
  const el = document.createElement('div');
  el.className = 'sd-app sd-preview';
  el.innerHTML = `
    <div class="sd-toolbar">
      <button class="sd-btn sd-icon-btn" data-act="reload" title="Reload" aria-label="Reload">${RELOAD}</button>
      <div class="sd-path sd-preview-addr"></div>
      <a class="sd-btn sd-icon-btn" data-act="tab" title="Open in a browser tab" aria-label="Open in a browser tab" target="_blank" rel="noopener" hidden>${EXTERNAL}</a>
    </div>
    <div class="sd-preview-body"></div>`;
  const body = el.querySelector<HTMLElement>('.sd-preview-body')!;
  const addr = el.querySelector<HTMLElement>('.sd-preview-addr')!;
  const tabLink = el.querySelector<HTMLAnchorElement>('[data-act=tab]')!;
  const name = title ? title.split('/').filter(Boolean).pop() : undefined;
  const label = (p: string) => `localhost:${port}${p}`;
  const win = wm.createWindow({ appId: 'preview', title: name ? `${name} — ${label(path)}` : label(path), width: 720, height: 560, minWidth: 320, minHeight: 200, content: { kind: 'dom', element: el } });
  let current = path;
  let iframe: HTMLIFrameElement | null = null;

  const load = async (p: string) => {
    current = p;
    addr.textContent = label(p);
    win.setTitle(name ? `${name} — ${label(p)}` : label(p));
    body.querySelector('.sd-preview-stopped')?.remove();
    iframe?.remove();
    const f = document.createElement('iframe');
    f.className = 'sd-preview-frame';
    f.setAttribute('data-virtual-port', String(port));
    f.setAttribute('data-virtual-path', p);
    f.title = label(p);
    iframe = f;
    body.appendChild(f);
    const url = await previewUrl(port, p);
    if (iframe !== f) return;
    if (url) {
      f.setAttribute('data-preview-sw', '');
      f.src = url;
      tabLink.href = url;
      tabLink.hidden = false;
    } else {
      // No service worker (file:, some private modes): the page's HTML, its resources by message
      const { injectIframeScripts } = await import('../commands/serve');
      const r = await iframeServer.fetch(port, p).catch(() => null);
      const html = typeof r?.body === 'string' ? r.body : r?.body instanceof Uint8Array ? new TextDecoder().decode(r.body) : '<!DOCTYPE html><html><body></body></html>';
      iframeServer.ensureResourceProxy();
      if (iframe === f) f.srcdoc = injectIframeScripts(html, port);
    }
    // Static `serve` reloads the frame on file changes through this
    const server = iframeServer.getServer(port);
    if (server) (server as { iframe?: HTMLIFrameElement }).iframe = f;
  };
  const stopped = () => {
    if (body.querySelector('.sd-preview-stopped')) return;
    const s = document.createElement('div');
    s.className = 'sd-preview-stopped';
    s.innerHTML = `<div><b>The server on port ${port} stopped.</b><div class="sd-small sd-muted">This window reloads when a server listens on ${port} again.</div>
      <div class="sd-row" style="justify-content:center;border:0;gap:8px;margin-top:10px"><button class="sd-btn" data-act="close" type="button">Close</button></div></div>`;
    body.appendChild(s);
    win.setTitle(`${name ? name + ' — ' : ''}${label(current)} (stopped)`);
  };
  el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'reload') void load(current);
    if (act === 'close') win.close();
  });
  const off = iframeServer.onPortChange((p, up) => {
    if (p !== port) return;
    if (up) void load(current); else stopped();
  });
  win.on('close', () => { off(); previews.delete(port); });
  previews.set(port, { win, port, navigate: load });

  // Beside the Terminal: the preview takes the right half, a centered Terminal the left
  if (!wm.compact) {
    const term = wm.visibleOrder().find(w => w.appId === 'terminal' && w.state === 'normal');
    win.snap('right');
    term?.snap('left');
  }
  if (iframeServer.isPortInUse(port)) await load(path); else { addr.textContent = label(path); stopped(); }
  return win;
}

// ── "A server is listening" ──

/** Ports with an open offer, and how to withdraw it */
const offered = new Map<number, () => void>();

/** A server started on `port`: reload its Preview if there is one, else offer one */
export function notifyListening(ctx: AppContext, port: number, title?: string): void {
  if (previews.has(port) || offered.has(port)) return;
  const t = document.createElement('div');
  t.className = 'sd-toast sd-preview-toast';
  t.setAttribute('role', 'status');
  // Callers name it "Server :3000" or "Express :3000": keep the name, not the port twice
  const who = (title ?? '').replace(/\s*:\d+$/, '').trim();
  const name = !who || /^server$/i.test(who) ? 'A server' : who;
  t.innerHTML = `<div class="sd-grow"><b>${esc(name)} is listening on port ${port}</b><div class="sd-small sd-muted">localhost:${port}</div></div>
    <button class="sd-btn sd-primary" data-act="open" type="button">Open Preview</button>
    <button class="sd-btn sd-icon-btn" data-act="dismiss" type="button" aria-label="Dismiss">×</button>`;
  const close = () => { t.remove(); offered.delete(port); offPort(); };
  // The offer goes when its server does
  const offPort = iframeServer.onPortChange((p, up) => { if (p === port && !up) close(); });
  t.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'open') { close(); void openPreview(ctx, port, '/', title); }
    if (act === 'dismiss') close();
  });
  offered.set(port, close);
  ctx.wm.root.appendChild(t);
  // (the page's timer: the global one, while an in-page node script runs, is the
  // script's and counted as its activity; its server stayed up 20 s before returning)
  PAGE_SET_TIMEOUT(close, 20_000);
}

/** For tests: the ports with a Preview window, and those offered */
export function previewState(): { open: number[]; offered: number[] } {
  return { open: [...previews.keys()], offered: [...offered.keys()] };
}
