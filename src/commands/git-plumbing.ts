/**
 * The git plumbing that git UIs (tig, lazygit, editor integrations) and
 * agents run, for Shiro's built-in git (isomorphic-git): rev-parse,
 * symbolic-ref, show-ref, for-each-ref, cat-file, ls-files, worktree list,
 * rev-list, merge-base, machine-readable status (--porcelain v1/v2, -z),
 * log with git's pretty formats, diff --name-status/--numstat/--name-only,
 * branch -v/-vv/--format and stash list formats. Output follows git's.
 *
 * gitPlumbing() returns null for anything it doesn't take, and git.ts goes on
 * with its own implementation.
 */
import git, { TREE, STAGE, WORKDIR } from './git-cached';
import type { CommandContext } from './index';
import { resolveRevision, readFileAtRef, unifiedDiff } from './git-utils';

type Fs = any;
interface CommitInfo { oid: string; commit: any; payload?: string }

// ── Small helpers ─────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** A person line's time in its own zone (isomorphic-git's timezoneOffset is minutes, sign as JS's getTimezoneOffset) */
function zoned(who: { timestamp: number; timezoneOffset?: number }) {
  const off = -(who.timezoneOffset ?? 0); // minutes east of UTC
  const d = new Date((who.timestamp + off * 60) * 1000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return { d, tz: `${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`, tzColon: `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}` };
}

/** git's dates: default "Thu Oct 9 21:25:34 2026 +0000", and the --date= styles */
export function gitDate(who: { timestamp: number; timezoneOffset?: number }, style = 'default'): string {
  const { d, tz, tzColon } = zoned(who);
  const Y = d.getUTCFullYear(), M = d.getUTCMonth(), D = d.getUTCDate();
  const hms = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  switch (style) {
    case 'iso': case 'iso8601': return `${Y}-${pad(M + 1)}-${pad(D)} ${hms} ${tz}`;
    case 'iso-strict': case 'iso8601-strict': return `${Y}-${pad(M + 1)}-${pad(D)}T${hms}${tzColon}`;
    case 'short': return `${Y}-${pad(M + 1)}-${pad(D)}`;
    case 'unix': return String(who.timestamp);
    case 'raw': return `${who.timestamp} ${tz}`;
    case 'relative': return relativeDate(who.timestamp);
    case 'rfc': case 'rfc2822': return `${DAYS[d.getUTCDay()]}, ${D} ${MONTHS[M]} ${Y} ${hms} ${tz}`;
    default: return `${DAYS[d.getUTCDay()]} ${MONTHS[M]} ${D} ${hms} ${Y} ${tz}`;
  }
}

function relativeDate(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'} ago`;
  if (s < 90) return unit(s, 'second');
  if (s < 90 * 60) return unit(Math.round(s / 60), 'minute');
  if (s < 36 * 3600) return unit(Math.round(s / 3600), 'hour');
  if (s < 14 * 86400) return unit(Math.round(s / 86400), 'day');
  if (s < 10 * 7 * 86400) return unit(Math.round(s / (7 * 86400)), 'week');
  if (s < 365 * 86400) return unit(Math.round(s / (30 * 86400)), 'month');
  return unit(Math.round(s / (365 * 86400)), 'year');
}

const subjectOf = (msg: string) => msg.split('\n\n')[0].split('\n').join(' ').trim();
const bodyOf = (msg: string) => { const i = msg.indexOf('\n\n'); return i < 0 ? '' : msg.slice(i + 2).replace(/\n+$/, '\n'); };

/** Every ref: name → oid (heads, remotes, tags; tags peeled separately) */
async function allRefs(fs: Fs, dir: string): Promise<{ ref: string; oid: string }[]> {
  const out: { ref: string; oid: string }[] = [];
  const add = async (ref: string) => { try { out.push({ ref, oid: await git.resolveRef({ fs, dir, ref, depth: 1 }) }); } catch { /* broken */ } };
  for (const b of await git.listBranches({ fs, dir }).catch(() => [] as string[])) await add(`refs/heads/${b}`);
  for (const r of await git.listRemotes({ fs, dir }).catch(() => [] as { remote: string }[])) {
    for (const b of await git.listBranches({ fs, dir, remote: r.remote }).catch(() => [] as string[])) {
      if (b === 'HEAD') continue;
      await add(`refs/remotes/${r.remote}/${b}`);
    }
  }
  for (const t of await git.listTags({ fs, dir }).catch(() => [] as string[])) await add(`refs/tags/${t}`);
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return out;
}

/** The commit a ref or tag names (annotated tags peeled) */
async function peel(fs: Fs, dir: string, oid: string): Promise<{ oid: string; type: string }> {
  for (let i = 0; i < 10; i++) {
    const o = await git.readObject({ fs, dir, oid, format: 'parsed' });
    if (o.type !== 'tag') return { oid, type: o.type };
    oid = (o.object as any).object;
  }
  return { oid, type: 'commit' };
}

async function objectType(fs: Fs, dir: string, oid: string): Promise<string> {
  return (await git.readObject({ fs, dir, oid, format: 'deflated' }).catch(() => git.readObject({ fs, dir, oid }))).type;
}

async function currentBranch(fs: Fs, dir: string): Promise<string | undefined> {
  return (await git.currentBranch({ fs, dir, fullname: false }).catch(() => undefined)) || undefined;
}

async function headOid(fs: Fs, dir: string): Promise<string | null> {
  try { return await git.resolveRef({ fs, dir, ref: 'HEAD' }); } catch { return null; }
}

/** branch.<b>.remote / merge → "origin/main" (or null) */
async function upstreamOf(fs: Fs, dir: string, branch: string): Promise<{ short: string; ref: string; remote: string } | null> {
  const remote = await git.getConfig({ fs, dir, path: `branch.${branch}.remote` }).catch(() => undefined);
  const merge = await git.getConfig({ fs, dir, path: `branch.${branch}.merge` }).catch(() => undefined);
  if (!remote || !merge) return null;
  const name = String(merge).replace(/^refs\/heads\//, '');
  if (remote === '.') return { short: name, ref: `refs/heads/${name}`, remote };
  return { short: `${remote}/${name}`, ref: `refs/remotes/${remote}/${name}`, remote };
}

/** All commits reachable from `oids` (for ranges and ahead/behind counts) */
async function ancestors(fs: Fs, dir: string, oids: string[], cache: Map<string, any>): Promise<Set<string>> {
  const seen = new Set<string>();
  const stack = [...oids];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = await readCommit(fs, dir, oid, cache);
    if (c) stack.push(...c.commit.parent);
  }
  return seen;
}

async function readCommit(fs: Fs, dir: string, oid: string, cache: Map<string, any>): Promise<CommitInfo | null> {
  if (cache.has(oid)) return cache.get(oid);
  let c: CommitInfo | null = null;
  try { c = await git.readCommit({ fs, dir, oid }) as CommitInfo; } catch { c = null; }
  cache.set(oid, c);
  return c;
}

async function aheadBehind(fs: Fs, dir: string, a: string, b: string, cache: Map<string, any>): Promise<[number, number]> {
  const A = await ancestors(fs, dir, [a], cache);
  const B = await ancestors(fs, dir, [b], cache);
  let ahead = 0, behind = 0;
  for (const x of A) if (!B.has(x)) ahead++;
  for (const x of B) if (!A.has(x)) behind++;
  return [ahead, behind];
}

/** Decorations: oid → ["HEAD -> main", "origin/main", "tag: v1"] */
async function decorations(fs: Fs, dir: string, full = false): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const push = (oid: string, s: string) => { const l = map.get(oid) ?? []; l.push(s); map.set(oid, l); };
  const head = await headOid(fs, dir);
  const branch = await currentBranch(fs, dir);
  const name = (ref: string) => (full ? ref : ref.replace(/^refs\/(heads|remotes)\//, '').replace(/^refs\/tags\//, ''));
  if (head && !branch) push(head, 'HEAD');
  for (const { ref, oid } of await allRefs(fs, dir)) {
    const target = ref.startsWith('refs/tags/') ? (await peel(fs, dir, oid)).oid : oid;
    if (branch && ref === `refs/heads/${branch}`) { push(target, `HEAD -> ${name(ref)}`); continue; }
    push(target, ref.startsWith('refs/tags/') ? `tag: ${name(ref)}` : name(ref));
  }
  return map;
}

/** A pretty format (`%h %s`), with git's placeholders */
export function formatPretty(c: CommitInfo, fmt: string, extra: { decor?: Map<string, string[]>; date?: string; reflog?: { selector: string; subject: string }; mark?: string } = {}): string {
  const a = c.commit.author, m = c.commit.committer ?? a;
  const msg: string = c.commit.message ?? '';
  const date = extra.date ?? 'default';
  const dec = extra.decor?.get(c.oid) ?? [];
  const tree: string = c.commit.tree ?? '';
  const parents: string[] = c.commit.parent ?? [];
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch !== '%') { out += ch; continue; }
    const rest = fmt.slice(i + 1);
    const take = (s: string, len: number) => { out += s; i += len; };
    if (rest.startsWith('%')) { take('%', 1); continue; }
    if (rest.startsWith('n')) { take('\n', 1); continue; }
    const hex = /^x([0-9a-fA-F]{2})/.exec(rest);
    if (hex) { take(String.fromCharCode(parseInt(hex[1], 16)), 3); continue; }
    if (rest.startsWith('Cred') || rest.startsWith('Cgreen') || rest.startsWith('Cblue') || rest.startsWith('Creset')) {
      const w = /^C(red|green|blue|reset)/.exec(rest)!; i += w[0].length; continue; // no colour
    }
    const color = /^C\([^)]*\)/.exec(rest);
    if (color) { i += color[0].length; continue; }
    const two = rest.slice(0, 2), one = rest[0];
    const person = (p: any, k: string): string | null => {
      switch (k) {
        case 'n': case 'N': return p.name;
        case 'e': case 'E': return p.email;
        case 'l': return p.email.split('@')[0];
        case 'd': return gitDate(p, date);
        case 'D': return gitDate(p, 'rfc');
        case 'i': return gitDate(p, 'iso');
        case 'I': return gitDate(p, 'iso-strict');
        case 't': return String(p.timestamp);
        case 'r': return relativeDate(p.timestamp);
        case 's': return gitDate(p, 'short');
        default: return null;
      }
    };
    if (one === 'a' || one === 'c') {
      const v = person(one === 'a' ? a : m, rest[1]);
      if (v !== null) { take(v, 2); continue; }
    }
    if (two === 'gd' && extra.reflog) { take(extra.reflog.selector, 2); continue; }
    if (two === 'gs' && extra.reflog) { take(extra.reflog.subject, 2); continue; }
    if (two === 'GG' || two === 'GS' || two === 'GK' || two === 'GF' || two === 'GP') { take('', 2); continue; }
    if (two === 'G?') { take('N', 2); continue; }
    switch (one) {
      case 'H': take(c.oid, 1); continue;
      case 'h': take(c.oid.slice(0, 7), 1); continue;
      case 'T': take(tree, 1); continue;
      case 't': take(tree.slice(0, 7), 1); continue;
      case 'P': take(parents.join(' '), 1); continue;
      case 'p': take(parents.map((p) => p.slice(0, 7)).join(' '), 1); continue;
      case 's': take(subjectOf(msg), 1); continue;
      case 'f': take(subjectOf(msg).replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-|-$/g, ''), 1); continue;
      case 'b': take(bodyOf(msg), 1); continue;
      case 'B': take(msg.replace(/\n*$/, '\n'), 1); continue;
      case 'd': take(dec.length ? ` (${dec.join(', ')})` : '', 1); continue;
      case 'D': take(dec.join(', '), 1); continue;
      case 'e': take('', 1); continue;
      case 'N': take('', 1); continue; // no notes
      case 'm': take(extra.mark ?? '', 1); continue;
      default: out += '%';
    }
  }
  return out;
}

/** The raw text of a commit (cat-file -p, --pretty=raw) */
function rawPerson(p: any): string { return `${p.name} <${p.email}> ${gitDate(p, 'raw')}`; }
function rawCommit(c: CommitInfo): string {
  const lines = [`tree ${c.commit.tree}`, ...c.commit.parent.map((p: string) => `parent ${p}`),
    `author ${rawPerson(c.commit.author)}`, `committer ${rawPerson(c.commit.committer ?? c.commit.author)}`];
  return lines.join('\n') + '\n\n' + c.commit.message.replace(/\n*$/, '\n');
}

// ── Revisions ─────────────────────────────────────────────────────────────

/** A revision → oid: names, short oids, X~N, X^N, @, @{u}, X^{commit}/^{tree}/^{} */
async function rev(fs: Fs, dir: string, spec: string): Promise<string> {
  let s = spec;
  let want = '';
  const peelM = /\^\{(\w*)\}$/.exec(s);
  if (peelM) { want = peelM[1] || 'commit'; s = s.slice(0, peelM.index); }
  if (s === '@' || s === '') s = 'HEAD';
  const up = /^(.*)@\{(u|upstream|push)\}$/.exec(s);
  if (up) {
    const b = up[1] && up[1] !== 'HEAD' ? up[1] : await currentBranch(fs, dir);
    const u = b ? await upstreamOf(fs, dir, b) : null;
    if (!u) throw new Error(`no upstream configured for branch '${b ?? 'HEAD'}'`);
    s = u.ref;
  }
  if (/^stash(@\{\d+\})?$/.test(s)) throw new Error(`bad revision '${spec}'`);
  let oid = await resolveRevision(fs, dir, s);
  if (want === 'tree') oid = (await git.readCommit({ fs, dir, oid })).commit.tree;
  else if (want) oid = (await peel(fs, dir, oid)).oid;
  return oid;
}

/** The short name `HEAD`/a branch resolves to (rev-parse --abbrev-ref) */
async function abbrevRef(fs: Fs, dir: string, spec: string): Promise<string> {
  if (spec === 'HEAD' || spec === '@') return (await currentBranch(fs, dir)) ?? 'HEAD';
  const up = /^(.*)@\{(u|upstream)\}$/.exec(spec);
  if (up) {
    const b = up[1] && up[1] !== 'HEAD' ? up[1] : await currentBranch(fs, dir);
    const u = b ? await upstreamOf(fs, dir, b) : null;
    if (!u) throw new Error(`no upstream configured for branch '${b ?? 'HEAD'}'`);
    return u.short;
  }
  const full = await git.expandRef({ fs, dir, ref: spec }).catch(() => null);
  if (!full) throw new Error(`ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
  return full.replace(/^refs\/(heads|tags)\//, '').replace(/^refs\/remotes\//, '');
}

async function fullRef(fs: Fs, dir: string, spec: string): Promise<string> {
  const up = /^(.*)@\{(u|upstream|push)\}$/.exec(spec);
  if (up) {
    const b = up[1] && up[1] !== 'HEAD' ? up[1] : await currentBranch(fs, dir);
    const u = b ? await upstreamOf(fs, dir, b) : null;
    if (!u) throw new Error(`no upstream configured for branch '${b ?? 'HEAD'}'`);
    return u.ref;
  }
  if (spec === 'HEAD' || spec === '@') { const b = await currentBranch(fs, dir); return b ? `refs/heads/${b}` : 'HEAD'; }
  const full = await git.expandRef({ fs, dir, ref: spec }).catch(() => null);
  return full ?? '';
}

/** `git log -g`: the HEAD reflog, newest first (isomorphic-git writes none, so usually nothing) */
async function reflogLog(ctx: CommandContext, fs: Fs, dir: string, args: string[]): Promise<number> {
  let text = '';
  try { text = String(await fs.promises.readFile(`${dir}/.git/logs/HEAD`, 'utf8')); } catch { return 0; }
  const fmtArg = args.find((a) => a.startsWith('--format=') || a.startsWith('--pretty='));
  const fmt = fmtArg ? fmtArg.slice(fmtArg.indexOf('=') + 1).replace(/^t?format:/, '') : '%h %gd: %gs';
  const maxArg = args.find((a) => /^-\d+$/.test(a) || a.startsWith('--max-count='));
  const max = maxArg ? parseInt(maxArg.replace(/^-|--max-count=/g, ''), 10) : Infinity;
  const lines = text.split('\n').filter(Boolean).reverse().slice(0, max);
  const out: string[] = [];
  for (let n = 0; n < lines.length; n++) {
    const m = /^[0-9a-f]+ ([0-9a-f]+) [^\t]*\t(.*)$/.exec(lines[n]);
    if (!m) continue;
    try {
      const { commit } = await git.readCommit({ fs, dir, oid: m[1] });
      out.push(formatPretty({ oid: m[1], commit } as CommitInfo, fmt, { reflog: { selector: `HEAD@{${n}}`, subject: m[2] } }));
    } catch { /* pruned */ }
  }
  if (out.length) ctx.stdout += out.join(args.includes('-z') ? '\0' : '\n') + '\n';
  return 0;
}

/** `log --graph`: lanes of the commits still to come, one row per commit and a row where lanes fork or join */
class Graph {
  private lanes: string[] = [];
  constructor(private firstParent: boolean) {}
  private bars(n: number): string { return '| '.repeat(n); }
  draw(c: CommitInfo, text: string, multiline: boolean): string {
    let i = this.lanes.indexOf(c.oid);
    if (i < 0) { this.lanes.push(c.oid); i = this.lanes.length - 1; }
    const before = this.lanes.length;
    const head = this.lanes.map((_, j) => (j === i ? '* ' : '| ')).join('');
    const parents: string[] = this.firstParent ? c.commit.parent.slice(0, 1) : c.commit.parent;
    // first parent takes this lane; the others fork off to its right
    let forked = 0;
    if (parents.length) this.lanes[i] = parents[0]; else this.lanes.splice(i, 1);
    for (const p of parents.slice(1)) if (!this.lanes.includes(p)) { this.lanes.splice(i + 1 + forked, 0, p); forked++; }
    const width = 2 * Math.max(before, this.lanes.length);
    const lines = text.replace(/\n$/, '').split('\n');
    const out = [(forked ? head.padEnd(width) : head) + lines[0]];
    const rest = lines.slice(1);
    if (forked) {
      const fork = (this.bars(i) + '|' + '\\ '.repeat(forked).replace(/ $/, '') + (this.lanes.length > i + 1 + forked ? ' ' + this.bars(this.lanes.length - i - 1 - forked) : '')).padEnd(width);
      out.push(multiline && rest.length ? fork + rest.shift() : fork);
    }
    for (const l of rest) out.push((this.bars(this.lanes.length) + l).replace(/\s+$/, ''));
    // a lane whose commit another lane already waits for joins it
    if (parents.length) {
      const j = this.lanes.findIndex((o, k) => o === this.lanes[i] && k !== i);
      if (j >= 0) {
        const k = Math.max(i, j);
        this.lanes.splice(k, 1);
        out.push((this.bars(k - 1) + '|/' + ' /'.repeat(this.lanes.length - k)).padEnd(width));
      }
    }
    if (multiline) out.push(this.bars(this.lanes.length).replace(/\s+$/, ''));
    return out.join('\n');
  }
}

/** --topo-order (and --graph): no parent before its children; a merge's later parents first, as git's stack has them */
function topoOrder(commits: CommitInfo[]): CommitInfo[] {
  const byOid = new Map(commits.map((c) => [c.oid, c]));
  const indegree = new Map<string, number>(commits.map((c) => [c.oid, 0]));
  for (const c of commits) for (const p of c.commit.parent) if (indegree.has(p)) indegree.set(p, indegree.get(p)! + 1);
  const stack = commits.filter((c) => indegree.get(c.oid) === 0).reverse();
  const out: CommitInfo[] = [];
  while (stack.length) {
    const c = stack.pop()!;
    out.push(c);
    for (const p of c.commit.parent) {
      if (!indegree.has(p)) continue;
      const n = indegree.get(p)! - 1;
      indegree.set(p, n);
      if (n === 0) stack.push(byOid.get(p)!);
    }
  }
  return out;
}

// ── Commit walking (log, rev-list) ────────────────────────────────────────

interface WalkOpts { include: string[]; exclude: string[]; max?: number; skip?: number; firstParent?: boolean; noMerges?: boolean; merges?: boolean; paths?: string[]; author?: RegExp; grep?: RegExp; reverse?: boolean }

async function touches(fs: Fs, dir: string, c: CommitInfo, paths: string[], cache: Map<string, any>): Promise<boolean> {
  const parent = c.commit.parent[0];
  for (const p of paths) {
    const now = await blobAt(fs, dir, c.oid, p);
    const before = parent ? await blobAt(fs, dir, parent, p) : null;
    if (now !== before) return true;
    // a directory: compare its tree
  }
  void cache;
  return false;
}

async function blobAt(fs: Fs, dir: string, commit: string, path: string): Promise<string | null> {
  try { return (await git.readTree({ fs, dir, oid: commit, filepath: path.replace(/\/$/, '') })).oid; } catch { /* not a tree */ }
  try { return (await git.readBlob({ fs, dir, oid: commit, filepath: path })).oid; } catch { return null; }
}

async function walk(fs: Fs, dir: string, o: WalkOpts, cache: Map<string, any>): Promise<CommitInfo[]> {
  const excluded = o.exclude.length ? await ancestors(fs, dir, o.exclude, cache) : new Set<string>();
  const queue: CommitInfo[] = [];
  const seen = new Set<string>();
  for (const oid of o.include) {
    if (seen.has(oid) || excluded.has(oid)) continue;
    const c = await readCommit(fs, dir, oid, cache);
    if (c) { queue.push(c); seen.add(oid); }
  }
  const out: CommitInfo[] = [];
  let skip = o.skip ?? 0;
  const time = (c: CommitInfo) => (c.commit.committer ?? c.commit.author).timestamp;
  while (queue.length) {
    queue.sort((a, b) => time(b) - time(a));
    const c = queue.shift()!;
    const parents: string[] = o.firstParent ? c.commit.parent.slice(0, 1) : c.commit.parent;
    for (const p of parents) {
      if (seen.has(p) || excluded.has(p)) continue;
      seen.add(p);
      const pc = await readCommit(fs, dir, p, cache);
      if (pc) queue.push(pc);
    }
    const merge = c.commit.parent.length > 1;
    if (o.noMerges && merge) continue;
    if (o.merges && !merge) continue;
    if (o.author && !o.author.test(`${c.commit.author.name} <${c.commit.author.email}>`)) continue;
    if (o.grep && !o.grep.test(c.commit.message)) continue;
    if (o.paths?.length && !(await touches(fs, dir, c, o.paths, cache))) continue;
    if (skip > 0) { skip--; continue; }
    out.push(c);
    if (o.max !== undefined && out.length >= o.max && !o.reverse) break;
  }
  if (o.reverse) { out.reverse(); if (o.max !== undefined) return out.slice(0, o.max); }
  return out;
}

/** Revision arguments → include/exclude oids (A..B, A...B, ^A, --all, --branches, --tags) */
async function revRange(fs: Fs, dir: string, specs: string[], flags: { all?: boolean; branches?: boolean; tags?: boolean; remotes?: boolean }): Promise<{ include: string[]; exclude: string[] }> {
  const include: string[] = [], exclude: string[] = [];
  const refs = await allRefs(fs, dir);
  if (flags.all || flags.branches) for (const r of refs) if (r.ref.startsWith('refs/heads/')) include.push(r.oid);
  if (flags.all || flags.remotes) for (const r of refs) if (r.ref.startsWith('refs/remotes/')) include.push(r.oid);
  if (flags.all || flags.tags) for (const r of refs) if (r.ref.startsWith('refs/tags/')) include.push((await peel(fs, dir, r.oid)).oid);
  if (flags.all) { const h = await headOid(fs, dir); if (h) include.push(h); }
  for (const s of specs) {
    const three = s.indexOf('...'), two = s.indexOf('..');
    if (three >= 0) {
      const a = await rev(fs, dir, s.slice(0, three) || 'HEAD'), b = await rev(fs, dir, s.slice(three + 3) || 'HEAD');
      include.push(a, b);
      const cache = new Map();
      const A = await ancestors(fs, dir, [a], cache), B = await ancestors(fs, dir, [b], cache);
      for (const x of A) if (B.has(x)) exclude.push(x);
    } else if (two >= 0) {
      exclude.push(await rev(fs, dir, s.slice(0, two) || 'HEAD'));
      include.push(await rev(fs, dir, s.slice(two + 2) || 'HEAD'));
    } else if (s.startsWith('^')) {
      exclude.push(await rev(fs, dir, s.slice(1)));
    } else {
      include.push(await rev(fs, dir, s));
    }
  }
  if (!include.length && !flags.all && !flags.branches && !flags.tags && !flags.remotes) {
    const h = await headOid(fs, dir);
    if (h) include.push(h);
  }
  return { include, exclude };
}

// ── Changes (status, diff) ────────────────────────────────────────────────

interface Entry { path: string; head?: { oid: string; mode: number }; stage?: { oid: string; mode: number }; work?: { oid: string; mode: number } }

/** HEAD tree, index and (when asked) work tree side by side, by path */
async function entries(fs: Fs, dir: string, withWork: boolean, ref = 'HEAD'): Promise<Entry[]> {
  const hasHead = !!(await headOid(fs, dir)) || ref !== 'HEAD';
  const trees = [STAGE(), ...(hasHead ? [TREE({ ref })] : []), ...(withWork ? [WORKDIR()] : [])];
  const out: Entry[] = [];
  await git.walk({
    fs, dir, trees,
    map: async (filepath: string, ents: any[]) => {
      if (filepath === '.') return true;
      if (filepath === '.git') return null; // the work tree walker lists the repository itself
      const [stage, ...more] = ents;
      const head = hasHead ? more.shift() : null;
      const work = withWork ? more.shift() : null;
      const types = await Promise.all([stage, head, work].map((e) => (e ? e.type() : null)));
      if (types.includes('tree')) return true; // a directory: descend
      const pick = async (e: any) => (e ? { oid: await e.oid(), mode: await e.mode() } : undefined);
      out.push({ path: filepath, stage: await pick(stage), head: await pick(head), work: work ? { oid: '', mode: await work.mode() } : undefined });
      return true;
    },
  });
  if (withWork) {
    // the work tree's content hash only for files the index has (untracked ones are listed as such)
    for (const e of out) {
      if (!e.work) continue;
      try {
        const data = await fs.promises.readFile(`${dir}/${e.path}`);
        e.work.oid = (await git.hashBlob({ object: data })).oid;
      } catch { e.work = undefined; }
    }
  }
  return out;
}

/** Ignored by .gitignore (untracked files only) */
async function ignored(fs: Fs, dir: string, path: string): Promise<boolean> {
  return git.isIgnored({ fs, dir, filepath: path }).catch(() => false);
}

interface Status { path: string; x: string; y: string; e: Entry }
async function statusList(fs: Fs, dir: string, untracked: 'no' | 'normal' | 'all'): Promise<Status[]> {
  const out: Status[] = [];
  for (const e of await entries(fs, dir, true)) {
    if (!e.stage && !e.head) {
      if (untracked === 'no' || !e.work || await ignored(fs, dir, e.path)) continue;
      out.push({ path: e.path, x: '?', y: '?', e });
      continue;
    }
    let x = ' ', y = ' ';
    if (e.stage && !e.head) x = 'A';
    else if (!e.stage && e.head) x = 'D';
    else if (e.stage && e.head && (e.stage.oid !== e.head.oid || e.stage.mode !== e.head.mode)) x = 'M';
    if (e.stage && !e.work) y = 'D';
    else if (e.stage && e.work && e.work.oid !== e.stage.oid) y = 'M';
    if (x === ' ' && y === ' ') continue;
    out.push({ path: e.path, x, y, e });
  }
  if (untracked === 'normal') {
    // untracked files fold into their top untracked directory, as git shows them
    const tracked = new Set(out.filter((s) => s.x !== '?').map((s) => s.path));
    const trackedDirs = new Set<string>();
    for (const e of await git.listFiles({ fs, dir }).catch(() => [] as string[])) {
      tracked.add(e);
      for (let i = e.indexOf('/'); i >= 0; i = e.indexOf('/', i + 1)) trackedDirs.add(e.slice(0, i));
    }
    const folded = new Map<string, Status>();
    for (const s of out) {
      if (s.x !== '?') continue;
      const parts = s.path.split('/');
      let key = s.path;
      for (let k = 1; k < parts.length; k++) {
        const d = parts.slice(0, k).join('/');
        if (!trackedDirs.has(d)) { key = d + '/'; break; }
      }
      if (!folded.has(key)) folded.set(key, { ...s, path: key });
    }
    return [...out.filter((s) => s.x !== '?'), ...folded.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const oct = (m?: number) => (m ? m.toString(8).padStart(6, '0') : '000000');
const ZERO = '0'.repeat(40);

// ── The commands ──────────────────────────────────────────────────────────

/** Path of `p` (repository-relative) as seen from the working directory `prefix` */
function relTo(prefix: string, p: string): string {
  if (!prefix) return p;
  const a = prefix.replace(/\/$/, '').split('/'), b = p.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return '../'.repeat(a.length - i) + b.slice(i).join('/');
}

export async function gitPlumbing(ctx: CommandContext, fs: Fs, dir: string, workDir: string): Promise<number | null> {
  const [sub, ...args] = ctx.args;
  const prefix = workDir === dir ? '' : workDir.slice(dir === '/' ? 1 : dir.length + 1) + '/';
  const nul = args.includes('-z');
  const fail = (msg: string, code = 128) => { ctx.stderr += `fatal: ${msg}\n`; return code; };
  const cache = new Map<string, any>();
  const valueOf = (name: string, short?: string): string | undefined => {
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
      if ((args[i] === name || (short && args[i] === short)) && i + 1 < args.length) return args[i + 1];
    }
    return undefined;
  };

  switch (sub) {
    case 'rev-parse': {
      let abbrev = false, symbolic = false, verify = false, quiet = false, short = 0;
      const lines: string[] = [];
      const revs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') break;
        if (a === '--git-dir') lines.push(workDir === dir ? '.git' : `${dir === '/' ? '' : dir}/.git`);
        else if (a === '--absolute-git-dir' || a === '--git-common-dir') lines.push(`${dir === '/' ? '' : dir}/.git`);
        else if (a === '--show-toplevel') lines.push(dir);
        else if (a === '--is-inside-work-tree') lines.push('true');
        else if (a === '--is-inside-git-dir' || a === '--is-bare-repository' || a === '--is-shallow-repository') lines.push('false');
        else if (a === '--show-cdup') lines.push(prefix ? '../'.repeat(prefix.split('/').length - 1) : '');
        else if (a === '--show-prefix') lines.push(prefix);
        else if (a === '--show-superproject-working-tree') { /* not a submodule */ }
        else if (a === '--abbrev-ref' || a.startsWith('--abbrev-ref=')) abbrev = true;
        else if (a === '--symbolic-full-name') symbolic = true;
        else if (a === '--verify') verify = true;
        else if (a === '-q' || a === '--quiet') quiet = true;
        else if (a === '--short') short = 7;
        else if (a.startsWith('--short=')) short = Math.max(4, parseInt(a.slice(8), 10) || 7);
        else if (a === '--local-env-vars') lines.push('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY');
        else if (a.startsWith('--')) { /* --sq, --default, ...: ignored */ }
        else revs.push(a), lines.push(`\0rev:${a}`);
      }
      if (verify && revs.length !== 1) return quiet ? 1 : fail('Needed a single revision');
      const out: string[] = [];
      for (const l of lines) {
        if (!l.startsWith('\0rev:')) { out.push(l); continue; }
        const spec = l.slice(5);
        try {
          if (abbrev) out.push(await abbrevRef(fs, dir, spec));
          else if (symbolic) out.push(await fullRef(fs, dir, spec));
          else { const oid = await rev(fs, dir, spec); out.push(short ? oid.slice(0, short) : oid); }
        } catch (e: any) {
          if (verify) return quiet ? 1 : fail('Needed a single revision');
          ctx.stdout += out.map((x) => x + '\n').join('');
          if (/no upstream/.test(e?.message ?? '')) return fail(e.message);
          ctx.stdout += `${spec}\n`;
          return fail(`ambiguous argument '${spec}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
        }
      }
      ctx.stdout += out.map((x) => x + '\n').join('');
      return 0;
    }

    case 'symbolic-ref': {
      const quiet = args.includes('-q') || args.includes('--quiet');
      const short = args.includes('--short');
      const pos = args.filter((a) => !a.startsWith('-'));
      const name = pos[0] ?? 'HEAD';
      if (name !== 'HEAD') return fail(`ref ${name} is not a symbolic ref`);
      if (pos[1]) {
        await fs.promises.writeFile(`${dir}/.git/HEAD`, `ref: ${pos[1]}\n`);
        return 0;
      }
      const b = await currentBranch(fs, dir);
      if (!b) return quiet ? 1 : fail('ref HEAD is not a symbolic ref');
      ctx.stdout += short ? `${b}\n` : `refs/heads/${b}\n`;
      return 0;
    }

    case 'show-ref': {
      const heads = args.includes('--heads') || args.includes('--branches'), tags = args.includes('--tags');
      const deref = args.includes('-d') || args.includes('--dereference');
      const hashOnly = args.some((a) => a === '-s' || a === '--hash' || a.startsWith('--hash='));
      const verifyMode = args.includes('--verify');
      const quiet = args.includes('-q') || args.includes('--quiet');
      const pats = args.filter((a) => !a.startsWith('-'));
      const rows: string[] = [];
      if (args.includes('--head')) { const h = await headOid(fs, dir); if (h) rows.push(hashOnly ? h : `${h} HEAD`); }
      for (const { ref, oid } of await allRefs(fs, dir)) {
        if (heads && !tags && !ref.startsWith('refs/heads/')) continue;
        if (tags && !heads && !ref.startsWith('refs/tags/')) continue;
        if (pats.length && !pats.some((p) => (verifyMode ? ref === p : ref === p || ref.endsWith('/' + p)))) continue;
        rows.push(hashOnly ? oid : `${oid} ${ref}`);
        if (deref && ref.startsWith('refs/tags/')) {
          const p = await peel(fs, dir, oid);
          if (p.oid !== oid) rows.push(hashOnly ? p.oid : `${p.oid} ${ref}^{}`);
        }
      }
      if (!rows.length) return verifyMode && !quiet ? fail(`'${pats[0] ?? ''}' - not a valid ref`) : 1;
      if (!quiet) ctx.stdout += rows.map((r) => r + '\n').join('');
      return 0;
    }

    case 'for-each-ref': {
      const format = valueOf('--format') ?? '%(objectname) %(objecttype)\t%(refname)';
      const sorts = args.filter((a) => a.startsWith('--sort=')).map((a) => a.slice(7));
      for (let i = 0; i < args.length; i++) if (args[i] === '--sort' && args[i + 1]) sorts.push(args[i + 1]);
      const count = parseInt(valueOf('--count') ?? '0', 10) || 0;
      const pointsAt = valueOf('--points-at');
      const skipNext = new Set(['--format', '--sort', '--count', '--points-at']);
      const pats: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (skipNext.has(args[i])) { i++; continue; }
        if (!args[i].startsWith('-')) pats.push(args[i]);
      }
      const head = await currentBranch(fs, dir);
      type Row = { ref: string; oid: string; c: CommitInfo | null; type: string };
      const rows: Row[] = [];
      const pointsOid = pointsAt ? await rev(fs, dir, pointsAt).catch(() => '') : '';
      for (const { ref, oid } of await allRefs(fs, dir)) {
        if (pats.length && !pats.some((p) => ref === p || ref.startsWith(p.replace(/\/?\*?$/, '/')) || (p.includes('*') && new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$').test(ref)))) continue;
        const type = await objectType(fs, dir, oid).catch(() => 'commit');
        const target = type === 'tag' ? (await peel(fs, dir, oid)).oid : oid;
        if (pointsAt && target !== pointsOid && oid !== pointsOid) continue;
        rows.push({ ref, oid, type, c: await readCommit(fs, dir, target, cache) });
      }
      const key = (r: Row, k: string): string | number => {
        if (k === 'committerdate' || k === 'creatordate') return r.c ? (r.c.commit.committer ?? r.c.commit.author).timestamp : 0;
        if (k === 'authordate') return r.c ? r.c.commit.author.timestamp : 0;
        if (k === 'objectname') return r.oid;
        return r.ref;
      };
      for (const s of [...sorts].reverse()) {
        const desc = s.startsWith('-'), k = s.replace(/^-/, '');
        rows.sort((a, b) => { const x = key(a, k), y = key(b, k); const c = x < y ? -1 : x > y ? 1 : 0; return desc ? -c : c; });
      }
      const picked = count ? rows.slice(0, count) : rows;
      for (const r of picked) {
        let line = '';
        for (let i = 0; i < format.length; i++) {
          if (format[i] === '%' && format[i + 1] === '%') { line += '%'; i++; continue; }
          if (format[i] === '%' && /^[0-9a-fA-F]{2}/.test(format.slice(i + 1, i + 3))) { line += String.fromCharCode(parseInt(format.slice(i + 1, i + 3), 16)); i += 2; continue; }
          if (format[i] === '%' && format[i + 1] === '(') {
            const end = format.indexOf(')', i);
            const atom = format.slice(i + 2, end);
            line += await refAtom(fs, dir, r, atom, head, cache);
            i = end;
            continue;
          }
          line += format[i];
        }
        ctx.stdout += line + '\n';
      }
      return 0;
    }

    case 'cat-file': {
      const batch = args.find((a) => a === '--batch' || a === '--batch-check' || a.startsWith('--batch-check=') || a.startsWith('--batch='));
      if (batch) {
        for (const line of (ctx.stdin ?? '').split('\n').filter(Boolean)) {
          const spec = line.trim();
          let oid: string;
          try { oid = /^[0-9a-f]{40}$/.test(spec) ? spec : await rev(fs, dir, spec); } catch { ctx.stdout += `${spec} missing\n`; continue; }
          const o = await git.readObject({ fs, dir, oid, format: 'content' }).catch(() => null);
          if (!o) { ctx.stdout += `${spec} missing\n`; continue; }
          const data = o.object as Uint8Array;
          ctx.stdout += `${oid} ${o.type} ${data.length}\n`;
          if (batch.startsWith('--batch') && !batch.startsWith('--batch-check')) ctx.stdout += new TextDecoder().decode(data) + '\n';
        }
        return 0;
      }
      const flag = args.find((a) => /^-[tspe]$/.test(a));
      const pos = args.filter((a) => !a.startsWith('-'));
      const spec = flag ? pos[0] : pos[1];
      if (!spec) return fail('usage: git cat-file (-t | -s | -e | -p | <type>) <object>', 129);
      let oid: string;
      const colon = spec.indexOf(':');
      try {
        if (colon >= 0) {
          const commit = await rev(fs, dir, spec.slice(0, colon) || 'HEAD');
          const path = spec.slice(colon + 1);
          oid = path ? (await blobAt(fs, dir, commit, path)) ?? '' : (await git.readCommit({ fs, dir, oid: commit })).commit.tree;
          if (!oid) throw new Error('no such path');
        } else oid = /^[0-9a-f]{40}$/.test(spec) ? spec : await rev(fs, dir, spec);
      } catch { return flag === '-e' ? 1 : fail(`Not a valid object name ${spec}`); }
      const o = await git.readObject({ fs, dir, oid, format: 'content' }).catch(() => null);
      if (!o) return flag === '-e' ? 1 : fail(`Not a valid object name ${spec}`);
      const data = o.object as Uint8Array;
      if (flag === '-e') return 0;
      if (flag === '-t') { ctx.stdout += `${o.type}\n`; return 0; }
      if (flag === '-s') { ctx.stdout += `${data.length}\n`; return 0; }
      if (o.type === 'tree' && flag === '-p') {
        const t = await git.readTree({ fs, dir, oid });
        for (const e of t.tree) ctx.stdout += `${e.mode.padStart(6, '0')} ${e.type} ${e.oid}\t${e.path}\n`;
        return 0;
      }
      ctx.stdout += new TextDecoder().decode(data);
      return 0;
    }

    case 'ls-files': {
      const modified = args.includes('-m') || args.includes('--modified');
      const others = args.includes('-o') || args.includes('--others');
      const deleted = args.includes('-d') || args.includes('--deleted');
      const stage = args.includes('-s') || args.includes('--stage');
      const cached = args.includes('-c') || args.includes('--cached') || (!modified && !others && !deleted);
      const full = args.includes('--full-name');
      const pats = args.slice(args.indexOf('--') >= 0 ? args.indexOf('--') + 1 : 0).filter((a) => !a.startsWith('-'));
      const show = (p: string) => (full ? p : relTo(prefix, p));
      const inScope = (p: string) => (!prefix || p.startsWith(prefix)) && (!pats.length || pats.some((x) => { const q = prefix + x.replace(/^\.\/?/, ''); return !q || p === q || p.startsWith(q.replace(/\/?$/, '/')); }));
      const sep = nul ? '\0' : '\n';
      const ents = await entries(fs, dir, modified || others || deleted);
      for (const e of ents) {
        if (!inScope(e.path)) continue;
        if (e.stage) {
          if (cached) ctx.stdout += (stage ? `${oct(e.stage.mode)} ${e.stage.oid} 0\t` : '') + show(e.path) + sep;
          if (deleted && !e.work) ctx.stdout += show(e.path) + sep;
          if (modified && (!e.work || e.work.oid !== e.stage.oid)) ctx.stdout += show(e.path) + sep;
        } else if (others && e.work && !(await ignored(fs, dir, e.path))) ctx.stdout += show(e.path) + sep;
      }
      return 0;
    }

    case 'worktree': {
      if (args[0] !== 'list') return null;
      const h = await headOid(fs, dir);
      const b = await currentBranch(fs, dir);
      if (args.includes('--porcelain')) {
        ctx.stdout += `worktree ${dir}\nHEAD ${h ?? ZERO}\n${b ? `branch refs/heads/${b}` : 'detached'}\n\n`;
      } else {
        ctx.stdout += `${dir}  ${(h ?? ZERO).slice(0, 7)} ${b ? `[${b}]` : '(detached HEAD)'}\n`;
      }
      return 0;
    }

    case 'merge-base': {
      const pos = args.filter((a) => !a.startsWith('-'));
      if (args.includes('--is-ancestor')) {
        const [a, b] = await Promise.all(pos.slice(0, 2).map((p) => rev(fs, dir, p)));
        return (await ancestors(fs, dir, [b], cache)).has(a) ? 0 : 1;
      }
      if (pos.length < 2) return fail('usage: git merge-base <commit> <commit>', 129);
      const oids = await Promise.all(pos.map((p) => rev(fs, dir, p)));
      const bases = await git.findMergeBase({ fs, dir, oids }).catch(() => [] as string[]);
      if (!bases.length) return 1;
      ctx.stdout += (args.includes('--all') ? bases : bases.slice(0, 1)).map((b: string) => b + '\n').join('');
      return 0;
    }

    case 'rev-list': {
      const o = await logOptions(fs, dir, args);
      const commits = await walk(fs, dir, o.walk, cache);
      if (args.includes('--count')) {
        if (args.includes('--left-right')) {
          const range = o.specs.find((s) => s.includes('...'));
          if (range) {
            const [l, r] = range.split('...');
            const [ahead, behind] = await aheadBehind(fs, dir, await rev(fs, dir, l || 'HEAD'), await rev(fs, dir, r || 'HEAD'), cache);
            ctx.stdout += `${ahead}\t${behind}\n`;
            return 0;
          }
        }
        ctx.stdout += `${commits.length}\n`;
        return 0;
      }
      for (const c of commits) ctx.stdout += (args.includes('--parents') ? [c.oid, ...c.commit.parent].join(' ') : c.oid) + '\n';
      return 0;
    }

    case 'status': {
      // -sb, -bs, -s -b
      for (let i = 0; i < args.length; i++) if (/^-[sbz]{2,}$/.test(args[i])) args.splice(i, 1, ...[...args[i].slice(1)].map((f) => '-' + f));
      const porc = args.find((a) => a === '--porcelain' || a.startsWith('--porcelain='));
      const short = args.includes('-s') || args.includes('--short');
      const branchHdr = args.includes('-b') || args.includes('--branch');
      if (!porc && !nul && !(short && branchHdr)) return null;
      const v2 = porc === '--porcelain=v2' || porc === '--porcelain=2';
      const uArg = args.find((a) => a.startsWith('-u') || a.startsWith('--untracked-files'));
      const uVal = uArg ? (uArg.includes('=') ? uArg.split('=')[1] : uArg.slice(2)) : '';
      const untracked = uVal === 'no' ? 'no' : uVal === 'all' || nul ? 'all' : 'normal';
      const end = nul ? '\0' : '\n';
      const list = await statusList(fs, dir, untracked);
      const b = await currentBranch(fs, dir);
      const h = await headOid(fs, dir);
      const up = b ? await upstreamOf(fs, dir, b) : null;
      let ab: [number, number] | null = null;
      if (up && h) { try { ab = await aheadBehind(fs, dir, h, await git.resolveRef({ fs, dir, ref: up.ref }), cache); } catch { ab = null; } }
      const show = (p: string) => (porc ? p : relTo(prefix, p));
      if (v2) {
        if (branchHdr) {
          ctx.stdout += `# branch.oid ${h ?? '(initial)'}${end}# branch.head ${b ?? '(detached)'}${end}`;
          if (up) ctx.stdout += `# branch.upstream ${up.short}${end}` + (ab ? `# branch.ab +${ab[0]} -${ab[1]}${end}` : '');
        }
        for (const s of list) {
          if (s.x === '?') { ctx.stdout += `? ${s.path}${end}`; continue; }
          const e = s.e;
          ctx.stdout += `1 ${s.x === ' ' ? '.' : s.x}${s.y === ' ' ? '.' : s.y} N... ${oct(e.head?.mode)} ${oct(e.stage?.mode)} ${oct(e.work ? e.stage?.mode ?? e.work.mode : 0)} ${e.head?.oid ?? ZERO} ${e.stage?.oid ?? ZERO} ${s.path}${end}`;
        }
        return 0;
      }
      if (branchHdr) {
        let hdr = `## ${b ?? 'HEAD (no branch)'}`;
        if (!h && b) hdr = `## No commits yet on ${b}`;
        else if (up) hdr += `...${up.short}` + (ab && (ab[0] || ab[1]) ? ` [${[ab[0] ? `ahead ${ab[0]}` : '', ab[1] ? `behind ${ab[1]}` : ''].filter(Boolean).join(', ')}]` : '');
        ctx.stdout += hdr + end;
      }
      for (const s of list) ctx.stdout += `${s.x}${s.y} ${show(s.path)}${end}`;
      return 0;
    }

    case 'log':
    case 'show': {
      if (sub === 'show' && !args.some((a) => a.startsWith('--format') || a.startsWith('--pretty') || a === '-s' || a === '--no-patch' || a === '--name-status' || a === '--numstat' || a === '--name-only' || a === '--stat')) return null;
      if (sub === 'log' && (args.includes('-g') || args.includes('--walk-reflogs'))) return reflogLog(ctx, fs, dir, args);
      const o = await logOptions(fs, dir, sub === 'show' ? ['-1', '--no-walk', ...args] : args);
      const commits = await walk(fs, dir, o.walk, cache);
      const decor = o.decorate || /%[dD]/.test(o.format ?? '') ? await decorations(fs, dir, o.decorate === 'full') : undefined;
      const parts: string[] = [];
      const graph = args.includes('--graph') ? new Graph(!!o.walk.firstParent) : null;
      const ordered = graph || args.includes('--topo-order') ? topoOrder(commits) : commits;
      for (const c of ordered) {
        let text: string;
        if (o.style === 'format') text = formatPretty(c, o.format!, { decor, date: o.date });
        else if (o.style === 'oneline') text = `${o.abbrev ? c.oid.slice(0, 7) : c.oid}${decor?.get(c.oid)?.length ? ` (${decor.get(c.oid)!.join(', ')})` : ''} ${subjectOf(c.commit.message)}`;
        else if (o.style === 'raw') text = `commit ${[c.oid, ...(o.parents ? c.commit.parent : [])].join(' ')}\n` + rawCommit(c).replace(/\n\n([^]*)$/, (_m, msg: string) => '\n\n' + msg.replace(/\n$/, '').split('\n').map((l: string) => '    ' + l).join('\n') + '\n');
        else {
          const d = decor?.get(c.oid);
          text = `commit ${[c.oid, ...(o.parents ? c.commit.parent : [])].join(' ')}${d?.length ? ` (${d.join(', ')})` : ''}\n`;
          if (c.commit.parent.length > 1) text += `Merge: ${c.commit.parent.map((p: string) => p.slice(0, 7)).join(' ')}\n`;
          text += `Author: ${c.commit.author.name} <${c.commit.author.email}>\n`;
          if (o.style === 'fuller') text += `AuthorDate: ${gitDate(c.commit.author, o.date)}\nCommit:     ${(c.commit.committer ?? c.commit.author).name} <${(c.commit.committer ?? c.commit.author).email}>\nCommitDate: ${gitDate(c.commit.committer ?? c.commit.author, o.date)}\n`;
          else if (o.style !== 'short') text += `Date:   ${gitDate(c.commit.author, o.date)}\n`;
          const msg = o.style === 'short' ? subjectOf(c.commit.message) : c.commit.message.replace(/\n+$/, '');
          text += `\n${msg.split('\n').map((l: string) => '    ' + l).join('\n')}\n`;
        }
        if (o.changes) {
          const parent = c.commit.parent[0] ?? null;
          const ch = await changesBetween(fs, dir, parent, c.oid);
          const extra = await formatChanges(fs, dir, ch, o.changes, nul, prefix, { from: parent, to: c.oid });
          if (extra) text = text ? text.replace(/\n$/, '') + '\n\n' + extra.replace(/\n$/, '') : extra.replace(/\n$/, '');
        }
        if (graph) text = graph.draw(c, text, o.style !== 'oneline' && o.style !== 'format');
        parts.push(text);
      }
      if (!parts.length) return 0;
      if (graph && o.style !== 'oneline' && o.style !== 'format') {
        // each commit ends with its lanes as the separator line; not after the last
        ctx.stdout += parts.join('\n').replace(/\n[| ]*$/, '') + '\n';
        return 0;
      }
      const sep = nul ? '\0' : o.style === 'format' || o.style === 'oneline' ? '\n' : '\n';
      if (o.style === 'medium' || o.style === 'raw' || o.style === 'fuller' || o.style === 'short' || o.style === 'full') {
        ctx.stdout += parts.join(nul ? '\0' : '\n') + (nul ? '' : '');
      } else {
        ctx.stdout += parts.join(sep) + (o.terminate ? (nul ? '\0' : '\n') : '');
      }
      return 0;
    }

    case 'update-index': {
      // --add --remove [-z --stdin | -- paths]: what tig stages and unstages files with (--refresh: nothing to refresh)
      let paths = args.filter((a) => !a.startsWith('-'));
      if (args.includes('--stdin')) paths = ctx.stdin.split(nul ? '\0' : '\n').filter(Boolean);
      for (const p of paths) {
        const filepath = (prefix + p).replace(/^\.\//, '');
        if (await fs.promises.stat(`${dir}/${filepath}`).then(() => true, () => false)) {
          await git.add({ fs, dir, filepath });
        } else if (args.includes('--remove') || args.includes('--force-remove')) {
          await git.remove({ fs, dir, filepath });
        }
      }
      return 0;
    }

    case 'diff-files':
    case 'diff-index':
    case 'diff': {
      const mode = changeMode(args) ?? (sub === 'diff' ? 'patch' : 'raw');
      if (sub === 'diff-files' || sub === 'diff-index') {
        const dd = args.indexOf('--');
        const paths = (dd >= 0 ? args.slice(dd + 1) : []).map((p) => (prefix + p.replace(/^\.\/?/, '')).replace(/\/$/, ''));
        let from: Side | null = 'index', to: Side = 'work';
        if (sub === 'diff-index') {
          const r = (dd >= 0 ? args.slice(0, dd) : args).find((a) => !a.startsWith('-'));
          if (!r) return fail('usage: git diff-index [<options>] <tree-ish> [<path>...]', 129);
          from = await rev(fs, dir, r).catch(() => null);
          if (!from) return fail(`bad revision '${r}'`);
          to = args.includes('--cached') ? 'index' : 'work';
        }
        let ch = await changesFor(fs, dir, from, to);
        if (paths.length) ch = ch.filter((c) => paths.some((p) => c.path === p || c.path.startsWith(p + '/')));
        if (args.includes('--quiet')) return ch.length ? 1 : 0;
        ctx.stdout += await formatChanges(fs, dir, ch, mode, nul, prefix, { from, to });
        return args.includes('--exit-code') && ch.length ? 1 : 0;
      }
      if (args.includes('--no-index')) return null;
      const { from, to, paths } = await diffSides(fs, dir, args, prefix);
      let ch = await changesFor(fs, dir, from, to);
      if (paths.length) ch = ch.filter((c) => paths.some((p) => c.path === p || c.path.startsWith(p.replace(/\/?$/, '/'))));
      if (args.includes('--quiet')) return ch.length ? 1 : 0;
      ctx.stdout += await formatChanges(fs, dir, ch, mode, nul, prefix, { from, to });
      return args.includes('--exit-code') && ch.length ? 1 : 0;
    }

    case 'branch': {
      const vv = args.includes('-vv'), v = vv || args.includes('-v') || args.includes('--verbose');
      const fmt = valueOf('--format');
      if (args.includes('--show-current')) { ctx.stdout += `${(await currentBranch(fs, dir)) ?? ''}\n`; return 0; }
      if (!v && !fmt) return null;
      const all = args.includes('-a') || args.includes('--all'), remote = args.includes('-r') || args.includes('--remotes');
      const pats = remote || all ? ['refs/remotes/'] : [];
      if (!remote) pats.unshift('refs/heads/');
      if (fmt) {
        const sorted = args.find((a) => a.startsWith('--sort='));
        return gitPlumbing({ ...ctx, args: ['for-each-ref', `--format=${fmt}`, ...(sorted ? [sorted] : []), ...pats] } as CommandContext, fs, dir, workDir)
          .then((code) => code);
      }
      const head = await currentBranch(fs, dir);
      const refs = (await allRefs(fs, dir)).filter((r) => pats.some((p) => r.ref.startsWith(p)));
      const width = Math.max(0, ...refs.map((r) => r.ref.replace(/^refs\/heads\//, '').replace(/^refs\//, '').length));
      for (const r of refs) {
        const name = r.ref.startsWith('refs/heads/') ? r.ref.slice(11) : r.ref.slice(5);
        const c = await readCommit(fs, dir, r.oid, cache);
        let track = '';
        if (r.ref.startsWith('refs/heads/')) {
          const up = await upstreamOf(fs, dir, name);
          if (up) {
            let ab: [number, number] | null = null;
            try { ab = await aheadBehind(fs, dir, r.oid, await git.resolveRef({ fs, dir, ref: up.ref }), cache); } catch { ab = null; }
            const bits = ab ? [ab[0] ? `ahead ${ab[0]}` : '', ab[1] ? `behind ${ab[1]}` : ''].filter(Boolean).join(', ') : 'gone';
            if (vv) track = `[${up.short}${bits ? `: ${bits}` : ''}] `;
            else if (bits) track = `[${bits}] `;
          }
        }
        ctx.stdout += `${name === head ? '*' : ' '} ${name.padEnd(width)} ${r.oid.slice(0, 7)} ${track}${c ? subjectOf(c.commit.message) : ''}\n`;
      }
      return 0;
    }

    default:
      return null;
  }
}

/** One %(atom) of for-each-ref */
async function refAtom(fs: Fs, dir: string, r: { ref: string; oid: string; c: CommitInfo | null; type: string }, atom: string, head: string | undefined, cache: Map<string, any>): Promise<string> {
  const [name, mod = ''] = atom.split(/:(.*)/s);
  const short = (ref: string) => ref.replace(/^refs\/(heads|tags)\//, '').replace(/^refs\/remotes\//, '').replace(/^refs\//, '');
  const strip = (ref: string, n: number) => ref.split('/').slice(n).join('/');
  const c = r.c?.commit;
  const who = (p: any) => {
    if (!p) return '';
    if (mod === 'unix') return String(p.timestamp);
    if (mod === 'iso8601' || mod === 'iso') return gitDate(p, 'iso');
    if (mod === 'iso8601-strict' || mod === 'iso-strict') return gitDate(p, 'iso-strict');
    if (mod === 'relative') return relativeDate(p.timestamp);
    if (mod === 'short') return gitDate(p, 'short');
    if (mod === 'raw') return gitDate(p, 'raw');
    return gitDate(p);
  };
  switch (name) {
    case 'refname':
      if (mod === 'short') return short(r.ref);
      if (mod.startsWith('lstrip=') || mod.startsWith('strip=')) return strip(r.ref, parseInt(mod.split('=')[1], 10));
      return r.ref;
    case 'objectname': return mod === 'short' || mod.startsWith('short') ? r.oid.slice(0, parseInt(mod.split('=')[1] ?? '7', 10) || 7) : r.oid;
    case 'objecttype': return r.type;
    case 'HEAD': return r.ref === `refs/heads/${head}` ? '*' : ' ';
    case 'subject': case 'contents:subject': return c ? subjectOf(c.message) : '';
    case 'contents': return mod === 'subject' ? (c ? subjectOf(c.message) : '') : mod === 'body' ? (c ? bodyOf(c.message) : '') : c?.message ?? '';
    case 'body': return c ? bodyOf(c.message) : '';
    case 'authorname': return c?.author.name ?? '';
    case 'authoremail': return c ? (mod === 'trim' ? c.author.email : `<${c.author.email}>`) : '';
    case 'authordate': return who(c?.author);
    case 'committername': return (c?.committer ?? c?.author)?.name ?? '';
    case 'committeremail': return c ? (mod === 'trim' ? (c.committer ?? c.author).email : `<${(c.committer ?? c.author).email}>`) : '';
    case 'committerdate': case 'creatordate': return who(c?.committer ?? c?.author);
    case 'upstream': case 'push': {
      if (!r.ref.startsWith('refs/heads/')) return '';
      const up = await upstreamOf(fs, dir, r.ref.slice(11));
      if (!up) return '';
      if (mod === 'short') return up.short;
      if (mod === 'remotename') return up.remote;
      if (mod === 'remoteref') return up.ref.replace(/^refs\/remotes\/[^/]+\//, 'refs/heads/');
      if (mod.startsWith('track')) {
        let ab: [number, number];
        try { ab = await aheadBehind(fs, dir, r.oid, await git.resolveRef({ fs, dir, ref: up.ref }), cache); } catch { return mod.endsWith('short') ? '' : '[gone]'; }
        const nobracket = mod.includes('nobracket');
        if (mod.startsWith('trackshort')) return ab[0] && ab[1] ? '<>' : ab[0] ? '>' : ab[1] ? '<' : '=';
        const s = [ab[0] ? `ahead ${ab[0]}` : '', ab[1] ? `behind ${ab[1]}` : ''].filter(Boolean).join(', ');
        return s ? (nobracket ? s : `[${s}]`) : '';
      }
      return up.ref;
    }
    case 'symref': return '';
    case 'worktreepath': return r.ref === `refs/heads/${head}` ? dir : '';
    case 'objectsize': return '';
    default: return '';
  }
}

// ── log options ───────────────────────────────────────────────────────────

interface LogOptions { walk: WalkOpts; specs: string[]; style: string; format?: string; terminate: boolean; date: string; decorate?: string; abbrev: boolean; parents: boolean; changes?: string }

async function logOptions(fs: Fs, dir: string, args: string[]): Promise<LogOptions> {
  const o: LogOptions = { walk: { include: [], exclude: [] }, specs: [], style: 'medium', terminate: true, date: 'default', abbrev: false, parents: false };
  const flags: { all?: boolean; branches?: boolean; tags?: boolean; remotes?: boolean } = {};
  const paths: string[] = [];
  let noWalk = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i]);
    if (a === '--') { paths.push(...args.slice(i + 1)); break; }
    if (/^-\d+$/.test(a)) o.walk.max = parseInt(a.slice(1), 10);
    else if (a === '-n' || a.startsWith('--max-count')) o.walk.max = parseInt(a === '-n' ? args[++i] : val(), 10);
    else if (/^-n\d+$/.test(a)) o.walk.max = parseInt(a.slice(2), 10);
    else if (a.startsWith('--skip')) o.walk.skip = parseInt(val(), 10);
    else if (a === '--oneline') { o.style = 'oneline'; o.abbrev = true; }
    else if (a.startsWith('--pretty') || a.startsWith('--format')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : a === '--pretty' ? 'medium' : args[++i];
      if (/^(oneline|short|medium|full|fuller|raw|reference|email)$/.test(v)) { o.style = v === 'reference' ? 'oneline' : v; if (v === 'oneline') o.abbrev = false; }
      else if (v.startsWith('format:')) { o.style = 'format'; o.format = v.slice(7); o.terminate = false; }
      else if (v.startsWith('tformat:')) { o.style = 'format'; o.format = v.slice(8); }
      else { o.style = 'format'; o.format = v; }
    }
    else if (a === '--abbrev-commit') o.abbrev = true;
    else if (a.startsWith('--date=')) o.date = a.slice(7).replace(/^format:.*/, 'default').replace(/-local$/, '');
    else if (a === '--decorate' || a === '--decorate=short') o.decorate = 'short';
    else if (a === '--decorate=full') o.decorate = 'full';
    else if (a === '--no-decorate' || a === '--decorate=no') o.decorate = undefined;
    else if (a === '--parents') o.parents = true;
    else if (a === '--all') flags.all = true;
    else if (a === '--branches') flags.branches = true;
    else if (a === '--tags') flags.tags = true;
    else if (a === '--remotes') flags.remotes = true;
    else if (a === '--reverse') o.walk.reverse = true;
    else if (a === '--no-merges') o.walk.noMerges = true;
    else if (a === '--merges') o.walk.merges = true;
    else if (a === '--first-parent') o.walk.firstParent = true;
    else if (a === '--no-walk' || a.startsWith('--no-walk=')) noWalk = true;
    else if (a.startsWith('--author')) o.walk.author = new RegExp(val(), 'i');
    else if (a.startsWith('--grep')) o.walk.grep = new RegExp(val(), 'i');
    else if (a === '--name-status' || a === '--name-only' || a === '--numstat' || a === '--stat' || a === '--shortstat') o.changes = a.slice(2);
    else if (a === '-p' || a === '--patch' || a === '-u') o.changes = 'patch';
    else if (a.startsWith('--stat=')) o.changes = o.changes === 'patch' ? 'patch-with-stat' : 'stat';
    else if (a === '--patch-with-stat') o.changes = 'patch-with-stat';
    else if (a === '-s' || a === '--no-patch') o.changes = undefined;
    else if (a.startsWith('-')) { /* --no-color, --topo-order, --date-order, -z, --follow, ...: no change */ }
    else o.specs.push(a);
  }
  const { include, exclude } = await revRange(fs, dir, o.specs, flags);
  o.walk.include = include;
  o.walk.exclude = exclude;
  if (noWalk) o.walk.max = Math.min(o.walk.max ?? include.length, include.length) || 1;
  if (paths.length) o.walk.paths = paths;
  return o;
}

// ── diff ──────────────────────────────────────────────────────────────────

interface Change { path: string; status: 'A' | 'M' | 'D'; old?: string; new?: string; newWork?: boolean }

/** What a diff compares: commits (oid), 'index' or 'work' */
type Side = string;

async function diffSides(fs: Fs, dir: string, args: string[], prefix: string): Promise<{ from: Side | null; to: Side; paths: string[] }> {
  const dd = args.indexOf('--');
  const pos = (dd >= 0 ? args.slice(0, dd) : args).filter((a) => !a.startsWith('-'));
  const paths = (dd >= 0 ? args.slice(dd + 1) : []).map((p) => (prefix + p.replace(/^\.\/?/, '')).replace(/\/$/, ''));
  const cached = args.includes('--cached') || args.includes('--staged');
  const revs: string[] = [];
  for (const p of pos) {
    if (p.includes('..')) {
      const three = p.includes('...');
      const [a, b] = p.split(three ? '...' : '..');
      const A = await rev(fs, dir, a || 'HEAD'), B = await rev(fs, dir, b || 'HEAD');
      if (three) { const base = await git.findMergeBase({ fs, dir, oids: [A, B] }); return { from: base[0] ?? A, to: B, paths }; }
      return { from: A, to: B, paths };
    }
    try { revs.push(await rev(fs, dir, p)); } catch { paths.push((prefix + p).replace(/\/$/, '')); }
  }
  const head = await headOid(fs, dir);
  if (revs.length >= 2) return { from: revs[0], to: revs[1], paths };
  if (revs.length === 1) return cached ? { from: revs[0], to: 'index', paths } : { from: revs[0], to: 'work', paths };
  return cached ? { from: head, to: 'index', paths } : { from: 'index', to: 'work', paths };
}

/** What a diff prints, from its options (null: the command's default) */
function changeMode(args: string[]): string | null {
  const patch = args.some((a) => a === '-p' || a === '-u' || a === '--patch');
  if (args.includes('--patch-with-stat') || (patch && args.some((a) => a === '--stat' || a.startsWith('--stat=')))) return 'patch-with-stat';
  if (args.includes('--numstat')) return 'numstat';
  if (args.includes('--name-status')) return 'name-status';
  if (args.includes('--name-only')) return 'name-only';
  if (args.includes('--shortstat')) return 'shortstat';
  if (args.some((a) => a === '--stat' || a.startsWith('--stat='))) return 'stat';
  if (args.includes('--raw')) return 'raw';
  return patch ? 'patch' : null;
}

async function changesBetween(fs: Fs, dir: string, a: string | null, b: string): Promise<Change[]> {
  const out: Change[] = [];
  const trees = [TREE({ ref: b }), ...(a ? [TREE({ ref: a })] : [])];
  await git.walk({
    fs, dir, trees,
    map: async (path: string, [nb, na]: any[]) => {
      if (path === '.') return true;
      const tb = nb ? await nb.type() : null, ta = na ? await na.type() : null;
      if (tb === 'tree' || ta === 'tree') return true;
      const ob = nb ? await nb.oid() : undefined, oa = na ? await na.oid() : undefined;
      if (ob === oa) return true;
      out.push({ path, status: !oa ? 'A' : !ob ? 'D' : 'M', old: oa, new: ob });
      return true;
    },
  });
  return out.sort((x, y) => (x.path < y.path ? -1 : 1));
}

async function changesFor(fs: Fs, dir: string, from: Side | null, to: Side): Promise<Change[]> {
  if (to !== 'index' && to !== 'work' && from !== 'index') return changesBetween(fs, dir, from, to);
  const ents = await entries(fs, dir, to === 'work', from && from !== 'index' ? from : 'HEAD');
  const out: Change[] = [];
  for (const e of ents) {
    const a = from === 'index' ? e.stage : from ? e.head : undefined;
    let b: { oid: string } | undefined = to === 'index' ? e.stage : e.work;
    if (to === 'work' && !e.stage && !e.head) continue; // untracked: not part of a diff
    if (to === 'work' && from !== 'index' && !e.work && !e.stage) b = undefined;
    if (a?.oid === b?.oid) continue;
    if (!a && !b) continue;
    out.push({ path: e.path, status: !a ? 'A' : !b ? 'D' : 'M', old: a?.oid, new: b?.oid, newWork: to === 'work' });
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : 1));
}

async function textOf(fs: Fs, dir: string, oid: string | undefined, path: string, fromWork: boolean): Promise<string | null> {
  if (fromWork) {
    try {
      const d = await fs.promises.readFile(`${dir}/${path}`);
      if (typeof d === 'string') return d;
      return d.subarray(0, 8000).includes(0) ? null : new TextDecoder().decode(d);
    } catch { return ''; }
  }
  if (!oid) return '';
  const o = await git.readObject({ fs, dir, oid, format: 'content' }).catch(() => null);
  if (!o) return '';
  const bytes = o.object as Uint8Array;
  if (bytes.subarray(0, 8000).includes(0)) return null; // binary
  return new TextDecoder().decode(bytes);
}

async function formatChanges(fs: Fs, dir: string, ch: Change[], mode: string, nul: boolean, prefix: string, sides: { from: Side | null; to: Side }): Promise<string> {
  void prefix; void sides;
  const counts = async (c: Change): Promise<[number, number] | null> => {
    const a = await textOf(fs, dir, c.old, c.path, false);
    const b = await textOf(fs, dir, c.new, c.path, !!c.newWork && c.status !== 'D');
    if (a === null || b === null) return null;
    const al = a ? a.replace(/\n$/, '').split('\n') : [], bl = b ? b.replace(/\n$/, '').split('\n') : [];
    const d = unifiedDiff(al, bl);
    let plus = 0, minus = 0;
    for (const l of d.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) plus++; else if (l.startsWith('-') && !l.startsWith('---')) minus++; }
    return [plus, minus];
  };
  let out = '';
  if (mode === 'patch-with-stat') {
    const stat = await formatChanges(fs, dir, ch, 'stat', nul, prefix, sides);
    return stat + (stat ? '\n' : '') + await formatChanges(fs, dir, ch, 'patch', nul, prefix, sides);
  }
  if (mode === 'raw') {
    const z = '0'.repeat(40);
    for (const c of ch) {
      const line = `:${c.status === 'A' ? '000000' : '100644'} ${c.status === 'D' ? '000000' : '100644'} ${c.old ?? z} ${c.newWork ? z : c.new ?? z} ${c.status}`;
      out += nul ? `${line}\0${c.path}\0` : `${line}\t${c.path}\n`;
    }
    return out;
  }
  if (mode === 'name-only') for (const c of ch) out += c.path + (nul ? '\0' : '\n');
  else if (mode === 'name-status') for (const c of ch) out += nul ? `${c.status}\0${c.path}\0` : `${c.status}\t${c.path}\n`;
  else if (mode === 'numstat') {
    for (const c of ch) {
      const n = await counts(c);
      out += `${n ? n[0] : '-'}\t${n ? n[1] : '-'}\t${c.path}${nul ? '\0' : '\n'}`;
    }
  } else if (mode === 'stat' || mode === 'shortstat') {
    let files = 0, ins = 0, del = 0;
    const rows: [string, number, number][] = [];
    for (const c of ch) { const n = (await counts(c)) ?? [0, 0]; files++; ins += n[0]; del += n[1]; rows.push([c.path, n[0], n[1]]); }
    if (mode === 'stat') {
      const w = Math.max(0, ...rows.map((r) => r[0].length));
      for (const [p, a, d] of rows) out += ` ${p.padEnd(w)} | ${String(a + d).padStart(3)} ${'+'.repeat(Math.min(a, 40))}${'-'.repeat(Math.min(d, 40))}\n`;
    }
    if (files) out += ` ${files} file${files === 1 ? '' : 's'} changed` + (ins ? `, ${ins} insertion${ins === 1 ? '' : 's'}(+)` : '') + (del ? `, ${del} deletion${del === 1 ? '' : 's'}(-)` : '') + '\n';
  } else if (mode === 'patch') {
    const short = (o?: string) => (o ?? '0'.repeat(40)).slice(0, 7);
    for (const c of ch) {
      const a = await textOf(fs, dir, c.old, c.path, false);
      const b = c.status === 'D' ? '' : await textOf(fs, dir, c.new, c.path, !!c.newWork);
      out += `diff --git a/${c.path} b/${c.path}\n`;
      if (c.status === 'A') out += `new file mode 100644\nindex ${short()}..${short(c.new)}\n`;
      else if (c.status === 'D') out += `deleted file mode 100644\nindex ${short(c.old)}..${short()}\n`;
      else out += `index ${short(c.old)}..${short(c.new)} 100644\n`;
      if (a === null || b === null) {
        out += `Binary files ${c.status === 'A' ? '/dev/null' : `a/${c.path}`} and ${c.status === 'D' ? '/dev/null' : `b/${c.path}`} differ\n`;
        continue;
      }
      out += `--- ${c.status === 'A' ? '/dev/null' : `a/${c.path}`}\n+++ ${c.status === 'D' ? '/dev/null' : `b/${c.path}`}\n`;
      out += unifiedDiff(a ? a.replace(/\n$/, '').split('\n') : [], b ? b.replace(/\n$/, '').split('\n') : []);
    }
  }
  void readFileAtRef;
  return out;
}
