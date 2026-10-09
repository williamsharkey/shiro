/**
 * Browser: a browser shell on the host browser's own engine (docs/BROWSER.md).
 * Tabs are iframes on per-site browse origins; the broker (src/browser/broker.ts)
 * does their networking with TLS in the page over the TCP relay.
 */
import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { OriginMap } from '../../browser/origin-map';
import { CookieJar, type Cookie } from '../../browser/cookies';
import { Broker, type BrokerTab } from '../../browser/broker';
import { setTrustRoots } from '../../browser/tls';
import { kvGet, kvSet } from '../../browser/kv';
import type { ByteStream } from '../../browser/http1';
import type { Dialer } from '../../browser/netfetch';
import { AF_INET, SOCK_STREAM, errnoName, netStack, netStackOf, type KSocket } from '../../kernel/net';
import type { Kernel } from '../../kernel/kernel';

interface HistoryEntry { url: string; title: string; t: number }

const STYLE = `
.sd-br-tabs { display: flex; gap: 4px; padding: 6px 8px 0; overflow-x: auto; flex: 0 0 auto; border-bottom: 1px solid var(--sd-sep); }
.sd-br-tab { display: flex; align-items: center; gap: 6px; max-width: 200px; min-width: 90px; height: 30px; padding: 0 8px 0 12px; border: 1px solid var(--sd-sep); border-bottom: 0; border-radius: 8px 8px 0 0; background: transparent; color: var(--sd-text-2); font: inherit; font-size: 12.5px; cursor: default; }
.sd-br-tab.sd-active { background: var(--sd-field); color: var(--sd-text); }
.sd-br-tab span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.sd-br-tab i { font-style: normal; opacity: .6; padding: 0 3px; border-radius: 4px; }
.sd-br-tab i:hover { background: var(--sd-hover); opacity: 1; }
.sd-br-addr { flex: 1; min-width: 0; }
.sd-br-banner { display: none; align-items: center; gap: 10px; padding: 8px 12px; background: color-mix(in srgb, #f5b400 22%, var(--sd-window)); border-bottom: 1px solid var(--sd-sep); font-size: 13px; }
.sd-br-banner.sd-on { display: flex; }
.sd-br-banner span { flex: 1; }
.sd-br-view { position: relative; flex: 1; min-height: 0; background: #fff; }
.sd-br-view iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: none; background: #fff; }
.sd-br-view iframe.sd-active { display: block; }
.sd-br-panel { position: absolute; inset: 0; overflow: auto; background: var(--sd-window); color: var(--sd-text); z-index: 2; display: none; }
.sd-br-panel.sd-on { display: block; }
.sd-br-panel a { color: var(--sd-accent); }
.sd-br-status { flex: 0 0 auto; font-size: 11px; color: var(--sd-text-3); padding: 2px 10px; border-top: 1px solid var(--sd-sep); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

const FALLBACK_TEXT: Record<string, string> = {
  webauthn: 'This site asked for a passkey. Passkeys belong to the site\'s real address, so they only work in a real tab.',
  'google-signin': 'Google sign-in refuses browsers it can\'t verify. Sign in from a real tab.',
  tls: 'This site only speaks TLS 1.2; this browser does TLS 1.3 only for now.',
  unproxyable: 'This address can\'t be shown here.',
  'no-service-worker': 'The host browser blocked this site\'s service worker (third-party storage blocked?).',
};

let shared: Promise<Engine> | null = null;

/** One broker, cookie jar and history for every Browser window. */
class Engine {
  broker!: Broker;
  map!: OriginMap;
  app = '';
  jar = new CookieJar();
  history: HistoryEntry[] = [];
  bookmarks: { url: string; title: string }[] = [];
  tabs = new Set<Tab>();
  error = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  static async create(kernel: Kernel): Promise<Engine> {
    const e = new Engine();
    let cfg: { origin: string | null; app?: string } = { origin: null };
    try { cfg = await (await fetch('browse/config.json', { cache: 'no-store' })).json(); } catch { /* old server */ }
    if (!cfg.origin) { e.error = 'This server has no browse origins (SHIRO_BROWSE_ORIGIN), so pages can only open in real tabs.'; return e; }
    e.map = new OriginMap(cfg.origin);
    e.app = cfg.app || location.origin;
    e.jar = CookieJar.fromJSON(await kvGet<Record<string, Cookie[]>>('cookies').catch(() => undefined));
    e.jar.onChange = () => e.saveSoon();
    e.history = (await kvGet<HistoryEntry[]>('history').catch(() => undefined)) ?? [];
    e.bookmarks = (await kvGet<{ url: string; title: string }[]>('bookmarks').catch(() => undefined)) ?? [];
    await e.loadRoots();
    const stack = netStackOf(kernel) ?? netStack;
    e.broker = new Broker({ map: e.map, app: e.app, dial: kernelDialer(stack), jar: e.jar, tabs: () => [...e.tabs] });
    e.broker.start();
    return e;
  }

  async loadRoots() {
    const extra = (await kvGet<string>('extraRoots').catch(() => undefined)) ?? '';
    setTrustRoots(async () => (await fetch('browse/cacert.pem')).text(), extra);
  }

  async setExtraRoots(pem: string) { await kvSet('extraRoots', pem); await this.loadRoots(); }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void kvSet('cookies', this.jar.toJSON()).catch(() => {});
      void kvSet('history', this.history.slice(-5000)).catch(() => {});
      void kvSet('bookmarks', this.bookmarks).catch(() => {});
    }, 1000);
  }

  visit(url: string, title: string) {
    const last = this.history[this.history.length - 1];
    if (last && last.url === url) { if (title) last.title = title; }
    else this.history.push({ url, title, t: Date.now() });
    this.saveSoon();
  }
}

function kernelDialer(stack: typeof netStack): Dialer {
  return async (host, port) => {
    const s = stack.socket(AF_INET, SOCK_STREAM) as KSocket;
    if (typeof s === 'number') throw new Error(`socket: ${errnoName(-s)}`);
    const r = await s.connectHost(host, port);
    if (r < 0) { void s.close(); throw new Error(`connect ${host}:${port}: ${errnoName(-r)}`); }
    const stream: ByteStream = {
      async read() {
        const buf = new Uint8Array(64 * 1024);
        const n = await s.read(buf);
        return n > 0 ? buf.subarray(0, n) : undefined;
      },
      async write(d) {
        for (let off = 0; off < d.length;) {
          const n = await s.write(d.subarray(off));
          if (n < 0) throw new Error(`write: ${errnoName(-n)}`);
          off += n;
        }
      },
      close() { void s.close(); },
    };
    return stream;
  };
}

let nextTab = 1;

class Tab implements BrokerTab {
  readonly id = nextTab++;
  partition: string | null = null;
  bytes = 0;
  requests = 0;
  url = '';
  title = 'New Tab';
  stack: string[] = [];
  index = -1;
  traversing: string | null = null;
  fallback: { reason: string; url: string } | null = null;
  iframe: HTMLIFrameElement | null = null;
  button: HTMLButtonElement;
  constructor(private ui: BrowserWindow) {
    this.button = document.createElement('button');
    this.button.className = 'sd-br-tab';
    this.button.innerHTML = '<span></span><i title="Close tab">×</i>';
    this.button.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName === 'I') ui.closeTab(this); else ui.select(this);
    });
    this.render();
  }
  frame() { return this.iframe; }
  render() {
    this.button.querySelector('span')!.textContent = this.title || this.url || 'New Tab';
    this.button.title = this.url;
  }
  load(realUrl: string) {
    const target = this.ui.engine.map.toBrowse(realUrl);
    this.fallback = null;
    if (!target) { this.onFallback('unproxyable', realUrl); return; }
    if (!this.iframe) {
      const f = document.createElement('iframe');
      // allow-same-origin keeps the frame on its browse origin (so its service worker runs); the
      // origin is never the desktop's, so this does not give it the desktop. No allow-top-navigation.
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation');
      f.setAttribute('allow', 'fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture');
      f.setAttribute('referrerpolicy', 'no-referrer');
      this.iframe = f;
      f.classList.toggle('sd-active', this.ui.active === this);
      this.ui.view.append(f);
    }
    this.url = realUrl;
    this.iframe.src = target;
    this.ui.refresh();
  }
  onUrl(url: string) {
    this.url = url;
    if (this.traversing === url) this.traversing = null;
    else if (this.stack[this.index] !== url) { this.stack.splice(this.index + 1); this.stack.push(url); this.index = this.stack.length - 1; }
    this.ui.engine.visit(url, '');
    this.ui.refresh();
  }
  onTitle(title: string) {
    this.title = title;
    this.ui.engine.visit(this.url, title);
    this.render();
    this.ui.refresh();
  }
  onFallback(reason: string, url: string) {
    this.fallback = { reason, url };
    this.ui.refresh();
  }
  openTab(url: string) { this.ui.newTab(url); }
  go(delta: number) {
    const i = this.index + delta;
    if (i < 0 || i >= this.stack.length) return;
    this.index = i;
    this.traversing = this.stack[i];
    this.load(this.stack[i]);
  }
}

class BrowserWindow {
  root = document.createElement('div');
  view!: HTMLElement;
  tabs: Tab[] = [];
  active: Tab | null = null;
  win!: DesktopWindow;
  private addr!: HTMLInputElement;
  private banner!: HTMLElement;
  private panel!: HTMLElement;
  private status!: HTMLElement;
  private tabStrip!: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;

  engine!: Engine;
  constructor(private ready: Promise<Engine>) { void ready.then((e) => { this.engine = e; }); }

  build(ctx: AppContext): DesktopWindow {
    if (!document.getElementById('sd-br-style')) {
      const st = document.createElement('style');
      st.id = 'sd-br-style';
      st.textContent = STYLE;
      document.head.append(st);
    }
    const r = this.root;
    r.className = 'sd-app';
    r.innerHTML = `
      <div class="sd-br-tabs"><button class="sd-btn sd-icon-btn" data-act="new" title="New tab">+</button></div>
      <div class="sd-toolbar">
        <button class="sd-btn sd-icon-btn" data-act="back" title="Back">‹</button>
        <button class="sd-btn sd-icon-btn" data-act="fwd" title="Forward">›</button>
        <button class="sd-btn sd-icon-btn" data-act="reload" title="Reload">⟳</button>
        <input class="sd-input sd-br-addr" spellcheck="false" placeholder="Search or enter address" list="sd-br-hist">
        <datalist id="sd-br-hist"></datalist>
        <button class="sd-btn sd-icon-btn" data-act="star" title="Bookmark this page">☆</button>
        <button class="sd-btn" data-act="real" title="Open this page in a real browser tab">Open in real tab</button>
        <button class="sd-btn sd-icon-btn" data-act="menu" title="History, bookmarks, settings">☰</button>
      </div>
      <div class="sd-br-banner"><span></span><button class="sd-btn sd-primary" data-act="real">Open in a real tab</button><button class="sd-btn" data-act="dismiss">Dismiss</button></div>
      <div class="sd-br-view"><div class="sd-br-panel"></div></div>
      <div class="sd-br-status"></div>`;
    this.tabStrip = r.querySelector('.sd-br-tabs')!;
    this.view = r.querySelector('.sd-br-view')!;
    this.addr = r.querySelector('.sd-br-addr')!;
    this.banner = r.querySelector('.sd-br-banner')!;
    this.panel = r.querySelector('.sd-br-panel')!;
    this.status = r.querySelector('.sd-br-status')!;
    r.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      const t = this.active;
      switch (act) {
        case 'new': this.newTab(''); break;
        case 'back': t?.go(-1); break;
        case 'fwd': t?.go(1); break;
        case 'reload': if (t?.url) t.load(t.url); break;
        case 'real': { const u = t?.fallback?.url || t?.url; if (u) window.open(u, '_blank', 'noopener'); break; }
        case 'dismiss': if (t) { t.fallback = null; this.refresh(); } break;
        case 'star': if (this.engine) this.toggleBookmark(); break;
        case 'menu': if (this.engine) this.togglePanel(); break;
      }
    });
    this.addr.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !this.engine) return;
      const url = normalizeInput(this.addr.value);
      if (!url) return;
      this.panel.classList.remove('sd-on');
      (this.active ?? this.newTab('')).load(url);
      this.addr.blur();
    });
    this.win = ctx.wm.createWindow({
      appId: 'browser', title: 'Browser', width: 1000, height: 680, minWidth: 360, content: { kind: 'dom', element: r },
    });
    (this.win as { content?: unknown }).content = this;
    this.win.on('close', () => {
      for (const t of this.tabs) this.engine?.tabs.delete(t);
      if (this.timer) clearInterval(this.timer);
    });
    this.timer = setInterval(() => this.renderStatus(), 1000);
    void this.ready.then((e) => { if (engineError(e)) this.showMessage(e.error); });
    return this.win;
  }

  /** desktop.openApp('browser', { url }) on an open window */
  navigate(args: Record<string, unknown>) {
    if (typeof args.url === 'string') this.newTab(args.url);
  }

  newTab(url: string): Tab {
    const t = new Tab(this);
    this.tabs.push(t);
    this.tabStrip.insertBefore(t.button, this.tabStrip.lastElementChild);
    this.select(t);
    const real = normalizeInput(url);
    void this.ready.then((e) => {
      e.tabs.add(t);
      if (real && !engineError(e)) t.load(real);
      else this.addr.focus();
    });
    return t;
  }

  closeTab(t: Tab) {
    const i = this.tabs.indexOf(t);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    this.engine?.tabs.delete(t);
    t.iframe?.remove();
    t.button.remove();
    if (this.active === t) this.select(this.tabs[Math.max(0, i - 1)] ?? null);
    if (!this.tabs.length) this.win.close();
  }

  select(t: Tab | null) {
    this.active = t;
    for (const x of this.tabs) {
      x.button.classList.toggle('sd-active', x === t);
      x.iframe?.classList.toggle('sd-active', x === t);
    }
    this.refresh();
  }

  refresh() {
    const t = this.active;
    if (document.activeElement !== this.addr) this.addr.value = t?.url ?? '';
    this.win?.setTitle(t?.title ? `${t.title}` : 'Browser');
    const fb = t?.fallback;
    this.banner.classList.toggle('sd-on', !!fb);
    if (fb) this.banner.querySelector('span')!.textContent = FALLBACK_TEXT[fb.reason] ?? `This page needs a real tab (${fb.reason}).`;
    if (!this.engine) return;
    const starred = !!t?.url && this.engine.bookmarks.some((b) => b.url === t.url);
    this.root.querySelector('[data-act=star]')!.textContent = starred ? '★' : '☆';
    const dl = this.root.querySelector('#sd-br-hist')!;
    const seen = new Set<string>();
    const opts: string[] = [];
    for (let i = this.engine.history.length - 1; i >= 0 && opts.length < 50; i--) {
      const u = this.engine.history[i].url;
      if (seen.has(u)) continue;
      seen.add(u);
      opts.push(`<option value="${escHtml(u)}"></option>`);
    }
    dl.innerHTML = opts.join('');
    this.renderStatus();
  }

  renderStatus() {
    const t = this.active;
    if (!t) { this.status.textContent = ''; return; }
    const s = this.engine.broker?.fetcher.stats;
    this.status.textContent = `${t.requests} requests · ${(t.bytes / 1048576).toFixed(2)} MB` + (s ? ` · ${s.connects} connections (${s.reused} reused)` : '');
  }

  showMessage(text: string) {
    this.panel.classList.add('sd-on');
    this.panel.innerHTML = `<div class="sd-panel"><h2>Browser</h2><p class="sd-muted">${escHtml(text)}</p></div>`;
  }

  toggleBookmark() {
    const t = this.active;
    if (!t?.url) return;
    const i = this.engine.bookmarks.findIndex((b) => b.url === t.url);
    if (i >= 0) this.engine.bookmarks.splice(i, 1); else this.engine.bookmarks.push({ url: t.url, title: t.title });
    this.engine.saveSoon();
    this.refresh();
  }

  togglePanel() {
    if (this.panel.classList.toggle('sd-on')) this.renderPanel();
  }

  renderPanel() {
    const e = this.engine;
    const link = (u: string, title: string) => `<div class="sd-row"><a href="#" data-open="${escHtml(u)}">${escHtml(title || u)}</a><span class="sd-muted sd-small sd-grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(u)}</span></div>`;
    const hist = e.history.slice(-100).reverse();
    this.panel.innerHTML = `<div class="sd-panel" style="max-width:820px">
      <h2>Bookmarks</h2><div class="sd-card">${e.bookmarks.map((b) => link(b.url, b.title)).join('') || '<span class="sd-muted">None yet: ☆ adds the page you are on.</span>'}</div>
      <h3>History</h3><div class="sd-card">${hist.map((h) => link(h.url, h.title)).join('') || '<span class="sd-muted">Nothing yet.</span>'}</div>
      <h3>Privacy</h3><div class="sd-card"><div class="sd-row"><span class="sd-grow">${e.jar.all().length} cookies in ${e.jar.partitions().length} sites</span><button class="sd-btn" data-p="clear-cookies">Clear cookies</button><button class="sd-btn" data-p="clear-history">Clear history</button></div></div>
      <h3>Certificates</h3><div class="sd-card"><p class="sd-small sd-muted">Extra trusted root certificates (PEM), for example a company proxy's. Pages are otherwise checked against Mozilla's roots.</p>
        <textarea class="sd-input" style="width:100%;height:90px;font-size:11px" data-p="roots"></textarea>
        <div class="sd-row"><button class="sd-btn" data-p="save-roots">Save</button></div></div>
    </div>`;
    void kvGet<string>('extraRoots').then((v) => { (this.panel.querySelector('[data-p=roots]') as HTMLTextAreaElement).value = v ?? ''; });
    this.panel.onclick = (ev) => {
      const el = ev.target as HTMLElement;
      const open = el.closest<HTMLElement>('[data-open]')?.dataset.open;
      if (open) { ev.preventDefault(); this.panel.classList.remove('sd-on'); (this.active ?? this.newTab('')).load(open); return; }
      const p = el.dataset.p;
      if (p === 'clear-cookies') { e.jar.clear(); this.renderPanel(); }
      if (p === 'clear-history') { e.history = []; e.saveSoon(); this.renderPanel(); }
      if (p === 'save-roots') void e.setExtraRoots((this.panel.querySelector('[data-p=roots]') as HTMLTextAreaElement).value);
    };
  }
}

function engineError(e: Engine): boolean { return !!e.error; }

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Address-bar text → URL: URLs as they are, host-like text with https://, anything else a search. */
export function normalizeInput(text: string): string {
  const s = text.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) { try { return new URL(s).href; } catch { /* search */ } }
  if (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) { try { return new URL('https://' + s).href; } catch { /* search */ } }
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(s)}`;
}

export function open(ctx: AppContext, args?: Record<string, unknown>): DesktopWindow {
  shared ??= Engine.create(ctx.kernel);
  const bw = new BrowserWindow(shared);
  const win = bw.build(ctx);
  void shared.then((engine) => { (window as any).__shiroBrowser = { engine, window: bw, broker: engine.broker }; });
  bw.newTab(typeof args?.url === 'string' ? args.url : '');
  return win;
}
