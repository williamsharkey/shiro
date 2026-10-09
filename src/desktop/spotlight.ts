/**
 * The launcher (Ctrl+Space, Cmd+Space, Alt+Shift+Space, or the menu bar's
 * search icon): fuzzy-search apps, commands (builtins and installed
 * programs), recent commands and files in your home directory. Enter opens an
 * app or file, or runs a command in a new Terminal window. Loaded on first use.
 */

import type { AppContext } from './index';
import { appIcon, GLYPHS } from './icons';

type Kind = 'app' | 'recent' | 'command' | 'file' | 'dir' | 'run';
interface Item { kind: Kind; title: string; detail: string; key: string; icon: string; run: () => void }

const KIND_RANK: Record<Kind, number> = { app: 0, recent: 1, command: 2, dir: 3, file: 4, run: 5 };
const KIND_LABEL: Record<Kind, string> = { app: 'App', recent: 'Recent', command: 'Command', dir: 'Folder', file: 'File', run: 'Run' };
const HOME = '/home/user';
const MAX_FILES = 3000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.npm', '__pycache__']);

/**
 * Fuzzy score of `q` in `text` (higher is better), or -1 when `q` is not a
 * subsequence. Prefix, word-start and consecutive matches score more.
 */
export function fuzzyScore(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase(), s = q.toLowerCase();
  if (t === s) return 1000;
  if (t.startsWith(s)) return 800 - t.length;
  const at = t.indexOf(s);
  if (at >= 0) return 600 - at - t.length / 10;
  let score = 0, ti = 0, prev = -2;
  for (const ch of s) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    const boundary = i === 0 || /[\s\-_./]/.test(t[i - 1]);
    score += (i === prev + 1 ? 12 : 1) + (boundary ? 8 : 0);
    prev = i;
    ti = i + 1;
  }
  return Math.max(1, 300 + score - t.length / 5);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let filesCache: { at: number; items: { path: string; dir: boolean }[] } | null = null;

async function homeFiles(ctx: AppContext): Promise<{ path: string; dir: boolean }[]> {
  if (filesCache && Date.now() - filesCache.at < 30_000) return filesCache.items;
  const out: { path: string; dir: boolean }[] = [];
  const walk = async (dir: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > 4) return;
    let names: string[];
    try { names = await ctx.fs.readdir(dir); } catch { return; }
    for (const n of names) {
      if (out.length >= MAX_FILES) return;
      const p = `${dir}/${n}`;
      let isDir = false;
      try { isDir = (await ctx.fs.lstat(p)).isDirectory(); } catch { continue; }
      out.push({ path: p, dir: isDir });
      if (isDir && !SKIP_DIRS.has(n)) await walk(p, depth + 1);
    }
  };
  await walk(HOME, 0);
  filesCache = { at: Date.now(), items: out };
  return out;
}

async function recentCommands(ctx: AppContext): Promise<string[]> {
  try {
    const text = await ctx.fs.readFile(`${HOME}/.bash_history`, 'utf8') as string;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean).reverse();
    return [...new Set(lines)].slice(0, 200);
  } catch { return []; }
}

async function programNames(ctx: AppContext): Promise<string[]> {
  const names = new Set<string>();
  for (const c of ((globalThis as any).__tabcomputer?.commands?.list?.() ?? []) as { name: string }[]) names.add(c.name);
  for (const dir of ['/usr/bin', '/usr/local/bin', '/bin']) {
    try { for (const n of await ctx.fs.readdir(dir)) names.add(n); } catch {}
  }
  return [...names];
}

let open: { close: () => void } | null = null;

/** Show the launcher (or close it when it is open). */
export function toggleSpotlight(ctx: AppContext): void {
  if (open) { open.close(); return; }
  const { wm } = ctx;
  const panel = document.createElement('div');
  panel.className = 'sd-spot';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Search');
  panel.innerHTML = `
    <div class="sd-spot-field">${GLYPHS.search}<input type="text" spellcheck="false" autocomplete="off" placeholder="Search apps, commands, files…" aria-label="Search"></div>
    <div class="sd-spot-list" role="listbox"></div>
    <div class="sd-spot-foot sd-small sd-muted"><span>↑↓ choose · ↵ open · esc close</span><span class="sd-spot-count"></span></div>`;
  wm.root.appendChild(panel);
  const input = panel.querySelector('input')!;
  const list = panel.querySelector<HTMLElement>('.sd-spot-list')!;
  const count = panel.querySelector<HTMLElement>('.sd-spot-count')!;
  const prevFocus = document.activeElement as HTMLElement | null;
  let items: Item[] = [];
  let shown: Item[] = [];
  let sel = 0;

  const close = (restoreFocus = true) => {
    if (!open) return;
    open = null;
    panel.remove();
    document.removeEventListener('pointerdown', outside, true);
    if (restoreFocus) prevFocus?.focus?.();
  };
  const outside = (e: Event) => { if (!panel.contains(e.target as Node)) close(); };
  open = { close };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));

  const runInTerminal = (command: string) => () => { ctx.openTerminal({ command, cwd: HOME }); };
  const base: Item[] = wm.apps().map(a => ({
    kind: 'app' as Kind, title: a.name, detail: a.id, key: `${a.name} ${a.id}`,
    icon: a.icon?.trim().startsWith('<') ? a.icon : appIcon(a.id), run: () => { void wm.openApp(a.id); },
  }));
  items = base;

  // Sources that read the filesystem fill in as they arrive
  void Promise.all([recentCommands(ctx), programNames(ctx), homeFiles(ctx)]).then(([recent, progs, files]) => {
    if (!open) return;
    const appIds = new Set(base.map(b => b.detail));
    items = [
      ...base,
      ...recent.map(c => ({ kind: 'recent' as Kind, title: c, detail: 'run again', key: c, icon: GLYPHS.clock, run: runInTerminal(c) })),
      ...progs.filter(n => !appIds.has(n)).map(n => ({ kind: 'command' as Kind, title: n, detail: 'run in Terminal', key: n, icon: GLYPHS.terminalSmall, run: runInTerminal(n) })),
      ...files.map(f => ({
        kind: (f.dir ? 'dir' : 'file') as Kind, title: f.path.split('/').pop()!, detail: f.path.replace(HOME, '~'), key: f.path.replace(HOME + '/', ''),
        icon: f.dir ? GLYPHS.folder : GLYPHS.file, run: () => { void wm.openApp('files', { path: f.path, newWindow: true }); },
      })),
    ];
    render();
  });

  const render = () => {
    const q = input.value.trim();
    let ranked: Item[];
    if (!q) ranked = [...items.filter(i => i.kind === 'app'), ...items.filter(i => i.kind === 'recent').slice(0, 5)];
    else {
      ranked = items
        .map(i => ({ i, s: fuzzyScore(q, i.kind === 'file' || i.kind === 'dir' ? i.title : i.key) }))
        .filter(x => x.s >= 0)
        .sort((a, b) => b.s - a.s || KIND_RANK[a.i.kind] - KIND_RANK[b.i.kind])
        .map(x => x.i);
      // One entry per kind+title (a command can be both a builtin and in /usr/bin)
      const seen = new Set<string>();
      ranked = ranked.filter(i => { const k = `${i.kind}:${i.title}:${i.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
      ranked.push({ kind: 'run', title: q, detail: 'run in a new Terminal window', key: q, icon: GLYPHS.terminalSmall, run: runInTerminal(q) });
    }
    shown = ranked.slice(0, 9);
    sel = Math.min(sel, shown.length - 1);
    list.innerHTML = shown.map((it, n) => `
      <div class="sd-spot-item${n === sel ? ' sd-sel' : ''}" role="option" aria-selected="${n === sel}" data-n="${n}">
        <span class="sd-spot-icon">${it.icon}</span>
        <span class="sd-spot-title">${esc(it.title)}</span>
        <span class="sd-spot-detail">${esc(it.detail)}</span>
        <span class="sd-spot-kind">${KIND_LABEL[it.kind]}</span>
      </div>`).join('');
    count.textContent = q ? `${ranked.length - 1} found` : '';
  };

  const choose = (n: number) => {
    const it = shown[n];
    if (!it) return;
    close(false);
    it.run();
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  list.addEventListener('pointermove', (e) => {
    const n = Number((e.target as HTMLElement).closest<HTMLElement>('[data-n]')?.dataset.n);
    if (Number.isFinite(n) && n !== sel) { sel = n; render(); }
  });
  list.addEventListener('click', (e) => {
    const n = Number((e.target as HTMLElement).closest<HTMLElement>('[data-n]')?.dataset.n);
    if (Number.isFinite(n)) choose(n);
  });
  render();
  input.focus();
}
