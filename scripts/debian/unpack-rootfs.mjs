#!/usr/bin/env node
// Rebuild a directory tree from a packed rootfs (pack-rootfs.mjs's output),
// so a toolchain layer is built on exactly the base users install:
//
//   node scripts/debian/unpack-rootfs.mjs public/debian DIR
//
// Writes every path with its mode and mtime; owners are root (the index has
// none). Chunks are checked against their sha256 names.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, lutimesSync, utimesSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) { console.error('usage: unpack-rootfs.mjs PACKED_DIR DEST'); process.exit(2); }
const manifest = JSON.parse(readFileSync(join(src, 'rootfs.json'), 'utf8'));
const index = JSON.parse(gunzipSync(readFileSync(join(src, manifest.index))).toString());

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const chunkCache = new Map();
function chunk(i) {
  const [id] = index.chunks[i];
  let data = chunkCache.get(id);
  if (!data) {
    data = gunzipSync(readFileSync(join(src, 'chunks', `${id}.gz`)));
    if (createHash('sha256').update(data).digest('hex') !== id) throw new Error(`chunk ${id}: sha256 mismatch`);
    chunkCache.clear(); // rows are grouped by chunk often enough; keep memory flat
    chunkCache.set(id, data);
  }
  return data;
}

const dirs = [];
for (const row of index.entries) {
  const [path, type, mode, mtime] = row;
  const abs = join(dest, path);
  if (type === 'd') {
    mkdirSync(abs, { recursive: true });
    dirs.push([abs, mode, mtime]);
  } else if (type === 'l') {
    symlinkSync(row[4], abs);
    lutimesSync(abs, mtime, mtime);
  } else {
    const size = row[4];
    writeFileSync(abs, size ? chunk(row[5]).subarray(row[6], row[6] + size) : new Uint8Array(0));
    chmodSync(abs, mode);
    utimesSync(abs, mtime, mtime);
  }
}
// Directory modes and times last (writing into them changed the times)
for (const [abs, mode, mtime] of dirs.reverse()) { chmodSync(abs, mode); utimesSync(abs, mtime, mtime); }
console.log(`unpacked ${index.entries.length} paths of rootfs ${manifest.id} into ${dest}`);
