// User workflows (in --quick and full runs, isolated only), each from a fresh
// profile, with time and renderer RSS peaks:
// - Vite's React template typed into the real terminal, as
//   tests/browser/vite-react.mjs does: `npm create vite`, `npm i`, `npm run
//   dev` until ready, the preview renders, an edit reaches it by HMR (no
//   reload). npm and the template come from bench/.cache/net (no network).
// - `go run hello.go` on the go toolchain layer (debian install + toolchain
//   install go), served from TABCOMPUTER_DEBIAN_LAYERS (default
//   .toolchain-build/layers; `sudo bash scripts/debian/build-layers.sh go`
//   builds it in about a minute). Skipped without it.
// - apt: `apt-get update` and `apt-get install -y hello` from server.mjs's
//   mirror disk cache (.debian-build/mirror-cache), i.e. a warm cache after
//   the first run on a machine.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MB } from '../lib/harness.mjs';

export const name = 'workflows';
export const ownPages = true;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function timed(h, cmd, limitS, check) {
  const r = await h.withPeakRss(() => h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [`${cmd} > /tmp/wf.out 2>&1`, limitS * 1000]));
  const out = (await h.sh('cat /tmp/wf.out')).out;
  if (r.result.code !== 0 || (check && !check.test(out))) {
    throw new Error(`${cmd.slice(0, 70)}: ${r.result.code === 124 ? `timed out after ${limitS} s` : `exit ${r.result.code}`}: ${out.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
  }
  return { ms: r.result.ms, peak: r.peakDelta / MB };
}

/** Terminal text from line `from` on, and helpers to type and wait (the terminal runs vite). */
const termText = (h) => h.eval(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const rows = [];
  for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
  return rows.join('\n');
});
async function typeAndWait(h, line, re, limitMs, what) {
  const from = (await termText(h)).length;
  const t0 = Date.now();
  await h.eval((l) => window.__tabcomputer.terminal.term.input(l, true), line);
  for (;;) {
    const s = (await termText(h)).slice(from);
    const m = re.exec(s);
    if (m) return { ms: Date.now() - t0, m };
    if (Date.now() - t0 > limitMs) throw new Error(`timed out waiting for ${what}: ${s.split('\n').slice(-6).join(' | ').slice(0, 400)}`);
    await h.page.waitForTimeout(50);
  }
}
let marks = 0;
async function termStep(h, cmd, limitMs) {
  const mark = `@@wf${++marks}`;
  const r = await h.withPeakRss(() => typeAndWait(h, `${cmd}; echo "${mark} $?"\r`, new RegExp(`^${mark} (\\d+)$`, 'm'), limitMs, cmd));
  if (r.result.m[1] !== '0') throw new Error(`exit ${r.result.m[1]}: ${cmd}: ${(await termText(h)).split('\n').slice(-6).join(' | ').slice(0, 300)}`);
  return { ms: r.result.ms, peak: r.peakDelta / MB };
}
async function preview(h) {
  for (let i = 0; i < 600; i++) {
    for (const el of await h.page.$$('iframe[data-virtual-port="5173"]')) {
      const f = await el.contentFrame();
      if (f && f.url() !== 'about:blank' && f.url() !== '') return f;
    }
    await h.page.waitForTimeout(100);
  }
  throw new Error('no preview of :5173');
}
const side = (h, cmd) => h.eval(async (c) => {
  const sh = window.__tabcomputer.shell.fork(); sh.terminal = null;
  let out = '';
  const code = await sh.execute(c, (s) => { out += s; }, (s) => { out += s; });
  return { code, out };
}, cmd);

async function vite(h, add) {
  await h.page?.context().close().catch(() => {});
  await h.boot({ path: '/?ui=terminal' });
  const create = await termStep(h, 'cd ~ && npm create vite@latest app -- --template react --no-interactive', 300000);
  add('create', create.ms); add('create_peak', create.peak);
  const inst = await termStep(h, 'cd ~/app && npm i', 600000);
  add('npm_i', inst.ms); add('npm_i_peak', inst.peak);
  const dev = await h.withPeakRss(() => typeAndWait(h, 'npm run dev\r', /ready in \d+ ms|Local:\s+http/, 300000, 'vite ready'));
  add('dev_ready', dev.result.ms); add('dev_peak', dev.peakDelta / MB);
  let t0 = Date.now();
  const opened = await side(h, 'serve open 5173');
  if (opened.code !== 0) throw new Error(`serve open 5173: ${opened.out.slice(0, 200)}`);
  let frame = await preview(h);
  await frame.waitForFunction(() => /Count is \d/.test(document.body?.innerText ?? ''), null, { timeout: 300000 });
  frame = await preview(h);
  add('preview', Date.now() - t0);
  await frame.evaluate(() => { window.__notReloaded = true; });
  t0 = Date.now();
  await side(h, "sed -i 's|Get started|Edited by HMR|' ~/app/src/App.jsx");
  await frame.waitForFunction(() => /Edited by HMR/.test(document.body?.innerText ?? ''), null, { timeout: 60000 });
  add('hmr', Date.now() - t0);
  if (!await frame.evaluate(() => window.__notReloaded === true)) throw new Error('the preview reloaded instead of hot-updating');
}

export async function run(h) {
  if (!h.isolated) { h.skip('workflow.suite', '', 'measured in the isolated (production) configuration only'); return; }
  const rounds = h.quick ? 1 : Math.min(h.runs, 3);
  const S = (R, name, key, unit, notes) => { if (R[key]?.length) h.sample(name, R[key], unit, { notes }); };

  if (h.wants('workflow.vite')) {
    const R = {};
    const add = (k, v) => (R[k] ??= []).push(v);
    for (let i = 0; i < rounds; i++) {
      try { await vite(h, add); } catch (e) { h.skip('workflow.vite.round', '', `round ${i + 1} failed: ${String(e.message).slice(0, 300)}`); }
    }
    S(R, 'workflow.vite.create', 'create', 'ms', '`npm create vite@latest app -- --template react --no-interactive` typed at the terminal, fresh profile');
    S(R, 'workflow.vite.npm_i', 'npm_i', 'ms', '`npm i` in the new app (react, vite, plugins; registry from the bench cache)');
    S(R, 'workflow.vite.dev_ready', 'dev_ready', 'ms', '`npm run dev` until vite prints ready');
    S(R, 'workflow.vite.preview', 'preview', 'ms', '`serve open 5173` until the preview renders the app');
    S(R, 'workflow.vite.hmr', 'hmr', 'ms', 'edit src/App.jsx → the change shows in the preview by HMR (no reload)');
    S(R, 'workflow.peak_rss.vite_npm_i', 'npm_i_peak', 'MiB', 'renderer RSS peak above the pre-run level, npm i');
    S(R, 'workflow.peak_rss.vite_dev', 'dev_peak', 'MiB', 'renderer RSS peak above the pre-run level, npm run dev → ready');
  }

  const layers = process.env.TABCOMPUTER_DEBIAN_LAYERS || join(ROOT, '.toolchain-build', 'layers');
  const haveGo = existsSync(join(layers, 'go', 'layer.json'));
  if (!haveGo && h.wants('workflow.go')) h.skip('workflow.go.run', 'ms', `no go layer in ${layers} (sudo bash scripts/debian/build-layers.sh go builds it locally)`);
  if (h.wants('workflow.go') || h.wants('workflow.apt')) {
    const R = {};
    const add = (k, v) => (R[k] ??= []).push(v);
    const apt = 'sudo DEBIAN_FRONTEND=noninteractive apt-get';
    for (let i = 0; i < rounds; i++) {
      if (haveGo && h.wants('workflow.go')) {
        await h.page?.context().close().catch(() => {});
        await h.boot({ path: '/?ui=terminal' });
        try {
          await timed(h, 'debian install', 300);
          const inst = await timed(h, 'toolchain install go', 600);
          await h.eval(() => window.__bench.writeFile('/tmp/hello.go', 'package main\nimport "fmt"\nfunc main() { fmt.Println("hello") }\n'));
          const first = await timed(h, 'cd /tmp && go run hello.go', 1200, /^hello$/m);
          const warm = await timed(h, 'cd /tmp && go run hello.go', 1200, /^hello$/m);
          add('go_install', inst.ms); add('go_first', first.ms); add('go_first_peak', first.peak); add('go_warm', warm.ms); add('go_warm_peak', warm.peak);
        } catch (e) {
          h.skip('workflow.go.round', '', `round ${i + 1} failed: ${String(e.message).slice(0, 300)}`);
        }
      }
      // apt in a profile of its own (no go layer, no Go processes before it)
      if (h.wants('workflow.apt')) {
        await h.page?.context().close().catch(() => {});
        await h.boot({ path: '/?ui=terminal' });
        try {
          await timed(h, 'debian install', 300);
          const up = await timed(h, `${apt} update`, 1800);
          const hello = await timed(h, `${apt} install -y hello`, 1800);
          const runIt = await timed(h, 'hello', 120, /Hello, world!/);
          add('apt_update', up.ms); add('apt_update_peak', up.peak); add('apt_hello', hello.ms); add('apt_hello_peak', hello.peak); add('apt_hello_run', runIt.ms);
        } catch (e) {
          h.skip('workflow.apt.round', '', `round ${i + 1} failed: ${String(e.message).slice(0, 300)}`);
        }
      }
    }
    S(R, 'workflow.go.toolchain_install', 'go_install', 'ms', '`toolchain install go` (layer: placeholders + dpkg database) after `debian install`');
    S(R, 'workflow.go.run_first', 'go_first', 'ms', 'first `go run hello.go` (Go 1.24 in Blink: compile + link + run; fetches the toolchain\'s chunks)');
    S(R, 'workflow.go.run_warm', 'go_warm', 'ms', 'second `go run hello.go` (build cache warm)');
    S(R, 'workflow.peak_rss.go_run_first', 'go_first_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    S(R, 'workflow.peak_rss.go_run_warm', 'go_warm_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    S(R, 'workflow.apt.update', 'apt_update', 'ms', '`apt-get update` from the mirror disk cache (needed before any install on a fresh profile)');
    S(R, 'workflow.apt.install_hello', 'apt_hello', 'ms', '`apt-get install -y hello` (one small package, no new dependencies) from the warm mirror cache');
    S(R, 'workflow.apt.hello_run', 'apt_hello_run', 'ms', 'then `hello`');
    S(R, 'workflow.peak_rss.apt_update', 'apt_update_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    S(R, 'workflow.peak_rss.apt_install_hello', 'apt_hello_peak', 'MiB', 'renderer RSS peak above the pre-run level');
  }
}
