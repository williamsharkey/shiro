#!/usr/bin/env node
// Renderer memory of `apt-get update` with no network: a synthetic Debian
// repository (generated, deterministic) stands in for deb.debian.org, served
// to server.mjs's mirror (TABCOMPUTER_DEBIAN_MIRRORS) by a local HTTP server.
// The indexes have the shape and size of trixie main amd64 (Packages ~50 MB,
// Translation-en ~25 MB uncompressed, xz), so apt does the same work: fetch,
// xz decode into /var/lib/apt/lists, build pkgcache.bin.
//   [APT_MEM_ROUNDS=3] [APT_MEM_PKGS=64000] [APT_MEM_SRC=dir] node bench/apt-mem.mjs
// APT_MEM_SRC measures another checkout's dist/ (an A/B: run once per tree).
// APT_MEM_CMDS='cmd;;cmd' measures those commands instead (after the same
// setup; the repo is at /debian/mirror/deb.debian.org/debian/dists/trixie/).
import { createServer } from 'node:http';
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Harness } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = Number(process.env.APT_MEM_PKGS || 64000);
const ROUNDS = Number(process.env.APT_MEM_ROUNDS || 3);
const REPO = join(ROOT, 'bench', '.cache', `apt-synth-${PKGS}`);
const MB = 1 << 20;

/** A deterministic pseudo-random generator (the repo is the same every run). */
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const WORDS = 'the a library tool for and of with data files support utility package runtime module development headers documentation shared static python perl network server client graphics audio video system command line interface protocol format parser plugin extension'.split(' ');

function generate() {
  if (existsSync(join(REPO, 'dists/trixie/Release'))) return;
  const r = rng(42);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const hex = (n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  const names = Array.from({ length: PKGS }, (_, i) => `synth-${words(1)}-${i}`);
  const pk = [], tr = [];
  for (let i = 0; i < PKGS; i++) {
    const n = names[i];
    const deps = Array.from({ length: Math.floor(r() * 6) }, () => `${pick(names)} (>= ${1 + Math.floor(r() * 9)}.${Math.floor(r() * 20)})`);
    const long = Array.from({ length: 2 + Math.floor(r() * 6) }, () => ' ' + words(10)).join('\n');
    const md5 = hex(32);
    pk.push(`Package: ${n}\nVersion: ${1 + Math.floor(r() * 9)}.${Math.floor(r() * 50)}-${1 + Math.floor(r() * 5)}\nInstalled-Size: ${Math.floor(r() * 20000)}\n`
      + `Maintainer: Synthetic Maintainers <synth@example.org>\nArchitecture: amd64\n${deps.length ? `Depends: ${deps.join(', ')}\n` : ''}`
      + `Description: ${words(6)}\nHomepage: https://example.org/${n}\nDescription-md5: ${md5}\nTag: role::program, implemented-in::c\nSection: ${pick(['utils', 'libs', 'devel', 'net', 'python', 'doc'])}\nPriority: optional\n`
      + `Filename: pool/main/s/${n}/${n}_1.0_amd64.deb\nSize: ${Math.floor(r() * 5e6)}\nSHA256: ${hex(64)}\n`);
    tr.push(`Package: ${n}\nDescription-md5: ${md5}\nDescription-en: ${words(6)}\n${long}\n`);
  }
  const files = { 'main/binary-amd64/Packages': pk.join('\n'), 'main/i18n/Translation-en': tr.join('\n') };
  const dists = join(REPO, 'dists/trixie');
  const lines = [];
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dists, dirname(rel)), { recursive: true });
    writeFileSync(join(dists, rel), text);
    execFileSync('xz', ['-6', '-k', '-f', join(dists, rel)]);
    for (const f of [rel, rel + '.xz']) {
      const b = readFileSync(join(dists, f));
      lines.push(` ${createHash('sha256').update(b).digest('hex')} ${String(b.length).padStart(10)} ${f}`);
    }
    rmSync(join(dists, rel));
  }
  writeFileSync(join(dists, 'Release'), `Origin: Synthetic\nLabel: Synthetic\nSuite: stable\nCodename: trixie\nDate: Sat, 10 Oct 2026 00:00:00 UTC\nArchitectures: amd64\nComponents: main\nAcquire-By-Hash: no\nSHA256:\n${lines.join('\n')}\n`);
}

generate();
const repoServer = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/debian\//, '/');
  const f = join(REPO, p);
  if (p.includes('..') || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => repoServer.listen(0, '127.0.0.1', r));
process.env.TABCOMPUTER_DEBIAN_MIRRORS = `deb.debian.org=http://127.0.0.1:${repoServer.address().port}`;
process.env.TABCOMPUTER_DEBIAN_CACHE = mkdtempSync(join(tmpdir(), 'apt-mem-'));
process.env.TABCOMPUTER_DEBIAN_INDEX_TTL = '0';
const { startShiroServer } = await import('./lib/servers.mjs');
const src = process.env.APT_MEM_SRC || ROOT;
const server = await startShiroServer({ staticDir: join(src, 'dist'), isolated: true });
const h = new Harness({ mode: 'isolated', origin: server.origin, netcache: new NetCache(join(ROOT, 'bench/.cache/net')), runs: 1, log: () => {}, results: [] });
await h.launch();
const sh = (c, s = 1800) => h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [c, s * 1000]);
const peaks = [], times = [];
try {
  for (let i = 0; i < ROUNDS; i++) {
    await h.page?.context().close().catch(() => {});
    await h.boot({ path: '/?ui=terminal' });
    let r = await sh('debian install >/tmp/di.out 2>&1; echo $?', 300);
    if (r.out.trim() !== '0') throw new Error('debian install: ' + (await sh('tail -3 /tmp/di.out')).out);
    await sh(`sudo rm -f /etc/apt/sources.list.d/*; echo 'deb [trusted=yes] http://deb.debian.org/debian trixie main' | sudo tee /etc/apt/sources.list >/dev/null`);
    if (process.env.APT_MEM_CMDS) {
      for (const c of process.env.APT_MEM_CMDS.split(';;')) {
        const m = await h.withPeakRss(() => sh(`{ ${c}; } >/tmp/c.out 2>&1; echo $?`), { buffer: true });
        console.log(`${c.slice(0, 60).padEnd(60)} exit ${m.result.out.trim()} ${(m.result.ms / 1000).toFixed(1)} s  peak +${((m.peakDeltaNet ?? m.peakDelta) / MB).toFixed(1)} MiB`);
        if (m.result.out.trim() !== '0') console.log('   ', (await sh('tail -3 /tmp/c.out')).out.trim());
      }
      continue;
    }
    const m = await h.withPeakRss(() => sh('sudo apt-get update >/tmp/au.out 2>&1; echo $?'), { buffer: true });
    if (m.result.out.trim() !== '0') throw new Error('apt-get update: ' + (await sh('tail -5 /tmp/au.out')).out);
    const ls = (await sh('ls -l /var/lib/apt/lists/ /var/cache/apt/ | grep -v "^total"')).out;
    if (i === 0) console.log(ls.trim());
    const net = m.peakDeltaNet ?? m.peakDelta;
    peaks.push(net / MB); times.push(m.result.ms);
    console.log(`round ${i + 1}: apt-get update ${(m.result.ms / 1000).toFixed(1)} s, peak +${(m.peakDelta / MB).toFixed(1)} MiB (net of DevTools buffers +${(net / MB).toFixed(1)} MiB)`);
  }
} finally {
  await h.close(); await server.close(); repoServer.close();
  rmSync(process.env.TABCOMPUTER_DEBIAN_CACHE, { recursive: true, force: true });
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
if (peaks.length) console.log(`median: ${(med(times) / 1000).toFixed(1)} s, peak +${med(peaks).toFixed(1)} MiB (net)  samples ${peaks.map((p) => p.toFixed(0)).join(' ')}`);
