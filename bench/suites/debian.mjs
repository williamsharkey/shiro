// Debian mode (docs/DEBIAN.md): the streamed rootfs's first-boot and
// warm-boot costs, storage, and apt. Not in the default suite list (apt takes
// minutes): `node bench/run.mjs --suites debian --modes isolated`.
// The package mirror's disk cache (.debian-build/mirror-cache, see
// startShiroServer) keeps apt off the network after the first run.
import { MB } from '../lib/harness.mjs';

export const name = 'debian';

const statusRe = /this session: (\d+) chunks fetched \(([\d.]+) MB\), (\d+) from the browser cache, (\d+) files filled/;

async function status(h) {
  const r = await h.sh('debian status');
  const m = statusRe.exec(r.out);
  return m ? { chunks: +m[1], mb: +m[2], cached: +m[3], files: +m[4] } : null;
}

async function timed(h, cmd, limitS = 600) {
  const r = await h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [cmd, limitS * 1000]);
  if (r.code !== 0) throw new Error(`${cmd}: exit ${r.code}: ${(r.err || r.out).slice(-300)}`);
  return r;
}

export async function run(h) {
  if (!h.isolated) { h.skip('debian.suite', '', 'Blink needs a cross-origin isolated page'); return; }
  const n = h.quick ? 2 : Math.min(h.runs, 3);
  const install = [], firstBash = [], dpkgList = [], fetchedMb = [], idb = [], warmBash = [], warmFetched = [], warmBoot = [];
  for (let i = 0; i < n; i++) {
    const b = await h.boot({});
    install.push((await timed(h, 'debian install')).ms);
    firstBash.push((await timed(h, '/usr/bin/bash -c true')).ms);
    dpkgList.push((await timed(h, 'dpkg -l > /dev/null')).ms);
    const st = await status(h);
    fetchedMb.push(st?.mb ?? NaN);
    idb.push(await b.page.evaluate(async () => (await navigator.storage.estimate()).usage) / MB);
    // Warm: reload; everything read so far is in IndexedDB now
    const w = await h.boot({ context: b.context, page: b.page });
    warmBoot.push(w.marks.firstPrompt);
    warmBash.push((await timed(h, '/usr/bin/bash -c true')).ms);
    warmFetched.push((await status(h))?.chunks ?? NaN);
    await b.context.close();
  }
  h.sample('debian.rootfs.install', install, 'ms', { notes: '`debian install`: manifest + index fetch, placeholders for every path' });
  h.sample('debian.rootfs.first_bash', firstBash, 'ms', { notes: 'first `/usr/bin/bash -c true` after install: fetches bash, libc, libtinfo chunks' });
  h.sample('debian.rootfs.first_dpkg_list', dpkgList, 'ms', { notes: 'then `dpkg -l` (dpkg, its libraries, the status file)' });
  h.sample('debian.rootfs.fetched', fetchedMb, 'MB', { notes: 'chunk bytes fetched for the two commands (compressed)' });
  h.sample('debian.rootfs.storage', idb, 'MiB', { notes: 'navigator.storage.estimate().usage after install + those commands (IndexedDB + chunk cache)' });
  h.sample('debian.warm.first_prompt', warmBoot, 'ms', { cache: 'warm', notes: 'reload of a Debian-mode page: navigation → prompt' });
  h.sample('debian.warm.first_bash', warmBash, 'ms', { cache: 'warm', notes: '`/usr/bin/bash -c true` after the reload' });
  h.sample('debian.warm.chunks_fetched', warmFetched, 'count', { cache: 'warm', notes: 'chunks fetched after the reload (0 = no network)' });

  if (h.quick || !h.wants('debian.apt')) return;
  const b = await h.boot({});
  await timed(h, 'debian install');
  await h.try('debian.apt.update', 'ms', async () => {
    const r = await timed(h, 'sudo apt-get update', 1800);
    h.sample('debian.apt.update', [r.ms], 'ms', { notes: 'trixie + updates + security indexes (10 MB) from the mirror cache; one sample' });
  });
  for (const [pkg, check] of [['hello', 'hello'], ['jq', 'jq --version'], ['python3-minimal', 'python3 -c "print(1)"']]) {
    await h.try(`debian.apt.install.${pkg}`, 'ms', async () => {
      const r = await timed(h, `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkg}`, 1800);
      const c = await timed(h, check, 300);
      h.sample(`debian.apt.install.${pkg}`, [r.ms], 'ms', { notes: `\`apt-get install -y ${pkg}\` incl. dependencies; then \`${check}\` ${Math.round(c.ms)} ms; one sample` });
    });
  }
  h.sample('debian.apt.storage', [await b.page.evaluate(async () => (await navigator.storage.estimate()).usage) / MB], 'MiB', { notes: 'storage after update + the three installs' });
  await b.context.close();
}
