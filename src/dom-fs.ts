/**
 * /dom: the live page as files, in the Plan 9 spirit (docs/DESKTOP.md).
 *
 *   /dom/ctl                      write JavaScript to evaluate it; read the last result
 *   /dom/<id-or-selector>/        an element: the element with that id, else
 *                                 the first match of the CSS selector
 *                                 (URL-encode '/' as %2F)
 *       text html outerhtml value tag rect count click
 *       attr/<name>  style/<prop>  children/<n>/…  <n>/… (nth match)
 *   /dom/events/<type>            events of that type, one line each: a live
 *                                 stream for kernel processes and `cat` at a
 *                                 terminal, the recent ones otherwise
 *   /dom/windows/<id>/            desktop windows: title geometry state app kind ctl
 *   /dom/windows/ctl              `open <app>` opens an app's window
 *
 * Reads and writes are synchronous against the DOM. It is a FileSystem
 * virtual provider (so builtins see it) plus kernel devices for the event
 * streams (so a blocking read(2) waits for the next event).
 */

import type { FileSystem, StatResult, VirtualFSProvider } from './filesystem';
import { makeStat } from './filesystem';
import { BufferFile } from './kernel/fd';
import type { Kernel } from './kernel/kernel';
import type { DesktopAPI, DesktopWindow } from './desktop/wm';

/** Event types with a live kernel device (other types still have the recent-events file). */
export const DOM_EVENT_TYPES = [
  'click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'mousemove', 'wheel',
  'pointerdown', 'pointerup', 'pointermove', 'keydown', 'keyup', 'input', 'change', 'submit',
  'focusin', 'focusout', 'scroll', 'resize', 'hashchange', 'visibilitychange', 'copy', 'paste',
  'window',
];

const ELEMENT_FILES = ['text', 'html', 'outerhtml', 'value', 'tag', 'rect', 'count', 'click', 'attr', 'style', 'children'];
const WINDOW_FILES = ['title', 'geometry', 'state', 'app', 'kind', 'focused', 'ctl'];
const RECENT_MAX = 200;

class DomError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}

type Node =
  | { type: 'dir'; entries: () => string[] }
  | { type: 'file'; read: () => string; write?: (s: string) => void; stream?: string; /** exists for writing only */ absent?: boolean };

export class DomProvider implements VirtualFSProvider {
  /** Shown in `ls /` */
  readonly mountPoint = 'dom';
  private lastResult = '';
  private recent = new Map<string, string[]>();
  private recording = new Map<string, (e: Event) => void>();
  private streams = new Map<string, Set<(line: string) => void>>();
  private desktopUnsub: (() => void) | null = null;

  constructor(private getDesktop: () => DesktopAPI | null = () => null) {}

  handles(path: string): boolean {
    return path === '/dom' || path.startsWith('/dom/');
  }

  // ── VirtualFSProvider ──

  readFile(path: string, encoding?: 'utf8'): string | Uint8Array | null {
    const n = this.lookup(path);
    if (!n || n.type === 'dir') return null;
    if (n.absent) throw fsErr('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
    const s = n.read();
    return encoding === 'utf8' ? s : new TextEncoder().encode(s);
  }

  stat(path: string): StatResult | null {
    let n: Node | null;
    try { n = this.lookup(path); } catch { return null; }
    if (!n || (n.type === 'file' && n.absent)) return null;
    const now = Date.now();
    if (n.type === 'dir') return makeStat({ path, type: 'dir', content: null, mode: 0o755, mtime: now, ctime: now, size: 0 });
    let size = 0;
    if (!n.stream) { try { size = new TextEncoder().encode(n.read()).length; } catch {} }
    return makeStat({ path, type: 'file', content: null, mode: n.write ? 0o666 : 0o444, mtime: now, ctime: now, size });
  }

  readdir(path: string): string[] | null {
    const n = this.lookup(path);
    return n && n.type === 'dir' ? n.entries() : null;
  }

  exists(path: string): boolean {
    if (!this.handles(path)) return false;
    try { const n = this.lookup(path); return !!n && !(n.type === 'file' && n.absent); } catch { return false; }
  }

  writeFile(path: string, data: Uint8Array | string): boolean {
    if (!this.handles(path)) return false;
    const n = this.lookup(path);
    if (!n) return false; // the FileSystem then reports ENOENT
    if (n.type === 'dir') throw fsErr('EISDIR', `EISDIR: illegal operation on a directory, write '${path}'`);
    if (!n.write) throw fsErr('EACCES', `EACCES: permission denied, write '${path}'`);
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    try { n.write(text); } catch (e) {
      if (e instanceof DomError) throw fsErr(e.code, `${e.code}: ${e.message}, write '${path}'`);
      throw e;
    }
    return true;
  }

  // ── Event streams ──

  /** Subscribe to events of `type` as text lines. Returns unsubscribe. */
  subscribe(type: string, cb: (line: string) => void): () => void {
    this.record(type);
    let set = this.streams.get(type);
    if (!set) this.streams.set(type, set = new Set());
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  /** The event type a path streams, if it is an event file. */
  streamType(path: string): string | null {
    const m = /^\/dom\/events\/([A-Za-z0-9_-]+)$/.exec(path);
    return m ? m[1] : null;
  }

  /** Start keeping recent events of `type` (from the first time anyone looks at it). */
  private record(type: string): void {
    if (this.recording.has(type) || typeof window === 'undefined') return;
    const emit = (line: string) => {
      let buf = this.recent.get(type);
      if (!buf) this.recent.set(type, buf = []);
      buf.push(line);
      if (buf.length > RECENT_MAX) buf.splice(0, buf.length - RECENT_MAX);
      for (const cb of this.streams.get(type) ?? []) { try { cb(line); } catch {} }
    };
    if (type === 'window') {
      const d = this.getDesktop();
      const fn = () => {};
      this.recording.set(type, fn);
      if (d) {
        const offs = (['window-created', 'window-closed', 'focus-changed', 'window-changed'] as const).map(ev =>
          d.on(ev, w => emit(`${ev} t=${Math.round(performance.now())}${w ? ` id=${w.id} app=${w.appId ?? ''} state=${w.state} title=${quote(w.title)}` : ''}`)));
        this.desktopUnsub = () => offs.forEach(o => o());
      }
      return;
    }
    const fn = (e: Event) => emit(describeEvent(e));
    this.recording.set(type, fn);
    window.addEventListener(type, fn, true);
  }

  /** Stop all listeners (tests). */
  dispose(): void {
    for (const [type, fn] of this.recording) if (type !== 'window') window.removeEventListener(type, fn, true);
    this.recording.clear();
    this.desktopUnsub?.();
  }

  // ── Path resolution ──

  private lookup(path: string): Node | null {
    if (!this.handles(path)) return null;
    const parts = path.slice(4).split('/').filter(Boolean).map(decodePart);
    const doc = typeof document !== 'undefined' ? document : null;
    if (parts.length === 0) {
      return { type: 'dir', entries: () => {
        const ids = doc ? [...doc.querySelectorAll('[id]:not(svg [id])')].slice(0, 500).map(e => e.id).filter(id => id && !id.includes('/')) : [];
        return [...new Set(['ctl', 'events', 'windows', 'html', 'head', 'body', ...ids])];
      } };
    }
    const [top, ...rest] = parts;
    if (top === 'ctl' && rest.length === 0) {
      return { type: 'file', read: () => this.lastResult, write: (s) => this.evaluate(s) };
    }
    if (top === 'events') {
      if (rest.length === 0) return { type: 'dir', entries: () => [...new Set([...DOM_EVENT_TYPES, ...this.recording.keys()])] };
      if (rest.length === 1 && /^[A-Za-z0-9_-]+$/.test(rest[0])) {
        const type = rest[0];
        return { type: 'file', stream: type, read: () => { this.record(type); const r = this.recent.get(type); return r?.length ? r.join('\n') + '\n' : ''; } };
      }
      return null;
    }
    if (top === 'windows') return this.windowNode(rest);
    if (!doc) return null;
    const matches = selectAll(doc, top);
    if (!matches.length) return null;
    let el: Element = matches[0];
    let i = 0;
    if (rest[0] !== undefined && /^\d+$/.test(rest[0])) {
      const n = Number(rest[0]);
      if (n >= matches.length) return null;
      el = matches[n];
      i = 1;
    }
    // children/<n>/… walks down
    while (rest[i] === 'children' && rest[i + 1] !== undefined) {
      const c = el.children[Number(rest[i + 1])];
      if (!/^\d+$/.test(rest[i + 1]) || !c) return null;
      el = c;
      i += 2;
    }
    return this.elementNode(el, rest.slice(i), matches.length);
  }

  private elementNode(el: Element, rest: string[], count: number): Node | null {
    if (rest.length === 0) return { type: 'dir', entries: () => ELEMENT_FILES };
    const [f, arg, ...more] = rest;
    if (more.length) return null;
    const html = el as HTMLElement;
    switch (f) {
      case 'text': if (arg) return null;
        return { type: 'file', read: () => withNl(el.textContent ?? ''), write: (s) => { el.textContent = chomp(s); } };
      case 'html': if (arg) return null;
        return { type: 'file', read: () => withNl(el.innerHTML), write: (s) => { el.innerHTML = chomp(s); } };
      case 'outerhtml': if (arg) return null;
        return { type: 'file', read: () => withNl(el.outerHTML) };
      case 'value': if (arg) return null;
        return { type: 'file', read: () => withNl(String((el as HTMLInputElement).value ?? '')), write: (s) => {
          const input = el as HTMLInputElement;
          input.value = chomp(s);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } };
      case 'tag': if (arg) return null;
        return { type: 'file', read: () => el.tagName.toLowerCase() + '\n' };
      case 'count': if (arg) return null;
        return { type: 'file', read: () => `${count}\n` };
      case 'rect': if (arg) return null;
        return { type: 'file', read: () => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)}\n`; } };
      case 'click': if (arg) return null;
        return { type: 'file', read: () => '', write: () => { html.click?.(); } };
      case 'children':
        if (arg) return null; // children/<n> was consumed by lookup
        return { type: 'dir', entries: () => [...el.children].map((_, i) => String(i)) };
      case 'attr':
        if (!arg) return { type: 'dir', entries: () => [...el.attributes].map(a => a.name) };
        if (!el.hasAttribute(arg)) {
          // Writing creates it: the node exists for writes only
          return { type: 'file', absent: true, read: () => '', write: (s) => el.setAttribute(arg, chomp(s)) };
        }
        return { type: 'file', read: () => withNl(el.getAttribute(arg) ?? ''), write: (s) => el.setAttribute(arg, chomp(s)) };
      case 'style':
        if (!arg) return { type: 'dir', entries: () => { const s = html.style; const out: string[] = []; for (let i = 0; i < (s?.length ?? 0); i++) out.push(s[i]); return out; } };
        return { type: 'file',
          read: () => withNl(html.style?.getPropertyValue(arg) || (typeof getComputedStyle === 'function' ? getComputedStyle(el).getPropertyValue(arg) : '')),
          write: (s) => { const v = chomp(s).trim(); if (v) html.style.setProperty(arg, v); else html.style.removeProperty(arg); } };
      default:
        return null;
    }
  }

  private windowNode(rest: string[]): Node | null {
    const d = this.getDesktop();
    if (rest.length === 0) return { type: 'dir', entries: () => ['ctl', ...(this.getDesktop()?.windows().map(w => w.id) ?? [])] };
    if (rest[0] === 'ctl' && rest.length === 1) {
      return { type: 'file', read: () => (d ? d.apps().map(a => `open ${a.id}`).join('\n') + '\n' : ''), write: (s) => {
        if (!d) throw new DomError('ENODEV', 'no desktop on this page');
        for (const line of chomp(s).split('\n')) {
          const [cmd, ...args] = line.trim().split(/\s+/);
          if (!cmd) continue;
          if (cmd !== 'open' || !args[0]) throw new DomError('EINVAL', `unknown command '${line.trim()}'`);
          if (!d.apps().some(a => a.id === args[0])) throw new DomError('ENOENT', `no app '${args[0]}'`);
          void d.openApp(args[0], args.length > 1 ? { args: args.slice(1) } : undefined);
        }
      } };
    }
    if (!d) return null;
    const w = d.get(rest[0]);
    if (!w || w.state === 'closed') return null;
    if (rest.length === 1) return { type: 'dir', entries: () => WINDOW_FILES };
    if (rest.length > 2) return null;
    switch (rest[1]) {
      case 'title': return { type: 'file', read: () => withNl(w.title), write: (s) => w.setTitle(chomp(s)) };
      case 'geometry': return { type: 'file', read: () => { const g = w.geometry(); return `${g.x} ${g.y} ${g.width} ${g.height}\n`; }, write: (s) => {
        const n = chomp(s).trim().split(/\s+/).map(Number);
        if (n.length !== 4 || n.some(v => !Number.isFinite(v))) throw new DomError('EINVAL', 'expected "x y width height"');
        w.setGeometry({ x: n[0], y: n[1], width: n[2], height: n[3] });
      } };
      case 'state': return { type: 'file', read: () => w.state + '\n' };
      case 'app': return { type: 'file', read: () => (w.appId ?? '') + '\n' };
      case 'kind': return { type: 'file', read: () => w.kind + '\n' };
      case 'focused': return { type: 'file', read: () => (w.focused ? '1' : '0') + '\n' };
      case 'ctl': return { type: 'file', read: () => '', write: (s) => { for (const line of chomp(s).split('\n')) windowCtl(w, line); } };
      default: return null;
    }
  }

  private evaluate(code: string): void {
    code = code.trim();
    if (!code) return;
    let result: unknown;
    try {
      result = (0, eval)(code);
    } catch (e) {
      this.lastResult = `error: ${(e as Error)?.message ?? e}\n`;
      throw new DomError('EIO', `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? e}`);
    }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      this.lastResult = '(pending)\n';
      (result as Promise<unknown>).then(
        v => { this.lastResult = formatResult(v); },
        e => { this.lastResult = `error: ${e?.message ?? e}\n`; });
      return;
    }
    this.lastResult = formatResult(result);
  }
}

/** `close`, `move x y`, `resize w h`, `focus`, `minimize`, `maximize`/`zoom`, `restore`, `snap left|right`, `title …`. */
export function windowCtl(w: DesktopWindow, line: string): void {
  const [cmd, ...args] = line.trim().split(/\s+/);
  const nums = () => {
    const n = args.map(Number);
    if (n.length < 2 || n.some(v => !Number.isFinite(v))) throw new DomError('EINVAL', `${cmd} needs two numbers`);
    return n;
  };
  switch (cmd) {
    case undefined: case '': return;
    case 'close': w.close(); return;
    case 'move': { const [x, y] = nums(); w.move(x, y); return; }
    case 'resize': { const [a, b] = nums(); w.resize(a, b); return; }
    case 'focus': case 'raise': w.focus(); return;
    case 'minimize': w.minimize(); return;
    case 'maximize': w.maximize(); return;
    case 'zoom': w.zoom(); return;
    case 'restore': w.restore(); return;
    case 'snap': if (args[0] !== 'left' && args[0] !== 'right') throw new DomError('EINVAL', 'snap left|right'); w.snap(args[0]); return;
    case 'title': w.setTitle(line.trim().slice(5).trim()); return;
    default: throw new DomError('EINVAL', `unknown command '${cmd}'`);
  }
}

function fsErr(code: string, message: string): Error {
  const errnos: Record<string, number> = { ENOENT: -2, EIO: -5, EACCES: -13, EISDIR: -21, EINVAL: -22, ENODEV: -19 };
  const err = new Error(message) as Error & { code: string; errno: number };
  err.code = code;
  err.errno = errnos[code] ?? -5;
  return err;
}

function decodePart(p: string): string {
  if (!p.includes('%')) return p;
  try { return decodeURIComponent(p); } catch { return p; }
}

function selectAll(doc: Document, sel: string): Element[] {
  if (sel === 'html') return [doc.documentElement];
  if (sel === 'head' && doc.head) return [doc.head];
  if (sel === 'body' && doc.body) return [doc.body];
  const byId = doc.getElementById(sel);
  if (byId) return [byId];
  try { return [...doc.querySelectorAll(sel)]; } catch { return []; }
}

function chomp(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

function withNl(s: string): string {
  return s === '' || s.endsWith('\n') ? s : s + '\n';
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function formatResult(v: unknown): string {
  if (v === undefined) return '';
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof Element !== 'undefined' && v instanceof Element) s = v.outerHTML.slice(0, 2000);
  else { try { s = JSON.stringify(v, null, 2) ?? String(v); } catch { s = String(v); } }
  return withNl(s);
}

/** A short CSS-ish name for an event target: tag#id.class1.class2 */
export function describeTarget(t: EventTarget | null): string {
  if (!t || typeof (t as Element).tagName !== 'string') return t === window ? 'window' : t === document ? 'document' : '-';
  const el = t as Element;
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
  for (const c of cls) s += '.' + c;
  return s;
}

/** One line per event: `type t=ms target=… key=value…` */
export function describeEvent(e: Event): string {
  const parts = [e.type, `t=${Math.round(e.timeStamp)}`, `target=${describeTarget(e.target)}`];
  const anyE = e as any;
  if (typeof anyE.clientX === 'number') parts.push(`x=${Math.round(anyE.clientX)}`, `y=${Math.round(anyE.clientY)}`, `button=${anyE.button}`);
  if (typeof anyE.deltaY === 'number') parts.push(`dx=${Math.round(anyE.deltaX)}`, `dy=${Math.round(anyE.deltaY)}`);
  if (typeof anyE.key === 'string') parts.push(`key=${quote(anyE.key)}`, `code=${anyE.code}`);
  const mods = ['ctrl', 'alt', 'shift', 'meta'].filter(m => anyE[m + 'Key']);
  if (mods.length) parts.push(`mods=${mods.join(',')}`);
  if (e.type === 'input' || e.type === 'change') {
    const t = e.target as HTMLInputElement | null;
    if (t && 'value' in t) parts.push(`value=${t.type === 'password' ? '"(hidden)"' : quote(String(t.value).slice(0, 200))}`);
  }
  if (e.type === 'resize') parts.push(`w=${window.innerWidth}`, `h=${window.innerHeight}`);
  return parts.join(' ');
}

/** An open /dom/events/<type> device: each event is a line; reads block until one comes. */
class DomEventFile extends BufferFile {
  private unsub: () => void;
  constructor(provider: DomProvider, type: string, flags: number) {
    super(null, flags, { open: true, fifo: true });
    this.unsub = provider.subscribe(type, line => this.push(line + '\n'));
  }
  async close(): Promise<void> {
    this.unsub();
    this.end();
  }
  closeSync(): boolean {
    this.unsub();
    this.end();
    return true;
  }
}

let installed: DomProvider | null = null;

/**
 * Mount /dom on a FileSystem (and its event devices on a kernel). Safe to
 * call again: the second call returns the same provider.
 */
export function installDomFs(fs: FileSystem, kernel: Kernel | null, getDesktop: () => DesktopAPI | null): DomProvider {
  if (installed) return installed;
  const p = new DomProvider(getDesktop);
  fs.addVirtualProvider(p);
  if (kernel) for (const type of DOM_EVENT_TYPES) kernel.registerDevice(`/dom/events/${type}`, (_proc, flags) => new DomEventFile(p, type, flags));
  installed = p;
  return p;
}

export function domProvider(): DomProvider | null {
  return installed;
}
