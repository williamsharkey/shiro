/**
 * The hybrid overlay: which programs are Shiro's and which are Debian's
 * (docs/DEBIAN.md "Hybrid overlay").
 *
 * The policy lives in dpkg's own database, as local diversions, so apt and
 * dpkg stay truthful:
 *
 *   Shiro's:  dpkg-divert --local --rename --divert PATH.debian --add PATH
 *             Debian's file moves to PATH.debian (later upgrades land there
 *             too); PATH holds a builtin shim the kernel and the shell run
 *             as the Shiro command of that name (or, for programs whose
 *             Shiro side is a kernel program, like apt's methods, a `#!`
 *             stub naming it), so PATH searches with stat() find it.
 *   Debian's: no diversion; PATH is the package's own file.
 *
 * `dpkg-divert --list`, `dpkg -S PATH` and `dpkg --verify` show exactly what
 * runs. `shiro-alternatives` (src/commands/shiro-alternatives.ts) switches a
 * program, update-alternatives style; defaults come from overlay-policy.json
 * and are applied when a package installs a program for the first time.
 *
 * In Debian mode the shell and the kernel prefer a file on the standard
 * PATH directories over a builtin of the same name (`debianShadows`).
 */
import type { FileSystem } from '../filesystem';
import { extraShadows } from '../pkg-manager';
import policyJson from './overlay-policy.json';
import { activeProfile } from '../profile';
import { BUILTIN_SHIM_INTERP, SHIM_COMMANDS } from '../path-shims';

export type Side = 'shiro' | 'debian';

export interface ProgramPolicy {
  /** Who runs it unless the user chose otherwise. */
  default: Side;
  /** The Shiro command that implements it. */
  command: string;
  /** Shiro's side needs a file at the path: a `#!/usr/bin/<command>` stub. */
  stub?: boolean;
  /** Why the default is what it is (test results). */
  why?: string;
}

export const POLICY: Record<string, ProgramPolicy> = (policyJson as { programs: Record<string, ProgramPolicy> }).programs;

const DIVERSIONS = '/var/lib/dpkg/diversions';
/** Choices made with `shiro-alternatives --set` (manual mode), path → side. */
const CHOICES = '/var/lib/shiro/alternatives.json';
const SUFFIX = '.debian';
const LOCAL = ':';

export interface Diversion { from: string; to: string; by: string }

export async function readDiversions(fs: FileSystem): Promise<Diversion[]> {
  let text = '';
  try { text = await fs.readFile(DIVERSIONS, 'utf8') as string; } catch { return []; }
  const lines = text.split('\n');
  const out: Diversion[] = [];
  for (let i = 0; i + 2 < lines.length && lines[i]; i += 3) out.push({ from: lines[i], to: lines[i + 1], by: lines[i + 2] });
  return out;
}

async function writeDiversions(fs: FileSystem, list: Diversion[]): Promise<void> {
  // dpkg writes diversions-new and renames it over the old file
  await fs.writeFile(DIVERSIONS + '-new', list.map((d) => `${d.from}\n${d.to}\n${d.by}\n`).join(''));
  await fs.rename(DIVERSIONS + '-new', DIVERSIONS);
}

async function readChoices(fs: FileSystem): Promise<Record<string, Side>> {
  try { return JSON.parse(await fs.readFile(CHOICES, 'utf8') as string); } catch { return {}; }
}

async function writeChoices(fs: FileSystem, choices: Record<string, Side>): Promise<void> {
  await fs.mkdir('/var/lib/shiro', { recursive: true });
  await fs.writeFile(CHOICES, JSON.stringify(choices, null, 2) + '\n');
}

async function exists(fs: FileSystem, path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; } catch { return false; }
}

/** The package that ships `path`, from dpkg's file lists (null: none). */
export async function packageOf(fs: FileSystem, path: string): Promise<string | null> {
  const names = await fs.readdir('/var/lib/dpkg/info').catch(() => [] as string[]);
  for (const n of names) {
    if (!n.endsWith('.list')) continue;
    const text = await fs.readFile(`/var/lib/dpkg/info/${n}`, 'utf8').catch(() => '') as string;
    if (text.split('\n').includes(path)) return n.slice(0, -5).replace(/:.*$/, '');
  }
  return null;
}

export interface ProgramState {
  path: string;
  policy?: ProgramPolicy;
  /** Who runs it now. */
  current: Side;
  /** Set by `--set` (manual mode) rather than the default. */
  manual: boolean;
  /** Debian's file is present (at the path or diverted). */
  debianInstalled: boolean;
  diversion?: Diversion;
}

export async function programState(fs: FileSystem, path: string, divs?: Diversion[], choices?: Record<string, Side>): Promise<ProgramState> {
  divs ??= await readDiversions(fs);
  choices ??= await readChoices(fs);
  const diversion = divs.find((d) => d.from === path);
  const current: Side = diversion && diversion.by === LOCAL && diversion.to === path + SUFFIX ? 'shiro' : 'debian';
  const debianInstalled = current === 'shiro' ? await exists(fs, path + SUFFIX) : await exists(fs, path);
  return { path, policy: POLICY[path], current, manual: path in choices, debianInstalled, diversion };
}

/** Resolve a name (`grep`) or path to the overlay path it means. */
export function overlayPath(nameOrPath: string): string | null {
  if (nameOrPath.startsWith('/')) return nameOrPath;
  for (const [p, pol] of Object.entries(POLICY)) {
    if (p.slice(p.lastIndexOf('/') + 1) === nameOrPath || pol.command === nameOrPath) return p;
  }
  return `/usr/bin/${nameOrPath}`;
}

/**
 * Make `path` Shiro's or Debian's. `manual` records the choice so defaults
 * never undo it (update-alternatives' manual mode). Returns what changed.
 */
export async function setSide(fs: FileSystem, path: string, side: Side, opts: { manual?: boolean; command?: string } = {}): Promise<string> {
  const divs = await readDiversions(fs);
  const state = await programState(fs, path, divs);
  const policy = POLICY[path];
  let msg: string;
  if (side === state.current) {
    msg = `${path}: already ${side === 'shiro' ? "tabcomputer's" : "Debian's"}`;
  } else if (side === 'shiro') {
    if (state.diversion) throw new Error(`${path} is already diverted to ${state.diversion.to} by ${state.diversion.by === LOCAL ? 'local' : state.diversion.by}`);
    if (await exists(fs, path + SUFFIX)) throw new Error(`${path + SUFFIX} exists; refusing to overwrite it`);
    divs.push({ from: path, to: path + SUFFIX, by: LOCAL });
    await writeDiversions(fs, divs);
    if (await exists(fs, path)) await fs.rename(path, path + SUFFIX);
    const command = opts.command ?? policy?.command ?? path.slice(path.lastIndexOf('/') + 1);
    // A stub naming a kernel program, or a builtin shim so programs that search
    // PATH themselves (Debian's bash) find the name; neither shadows the builtin
    await fs.writeFile(path, policy?.stub ? `#!/usr/bin/${command}\n` : builtinShim(command), { mode: 0o755 });
    msg = `${path}: now tabcomputer's (${command}); Debian's file is ${path + SUFFIX}`;
  } else {
    const d = state.diversion!;
    if (d.by !== LOCAL) throw new Error(`${path} is diverted by package ${d.by}, not by tabcomputer`);
    // Our stub (if any) goes; Debian's file comes back
    if (await exists(fs, path)) {
      const head = await fs.readFile(path, 'utf8').catch(() => '') as string;
      if ((head.startsWith('#!/usr/bin/') && head.length < 128) || isBuiltinShimText(head)) await fs.unlink(path);
      else throw new Error(`${path} exists and isn't tabcomputer's stub; refusing to replace it`);
    }
    if (await exists(fs, d.to)) await fs.rename(d.to, path);
    await writeDiversions(fs, divs.filter((x) => x !== d));
    msg = `${path}: now Debian's`;
  }
  if (opts.manual !== undefined) {
    const choices = await readChoices(fs);
    if (opts.manual) choices[path] = side; else delete choices[path];
    await writeChoices(fs, choices);
  }
  await refreshShadows(fs);
  return msg;
}

/**
 * Apply the default policy to every program that has no manual choice and
 * whose Debian file is installed (`--auto all`, and apt's post-invoke hook
 * after each dpkg run, so a newly installed hot program starts out Shiro's).
 */
export async function applyDefaults(fs: FileSystem, only?: string[]): Promise<string[]> {
  const choices = await readChoices(fs);
  const changed: string[] = [];
  for (const [path, policy] of Object.entries(POLICY)) {
    if (only && !only.includes(path)) continue;
    if (path in choices) continue;
    const st = await programState(fs, path, undefined, choices);
    if (!st.debianInstalled && st.current === 'debian') continue; // nothing to overlay (yet)
    // A profile without the overlay keeps Debian's own programs
    const want: Side = activeProfile().shims.debianOverlay ? policy.default : 'debian';
    if (st.current !== want) {
      try { changed.push(await setSide(fs, path, want)); } catch (e: any) { changed.push(`${path}: ${e?.message ?? e}`); }
    }
  }
  return changed;
}

// ── Builtin shims: files on PATH that run the builtin ────────────────────

/**
 * A builtin's file on PATH (`#!/usr/libexec/tabcomputer/builtin`): the kernel
 * and the shell run the builtin it is named after. Real bash, make and
 * execvp() search PATH with stat(), so an overlaid program (Debian's grep
 * diverted to grep.debian) or a builtin Debian doesn't ship (curl, git, rg)
 * needs a file there to be found at all.
 */
export const builtinShim = (cmd: string) => `#!${BUILTIN_SHIM_INTERP}\n# The kernel runs tabcomputer's builtin ${cmd} for this path; the file lets PATH searches find it.\n`;

const isBuiltinShimText = (text: string) => text.startsWith(`#!${BUILTIN_SHIM_INTERP}\n`);

/** Small files only: a Debian program streamed lazily isn't fetched to look at its first line. */
async function isBuiltinShim(fs: FileSystem, path: string, size: number): Promise<boolean> {
  if (size > 512) return false;
  const text = await fs.readFile(path, 'utf8').catch(() => '');
  return typeof text === 'string' && isBuiltinShimText(text);
}

/**
 * Shims for what Debian's programs should find on PATH: every overlaid
 * program (PATH diverted to PATH.debian, nothing at PATH), and the builtins
 * of path-shims.ts that no file provides in any bin directory. They go in
 * /usr/bin, where a package that installs the real program replaces the
 * shim (dpkg overwrites files no package owns). Returns the paths written.
 */
export async function ensureBuiltinShims(fs: FileSystem, isCommand: (name: string) => boolean): Promise<string[]> {
  const written: string[] = [];
  const put = async (path: string, cmd: string) => {
    await fs.writeFile(path, builtinShim(cmd), { mode: 0o755 });
    written.push(path);
  };
  const present = async (p: string) => !!(await fs.lstat(p).catch(() => null));
  for (const d of await readDiversions(fs)) {
    const policy = POLICY[d.from];
    if (d.by !== LOCAL || d.to !== d.from + SUFFIX || !policy || policy.stub) continue;
    if (!(await present(d.from)) && isCommand(policy.command)) await put(d.from, policy.command);
  }
  for (const cmd of SHIM_COMMANDS) {
    if (!isCommand(cmd)) continue;
    let found = false;
    for (const dir of BIN_DIRS) if (await present(`${dir}/${cmd}`)) { found = true; break; }
    if (!found) await put(`/usr/bin/${cmd}`, cmd);
  }
  return written;
}

// ── Builtins vs. files on PATH ───────────────────────────────────────────

const BIN_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
const shadowSets = new WeakMap<FileSystem, { names: (name: string) => boolean; set: Set<string> }>();

/** Debian mode: builtins whose name has a file in the standard bin directories. */
export function debianShadows(fs: FileSystem): Set<string> {
  return shadowSets.get(fs)?.set ?? new Set();
}

async function hasProgramFile(fs: FileSystem, name: string): Promise<boolean> {
  for (const dir of BIN_DIRS) {
    try {
      // A symlink counts as it is: dpkg unpacks /usr/bin/gcc -> gcc-14 before
      // gcc-14, so following it then found nothing, gcc stayed Shiro's, and
      // make's execvp("gcc") ran Shiro's compiler from /usr/local/bin/gcc
      const l = await fs.lstat(`${dir}/${name}`);
      if (l.type === 'symlink') return true;
      const st = await fs.stat(`${dir}/${name}`);
      if (st.type === 'file' && !(await isBuiltinShim(fs, `${dir}/${name}`, st.size))) return true;
    } catch { /* not here */ }
  }
  return false;
}

export async function refreshShadows(fs: FileSystem, name?: string): Promise<void> {
  const entry = shadowSets.get(fs);
  if (!entry) return;
  if (name !== undefined) {
    if (!entry.names(name)) return;
    if (await hasProgramFile(fs, name)) entry.set.add(name); else entry.set.delete(name);
    return;
  }
  const names = new Set<string>();
  for (const dir of BIN_DIRS) for (const n of await fs.readdir(dir).catch(() => [] as string[])) names.add(n);
  entry.set.clear();
  for (const n of names) if (entry.names(n) && await hasProgramFile(fs, n)) entry.set.add(n);
}

/**
 * Debian mode for the shell and kernel: a builtin named like a program file
 * in /usr/bin, /usr/sbin, ... runs that file instead (pkg-manager's
 * packageShadows includes these), kept current as files come and go.
 * `isCommand` says which names are Shiro commands.
 */
export async function enableDebianShadows(fs: FileSystem, isCommand: (name: string) => boolean): Promise<void> {
  // Programs that search PATH themselves find the builtins (installs made before shims existed get them now)
  await ensureBuiltinShims(fs, isCommand).catch(() => {});
  if (shadowSets.has(fs)) return refreshShadows(fs);
  const set = new Set<string>();
  shadowSets.set(fs, { names: isCommand, set });
  extraShadows.set(fs, set);
  await refreshShadows(fs);
  fs.onChange((ev, path, newPath) => {
    for (const p of [path, newPath]) {
      if (!p) continue;
      const i = p.lastIndexOf('/');
      if (!BIN_DIRS.includes(p.slice(0, i))) continue;
      // A file going away stops shadowing at once (a command typed right after
      // `apt remove` mustn't find the old name); the check below may add it back
      if (ev === 'delete' || (ev === 'rename' && p === path)) set.delete(p.slice(i + 1));
      void refreshShadows(fs, p.slice(i + 1));
    }
  });
}
