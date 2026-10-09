/**
 * Clone… and New Branch Folder… (docs/DESKTOP.md "Git"): sheets that run git
 * in a Terminal window, so its progress and any error are in front of you.
 *
 * - Clone: owner/repo or a URL into ~/src/OWNER/REPO. Signed in to GitHub,
 *   real git (`pkg install git` first if needed) makes a partial clone
 *   (`--filter=blob:none`: history now, file contents as they're needed) over
 *   the relay, authenticated with the GitHub sign-in through the environment
 *   (never in the command line or .git/config). Not signed in, the builtin git
 *   makes a shallow clone of a public repository through this site.
 * - Branch folder: `git worktree add ~/src/OWNER/REPO@BRANCH`, one folder per
 *   branch, so parallel agents each get their own.
 */

import type { AppContext } from './index';
import { networkCredential } from '../net-signin';
import { glyphFor } from './iconsets';
import { branchFolder, findRepo, headBranch, parseRepoSpec, validBranch, type Repo } from './gitstatus';
import { shq } from './devtools';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const HOME = '/home/user';
const tilde = (p: string) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${glyphFor('git')}"/></svg>`;

/** Real git, installed if the builtin is all there is */
const ENSURE_GIT = `if git --version 2>/dev/null | grep -q isomorphic; then printf '%s\\n' 'Installing git (pkg install git, a few seconds)…'; pkg install git; fi`;
/** git's credentials for github.com from $GITHUB_TOKEN, for this command only */
const AUTH_ENV = `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"`;

/** The Terminal command for a clone */
export function cloneScript(spec: { owner: string; repo: string; url: string }, signedIn: boolean): string {
  const parent = `~/src/${spec.owner}`;
  const clone = signedIn
    ? `${ENSURE_GIT} && ${AUTH_ENV} git clone --filter=blob:none --progress ${shq(spec.url)} ${shq(spec.repo)}`
    : `git clone --depth 1 ${shq(spec.url)} ${shq(spec.repo)}`;
  return `mkdir -p ${parent} && cd ${parent} && ${clone} && cd ${shq(spec.repo)} && git log --oneline -3`;
}

/** The Terminal command for a branch folder: an existing branch is checked out there, a new one is made from HEAD */
export function worktreeScript(mainRoot: string, branch: string): string {
  const folder = branchFolder(mainRoot, branch);
  const b = shq(branch), f = shq(folder);
  return `cd ${shq(mainRoot)} && ${ENSURE_GIT} && if git show-ref --verify --quiet ${shq('refs/heads/' + branch)}; then git worktree add ${f} ${b}; else git worktree add -b ${b} ${f}; fi && cd ${f} && git status -sb`;
}

/** The main working tree of a repo (a worktree's .git file points into the main repo's .git/worktrees/NAME) */
export function mainRoot(repo: Repo): string {
  return repo.worktree ? repo.gitdir.replace(/\/\.git\/worktrees\/[^/]+$/, '') : repo.root;
}

function sheet(ctx: AppContext, label: string, html: string): { el: HTMLElement; close: () => void } {
  const el = document.createElement('div');
  el.className = 'sd-sheet sd-git-sheet';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', label);
  el.innerHTML = html;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('sd-leaving');
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  el.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-act=cancel]')) close(); });
  ctx.wm.root.appendChild(el);
  return { el, close };
}

/** Clone a GitHub repository into ~/src/OWNER/REPO */
export function openCloneSheet(ctx: AppContext, initial = ''): void {
  const signedIn = !!networkCredential();
  const { el, close } = sheet(ctx, 'Clone a repository', `
    <div class="sd-sheet-head"><div class="sd-sheet-icon">${ICON}</div><div>
      <h3>Clone a Repository</h3>
      <p>${signedIn
        ? 'A partial clone with git: the history now, file contents as they are needed. Your GitHub sign-in reaches private repositories.'
        : 'Not signed in to GitHub: a shallow clone of a public repository. <button class="sd-link" data-act="signin" type="button">Sign in</button> for private ones and full history.'}</p>
    </div></div>
    <form class="sd-git-form">
      <input class="sd-input" name="repo" type="text" placeholder="owner/repo or https://github.com/owner/repo" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Repository" value="${esc(initial)}">
      <div class="sd-small sd-muted sd-git-dest" aria-live="polite"></div>
      <div class="sd-sheet-actions"><span class="sd-grow"></span>
        <button class="sd-btn" data-act="cancel" type="button">Cancel</button>
        <button class="sd-btn sd-primary" type="submit" disabled>Clone</button></div>
    </form>`);
  const input = el.querySelector<HTMLInputElement>('input[name=repo]')!;
  const dest = el.querySelector<HTMLElement>('.sd-git-dest')!;
  const submit = el.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const update = async () => {
    const spec = parseRepoSpec(input.value);
    submit.disabled = !spec;
    if (!spec) { dest.textContent = input.value.trim() ? 'Type owner/repo, or paste a GitHub URL.' : ''; return; }
    const target = `${HOME}/src/${spec.owner}/${spec.repo}`;
    const exists = await ctx.fs.exists(target).catch(() => false);
    dest.innerHTML = exists
      ? `<b>${esc(tilde(target))}</b> already exists: <button class="sd-link" data-act="show" type="button">show it in Files</button>`
      : `Into <b>${esc(tilde(target))}</b>`;
    submit.disabled = exists;
  };
  input.addEventListener('input', () => void update());
  el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    const spec = parseRepoSpec(input.value);
    if (act === 'show' && spec) { close(); void ctx.wm.openApp('files', { path: `${HOME}/src/${spec.owner}/${spec.repo}`, newWindow: true }); }
    if (act === 'signin') { close(); void import('./network').then(m => m.openSignIn()); }
  });
  el.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const spec = parseRepoSpec(input.value);
    if (!spec) return;
    close();
    // The clone's Terminal has the sign-in in its environment (git reads it from there)
    const token = networkCredential();
    if (token) ctx.shell.env.GITHUB_TOKEN = token;
    ctx.openTerminal({ title: `Clone ${spec.owner}/${spec.repo}`, cwd: HOME, command: cloneScript(spec, !!token) });
  });
  void update();
  setTimeout(() => input.focus(), 50);
}

/** New Branch Folder: a worktree for a new or existing branch beside the repository */
export async function openBranchFolderSheet(ctx: AppContext, dir: string): Promise<void> {
  const repo = await findRepo(ctx.fs, dir);
  if (!repo) return;
  const root = mainRoot(repo);
  const current = await headBranch(ctx.fs, repo);
  const name = root.split('/').pop()!;
  const { el, close } = sheet(ctx, 'New branch folder', `
    <div class="sd-sheet-head"><div class="sd-sheet-icon">${ICON}</div><div>
      <h3>New Branch Folder</h3>
      <p>A folder of its own for a branch of <b>${esc(name)}</b> (<code>git worktree add</code>): work on two branches at once, or give each agent its own.${current ? ` New branches start from <b>${esc(current)}</b>.` : ''}</p>
    </div></div>
    <form class="sd-git-form">
      <input class="sd-input" name="branch" type="text" placeholder="branch name, new or existing" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Branch">
      <div class="sd-small sd-muted sd-git-dest" aria-live="polite"></div>
      <div class="sd-sheet-actions"><span class="sd-grow"></span>
        <button class="sd-btn" data-act="cancel" type="button">Cancel</button>
        <button class="sd-btn sd-primary" type="submit" disabled>Create Folder</button></div>
    </form>`);
  const input = el.querySelector<HTMLInputElement>('input[name=branch]')!;
  const dest = el.querySelector<HTMLElement>('.sd-git-dest')!;
  const submit = el.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const update = async () => {
    const b = input.value.trim();
    const ok = validBranch(b);
    if (!ok) { submit.disabled = true; dest.textContent = b ? 'Not a valid branch name.' : ''; return; }
    const folder = branchFolder(root, b);
    const exists = await ctx.fs.exists(folder).catch(() => false);
    submit.disabled = exists;
    dest.innerHTML = exists ? `<b>${esc(tilde(folder))}</b> already exists.` : `Into <b>${esc(tilde(folder))}</b>`;
  };
  input.addEventListener('input', () => void update());
  el.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const b = input.value.trim();
    if (!validBranch(b)) return;
    close();
    ctx.openTerminal({ title: `${name}@${b}`, cwd: root, command: worktreeScript(root, b) });
  });
  setTimeout(() => input.focus(), 50);
}

