#!/usr/bin/env node
// Pack a root filesystem directory into Shiro's streamed rootfs format:
//
//   OUT/rootfs.json            { format, id, suite, snapshot, index: "index-<sha>.json.gz", ... }
//   OUT/index-<sha>.json.gz    every path: type, mode, mtime, size, symlink target or (chunk, offset)
//   OUT/chunks/<sha>.gz        content-addressed chunks (gzip; name = sha256 of the uncompressed bytes)
//
// Files of one Debian package go into the same chunks (in path order), so
// running a program fetches its package's chunk and usually nothing else.
// Identical files (hard links, duplicates) are stored once. src/debian/rootfs.ts
// is the reader. Usage:
//
//   node scripts/debian/pack-rootfs.mjs ROOTFS OUT [--snapshot TS] [--suite NAME]
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, existsSync, readdirSync as ls, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const snapshot = opt('--snapshot', '');
const suite = opt('--suite', '');
const CHUNK_TARGET = Number(opt('--chunk-size', String(768 * 1024)));
const [root, out] = args;
if (!root || !out) { console.error('usage: pack-rootfs.mjs ROOTFS OUT [--snapshot TS] [--suite NAME]'); process.exit(2); }

// Directories whose contents Shiro provides itself (devices, kernel views),
// and build leftovers.
const SKIP_CONTENTS = new Set(['/dev', '/proc', '/sys', '/run/lock']);
const SKIP = new Set(['/.debootstrap-done']);

/** path → owning package, from dpkg's file lists. */
const owner = new Map();
const infoDir = join(root, 'var/lib/dpkg/info');
if (existsSync(infoDir)) {
  for (const f of readdirSync(infoDir)) {
    if (!f.endsWith('.list')) continue;
    const pkg = f.slice(0, -5).replace(/:.*$/, '');
    for (const p of readFileSync(join(infoDir, f), 'utf8').split('\n')) if (p && !owner.has(p)) owner.set(p, pkg);
  }
}

const entries = []; // { path, type, mode, mtime, size, target?, data? }
function walk(rel) {
  const abs = join(root, rel);
  const st = lstatSync(abs);
  const path = rel || '/';
  if (SKIP.has(path)) return;
  const mode = st.mode & 0o7777;
  const mtime = Math.floor(st.mtimeMs / 1000);
  if (st.isDirectory()) {
    entries.push({ path, type: 'd', mode, mtime });
    if (SKIP_CONTENTS.has(path)) return;
    for (const name of readdirSync(abs).sort()) walk(`${rel}/${name}`);
  } else if (st.isSymbolicLink()) {
    entries.push({ path, type: 'l', mode: 0o777, mtime, target: readlinkSync(abs) });
  } else if (st.isFile()) {
    entries.push({ path, type: 'f', mode, mtime, size: st.size, abs });
  } // sockets, fifos and devices: none outside /dev in a fresh rootfs
}
walk('');

// Group files: by owning package, then everything dpkg doesn't own (the
// generated /etc files and dpkg's database) by top-level directory.
const groups = new Map();
for (const e of entries) {
  if (e.type !== 'f') continue;
  const pkg = owner.get(e.path);
  const key = pkg ? `pkg:${pkg}` : `dir:${e.path.split('/').slice(0, e.path.startsWith('/var/lib/dpkg/') ? 5 : 2).join('/')}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}

mkdirSync(join(out, 'chunks'), { recursive: true });
const chunks = []; // { id, size, csize }
const byContent = new Map(); // sha256 of file → [chunkIndex, offset]
let cur = [], curSize = 0;
function flush() {
  if (!cur.length) return;
  const data = Buffer.concat(cur);
  const id = createHash('sha256').update(data).digest('hex');
  const gz = gzipSync(data, { level: 9 });
  const file = join(out, 'chunks', `${id}.gz`);
  if (!existsSync(file)) writeFileSync(file, gz);
  chunks.push({ id, size: data.length, csize: gz.length });
  cur = []; curSize = 0;
}
for (const [, files] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  for (const e of files.sort((a, b) => a.path.localeCompare(b.path))) {
    if (e.size === 0) continue;
    const data = readFileSync(e.abs);
    const h = createHash('sha256').update(data).digest('hex');
    const known = byContent.get(h);
    if (known) { [e.chunk, e.off] = known; continue; }
    if (curSize && curSize + data.length > CHUNK_TARGET) flush();
    e.chunk = chunks.length; e.off = curSize;
    byContent.set(h, [e.chunk, e.off]);
    cur.push(data); curSize += data.length;
  }
  // A package's files start a fresh chunk once the current one is half full,
  // so small packages share and big ones don't drag neighbours along.
  if (curSize > CHUNK_TARGET / 2) flush();
}
flush();

// Index rows: [path, type, mode, mtime, size|target, chunk, offset]
const rows = entries.map((e) => e.type === 'f'
  ? (e.size ? [e.path, 'f', e.mode, e.mtime, e.size, e.chunk, e.off] : [e.path, 'f', e.mode, e.mtime, 0])
  : e.type === 'l' ? [e.path, 'l', e.mode, e.mtime, e.target] : [e.path, 'd', e.mode, e.mtime]);
const index = { format: 1, chunks: chunks.map((c) => [c.id, c.size, c.csize]), entries: rows };
const indexJson = Buffer.from(JSON.stringify(index));
const indexId = createHash('sha256').update(indexJson).digest('hex');
const indexName = `index-${indexId.slice(0, 32)}.json.gz`;
writeFileSync(join(out, indexName), gzipSync(indexJson, { level: 9 }));

let debianVersion = '';
try { debianVersion = readFileSync(join(root, 'etc/debian_version'), 'utf8').trim(); } catch {}
const packages = existsSync(join(root, 'var/lib/dpkg/status'))
  ? (readFileSync(join(root, 'var/lib/dpkg/status'), 'utf8').match(/^Package: /gm) || []).length : 0;
const totalSize = entries.reduce((n, e) => n + (e.size || 0), 0);
const manifest = {
  format: 1,
  id: indexId.slice(0, 32),
  distro: 'debian',
  suite,
  version: debianVersion,
  snapshot,
  arch: 'amd64',
  index: indexName,
  entries: rows.length,
  packages,
  files: entries.filter((e) => e.type === 'f').length,
  bytes: totalSize,
  chunks: chunks.length,
  chunkBytes: chunks.reduce((n, c) => n + c.csize, 0),
};
writeFileSync(join(out, 'rootfs.json'), JSON.stringify(manifest, null, 2) + '\n');

// Chunks no index of this build references are left in place on purpose:
// browsers that installed an older rootfs still fetch from them (they are
// content-addressed). `--prune` removes them.
if (process.argv.includes('--prune')) {
  const live = new Set(chunks.map((c) => `${c.id}.gz`));
  for (const f of ls(join(out, 'chunks'))) if (!live.has(f)) unlinkSync(join(out, 'chunks', f));
  for (const f of ls(out)) if (/^index-.*\.json\.gz$/.test(f) && f !== indexName) unlinkSync(join(out, f));
}
console.log(JSON.stringify(manifest, null, 2));
