#!/usr/bin/env node
// Pack a toolchain layer: what `apt-get install` changed between a base
// rootfs tree and the same tree after the install (build-layers.sh makes
// both), in the streamed rootfs format's chunks (pack-rootfs.mjs) plus what
// src/debian/layers.ts needs to apply it the way dpkg would have:
//
//   OUT/<id>/layer.json            manifest { format, kind: "layer", id, name, base, snapshot, recipe, index, ... }
//   OUT/<id>/index-<sha>.json.gz   packages (dpkg status stanzas), entries (paths with their
//                                  owning package), removed paths, merged text databases
//   OUT/chunks/<sha>.gz            content-addressed gzip chunks, shared by every layer
//   OUT/index.json                 the catalog (--catalog): every layer's manifest plus its title
//
// Chunks hold one package each (big ones split), so a package two layers
// share is stored and fetched once. Usage:
//
//   node pack-layer.mjs BASE_TREE ROOT_TREE OUT --id ID --spec layers.json --base-id ID --snapshot TS --recipe HASH
//   node pack-layer.mjs --catalog OUT --spec layers.json
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const catalogDir = opt('--catalog', '');
const specPath = opt('--spec', '');
const spec = specPath ? JSON.parse(readFileSync(specPath, 'utf8')) : { layers: {} };

if (catalogDir) {
  const layers = [];
  for (const id of Object.keys(spec.layers)) {
    const f = join(catalogDir, id, 'layer.json');
    if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, 'utf8'));
    const s = spec.layers[id];
    layers.push({ ...m, title: s.title, description: s.description, requested: s.packages, check: s.check });
  }
  const tmp = join(catalogDir, 'index.json.tmp');
  writeFileSync(tmp, JSON.stringify({ format: 1, layers }, null, 2) + '\n');
  renameSync(tmp, join(catalogDir, 'index.json'));
  // Each set keeps its current index and the one before (tabs that applied
  // it may still fetch its chunks); with --prune, chunks no kept index
  // names go too
  const keep = new Set();
  for (const l of layers) {
    keep.add(`${l.name}/${l.index.slice(l.name.length + 1)}`);
    const older = readdirSync(join(catalogDir, l.name))
      .filter((f) => /^index-.*\.json\.gz$/.test(f) && `${l.name}/${f}` !== l.index)
      .map((f) => ({ f, t: lstatSync(join(catalogDir, l.name, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (older[0]) keep.add(`${l.name}/${older[0].f}`);
    for (const o of older.slice(1)) unlinkSync(join(catalogDir, l.name, o.f));
  }
  if (args.includes('--prune')) {
    const live = new Set();
    for (const k of keep) for (const c of JSON.parse(gunzipSync(readFileSync(join(catalogDir, k)))).chunks) live.add(`${c[0]}.gz`);
    let n = 0;
    for (const f of readdirSync(join(catalogDir, 'chunks'))) if (!live.has(f)) { unlinkSync(join(catalogDir, 'chunks', f)); n++; }
    console.log(`pruned ${n} chunks`);
  }
  console.log(`catalog: ${layers.map((l) => l.name).join(', ')}`);
  process.exit(0);
}

const id = opt('--id', '');
const baseId = opt('--base-id', '');
const snapshot = opt('--snapshot', '');
const recipe = opt('--recipe', '');
const CHUNK_TARGET = Number(opt('--chunk-size', String(1024 * 1024)));
const [baseTree, rootTree, out] = args;
if (!baseTree || !rootTree || !out || !id) {
  console.error('usage: pack-layer.mjs BASE_TREE ROOT_TREE OUT --id ID [--spec F --base-id ID --snapshot TS --recipe H]');
  process.exit(2);
}

// Text databases merged with what the machine has instead of replaced
// (src/debian/layers.ts MERGED): dpkg's status is carried per package.
const STATUS = '/var/lib/dpkg/status';
const MERGED = new Set([
  '/var/lib/apt/extended_states', '/var/lib/dpkg/diversions', '/var/lib/dpkg/statoverride',
  '/var/cache/debconf/config.dat', '/var/cache/debconf/templates.dat', '/var/cache/debconf/passwords.dat',
  '/etc/passwd', '/etc/group', '/etc/shadow', '/etc/gshadow', '/etc/shells', '/etc/subuid', '/etc/subgid',
]);
const isMerged = (p) => MERGED.has(p) || (p.startsWith('/var/lib/dpkg/triggers/') && !/\/(Lock|Unincorp)$/.test(p));
// Never carried: locks, dpkg's scratch files, files the page provides
const IGNORE = (p) => /^\/var\/lib\/dpkg\/(lock|lock-frontend|available|status|triggers\/Lock|triggers\/Unincorp)$/.test(p)
  || p.startsWith('/var/lib/dpkg/updates/') || p === '/var/cache/apt/archives/lock' || p === '/var/lib/apt/lists/lock'
  || p.startsWith('/dev/') || p.startsWith('/proc/') || p.startsWith('/sys/') || p === '/.complete';

function walk(root) {
  const m = new Map();
  const visit = (rel) => {
    const abs = join(root, rel);
    const st = lstatSync(abs);
    const path = rel || '/';
    const mode = st.mode & 0o7777;
    const mtime = Math.floor(st.mtimeMs / 1000);
    if (st.isDirectory()) {
      m.set(path, { path, type: 'd', mode, mtime });
      if (['/dev', '/proc', '/sys'].includes(path)) return;
      for (const name of readdirSync(abs).sort()) visit(`${rel}/${name}`);
    } else if (st.isSymbolicLink()) m.set(path, { path, type: 'l', mode: 0o777, mtime, target: readlinkSync(abs) });
    else if (st.isFile()) m.set(path, { path, type: 'f', mode, mtime, size: st.size, abs });
  };
  visit('');
  return m;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** dpkg status → Map "name:arch" → { name, arch, version, status, text } */
function parseStatus(text) {
  const m = new Map();
  for (const stanza of text.split(/\n\n+/)) {
    if (!stanza.trim()) continue;
    const f = (k) => (stanza.match(new RegExp(`^${k}: (.*)$`, 'm')) || [])[1] || '';
    const name = f('Package'), arch = f('Architecture');
    m.set(`${name}:${arch}`, { name, arch, version: f('Version'), status: f('Status'), multiArch: f('Multi-Arch'), text: stanza.trim() + '\n' });
  }
  return m;
}

const base = walk(baseTree);
const root = walk(rootTree);
const baseStatus = parseStatus(readFileSync(join(baseTree, STATUS), 'utf8'));
const rootStatus = parseStatus(readFileSync(join(rootTree, STATUS), 'utf8'));

// The layer's packages: new, or a different version/state than the base's
const packages = [];
for (const [key, p] of rootStatus) {
  const b = baseStatus.get(key);
  if (b && b.version === p.version && b.status === p.status) continue;
  if (!/ installed$/.test(p.status)) throw new Error(`${key} is "${p.status}" after the install`);
  packages.push({ name: p.name, arch: p.arch, version: p.version, multiArch: p.multiArch, replaces: b ? b.version : undefined, status: p.text });
}
for (const [key] of baseStatus) if (!rootStatus.has(key)) throw new Error(`${key} was removed by the install; layers only add packages`);
packages.sort((a, b) => a.name.localeCompare(b.name));
const pkgIndex = new Map(packages.map((p, i) => [p.name, i]));

// Owner of each path: the layer package whose .list names it, or its dpkg info file
const owner = new Map();
for (const [i, p] of packages.entries()) {
  for (const f of [`${p.name}:${p.arch}.list`, `${p.name}.list`]) {
    const lf = join(rootTree, 'var/lib/dpkg/info', f);
    if (!existsSync(lf)) continue;
    for (const path of readFileSync(lf, 'utf8').split('\n')) if (path && !owner.has(path)) owner.set(path, i);
  }
}
const infoOwner = (path) => {
  if (!path.startsWith('/var/lib/dpkg/info/')) return undefined;
  const file = path.slice('/var/lib/dpkg/info/'.length);
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return pkgIndex.get(file.slice(0, dot).replace(/:[^:]*$/, ''));
};
const ownerOf = (path) => owner.get(path) ?? infoOwner(path) ?? -1;

const changed = [];
const merged = {};
for (const [path, e] of root) {
  if (IGNORE(path)) continue;
  const b = base.get(path);
  if (b && b.type === e.type) {
    if (e.type === 'd' && b.mode === e.mode) continue;
    if (e.type === 'l' && b.target === e.target) continue;
    if (e.type === 'f' && b.mode === e.mode && b.size === e.size && readFileSync(b.abs).equals(readFileSync(e.abs))) continue;
  }
  if (e.type === 'f' && isMerged(path)) { merged[path] = readFileSync(e.abs, 'utf8'); continue; }
  changed.push(e);
}
const removed = [];
for (const [path, b] of base) {
  if (IGNORE(path) || root.has(path)) continue;
  removed.push(path);
}

// Chunks: one package at a time (then everything unowned by directory), in path order
mkdirSync(join(out, 'chunks'), { recursive: true });
mkdirSync(join(out, id), { recursive: true });
const chunks = [];
const byContent = new Map();
let cur = [], curSize = 0;
function flush() {
  if (!cur.length) return;
  const data = Buffer.concat(cur);
  const cid = sha(data);
  const file = join(out, 'chunks', `${cid}.gz`);
  let csize;
  if (existsSync(file)) csize = lstatSync(file).size;
  else { const gz = gzipSync(data, { level: 9 }); writeFileSync(file, gz); csize = gz.length; }
  chunks.push([cid, data.length, csize]);
  cur = []; curSize = 0;
}
const groups = new Map();
for (const e of changed) {
  if (e.type !== 'f' || !e.size) continue;
  const o = ownerOf(e.path);
  const key = o >= 0 ? `pkg:${packages[o].name}` : `dir:${e.path.split('/').slice(0, 4).join('/')}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}
for (const [, files] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  for (const e of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const data = readFileSync(e.abs);
    const h = sha(data);
    const known = byContent.get(h);
    if (known) { [e.chunk, e.off] = known; continue; }
    if (curSize && curSize + data.length > CHUNK_TARGET) flush();
    e.chunk = chunks.length; e.off = curSize;
    byContent.set(h, [e.chunk, e.off]);
    cur.push(data); curSize += data.length;
  }
  flush(); // a package never shares a chunk, so layers sharing it share the chunk
}

// Rows as in a rootfs index, plus the owning package (index into packages, -1: none)
const entries = changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((e) => {
  const o = ownerOf(e.path);
  if (e.type === 'd') return [e.path, 'd', e.mode, e.mtime, o];
  if (e.type === 'l') return [e.path, 'l', e.mode, e.mtime, e.target, o];
  return e.size ? [e.path, 'f', e.mode, e.mtime, e.size, e.chunk, e.off, o] : [e.path, 'f', e.mode, e.mtime, 0, -1, 0, o];
});
// Parents before children: a plain sort puts "/a/b" after "/a-x", which is fine,
// but "/a" must precede "/a/..." — true for byte order since '/' sorts low... except
// for names with characters below '/', so sort by components to be safe.
entries.sort((a, b) => {
  const x = a[0].split('/'), y = b[0].split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length;
});

const index = { format: 1, kind: 'layer', name: id, base: baseId, packages, chunks, entries, removed, merged };
const json = Buffer.from(JSON.stringify(index));
const indexId = sha(json).slice(0, 32);
const indexName = `index-${indexId}.json.gz`;
writeFileSync(join(out, id, indexName), gzipSync(json, { level: 9 }));

const manifest = {
  format: 1,
  kind: 'layer',
  id: indexId,
  name: id,
  base: baseId,
  snapshot,
  recipe,
  index: `${id}/${indexName}`,
  packages: packages.length,
  entries: entries.length,
  files: changed.filter((e) => e.type === 'f').length,
  bytes: changed.reduce((n, e) => n + (e.size || 0), 0),
  chunks: chunks.length,
  chunkBytes: chunks.reduce((n, c) => n + c[2], 0),
  builtAt: new Date(Number(process.env.SOURCE_DATE_EPOCH || 0) * 1000).toISOString(),
};
writeFileSync(join(out, id, 'layer.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
if (removed.length) console.log(`removed from the base: ${removed.length} paths`);
