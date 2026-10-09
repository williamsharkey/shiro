/**
 * pip for the WASI CPython package (`pkg install python3`): resolves
 * requirements against PyPI's JSON API, downloads pure-Python wheels and
 * installs them into site-packages (or a venv, or --target), with
 * console-script launchers, RECORD files and uninstall.
 *
 * Real pip can't run inside WASI python (no sockets or TLS there), so this
 * does pip's job from the page, which can fetch PyPI (CORS-enabled).
 * Without the python package, `pip` falls back to Pyodide's micropip.
 */
import type { Command, CommandContext } from './index';
import type { FileSystem } from '../filesystem';
import {
  parseVersion, compareVersions, satisfies, parseRequirement, evalMarker, markerEnv,
  parseWheelName, wheelCompatible, normalizeName, parseSpecifiers, type Requirement, type Specifier,
} from '../utils/pep440';

export const PY_PREFIX = '/usr/lib/pkg/python3';
export const PY_VERSION = '3.13.7';
export const PY_SHORT = '3.13';
export const PY_BIN = `${PY_PREFIX}/bin/python3.wasm`;
const PY_MINOR = 13;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── where to install ─────────────────────────────────────────────────

export interface PipTarget {
  site: string;          // site-packages (or --target)
  scripts: string | null; // console scripts; null with --target
  python: string;        // shebang for scripts
  prefix: string;
}

export function venvTarget(venv: string): PipTarget {
  return { site: `${venv}/lib/python${PY_SHORT}/site-packages`, scripts: `${venv}/bin`, python: `${venv}/bin/python`, prefix: venv };
}

export function systemTarget(): PipTarget {
  return { site: `${PY_PREFIX}/lib/python${PY_SHORT}/site-packages`, scripts: '/usr/local/bin', python: '/usr/bin/python3', prefix: '/usr/local' };
}

// ── zip (wheels) ─────────────────────────────────────────────────────

export interface ZipEntry { name: string; data: () => Promise<Uint8Array> }

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

export function readZip(buf: Uint8Array): ZipEntry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    out.push({
      name,
      data: async () => {
        if (method === 0) return raw.slice();
        if (method === 8) return inflateRaw(raw);
        throw new Error(`${name}: unsupported zip compression ${method}`);
      },
    });
  }
  return out;
}

// ── installed distributions ──────────────────────────────────────────

export interface Installed { name: string; version: string; distInfo: string; metadata: Record<string, string[]> }

export function parseMetadata(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) break; // the body (description) follows a blank line
    const m = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line);
    if (m) (out[m[1].toLowerCase()] ??= []).push(m[2].trim());
  }
  return out;
}

export async function listInstalled(fs: FileSystem, site: string): Promise<Map<string, Installed>> {
  const out = new Map<string, Installed>();
  let names: string[] = [];
  try { names = await fs.readdir(site); } catch { return out; }
  for (const d of names) {
    if (!d.endsWith('.dist-info')) continue;
    try {
      const md = parseMetadata(await fs.readFile(`${site}/${d}/METADATA`, 'utf8') as string);
      const name = md.name?.[0], version = md.version?.[0];
      if (name && version) out.set(normalizeName(name), { name, version, distInfo: `${site}/${d}`, metadata: md });
    } catch { /* broken dist-info */ }
  }
  return out;
}

// ── PyPI ─────────────────────────────────────────────────────────────

interface PypiFile { filename: string; url: string; packagetype: string; requires_python?: string | null; yanked?: boolean; size?: number; digests?: { sha256?: string } }
interface PypiProject { info: { name: string; version: string; requires_dist?: string[] | null; requires_python?: string | null; summary?: string }; releases: Record<string, PypiFile[]>; urls?: PypiFile[] }

export interface Candidate { name: string; version: string; wheel: PypiFile; requires: string[] }

export class PyPI {
  private projects = new Map<string, Promise<PypiProject>>();
  constructor(public index = 'https://pypi.org', private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  project(name: string): Promise<PypiProject> {
    const key = normalizeName(name);
    let p = this.projects.get(key);
    if (!p) {
      p = this.json(`${this.index}/pypi/${key}/json`, name);
      this.projects.set(key, p);
    }
    return p;
  }

  private async json(url: string, name: string): Promise<any> {
    const r = await this.fetchFn(url);
    if (r.status === 404) throw new Error(`No matching distribution found for ${name} (not on ${this.index})`);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  async requires(name: string, version: string): Promise<string[]> {
    const proj = await this.project(name);
    if (proj.info.version === version) return proj.info.requires_dist ?? [];
    const v = await this.json(`${this.index}/pypi/${normalizeName(name)}/${version}/json`, name);
    return v.info?.requires_dist ?? [];
  }

  /** Newest version matching `specs` that has a pure-Python wheel. */
  async best(req: Requirement, specs: Specifier[], pre: boolean): Promise<Candidate> {
    const proj = await this.project(req.name);
    const versions = Object.keys(proj.releases)
      .map(v => ({ v, p: parseVersion(v) }))
      .filter((x): x is { v: string; p: NonNullable<ReturnType<typeof parseVersion>> } => !!x.p)
      .sort((a, b) => compareVersions(b.p, a.p));
    const py = parseVersion(PY_VERSION)!;
    let sdistOnly: string | null = null;
    for (const allowPre of pre ? [true] : [false, true]) {
      for (const { v, p } of versions) {
        if (!satisfies(p, specs, allowPre)) continue;
        const files = proj.releases[v].filter(f => !f.yanked);
        if (!files.length) continue;
        const wheels = files.filter(f => f.packagetype === 'bdist_wheel' && (() => {
          const w = parseWheelName(f.filename);
          return !!w && wheelCompatible(w, PY_MINOR);
        })() && (!f.requires_python || safeSatisfies(py, f.requires_python)));
        if (!wheels.length) {
          if (files.some(f => f.packagetype === 'sdist') && !sdistOnly) sdistOnly = v;
          continue;
        }
        // the most specific tag first (py3 over py2.py3 doesn't matter: any works)
        return { name: proj.info.name, version: v, wheel: wheels[0], requires: [] };
      }
      // pre-releases only when nothing else matches, as pip does
      if (versions.some(({ p }) => satisfies(p, specs, false))) break;
    }
    const spec = specs.map(s => s.op + s.version).join(',');
    if (sdistOnly) throw new Error(`${proj.info.name}${spec}: version ${sdistOnly} has no pure-Python wheel (only a source distribution, which tabcomputer's pip can't build yet)`);
    throw new Error(`No matching distribution found for ${req.name}${spec}`);
  }
}

function safeSatisfies(v: ReturnType<typeof parseVersion> & {}, spec: string): boolean {
  try { return satisfies(v, parseSpecifiers(spec), true); } catch { return true; }
}

// ── resolve ──────────────────────────────────────────────────────────

export interface ResolveOptions { upgrade?: boolean; noDeps?: boolean; pre?: boolean; forceReinstall?: boolean; log?: (s: string) => void }

export interface Plan { install: Candidate[]; satisfied: Installed[]; requested: Set<string> }

export async function resolve(pypi: PyPI, roots: Requirement[], installed: Map<string, Installed>, opts: ResolveOptions = {}): Promise<Plan> {
  const env = markerEnv(PY_VERSION);
  const specs = new Map<string, Specifier[]>();
  const extras = new Map<string, Set<string>>();
  const chosen = new Map<string, Candidate | Installed>();
  const requested = new Set(roots.map(r => normalizeName(r.name)));
  const queue: { req: Requirement; parentExtras: string[]; root: boolean }[] = roots.map(req => ({ req, parentExtras: [], root: true }));
  const log = opts.log ?? (() => {});
  let steps = 0;

  while (queue.length) {
    if (++steps > 5000) throw new Error('dependency resolution did not settle');
    const { req, parentExtras, root } = queue.shift()!;
    if (req.marker && !evalMarker(req.marker, env, parentExtras)) continue;
    const key = normalizeName(req.name);
    const all = [...(specs.get(key) ?? []), ...req.specifiers];
    specs.set(key, all);
    const ex = extras.get(key) ?? new Set<string>();
    const newExtras = req.extras.filter(e => !ex.has(e));
    newExtras.forEach(e => ex.add(e));
    extras.set(key, ex);

    const cur = chosen.get(key);
    if (cur && satisfies(cur.version, all, true)) {
      if (newExtras.length && !opts.noDeps) await enqueueDeps(cur, [...ex]);
      continue;
    }
    const have = installed.get(key);
    const upgradeThis = opts.forceReinstall || (opts.upgrade && root);
    if (!cur && have && !upgradeThis && satisfies(have.version, all, true)) {
      log(`Requirement already satisfied: ${req.text.split(';')[0].trim()} in ${have.distInfo.replace(/\/[^/]*$/, '')} (${have.version})\n`);
      chosen.set(key, have);
      if (!opts.noDeps) await enqueueDeps(have, [...ex]);
      continue;
    }
    log(`Collecting ${req.text.split(';')[0].trim()}\n`);
    const cand = await pypi.best(req, all, !!opts.pre);
    if (have && !opts.forceReinstall && have.version === cand.version && !upgradeThis) {
      chosen.set(key, have);
      continue;
    }
    if (have && have.version === cand.version && !opts.forceReinstall) {
      log(`Requirement already satisfied: ${have.name} in ${have.distInfo.replace(/\/[^/]*$/, '')} (${have.version})\n`);
      chosen.set(key, have);
      if (!opts.noDeps) await enqueueDeps(have, [...ex]);
      continue;
    }
    cand.requires = await pypi.requires(cand.name, cand.version);
    chosen.set(key, cand);
    if (!opts.noDeps) await enqueueDeps(cand, [...ex]);
  }

  async function enqueueDeps(c: Candidate | Installed, withExtras: string[]) {
    const reqs = 'requires' in c ? c.requires : (c.metadata['requires-dist'] ?? []);
    for (const r of reqs) {
      try { queue.push({ req: parseRequirement(r), parentExtras: withExtras, root: false }); } catch { /* skip malformed */ }
    }
  }

  const install: Candidate[] = [];
  const satisfied: Installed[] = [];
  for (const c of chosen.values()) ('wheel' in c ? install.push(c) : satisfied.push(c));
  return { install, satisfied, requested };
}

// ── install / uninstall ──────────────────────────────────────────────

const relPath = (from: string, to: string) => {
  const a = from.split('/').filter(Boolean), b = to.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') || '.';
};

async function writeFile(fs: FileSystem, path: string, data: Uint8Array | string, mode?: number) {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, data);
  if (mode !== undefined) await fs.chmod(path, mode);
}

export function consoleScript(python: string, spec: string): string {
  const [mod, attr = ''] = spec.split(/\s*:\s*/);
  const head = attr.split('.')[0];
  const call = attr || 'main';
  return `#!${python}\n# -*- coding: utf-8 -*-\nimport re\nimport sys\n` +
    (attr ? `from ${mod.trim()} import ${head.trim()}\n` : `import ${mod.trim()}\n`) +
    `if __name__ == '__main__':\n` +
    `    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])\n` +
    `    sys.exit(${attr ? call.trim() : `${mod.trim()}.main`}())\n`;
}

function parseEntryPoints(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let sect = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) { sect = s[1].trim(); out[sect] ??= {}; continue; }
    const eq = line.indexOf('=');
    if (eq > 0 && sect) out[sect][line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/\s*\[.*\]\s*$/, '');
  }
  return out;
}

/** Install one wheel's bytes. Returns the dist-info directory. */
export async function installWheel(fs: FileSystem, wheel: Uint8Array, target: PipTarget, opts: { requested?: boolean } = {}): Promise<string> {
  const entries = readZip(wheel);
  const di = entries.find(e => /^[^/]+\.dist-info\/WHEEL$/.test(e.name));
  if (!di) throw new Error('wheel has no .dist-info/WHEEL');
  const distInfo = di.name.split('/')[0];
  const dataDir = distInfo.replace(/\.dist-info$/, '.data');
  const record: string[] = [];
  const site = target.site;

  for (const e of entries) {
    let dest: string | null;
    let mode: number | undefined;
    let bytes = await e.data();
    if (e.name.startsWith(`${dataDir}/`)) {
      const [, kind, ...rest] = e.name.split('/');
      const sub = rest.join('/');
      if (kind === 'purelib' || kind === 'platlib') dest = `${site}/${sub}`;
      else if (kind === 'scripts') {
        if (!target.scripts) continue;
        dest = `${target.scripts}/${sub}`;
        mode = 0o755;
        const text = dec.decode(bytes);
        if (/^#!python[w]?\b/.test(text)) bytes = enc.encode(`#!${target.python}` + text.slice(text.indexOf('\n')));
      } else if (kind === 'data') dest = `${target.prefix}/${sub}`;
      else if (kind === 'headers') dest = `${target.prefix}/include/${sub}`;
      else dest = null;
    } else dest = `${site}/${e.name}`;
    if (!dest) continue;
    if (e.name === `${distInfo}/RECORD`) continue;
    await writeFile(fs, dest, bytes, mode);
    record.push(`${relPath(site, dest)},,`);
  }

  const epEntry = entries.find(e => e.name === `${distInfo}/entry_points.txt`);
  if (epEntry && target.scripts) {
    const eps = parseEntryPoints(dec.decode(await epEntry.data()));
    for (const group of ['console_scripts', 'gui_scripts']) {
      for (const [name, spec] of Object.entries(eps[group] ?? {})) {
        const dest = `${target.scripts}/${name}`;
        await writeFile(fs, dest, consoleScript(target.python, spec), 0o755);
        record.push(`${relPath(site, dest)},,`);
      }
    }
  }

  await writeFile(fs, `${site}/${distInfo}/INSTALLER`, 'pip\n');
  record.push(`${distInfo}/INSTALLER,,`);
  if (opts.requested) {
    await writeFile(fs, `${site}/${distInfo}/REQUESTED`, '');
    record.push(`${distInfo}/REQUESTED,,`);
  }
  record.push(`${distInfo}/RECORD,,`);
  await writeFile(fs, `${site}/${distInfo}/RECORD`, record.join('\n') + '\n');
  return `${site}/${distInfo}`;
}

export async function uninstall(fs: FileSystem, dist: Installed): Promise<number> {
  const site = dist.distInfo.slice(0, dist.distInfo.lastIndexOf('/'));
  let files: string[] = [];
  try {
    files = (await fs.readFile(`${dist.distInfo}/RECORD`, 'utf8') as string).split('\n')
      .map(l => l.split(',')[0]).filter(Boolean);
  } catch { /* no RECORD: just the dist-info */ }
  const dirs = new Set<string>();
  let n = 0;
  for (const f of files) {
    const p = f.startsWith('/') ? f : fs.resolvePath(f, site);
    try { await fs.unlink(p); n++; } catch { /* already gone */ }
    // and its bytecode
    if (p.endsWith('.py')) {
      const d = p.slice(0, p.lastIndexOf('/'));
      const base = p.slice(d.length + 1, -3);
      try {
        for (const c of await fs.readdir(`${d}/__pycache__`)) if (c.startsWith(base + '.')) await fs.unlink(`${d}/__pycache__/${c}`);
        dirs.add(`${d}/__pycache__`);
      } catch { /* none */ }
    }
    for (let d = p.slice(0, p.lastIndexOf('/')); d.startsWith(site + '/') ; d = d.slice(0, d.lastIndexOf('/'))) dirs.add(d);
  }
  try { await fs.rm(dist.distInfo, { recursive: true }); } catch { /* gone */ }
  // remove directories left empty, deepest first
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try { if ((await fs.readdir(d)).length === 0) await fs.rmdir(d); } catch { /* not empty / gone */ }
  }
  return n;
}

// ── the command ──────────────────────────────────────────────────────

const HELP = `Usage:
  pip install [options] <requirement specifier> [...]
  pip install [options] -r <requirements file>
  pip install [options] <wheel file> [...]
  pip uninstall [-y] <package> [...]
  pip list | freeze | show <package> | --version

Installs pure-Python wheels from PyPI into the WASI python (pkg install python),
the active venv ($VIRTUAL_ENV), or --target DIR.
`;

async function readRequirements(fs: FileSystem, file: string, cwd: string, seen = new Set<string>()): Promise<string[]> {
  const path = fs.resolvePath(file, cwd);
  if (seen.has(path)) return [];
  seen.add(path);
  const text = await fs.readFile(path, 'utf8') as string;
  const out: string[] = [];
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  for (let line of text.replace(/\\\n/g, '').split('\n')) {
    line = line.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const r = /^(?:-r|--requirement)\s*=?\s*(\S+)/.exec(line);
    if (r) { out.push(...await readRequirements(fs, r[1], dir, seen)); continue; }
    if (line.startsWith('-')) continue; // --index-url, -c, --hash... ignored
    out.push(line.replace(/\s+--hash=\S+/g, ''));
  }
  return out;
}

export async function pipMain(ctx: CommandContext, argv: string[], target: PipTarget, fetchFn?: typeof fetch): Promise<number> {
  const fs = ctx.fs;
  const out = (s: string) => { ctx.stdout += s; };
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { out(HELP); return sub ? 0 : 1; }
  if (sub === '--version' || sub === '-V') {
    out(`pip 24.0 (tabcomputer) from ${target.site} (python ${PY_SHORT})\n`);
    return 0;
  }
  const flag = (...names: string[]) => {
    const i = rest.findIndex(a => names.includes(a));
    if (i >= 0) { rest.splice(i, 1); return true; }
    return false;
  };
  const value = (...names: string[]) => {
    for (let i = 0; i < rest.length; i++) {
      for (const n of names) {
        if (rest[i] === n && i + 1 < rest.length) { const v = rest[i + 1]; rest.splice(i, 2); return v; }
        if (rest[i].startsWith(n + '=')) { const v = rest[i].slice(n.length + 1); rest.splice(i, 1); return v; }
      }
    }
    return undefined;
  };
  flag('--user'); flag('--no-cache-dir'); flag('--disable-pip-version-check'); flag('--no-input'); flag('--break-system-packages');
  const quiet = flag('-q', '--quiet');

  if (sub === 'list' || sub === 'freeze') {
    const inst = [...(await listInstalled(fs, target.site)).values()].sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
    if (sub === 'freeze') { for (const d of inst) out(`${d.name}==${d.version}\n`); return 0; }
    if (rest.includes('--format=json') || (rest.includes('--format') && rest.includes('json'))) {
      out(JSON.stringify(inst.map(d => ({ name: d.name, version: d.version }))) + '\n');
      return 0;
    }
    const w = Math.max(7, ...inst.map(d => d.name.length));
    const vw = Math.max(7, ...inst.map(d => d.version.length));
    out(`${'Package'.padEnd(w)} ${'Version'.padEnd(vw)}\n${'-'.repeat(w)} ${'-'.repeat(vw)}\n`);
    for (const d of inst) out(`${d.name.padEnd(w)} ${d.version}\n`);
    return 0;
  }

  if (sub === 'show') {
    const inst = await listInstalled(fs, target.site);
    let code = 0;
    const blocks: string[] = [];
    for (const n of rest.filter(a => !a.startsWith('-'))) {
      const d = inst.get(normalizeName(n));
      if (!d) { ctx.stderr += `WARNING: Package(s) not found: ${n}\n`; code = 1; continue; }
      const requires = (d.metadata['requires-dist'] ?? []).map(r => { try { const q = parseRequirement(r); return q.marker && /extra\s*==/.test(q.marker) ? '' : q.name; } catch { return ''; } }).filter(Boolean);
      const requiredBy = [...inst.values()].filter(o => (o.metadata['requires-dist'] ?? []).some(r => { try { const q = parseRequirement(r); return normalizeName(q.name) === normalizeName(d.name) && !(q.marker && /extra\s*==/.test(q.marker)); } catch { return false; } })).map(o => o.name);
      blocks.push([
        `Name: ${d.name}`, `Version: ${d.version}`, `Summary: ${d.metadata.summary?.[0] ?? ''}`,
        `Home-page: ${d.metadata['home-page']?.[0] ?? ''}`, `Author: ${d.metadata.author?.[0] ?? ''}`,
        `Author-email: ${d.metadata['author-email']?.[0] ?? ''}`, `License: ${d.metadata.license?.[0] ?? ''}`,
        `Location: ${target.site}`, `Requires: ${[...new Set(requires)].join(', ')}`, `Required-by: ${requiredBy.join(', ')}`,
      ].join('\n') + '\n');
    }
    out(blocks.join('---\n'));
    return code;
  }

  if (sub === 'uninstall') {
    flag('-y', '--yes');
    const reqFile = value('-r', '--requirement');
    const names = rest.filter(a => !a.startsWith('-'));
    if (reqFile) names.push(...(await readRequirements(fs, reqFile, ctx.cwd)).map(r => parseRequirement(r).name));
    const inst = await listInstalled(fs, target.site);
    for (const n of names) {
      const d = inst.get(normalizeName(parseRequirement(n).name));
      if (!d) { ctx.stderr += `WARNING: Skipping ${n} as it is not installed.\n`; continue; }
      out(`Found existing installation: ${d.name} ${d.version}\nUninstalling ${d.name}-${d.version}:\n`);
      await uninstall(fs, d);
      out(`  Successfully uninstalled ${d.name}-${d.version}\n`);
    }
    return 0;
  }

  if (sub === 'install' || sub === 'download') {
    const upgrade = flag('-U', '--upgrade');
    const noDeps = flag('--no-deps');
    const pre = flag('--pre');
    const forceReinstall = flag('--force-reinstall');
    flag('--only-binary=:all:'); flag('--prefer-binary'); flag('--no-build-isolation');
    const index = value('-i', '--index-url') ?? ctx.env.PIP_INDEX_URL;
    const tgt = value('-t', '--target');
    const dest = value('-d', '--dest');
    const reqFiles: string[] = [];
    for (let f = value('-r', '--requirement'); f; f = value('-r', '--requirement')) reqFiles.push(f);
    value('-c', '--constraint'); value('--extra-index-url'); value('--trusted-host');
    if (rest.some(a => a === '-e' || a === '--editable')) {
      ctx.stderr += 'pip: editable installs (-e) are not supported yet\n';
      return 1;
    }
    const target2: PipTarget = tgt ? { site: fs.resolvePath(tgt, ctx.cwd), scripts: null, python: target.python, prefix: fs.resolvePath(tgt, ctx.cwd) } : target;
    const specs = rest.filter(a => !a.startsWith('-'));
    for (const f of reqFiles) specs.push(...await readRequirements(fs, f, ctx.cwd));
    if (!specs.length) { ctx.stderr += 'ERROR: You must give at least one requirement to install (see "pip help install")\n'; return 1; }

    const pypi = new PyPI(index ? index.replace(/\/simple\/?$/, '').replace(/\/$/, '') : 'https://pypi.org', fetchFn);
    const log = quiet ? () => {} : out;
    const localWheels: { path: string; name: string }[] = [];
    const roots: Requirement[] = [];
    try {
      for (const s of specs) {
        if (s.endsWith('.whl')) {
          const w = parseWheelName(s.split('/').pop()!);
          if (!w) throw new Error(`${s} is not a valid wheel filename`);
          localWheels.push({ path: fs.resolvePath(s, ctx.cwd), name: w.name });
          continue;
        }
        if (s === '.' || s.startsWith('./') || s.startsWith('/') || s.endsWith('.tar.gz') || s.endsWith('.zip')) {
          throw new Error(`${s}: installing from a source tree or sdist is not supported yet (build a wheel elsewhere, or install from PyPI)`);
        }
        roots.push(parseRequirement(s));
      }
      const installed = await listInstalled(fs, target2.site);
      const plan = await resolve(pypi, roots, installed, { upgrade, noDeps, pre, forceReinstall, log });

      if (sub === 'download') {
        const dir = fs.resolvePath(dest ?? '.', ctx.cwd);
        for (const c of plan.install) {
          const data = await download(c, fetchFn, log);
          await writeFile(fs, `${dir}/${c.wheel.filename}`, data);
          log(`Saved ${dir}/${c.wheel.filename}\n`);
        }
        log('Successfully downloaded ' + plan.install.map(c => c.name).join(' ') + '\n');
        return 0;
      }

      const toInstall: { name: string; version: string; data: Uint8Array; requested: boolean }[] = [];
      for (const lw of localWheels) {
        const data = await fs.readFile(lw.path) as Uint8Array;
        const w = parseWheelName(lw.path.split('/').pop()!)!;
        log(`Processing ${lw.path}\n`);
        toInstall.push({ name: w.name, version: w.version, data, requested: true });
      }
      for (const c of plan.install) toInstall.push({ name: c.name, version: c.version, data: await download(c, fetchFn, log), requested: plan.requested.has(normalizeName(c.name)) });
      if (!toInstall.length) return 0;
      log(`Installing collected packages: ${toInstall.map(t => t.name).join(', ')}\n`);
      for (const t of toInstall) {
        const old = installed.get(normalizeName(t.name));
        if (old) {
          log(`  Attempting uninstall: ${old.name}\n    Found existing installation: ${old.name} ${old.version}\n    Uninstalling ${old.name}-${old.version}:\n`);
          await uninstall(fs, old);
          log(`      Successfully uninstalled ${old.name}-${old.version}\n`);
        }
        await installWheel(fs, t.data, target2, { requested: t.requested });
      }
      log(`Successfully installed ${toInstall.map(t => `${t.name}-${t.version}`).join(' ')}\n`);
      return 0;
    } catch (e: any) {
      ctx.stderr += `ERROR: ${e?.message ?? e}\n`;
      return 1;
    }
  }

  ctx.stderr += `ERROR: unknown command "${sub}"\n`;
  return 1;
}

async function download(c: Candidate, fetchFn: typeof fetch | undefined, log: (s: string) => void): Promise<Uint8Array> {
  const size = c.wheel.size ? ` (${c.wheel.size > 1e6 ? (c.wheel.size / 1e6).toFixed(1) + ' MB' : Math.ceil(c.wheel.size / 1e3) + ' kB'})` : '';
  log(`  Downloading ${c.wheel.filename}${size}\n`);
  const r = await (fetchFn ?? fetch)(c.wheel.url);
  if (!r.ok) throw new Error(`${c.wheel.url}: HTTP ${r.status}`);
  const data = new Uint8Array(await r.arrayBuffer());
  const want = c.wheel.digests?.sha256;
  if (want && globalThis.crypto?.subtle) {
    const got = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (got !== want) throw new Error(`THESE PACKAGES DO NOT MATCH THE HASHES: ${c.wheel.filename} expected sha256 ${want}, got ${got}`);
  }
  return data;
}

/** Is the WASI python package installed? */
export async function havePython(fs: FileSystem): Promise<boolean> {
  try { await fs.stat(PY_BIN); return true; } catch { return false; }
}

/** The venv a pip (or python) at `path` belongs to: `<venv>/bin/pip` with `<venv>/pyvenv.cfg`. */
export async function venvOf(fs: FileSystem, path: string): Promise<string | null> {
  const m = /^(.*)\/bin\/[^/]+$/.exec(path);
  if (!m) return null;
  return (await fs.exists(`${m[1]}/pyvenv.cfg`)) ? m[1] : null;
}

export async function pipTarget(ctx: CommandContext): Promise<PipTarget> {
  const venv = ctx.env.VIRTUAL_ENV;
  if (venv && await ctx.fs.exists(`${venv}/pyvenv.cfg`)) return venvTarget(venv);
  return systemTarget();
}

export const pipWasiCmd: Command = {
  name: 'pip',
  description: 'Install Python packages (pure-Python wheels from PyPI)',
  async exec(ctx) {
    return pipMain(ctx, ctx.args, await pipTarget(ctx));
  },
};

// ── venv ─────────────────────────────────────────────────────────────

export async function createVenv(fs: FileSystem, dir: string, opts: { systemSite?: boolean; prompt?: string; clear?: boolean } = {}): Promise<void> {
  if (opts.clear) { try { await fs.rm(dir, { recursive: true }); } catch { /* none */ } }
  const prompt = opts.prompt ?? dir.split('/').filter(Boolean).pop() ?? 'venv';
  await fs.mkdir(`${dir}/bin`, { recursive: true });
  await fs.mkdir(`${dir}/include`, { recursive: true });
  await fs.mkdir(`${dir}/lib/python${PY_SHORT}/site-packages`, { recursive: true });
  await fs.writeFile(`${dir}/pyvenv.cfg`,
    `home = ${PY_PREFIX}/bin\ninclude-system-site-packages = ${opts.systemSite ? 'true' : 'false'}\n` +
    `version = ${PY_VERSION}\nexecutable = ${PY_BIN}\ncommand = /usr/bin/python3 -m venv ${dir}\n` +
    (opts.prompt ? `prompt = '${opts.prompt}'\n` : ''));
  for (const n of ['python', 'python3', `python${PY_SHORT}`]) {
    const p = `${dir}/bin/${n}`;
    try { await fs.unlink(p); } catch { /* none */ }
    await fs.symlink(PY_BIN, p);
  }
  // pip in a venv installs into it, whatever $VIRTUAL_ENV says
  for (const n of ['pip', 'pip3', `pip${PY_SHORT}`]) {
    await fs.writeFile(`${dir}/bin/${n}`, `#!/bin/sh\nVIRTUAL_ENV='${dir}' builtin pip "$@"\n`);
    await fs.chmod(`${dir}/bin/${n}`, 0o755);
  }
  await fs.writeFile(`${dir}/bin/activate`, activateScript(dir, prompt));
  await fs.writeFile(`${dir}/.gitignore`, '# created by venv\n*\n');
}

function activateScript(dir: string, prompt: string): string {
  return `# This file must be used with "source bin/activate"
deactivate () {
    if [ -n "\${_OLD_VIRTUAL_PATH:-}" ] ; then
        PATH="\${_OLD_VIRTUAL_PATH:-}"
        export PATH
        unset _OLD_VIRTUAL_PATH
    fi
    if [ -n "\${_OLD_VIRTUAL_PS1:-}" ] ; then
        PS1="\${_OLD_VIRTUAL_PS1:-}"
        export PS1
        unset _OLD_VIRTUAL_PS1
    fi
    unset VIRTUAL_ENV
    unset VIRTUAL_ENV_PROMPT
    if [ ! "\${1:-}" = "nondestructive" ] ; then
        unset -f deactivate
    fi
}
deactivate nondestructive
VIRTUAL_ENV='${dir}'
export VIRTUAL_ENV
_OLD_VIRTUAL_PATH="$PATH"
PATH="$VIRTUAL_ENV/bin:$PATH"
export PATH
VIRTUAL_ENV_PROMPT='(${prompt}) '
export VIRTUAL_ENV_PROMPT
_OLD_VIRTUAL_PS1="\${PS1:-}"
PS1="(${prompt}) \${PS1:-}"
export PS1
`;
}

/** `python -m venv [options] DIR...` */
export async function venvMain(ctx: CommandContext, args: string[]): Promise<number> {
  const dirs: string[] = [];
  let systemSite = false, clear = false, prompt: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--system-site-packages') systemSite = true;
    else if (a === '--clear') clear = true;
    else if (a === '--prompt') prompt = args[++i];
    else if (a.startsWith('--prompt=')) prompt = a.slice(9);
    else if (a === '-h' || a === '--help') { ctx.stdout += 'usage: venv [-h] [--system-site-packages] [--clear] [--prompt PROMPT] [--without-pip] ENV_DIR [ENV_DIR ...]\n'; return 0; }
    else if (a.startsWith('-')) continue; // --without-pip, --upgrade-deps, --copies, --symlinks
    else dirs.push(a);
  }
  if (!dirs.length) { ctx.stderr += 'usage: venv [-h] [--system-site-packages] [--clear] [--prompt PROMPT] ENV_DIR [ENV_DIR ...]\nvenv: error: the following arguments are required: ENV_DIR\n'; return 2; }
  for (const d of dirs) await createVenv(ctx.fs, ctx.fs.resolvePath(d, ctx.cwd), { systemSite, clear, prompt: prompt === '.' ? ctx.cwd.split('/').pop() : prompt });
  return 0;
}
