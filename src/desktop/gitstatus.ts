/**
 * Git state for the desktop (Files' badges, the Git app): which repository a
 * folder is in, its branch, each entry's status and the branch's distance to
 * its upstream. Read straight from the repository with isomorphic-git (the
 * builtin git's library, its own chunk): no process, no emulation. Callers
 * ask only for the folder on screen and re-ask when the filesystem says
 * something in the repository changed; nothing polls.
 */

import type { FileSystem } from '../filesystem';

export interface Repo {
  /** The working tree's top folder */
  root: string;
  /** Its git directory: root/.git, or for a worktree the folder its `.git` file names */
  gitdir: string;
  /** A linked worktree (`git worktree add`): a `.git` file, objects in the main repository */
  worktree: boolean;
}

/** 'M' modified, 'A' added (staged new), 'D' deleted, '?' untracked; folders get 'M' if anything inside changed */
export type EntryState = 'M' | 'A' | 'D' | '?';

export interface Upstream { branch: string | null; upstream: string | null; ahead: number; behind: number }

type GitFs = ReturnType<FileSystem['toIsomorphicGitFS']>;
let lib: Promise<typeof import('isomorphic-git')> | null = null;
const git = () => (lib ??= import('isomorphic-git'));

const parentOf = (p: string) => (p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/');

/** The repository `dir` is in (walking up), or null */
export async function findRepo(fs: FileSystem, dir: string): Promise<Repo | null> {
  for (let d: string | null = dir; d; d = parentOf(d)) {
    const dotgit = d === '/' ? '/.git' : `${d}/.git`;
    let st;
    try { st = await fs.stat(dotgit); } catch { continue; }
    if (st.isDirectory()) return { root: d, gitdir: dotgit, worktree: false };
    // A worktree: ".git" is a file "gitdir: /path/to/repo/.git/worktrees/name"
    try {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(await fs.readFile(dotgit, 'utf8') as string);
      if (m) return { root: d, gitdir: fs.resolvePath(m[1].trim(), d), worktree: true };
    } catch {}
    return null;
  }
  return null;
}

/** The checked-out branch (or a short commit id when detached), from HEAD */
export async function headBranch(fs: FileSystem, repo: Repo): Promise<string | null> {
  try {
    const head = (await fs.readFile(`${repo.gitdir}/HEAD`, 'utf8') as string).trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 7);
  } catch { return null; }
}

/**
 * Status of the entries directly in `dir` (a folder inside `repo`): files by
 * name, folders 'M' when anything below changed. Only `dir`'s subtree is
 * walked. Null for a worktree (isomorphic-git can't read objects through
 * its commondir) or on any error.
 */
export async function dirStatus(fs: FileSystem, repo: Repo, dir: string): Promise<Map<string, EntryState> | null> {
  if (repo.worktree) return null;
  const rel = dir === repo.root ? '' : dir.slice(repo.root.length + 1);
  try {
    const g = await git();
    const matrix = await g.statusMatrix({ fs: fs.toIsomorphicGitFS() as GitFs, dir: repo.root, filepaths: rel ? [rel] : undefined });
    const out = new Map<string, EntryState>();
    for (const [filepath, head, work, stage] of matrix) {
      if (head === 1 && work === 1 && stage === 1) continue;
      const state: EntryState = head === 0 && stage === 0 ? '?' : head === 0 ? 'A' : work === 0 ? 'D' : 'M';
      const inside = rel ? filepath.slice(rel.length + 1) : filepath;
      if (rel && !filepath.startsWith(rel + '/')) continue;
      const slash = inside.indexOf('/');
      if (slash < 0) out.set(inside, state);
      else if (!out.has(inside.slice(0, slash))) out.set(inside.slice(0, slash), 'M');
    }
    return out;
  } catch { return null; }
}

/** Commits ahead of and behind the branch's upstream (origin/BRANCH), counted to 200 back */
export async function upstreamOf(fs: FileSystem, repo: Repo): Promise<Upstream> {
  const branch = await headBranch(fs, repo);
  const none: Upstream = { branch, upstream: null, ahead: 0, behind: 0 };
  if (!branch || repo.worktree) return none;
  try {
    const g = await git();
    const gfs = fs.toIsomorphicGitFS() as GitFs;
    const remoteRef = `refs/remotes/origin/${branch}`;
    let theirs: string;
    try { theirs = await g.resolveRef({ fs: gfs, dir: repo.root, ref: remoteRef }); } catch { return none; }
    const ours = await g.resolveRef({ fs: gfs, dir: repo.root, ref: 'HEAD' });
    if (ours === theirs) return { branch, upstream: `origin/${branch}`, ahead: 0, behind: 0 };
    const ids = async (ref: string) => new Set((await g.log({ fs: gfs, dir: repo.root, ref, depth: 200 }).catch(() => [])).map(c => c.oid));
    const [a, b] = await Promise.all([ids(ours), ids(theirs)]);
    let ahead = 0, behind = 0;
    for (const id of a) if (!b.has(id)) ahead++;
    for (const id of b) if (!a.has(id)) behind++;
    return { branch, upstream: `origin/${branch}`, ahead, behind };
  } catch { return none; }
}

/** "owner/repo", "github.com/owner/repo(.git)" or a full URL → owner, repo and the https URL; null if it isn't one */
export function parseRepoSpec(spec: string): { owner: string; repo: string; url: string } | null {
  const s = spec.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com[/:]|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (!m || m[1] === '.' || m[2] === '.' || m[1] === '..' || m[2] === '..') return null;
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` };
}

/** A branch name git accepts (the common rules of git check-ref-format) */
export function validBranch(name: string): boolean {
  return !!name && !/[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|^[/.-]|[/.]$|\.lock$/.test(name) && name !== '@';
}

/** The folder for a branch: ~/src/owner/repo + "@branch" (slashes become dashes) */
export function branchFolder(root: string, branch: string): string {
  return `${root}@${branch.replace(/\//g, '-')}`;
}
