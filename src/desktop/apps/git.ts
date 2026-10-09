/**
 * Git: a repository's changes for people (docs/DESKTOP.md "Git"). Status in
 * three lists (staged, changed, untracked) with stage/unstage, the selected
 * file's diff, commit, branches (switch, new) and the log. It reads and writes
 * the repository directly with isomorphic-git (the builtin git's library), so
 * nothing runs under emulation; pull and push open a Terminal with git there.
 * It follows the repository's changes from the filesystem, not a timer.
 */

import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { GLOBAL_GITCONFIG, parseGitConfig } from '../../commands/git-config';
import { findRepo, headBranch, upstreamOf, type Repo } from '../gitstatus';
import { openBranchFolderSheet, openCloneSheet, mainRoot } from '../gitsheets';
import { activeProfile } from '../../profile';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const HOME = '/home/user';
type Row = { path: string; head: number; work: number; stage: number };
type Kind = 'staged' | 'changed' | 'untracked';

/** Which list a statusMatrix row belongs in (a file can be in two: staged, then changed again) */
export function kindsOf(r: Row): Kind[] {
  const { head, work, stage } = r;
  if (head === 1 && work === 1 && stage === 1) return [];
  if (head === 0 && stage === 0) return work ? ['untracked'] : [];
  const out: Kind[] = [];
  // Index differs from HEAD: staged (added, modified or removed)
  if ((head === 0 && stage >= 2) || (head === 1 && (stage === 0 || stage === 2 || stage === 3))) out.push('staged');
  // Working copy differs from the index
  if ((stage === 0 && work !== 0 && head === 1) || (stage !== 0 && work === 0) || (stage === 1 && work === 2) || stage === 3) out.push('changed');
  if (!out.length && (work === 0 || work === 2)) out.push('changed');
  return [...new Set(out)];
}

/** M A D for a row in a list */
function letter(r: Row, kind: Kind): string {
  if (kind === 'untracked') return 'U';
  if (kind === 'staged') return r.head === 0 ? 'A' : r.stage === 0 ? 'D' : 'M';
  return r.work === 0 ? 'D' : 'M';
}

export function open(ctx: AppContext, args?: Record<string, unknown>): DesktopWindow {
  const { wm, fs } = ctx;
  const gfs = fs.toIsomorphicGitFS();
  const el = document.createElement('div');
  el.className = 'sd-app sd-gitui';
  el.tabIndex = -1;
  const win = wm.createWindow({ appId: 'git', title: 'Git', width: 860, height: 560, minWidth: 420, minHeight: 300, content: { kind: 'dom', element: el } });
  let repo: Repo | null = null;
  let rows: Row[] = [];
  let selected: { path: string; kind: Kind } | null = null;
  let tab: 'diff' | 'log' = 'diff';
  let busy = '';
  let message = '';
  const g = import('isomorphic-git');

  const author = async () => {
    const git = await g;
    const val = async (path: string) => { try { return await git.getConfig({ fs: gfs, dir: repo!.root, path }) as string | undefined; } catch { return undefined; } };
    let global: Record<string, string> = {};
    try { global = parseGitConfig(await fs.readFile(GLOBAL_GITCONFIG, 'utf8') as string); } catch {}
    return {
      name: (await val('user.name')) || global['user.name'] || 'user',
      email: (await val('user.email')) || global['user.email'] || `user@${activeProfile().hostname}.local`,
    };
  };

  // ── Choosing a repository ──
  async function repos(): Promise<string[]> {
    const out: string[] = [];
    for (const owner of await fs.readdir(`${HOME}/src`).catch(() => [] as string[])) {
      for (const r of await fs.readdir(`${HOME}/src/${owner}`).catch(() => [] as string[])) {
        if (await fs.exists(`${HOME}/src/${owner}/${r}/.git`).catch(() => false)) out.push(`${HOME}/src/${owner}/${r}`);
      }
    }
    return out;
  }
  async function pick(): Promise<void> {
    repo = null;
    win.setTitle('Git');
    const list = await repos();
    el.innerHTML = `<div class="sd-scroll"><div class="sd-panel">
      <h2>Git</h2><p class="sd-muted">Pick a repository, or clone one into <code>~/src</code>.</p>
      <div class="sd-card">${list.length ? list.map(p => `<div class="sd-row"><span class="sd-grow">${esc(p.replace(HOME + '/src/', ''))}</span><button class="sd-btn" data-open="${esc(p)}">Open</button></div>`).join('') : '<div class="sd-row sd-muted">No repositories in ~/src yet.</div>'}</div>
      <div class="sd-row" style="margin-top:12px;border:0"><button class="sd-btn sd-primary" data-act="clone">Clone…</button></div>
    </div></div>`;
  }

  // ── The repository view ──
  async function load(dir: string): Promise<void> {
    const r = await findRepo(fs, dir);
    if (!r) { await pick(); return; }
    repo = r;
    win.setTitle(`Git — ${r.root.split('/').pop()}`);
    if (r.worktree) {
      // isomorphic-git reads a worktree's objects only through the main repository
      const branch = await headBranch(fs, r);
      el.innerHTML = `<div class="sd-scroll"><div class="sd-panel">
        <h2>${esc(r.root.split('/').pop()!)} <span class="sd-muted">${esc(branch ?? '')}</span></h2>
        <p class="sd-muted">This folder is a branch folder (a git worktree) of <code>${esc(mainRoot(r).replace(HOME, '~'))}</code>. The Git app shows main folders; here, use git in a Terminal.</p>
        <div class="sd-row" style="border:0;gap:8px"><button class="sd-btn sd-primary" data-act="term">Terminal Here</button><button class="sd-btn" data-act="main">Open the Main Folder</button></div>
      </div></div>`;
      return;
    }
    await refresh();
  }

  async function refresh(): Promise<void> {
    if (!repo || repo.worktree) return;
    const git = await g;
    try {
      rows = (await git.statusMatrix({ fs: gfs, dir: repo.root })).map(([path, head, work, stage]) => ({ path, head, work, stage }));
    } catch (e) {
      el.innerHTML = `<div class="sd-panel"><h2>Git</h2><p class="sd-muted">Can't read this repository: ${esc((e as Error)?.message ?? String(e))}</p></div>`;
      return;
    }
    await render();
  }

  async function render(): Promise<void> {
    if (!repo) return;
    const git = await g;
    const up = await upstreamOf(fs, repo);
    const branches = await git.listBranches({ fs: gfs, dir: repo.root }).catch(() => [] as string[]);
    const lists: Record<Kind, Row[]> = { staged: [], changed: [], untracked: [] };
    for (const r of rows) for (const k of kindsOf(r)) lists[k].push(r);
    if (selected && !lists[selected.kind].some(r => r.path === selected!.path)) selected = null;
    if (!selected) {
      const first = (['changed', 'staged', 'untracked'] as Kind[]).find(k => lists[k].length);
      if (first) selected = { path: lists[first][0].path, kind: first };
    }
    const section = (kind: Kind, title: string) => lists[kind].length ? `
      <div class="sd-git-sec"><span class="sd-grow">${title} <span class="sd-muted">${lists[kind].length}</span></span>
        <button class="sd-link sd-small" data-all="${kind}">${kind === 'staged' ? 'Unstage all' : 'Stage all'}</button></div>
      ${lists[kind].map(r => `<div class="sd-git-file${selected?.path === r.path && selected.kind === kind ? ' sd-selected' : ''}" data-path="${esc(r.path)}" data-kind="${kind}">
        <span class="sd-git-badge sd-git-${letter(r, kind).toLowerCase()}">${letter(r, kind)}</span>
        <span class="sd-grow sd-git-path" title="${esc(r.path)}">${esc(r.path)}</span>
        <button class="sd-git-toggle" data-toggle="${kind}" title="${kind === 'staged' ? 'Unstage' : 'Stage'}" aria-label="${kind === 'staged' ? 'Unstage' : 'Stage'} ${esc(r.path)}">${kind === 'staged' ? '−' : '+'}</button>
      </div>`).join('')}` : '';
    const nothing = !lists.staged.length && !lists.changed.length && !lists.untracked.length;
    el.innerHTML = `
      <div class="sd-toolbar">
        <div class="sd-path" title="${esc(repo.root)}">${esc(repo.root.replace(HOME, '~'))}</div>
        <button class="sd-btn sd-git-branch" data-act="branches" aria-haspopup="menu">${esc(up.branch ?? 'no branch')}${up.ahead ? ` <span class="sd-ahead">↑${up.ahead}</span>` : ''}${up.behind ? ` <span class="sd-behind">↓${up.behind}</span>` : ''} ▾</button>
        <button class="sd-btn" data-act="pull" title="git pull, in a Terminal">Pull</button>
        <button class="sd-btn" data-act="push" title="git push, in a Terminal">Push</button>
      </div>
      <div class="sd-app-split">
        <aside class="sd-git-side">
          <div class="sd-git-files">${nothing ? '<div class="sd-muted sd-small" style="padding:14px">Nothing to commit: the working copy matches the last commit.</div>' : section('staged', 'Staged') + section('changed', 'Changes') + section('untracked', 'Untracked')}</div>
          <form class="sd-git-commit">
            <textarea class="sd-input" name="msg" rows="3" placeholder="Commit message" spellcheck="true">${esc(message)}</textarea>
            <div class="sd-row" style="border:0;padding:0;gap:6px"><span class="sd-grow sd-small sd-muted sd-git-busy">${esc(busy)}</span>
              <button class="sd-btn sd-primary" type="submit"${!lists.staged.length && !lists.changed.length ? ' disabled' : ''}>${lists.staged.length ? `Commit ${lists.staged.length}` : 'Stage All & Commit'}</button></div>
          </form>
        </aside>
        <section class="sd-main">
          <div class="sd-git-tabs" role="tablist"><button role="tab" data-tab="diff" aria-selected="${tab === 'diff'}">Diff</button><button role="tab" data-tab="log" aria-selected="${tab === 'log'}">Log</button></div>
          <div class="sd-scroll"><pre class="sd-git-diff"></pre></div>
        </section>
      </div>`;
    void fillPane();
  }

  async function fillPane(): Promise<void> {
    const pane = el.querySelector<HTMLElement>('.sd-git-diff');
    if (!pane || !repo) return;
    const git = await g;
    if (tab === 'log') {
      const log = await git.log({ fs: gfs, dir: repo.root, depth: 50 }).catch(() => []);
      pane.innerHTML = log.length ? log.map(c => `<div class="sd-git-commitrow"><span class="sd-git-oid">${c.oid.slice(0, 7)}</span> <b>${esc(c.commit.message.split('\n')[0])}</b><div class="sd-small sd-muted">${esc(c.commit.author.name)} · ${new Date(c.commit.author.timestamp * 1000).toLocaleString()}</div></div>`).join('') : '<span class="sd-muted">No commits yet.</span>';
      return;
    }
    if (!selected) { pane.innerHTML = '<span class="sd-muted">Select a file to see its changes.</span>'; return; }
    const { path, kind } = selected;
    const dec = new TextDecoder();
    let before = '';
    try {
      const oid = await git.resolveRef({ fs: gfs, dir: repo.root, ref: 'HEAD' });
      before = dec.decode((await git.readBlob({ fs: gfs, dir: repo.root, oid, filepath: path })).blob);
    } catch { /* new file, no commits, or not fetched yet (partial clone) */ }
    let after = '';
    try { after = await fs.readFile(`${repo.root}/${path}`, 'utf8') as string; } catch { /* deleted */ }
    if (/\x00/.test(before.slice(0, 8000) + after.slice(0, 8000))) { pane.innerHTML = '<span class="sd-muted">Binary file.</span>'; return; }
    const { unifiedDiff } = await import('../../commands/git-utils');
    const diff = unifiedDiff(before ? before.split('\n') : [], after ? after.split('\n') : []);
    const head = `<div class="sd-small sd-muted" style="margin-bottom:6px">${esc(path)} · last commit → working copy${kind === 'staged' ? ' (staged)' : ''}</div>`;
    pane.innerHTML = head + (diff ? diff.split('\n').map(l => `<div class="${l.startsWith('+') ? 'sd-add' : l.startsWith('-') ? 'sd-del' : l.startsWith('@@') ? 'sd-hunk' : ''}">${esc(l) || ' '}</div>`).join('') : '<span class="sd-muted">No changes in its text.</span>');
  }

  async function stage(r: Row): Promise<void> {
    const git = await g;
    if (r.work === 0) await git.remove({ fs: gfs, dir: repo!.root, filepath: r.path });
    else await git.add({ fs: gfs, dir: repo!.root, filepath: r.path });
  }
  async function unstage(r: Row): Promise<void> {
    const git = await g;
    await git.resetIndex({ fs: gfs, dir: repo!.root, filepath: r.path });
  }
  async function act(label: string, fn: () => Promise<void>): Promise<void> {
    busy = label;
    el.querySelector('.sd-git-busy')?.replaceChildren(label);
    try { await fn(); busy = ''; } catch (e) { busy = `${label.replace(/…$/, '')} failed: ${(e as Error)?.message ?? e}`; }
    await refresh();
  }

  async function branchMenu(anchor: HTMLElement): Promise<void> {
    if (!repo) return;
    const git = await g;
    const r0 = repo;
    const current = await headBranch(fs, r0);
    const branches = await git.listBranches({ fs: gfs, dir: r0.root }).catch(() => [] as string[]);
    const rect = anchor.getBoundingClientRect();
    ctx.openMenu?.({ title: 'Branches', items: [
      ...branches.map(b => ({ label: b, checked: b === current, action: () => void act(`Switching to ${b}…`, () => git.checkout({ fs: gfs, dir: r0.root, ref: b })) })),
      'separator' as const,
      { label: 'New Branch…', action: () => newBranch() },
      { label: 'New Branch Folder…', action: () => void openBranchFolderSheet(ctx, r0.root) },
    ] }, rect.left, rect.bottom + 4);
  }
  function newBranch(): void {
    const form = el.querySelector<HTMLElement>('.sd-toolbar');
    if (!form || el.querySelector('.sd-git-newbranch')) return;
    const box = document.createElement('form');
    box.className = 'sd-git-newbranch';
    box.innerHTML = `<input class="sd-input" placeholder="new branch name" aria-label="New branch name" spellcheck="false"><button class="sd-btn sd-primary" type="submit">Create &amp; Switch</button><button class="sd-btn" type="button" data-act="cancelbranch">Cancel</button>`;
    form.after(box);
    const input = box.querySelector('input')!;
    input.focus();
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      void act(`Creating ${name}…`, async () => { const git = await g; await git.branch({ fs: gfs, dir: repo!.root, ref: name, checkout: true }); });
    });
  }

  el.addEventListener('input', (e) => { if ((e.target as HTMLElement).matches('textarea[name=msg]')) message = (e.target as HTMLTextAreaElement).value; });
  el.addEventListener('submit', (e) => {
    const form = e.target as HTMLElement;
    if (!form.matches('.sd-git-commit')) return;
    e.preventDefault();
    const msg = message.trim();
    if (!msg) { el.querySelector<HTMLTextAreaElement>('textarea[name=msg]')?.focus(); return; }
    void act('Committing…', async () => {
      const git = await g;
      const lists = { staged: rows.filter(r => kindsOf(r).includes('staged')) };
      if (!lists.staged.length) for (const r of rows.filter(r => kindsOf(r).includes('changed'))) await stage(r);
      await git.commit({ fs: gfs, dir: repo!.root, message: msg, author: await author() });
      message = '';
    });
  });
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const open = t.closest<HTMLElement>('[data-open]')?.dataset.open;
    if (open) { void load(open); return; }
    const a = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (a === 'clone') { openCloneSheet(ctx); return; }
    if (a === 'term' && repo) { ctx.openTerminal({ cwd: repo.root }); return; }
    if (a === 'main' && repo) { void load(mainRoot(repo)); return; }
    if (a === 'branches') { void branchMenu(t.closest('button')!); return; }
    if (a === 'cancelbranch') { el.querySelector('.sd-git-newbranch')?.remove(); return; }
    if ((a === 'pull' || a === 'push') && repo) {
      ctx.openTerminal({ title: `git ${a}`, cwd: repo.root, command: `git ${a}` });
      return;
    }
    const tabBtn = t.closest<HTMLElement>('[data-tab]')?.dataset.tab;
    if (tabBtn) { tab = tabBtn as 'diff' | 'log'; for (const b of el.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === tab)); void fillPane(); return; }
    const all = t.closest<HTMLElement>('[data-all]')?.dataset.all as Kind | undefined;
    if (all) {
      const pick = rows.filter(r => kindsOf(r).includes(all));
      void act(all === 'staged' ? 'Unstaging…' : 'Staging…', async () => { for (const r of pick) await (all === 'staged' ? unstage(r) : stage(r)); });
      return;
    }
    const fileEl = t.closest<HTMLElement>('.sd-git-file');
    if (!fileEl) return;
    const row = rows.find(r => r.path === fileEl.dataset.path);
    const kind = fileEl.dataset.kind as Kind;
    if (!row) return;
    if (t.closest('[data-toggle]')) { void act(kind === 'staged' ? 'Unstaging…' : 'Staging…', () => (kind === 'staged' ? unstage(row) : stage(row))); return; }
    selected = { path: row.path, kind };
    for (const f of el.querySelectorAll('.sd-git-file')) f.classList.toggle('sd-selected', f === fileEl);
    tab = 'diff';
    for (const b of el.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === 'diff'));
    void fillPane();
  });

  // Follow the repository: its files, index and refs (debounced: one save can be many writes)
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = fs.onChange((_ev, path) => {
    if (!repo || repo.worktree || !(path.startsWith(repo.root + '/') || path === repo.root)) return;
    if (busy) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void refresh(); }, 600);
  });
  win.on('close', () => { off(); if (timer) clearTimeout(timer); });
  (win as { content?: unknown }).content = { navigate: (a: Record<string, unknown>) => { if (typeof a.dir === 'string') void load(a.dir); }, dir: () => repo?.root ?? null };
  void (typeof args?.dir === 'string' ? load(args.dir) : pick());
  return win;
}
