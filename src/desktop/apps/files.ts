/**
 * Files: browse the Shiro filesystem (IndexedDB-backed, plus /proc, /dev and
 * /dom). Double-click a folder to enter it, a file to open it (text in an
 * editor window, images in a viewer).
 */

import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { GLYPHS } from '../icons';

interface Entry { name: string; path: string; dir: boolean; size: number; mtime: number; link: boolean }

const PLACES: { label: string; path: string }[] = [
  { label: 'Home', path: '/home/user' },
  { label: 'Computer', path: '/' },
  { label: 'Programs', path: '/usr/bin' },
  { label: 'Packages', path: '/usr/lib/pkg' },
  { label: 'Temporary', path: '/tmp' },
  { label: 'Page (/dom)', path: '/dom' },
];

const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function open(ctx: AppContext, args?: Record<string, unknown>): DesktopWindow {
  const { wm, fs } = ctx;
  const start = typeof args?.path === 'string' ? args.path : '/home/user';
  const root = document.createElement('div');
  root.className = 'sd-app';
  root.innerHTML = `
    <div class="sd-app-split">
      <aside class="sd-sidebar"><div class="sd-side-h">Places</div></aside>
      <section class="sd-main">
        <div class="sd-toolbar">
          <button class="sd-btn sd-icon-btn" data-act="back" title="Back" aria-label="Back">${GLYPHS.back}</button>
          <button class="sd-btn sd-icon-btn" data-act="up" title="Enclosing folder" aria-label="Up">${GLYPHS.up}</button>
          <div class="sd-path"></div>
          <button class="sd-btn" data-act="term" title="Open a terminal here">Terminal here</button>
        </div>
        <div class="sd-scroll"><table class="sd-table"><thead><tr>
          <th>Name</th><th class="sd-num">Size</th><th>Modified</th></tr></thead><tbody></tbody></table>
          <div class="sd-empty sd-muted sd-small" style="padding:18px;display:none"></div>
        </div>
      </section>
    </div>`;
  const side = root.querySelector('.sd-sidebar')!;
  const pathEl = root.querySelector<HTMLElement>('.sd-path')!;
  const tbody = root.querySelector('tbody')!;
  const empty = root.querySelector<HTMLElement>('.sd-empty')!;
  const placeBtns = PLACES.map(p => {
    const b = document.createElement('button');
    b.className = 'sd-side-item';
    b.innerHTML = `${GLYPHS.folder}<span></span>`;
    b.querySelector('span')!.textContent = p.label;
    b.addEventListener('click', () => go(p.path));
    side.appendChild(b);
    return { b, path: p.path };
  });

  let cwd = start;
  const history: string[] = [];
  let entries: Entry[] = [];
  let selected: string | null = null;

  const win = wm.createWindow({
    appId: 'files', title: 'Files', width: 760, height: 460, minWidth: 360, minHeight: 220,
    content: { kind: 'dom', element: root },
  });

  async function list(dir: string): Promise<Entry[]> {
    const names = await fs.readdir(dir);
    const out: Entry[] = [];
    await Promise.all(names.map(async (name) => {
      const path = dir === '/' ? '/' + name : `${dir}/${name}`;
      try {
        const l = await fs.lstat(path);
        let isDir = l.isDirectory();
        if (l.isSymbolicLink()) { try { isDir = (await fs.stat(path)).isDirectory(); } catch {} }
        out.push({ name, path, dir: isDir, size: l.size, mtime: l.mtime.getTime(), link: l.isSymbolicLink() });
      } catch {
        out.push({ name, path, dir: false, size: 0, mtime: 0, link: false });
      }
    }));
    return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  }

  async function go(path: string, push = true): Promise<void> {
    path = fs.resolvePath(path, cwd);
    try {
      const st = await fs.stat(path);
      if (!st.isDirectory()) { void openFile(path); return; }
      entries = await list(path);
    } catch (e) {
      empty.style.display = '';
      empty.textContent = `Can't open ${path}: ${(e as Error)?.message ?? e}`;
      return;
    }
    if (push && path !== cwd) history.push(cwd);
    cwd = path;
    selected = null;
    render();
  }

  function render(): void {
    const base = cwd === '/' ? 'Computer' : cwd.split('/').pop() || cwd;
    win.setTitle(base);
    pathEl.textContent = cwd;
    pathEl.title = cwd;
    for (const p of placeBtns) p.b.classList.toggle('sd-active', p.path === cwd);
    tbody.textContent = '';
    empty.style.display = entries.length ? 'none' : '';
    empty.textContent = entries.length ? '' : 'This folder is empty.';
    const frag = document.createDocumentFragment();
    for (const e of entries.slice(0, 2000)) {
      const tr = document.createElement('tr');
      tr.dataset.path = e.path;
      tr.innerHTML = `<td><span class="sd-name">${e.dir ? GLYPHS.folder : `<span class="sd-ficon">${GLYPHS.file}</span>`}<span>${esc(e.name)}${e.link ? ' <span class="sd-muted">→</span>' : ''}</span></span></td>
        <td class="sd-num sd-muted">${e.dir ? '—' : fmtSize(e.size)}</td><td class="sd-muted">${e.mtime ? dateFmt.format(e.mtime) : ''}</td>`;
      if (e.path === selected) tr.classList.add('sd-selected');
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
  }

  async function openFile(path: string): Promise<void> {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const name = path.split('/').pop() || path;
    if (IMAGE_EXT[ext]) {
      const data = await fs.readFile(path) as Uint8Array;
      const url = URL.createObjectURL(new Blob([data.slice()], { type: IMAGE_EXT[ext] }));
      const box = document.createElement('div');
      box.className = 'sd-app';
      box.style.cssText = 'align-items:center;justify-content:center;background:var(--sd-window-bar)';
      box.innerHTML = `<img alt="" style="max-width:100%;max-height:100%;object-fit:contain">`;
      box.querySelector('img')!.src = url;
      const w = wm.createWindow({ appId: 'files', title: name, width: 520, height: 400, content: { kind: 'dom', element: box } });
      w.on('close', () => URL.revokeObjectURL(url));
      return;
    }
    let text: string;
    try { text = await fs.readFile(path, 'utf8') as string; } catch (e) { text = `(can't read: ${(e as Error)?.message ?? e})`; }
    const binary = /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 4096));
    const box = document.createElement('div');
    box.className = 'sd-app';
    box.innerHTML = `
      <div class="sd-toolbar"><div class="sd-path sd-small sd-muted"></div>
        <button class="sd-btn sd-primary" data-act="save" disabled>Save</button></div>
      <textarea spellcheck="false" style="flex:1;resize:none;border:0;outline:none;padding:12px 14px;background:var(--sd-window);color:var(--sd-text);font:13px/1.5 var(--sd-mono);tab-size:4"></textarea>`;
    box.querySelector<HTMLElement>('.sd-path')!.textContent = path + (binary ? ' — binary file, shown as text' : '');
    const ta = box.querySelector('textarea')!;
    ta.value = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
    ta.readOnly = binary || path.startsWith('/proc/');
    const save = box.querySelector<HTMLButtonElement>('[data-act=save]')!;
    const w = wm.createWindow({ appId: 'files', title: name, width: 640, height: 440, content: { kind: 'dom', element: box } });
    ta.addEventListener('input', () => { save.disabled = false; w.setTitle(`${name} — Edited`); });
    const doSave = async () => {
      try { await fs.writeFile(path, ta.value); save.disabled = true; w.setTitle(name); }
      catch (e) { save.textContent = 'Save failed'; console.warn('[files] save', e); }
    };
    save.addEventListener('click', () => void doSave());
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void doSave(); } });
  }

  tbody.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr');
    if (!tr) return;
    selected = tr.dataset.path ?? null;
    for (const r of tbody.querySelectorAll('tr')) r.classList.toggle('sd-selected', r === tr);
  });
  tbody.addEventListener('dblclick', (e) => {
    const tr = (e.target as HTMLElement).closest('tr');
    const ent = entries.find(x => x.path === tr?.dataset.path);
    if (!ent) return;
    if (ent.dir) void go(ent.path); else void openFile(ent.path);
  });
  root.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    const i = entries.findIndex(x => x.path === selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = entries[Math.max(0, Math.min(entries.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { selected = n.path; render(); }
    } else if (e.key === 'Enter' && i >= 0) {
      const ent = entries[i];
      if (ent.dir) void go(ent.path); else void openFile(ent.path);
    } else if (e.key === 'Backspace') void go(cwd === '/' ? '/' : cwd.replace(/\/[^/]+$/, '') || '/');
  });
  root.tabIndex = -1;
  root.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'back') { const p = history.pop(); if (p) void go(p, false); }
    if (act === 'up') void go(cwd === '/' ? '/' : cwd.replace(/\/[^/]+$/, '') || '/');
    if (act === 'term') ctx.openTerminal({ cwd });
  });
  let refresh: ReturnType<typeof setTimeout> | null = null;
  const off = fs.onChange((_ev, path) => {
    const parent = path.replace(/\/[^/]+$/, '') || '/';
    if (parent !== cwd || refresh) return;
    refresh = setTimeout(() => { refresh = null; void go(cwd, false); }, 250);
  });
  win.on('close', off);
  (win as { content?: unknown }).content = { navigate: (a: Record<string, unknown>) => { if (typeof a.path === 'string') void go(a.path); } };
  void go(start, false);
  return win;
}
