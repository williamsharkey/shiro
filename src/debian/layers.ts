/**
 * Toolchain layers (docs/DEBIAN.md "Toolchain layers").
 *
 * A layer is what `apt-get install` of a toolchain set changed on top of the
 * streamed base rootfs, built off the browser by scripts/debian/build-layers.sh
 * (pack-layer.mjs): its packages' dpkg status stanzas, every new or changed
 * path with the package that owns it, and the text databases maintainer
 * scripts edited (debconf, apt's auto-installed marks, diversions, ...).
 * File bytes are content-addressed chunks, the base rootfs's format.
 *
 * Applying one does what dpkg would have done, without running anything:
 * placeholders (FSNode.lazy) for the paths of packages this machine doesn't
 * have yet (or has older), status stanzas merged into dpkg's database, the
 * databases merged entry by entry. Bytes load on first read, as the base's
 * do. apt and dpkg then see ordinary installed packages.
 */
import type { FileSystem, FSNode } from '../filesystem';
import { attachRootfsLoader, defaultRootfsBase, installedRootfs } from './rootfs';

export interface LayerManifest {
  format: number;
  kind: 'layer';
  /** Index id: lazy refs carry it as `src`. */
  id: string;
  /** The set's name (`c`, `python`, ...). */
  name: string;
  /** The base rootfs id it was built on. */
  base: string;
  snapshot: string;
  recipe: string;
  /** Index path, relative to the layers directory. */
  index: string;
  packages: number;
  entries: number;
  files: number;
  bytes: number;
  chunks: number;
  chunkBytes: number;
}

export interface LayerInfo extends LayerManifest {
  title: string;
  description: string;
  /** The packages asked for (the rest are dependencies). */
  requested: string[];
  /** A shell command that shows the toolchain works. */
  check?: string;
}

interface LayerPackage { name: string; arch: string; version: string; multiArch?: string; replaces?: string; status: string }
type LayerRow =
  | [string, 'd', number, number, number]
  | [string, 'l', number, number, string, number]
  | [string, 'f', number, number, number, number, number, number];
interface LayerIndex {
  format: number;
  kind: 'layer';
  name: string;
  base: string;
  packages: LayerPackage[];
  chunks: Array<[string, number, number]>;
  entries: LayerRow[];
  removed: string[];
  merged: Record<string, string>;
}

export interface AppliedLayer { id: string; name: string; base: string; url: string; appliedAt: number; packages: string[] }

/** Applied layers: name → record. Boot re-attaches their chunk loaders. */
export const LAYERS_STATE = '/var/lib/shiro/layers.json';
const STATUS = '/var/lib/dpkg/status';
const DIVERSIONS = '/var/lib/dpkg/diversions';

const nodeProcess = (): any => (globalThis as any).process;

/** Where the layers are served (server.mjs: /debian/layers/). */
export function defaultLayersBase(): string {
  const env = nodeProcess()?.env?.TABCOMPUTER_DEBIAN_LAYERS_URL;
  if (env) return env.endsWith('/') ? env : env + '/';
  return new URL('layers/', defaultRootfsBase()).href;
}

async function getBytes(url: string): Promise<Uint8Array> {
  const p = nodeProcess();
  if (url.startsWith('file:') && typeof p?.getBuiltinModule === 'function') {
    return new Uint8Array(await p.getBuiltinModule('fs').promises.readFile(p.getBuiltinModule('url').fileURLToPath(url)));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The layers the server has (empty when it serves none). */
export async function fetchLayerCatalog(base = defaultLayersBase()): Promise<LayerInfo[]> {
  let bytes: Uint8Array;
  try { bytes = await getBytes(base + 'index.json'); } catch { return []; }
  try {
    const cat = JSON.parse(new TextDecoder().decode(bytes));
    return cat?.format === 1 && Array.isArray(cat.layers) ? cat.layers : [];
  } catch { return []; } // an SPA fallback page, not a catalog
}

export async function appliedLayers(fs: FileSystem): Promise<Record<string, AppliedLayer>> {
  try { return JSON.parse(await fs.readFile(LAYERS_STATE, 'utf8') as string); } catch { return {}; }
}

/** Boot hook: let applied layers' lazy files load. */
export async function bootLayers(fs: FileSystem): Promise<void> {
  const applied = await appliedLayers(fs);
  const bases: Record<string, string> = {};
  for (const l of Object.values(applied)) bases[l.id] = l.url;
  if (Object.keys(bases).length) attachRootfsLoader(fs, bases);
}

// ── dpkg's formats ────────────────────────────────────────────────────────

/** dpkg's version comparison (deb-version(7)): <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number, string, string] => {
    const c = v.indexOf(':');
    const epoch = c >= 0 ? Number(v.slice(0, c)) || 0 : 0;
    const rest = c >= 0 ? v.slice(c + 1) : v;
    const h = rest.lastIndexOf('-');
    return h >= 0 ? [epoch, rest.slice(0, h), rest.slice(h + 1)] : [epoch, rest, ''];
  };
  const order = (ch: string | undefined): number => {
    if (ch === undefined) return 0;
    if (ch === '~') return -1;
    if (/[A-Za-z]/.test(ch)) return ch.charCodeAt(0);
    return ch.charCodeAt(0) + 256;
  };
  const part = (x: string, y: string): number => {
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      let diff = 0;
      while ((i < x.length && !/\d/.test(x[i])) || (j < y.length && !/\d/.test(y[j]))) {
        const ox = i < x.length && !/\d/.test(x[i]) ? order(x[i]) : 0;
        const oy = j < y.length && !/\d/.test(y[j]) ? order(y[j]) : 0;
        if (ox !== oy) return ox - oy;
        if (i < x.length && !/\d/.test(x[i])) i++;
        if (j < y.length && !/\d/.test(y[j])) j++;
      }
      while (x[i] === '0') i++;
      while (y[j] === '0') j++;
      while (i < x.length && /\d/.test(x[i]) && j < y.length && /\d/.test(y[j])) {
        if (!diff) diff = x.charCodeAt(i) - y.charCodeAt(j);
        i++; j++;
      }
      if (i < x.length && /\d/.test(x[i])) return 1;
      if (j < y.length && /\d/.test(y[j])) return -1;
      if (diff) return diff;
    }
    return 0;
  };
  const [ea, ua, ra] = split(a), [eb, ub, rb] = split(b);
  return ea !== eb ? ea - eb : part(ua, ub) || part(ra, rb);
}

interface Stanza { key: string; text: string }

/** RFC 822-style stanzas (dpkg status, extended_states, debconf's *.dat), keyed by `key(text)`. */
function parseStanzas(text: string, key: (s: string) => string): Stanza[] {
  const out: Stanza[] = [];
  for (const s of text.split(/\n\s*\n/)) {
    if (!s.trim()) continue;
    const t = s.replace(/^\n+/, '').replace(/\n*$/, '\n');
    out.push({ key: key(t), text: t });
  }
  return out;
}
const field = (s: string, name: string) => (s.match(new RegExp(`^${name}: ?(.*)$`, 'mi')) || [])[1]?.trim() ?? '';
const pkgKey = (s: string) => `${field(s, 'Package')}:${field(s, 'Architecture')}`;

/** Add `layer`'s entries whose key `text` doesn't have; returns the merged text (or null: unchanged). */
function mergeStanzas(text: string, layer: string, key: (s: string) => string): string | null {
  const mine = parseStanzas(text, key);
  const have = new Set(mine.map((s) => s.key));
  const add = parseStanzas(layer, key).filter((s) => !have.has(s.key));
  if (!add.length) return null;
  return [...mine, ...add].map((s) => s.text).join('\n');
}

function mergeLines(text: string, layer: string, key: (line: string) => string): string | null {
  const lines = text.split('\n').filter((l) => l !== '');
  const have = new Set(lines.map(key));
  const add = layer.split('\n').filter((l) => l !== '' && !have.has(key(l)));
  if (!add.length) return null;
  return [...lines, ...add].join('\n') + '\n';
}

function mergeDiversions(text: string, layer: string): string | null {
  const triples = (t: string) => {
    const l = t.split('\n');
    const out: string[][] = [];
    for (let i = 0; i + 2 < l.length && l[i]; i += 3) out.push([l[i], l[i + 1], l[i + 2]]);
    return out;
  };
  const mine = triples(text);
  const have = new Set(mine.map((d) => d[0]));
  const add = triples(layer).filter((d) => !have.has(d[0]));
  if (!add.length) return null;
  return [...mine, ...add].map((d) => d.join('\n') + '\n').join('');
}

/** How each merged database combines with this machine's copy. */
function mergeText(path: string, mine: string, layer: string): string | null {
  if (path === DIVERSIONS) return mergeDiversions(mine, layer);
  if (path === '/var/lib/apt/extended_states') return mergeStanzas(mine, layer, pkgKey);
  if (path.startsWith('/var/cache/debconf/')) return mergeStanzas(mine, layer, (s) => field(s, 'Name'));
  if (/^\/etc\/(passwd|group|shadow|gshadow|subuid|subgid)$/.test(path)) return mergeLines(mine, layer, (l) => l.split(':')[0]);
  if (path.endsWith('/.config/go/env')) return mergeLines(mine, layer, (l) => l.split('=')[0]); // the user's own go env -w wins
  return mergeLines(mine, layer, (l) => l); // /etc/shells, statoverride, dpkg triggers
}

// ── Applying ──────────────────────────────────────────────────────────────

export interface ApplyResult {
  layer: LayerInfo;
  /** Packages written (new to this machine, or newer than its copy). */
  installed: string[];
  /** Packages this machine already had at the same or a newer version. */
  kept: string[];
  paths: number;
  ms: number;
}

/**
 * Apply layer `name` from the catalog at `base`. Needs the Debian base
 * rootfs the layer was built on (`debian install`).
 */
export async function applyLayer(fs: FileSystem, name: string, opts: { base?: string; progress?: (msg: string) => void } = {}): Promise<ApplyResult> {
  const t0 = Date.now();
  const base = opts.base ?? defaultLayersBase();
  const rootfs = await installedRootfs(fs);
  if (!rootfs) throw new Error('Debian is not installed (debian install)');
  const layer = (await fetchLayerCatalog(base)).find((l) => l.name === name);
  if (!layer) throw new Error(`no layer named ${name} on this server`);
  if (layer.base !== rootfs.id) throw new Error(`layer ${name} was built for Debian rootfs ${layer.base}; this machine has ${rootfs.id}`);
  const index: LayerIndex = JSON.parse(new TextDecoder().decode(await gunzip(await getBytes(base + layer.index))));
  attachRootfsLoader(fs, { [layer.id]: base });

  // Which packages to write: dpkg's view of this machine decides
  const status = await fs.readFile(STATUS, 'utf8') as string;
  const stanzas = parseStanzas(status, pkgKey);
  const installed = new Map<string, string>();
  for (const s of stanzas) if (/ installed$/.test(field(s.text, 'Status'))) installed.set(s.key, field(s.text, 'Version'));
  const apply = index.packages.map((p) => {
    const have = installed.get(`${p.name}:${p.arch}`);
    return have === undefined || compareVersions(have, p.version) < 0;
  });
  const kept = index.packages.filter((_, i) => !apply[i]).map((p) => p.name);
  const upgraded = index.packages.filter((p, i) => apply[i] && installed.has(`${p.name}:${p.arch}`));
  opts.progress?.(`${layer.title}: ${apply.filter(Boolean).length} packages to add${kept.length ? `, ${kept.length} already installed` : ''}, ${(layer.chunkBytes / 1e6).toFixed(0)} MB streamed on first use`);

  // Paths an upgraded package had and its new version doesn't
  const stale = new Set<string>();
  for (const p of upgraded) {
    for (const f of [`${p.name}:${p.arch}.list`, `${p.name}.list`]) {
      const list = await fs.readFile(`/var/lib/dpkg/info/${f}`, 'utf8').catch(() => null);
      if (typeof list === 'string') for (const l of list.split('\n')) if (l) stale.add(l);
    }
  }

  // dpkg puts a diverted path's file where the diversion says, unless the
  // package is the one diverting it
  const divs = new Map<string, { to: string; by: string }>();
  const divText = await fs.readFile(DIVERSIONS, 'utf8').catch(() => '') as string;
  const dl = divText.split('\n');
  for (let i = 0; i + 2 < dl.length && dl[i]; i += 3) divs.set(dl[i], { to: dl[i + 1], by: dl[i + 2] });

  const nodes: FSNode[] = [];
  for (const row of index.entries) {
    const owner = row[row.length - 1] as number;
    if (owner >= 0 && !apply[owner]) continue;
    let path = row[0];
    const [, type, mode, mtimeS] = row;
    const mtime = mtimeS * 1000;
    if (type !== 'd') {
      const d = divs.get(path);
      if (d && d.by !== (owner >= 0 ? index.packages[owner].name : '')) path = d.to;
      stale.delete(row[0]);
    }
    const existing = await fs.lstat(path).catch(() => null);
    if (type === 'd') {
      if (existing?.isDirectory()) continue;
      if (existing) await fs.rm(path, { recursive: true });
      nodes.push({ path, type: 'dir', content: null, mode, mtime, ctime: mtime, size: 0 });
    } else if (type === 'l') {
      const target = row[4] as string;
      if (existing?.isDirectory()) await fs.rm(path, { recursive: true });
      nodes.push({ path, type: 'symlink', content: null, mode: 0o777, mtime, ctime: mtime, size: target.length, symlinkTarget: target });
    } else {
      const size = row[4] as number;
      if (existing?.isDirectory()) await fs.rm(path, { recursive: true });
      const node: FSNode = { path, type: 'file', content: size ? null : new Uint8Array(0), mode, mtime, ctime: mtime, size };
      if (size) node.lazy = { src: layer.id, chunk: index.chunks[row[5] as number][0], off: row[6] as number };
      nodes.push(node);
    }
  }
  fs.putNodes(nodes);
  for (const p of [...stale, ...index.removed]) {
    const st = await fs.lstat(p).catch(() => null);
    if (st && !st.isDirectory()) await fs.unlink(p).catch(() => {});
  }

  // dpkg's database: the applied packages' stanzas, in dpkg's order (by name)
  const byKey = new Map(stanzas.map((s) => [s.key, s]));
  for (const [i, p] of index.packages.entries()) {
    if (apply[i]) byKey.set(`${p.name}:${p.arch}`, { key: `${p.name}:${p.arch}`, text: p.status });
  }
  const sorted = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  await fs.writeFile(STATUS + '-new', sorted.map((s) => s.text).join('\n'));
  await fs.rename(STATUS + '-new', STATUS);

  for (const [path, text] of Object.entries(index.merged)) {
    const mine = await fs.readFile(path, 'utf8').catch(() => null);
    const next = typeof mine === 'string' ? mergeText(path, mine, text) : text;
    if (next !== null) await fs.writeFile(path, next);
  }

  const applied = await appliedLayers(fs);
  applied[name] = { id: layer.id, name, base: layer.base, url: base, appliedAt: Date.now(), packages: index.packages.filter((_, i) => apply[i]).map((p) => p.name) };
  await fs.mkdir('/var/lib/shiro', { recursive: true });
  await fs.writeFile(LAYERS_STATE, JSON.stringify(applied, null, 2) + '\n');
  await fs.sync();
  return {
    layer,
    installed: index.packages.filter((_, i) => apply[i]).map((p) => p.name),
    kept,
    paths: nodes.length,
    ms: Date.now() - t0,
  };
}
