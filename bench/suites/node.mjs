// Node/npm: the node-compat runtime and npm against the registry (served
// from bench/.cache/net, so this measures Shiro, not the network), and
// Claude Code's CLI startup (installed by the background install at boot).
import { MB } from '../lib/harness.mjs';

export const name = 'node';

async function timed(h, cmd, n, check) {
  const first = await h.eval(([c]) => window.__bench.shLimit(c, 120000), [cmd]);
  if (first.code !== 0) throw new Error(`exit ${first.code}: ${(first.err || first.out).slice(-200)}`);
  if (check) {
    const out = await h.sh('cat /tmp/node.out');
    if (!check.test(out.out)) throw new Error('unexpected output: ' + out.out.slice(0, 160));
  }
  const ms = [];
  for (let i = 0; i < n; i++) {
    const r = await h.eval(([c]) => window.__bench.shLimit(c, 120000), [cmd]);
    if (r.code !== 0) throw new Error(`exit ${r.code} on run ${i + 2}`);
    ms.push(r.ms);
  }
  return { first: first.ms, ms };
}

export async function run(h) {
  const n = h.runs;
  await h.try('node.e1', 'ms', async () => {
    const r = await timed(h, 'node -e 1', n);
    h.sample('node.e1', r.ms, 'ms', { notes: `\`node -e 1\`; first run ${Math.round(r.first)} ms` });
  });
  await h.try('node.repl.first_prompt', 'ms', async () => {
    // `node` typed at the terminal's prompt until the REPL shows `> `, then .exit
    const r = await h.eval(async (n) => {
      const term = window.__tabcomputer.terminal, t = term.term;
      const cursorLine = () => { const b = t.buffer.active; const l = b.getLine(b.baseY + b.cursorY); return l ? l.translateToString(false).slice(0, b.cursorX) : ''; };
      const until = async (re, ms) => { const t0 = performance.now(); while (!re.test(cursorLine())) { if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${re}: ${JSON.stringify(cursorLine())}`); await new Promise((r) => setTimeout(r, 2)); } };
      await until(/\$ $/, 10000);
      const out = [];
      for (let i = 0; i <= n; i++) {
        const t0 = performance.now();
        t.input('node\r', true);
        await until(/^> $/, 60000);
        out.push(performance.now() - t0);
        t.input('.exit\r', true);
        await until(/\$ $/, 30000);
      }
      return out;
    }, n);
    h.sample('node.repl.first_prompt', r.slice(1), 'ms', { notes: `\`node\` typed at the terminal → the REPL's \`> \` prompt on screen; the page's first REPL ${Math.round(r[0])} ms` });
  });
  if (!h.quick) await h.try('node.require_builtins', 'ms', async () => {
    const r = await timed(h, `node -e "for (const m of ['fs','path','events','util','stream','crypto','http']) require(m); console.log('ok')" > /tmp/node.out`, n, /ok/);
    h.sample('node.require_builtins', r.ms, 'ms', { notes: `require fs/path/events/util/stream/crypto/http; first run ${Math.round(r.first)} ms` });
  });
  if (!h.quick) await h.try('node.script_file', 'ms', async () => {
    await h.eval(() => window.__bench.writeFile('/tmp/bench-hello.js', "const os = require('os'); console.log('hello', os.platform(), [1,2,3].map(x => x * 2).join(','));\n"));
    const r = await timed(h, 'node /tmp/bench-hello.js > /tmp/node.out', n, /hello/);
    h.sample('node.script_file', r.ms, 'ms', { notes: `\`node hello.js\` (requires os); first run ${Math.round(r.first)} ms` });
  });

  // node in the page (TABCOMPUTER_NODE_WORKER=0) and as a kernel guest in a Worker (src/node-worker,
  // the default where the page can): the same programs, plus file I/O and a blocking child process
  const FS_SCRIPT = "const fs = require('fs'); fs.mkdirSync('/tmp/bench-nfs', { recursive: true }); for (let i = 0; i < 200; i++) { const p = '/tmp/bench-nfs/f' + i; fs.writeFileSync(p, 'x'.repeat(100) + i); fs.readFileSync(p, 'utf8'); fs.statSync(p); } const n = fs.readdirSync('/tmp/bench-nfs').length; for (let i = 0; i < 200; i++) fs.unlinkSync('/tmp/bench-nfs/f' + i); console.log('files', n);\n";
  const EXEC_SCRIPT = "const cp = require('child_process'); let out = ''; for (let i = 0; i < 10; i++) out += String(cp.execSync('echo ' + i)); console.log('exec', out.split('\\n').length - 1);\n";
  {
    await h.eval(([a, b]) => Promise.all([window.__bench.writeFile('/tmp/bench-nfs.js', a), window.__bench.writeFile('/tmp/bench-nexec.js', b)]), [FS_SCRIPT, EXEC_SCRIPT]);
    for (const [mode, prefix] of [['', 'TABCOMPUTER_NODE_WORKER=0 '], ['.worker', 'TABCOMPUTER_NODE_WORKER=1 ']]) {
      if (mode) {
        await h.try(`node${mode}.e1`, 'ms', async () => {
          const r = await timed(h, `${prefix}node -e 1`, n);
          h.sample(`node${mode}.e1`, r.ms, 'ms', { notes: `\`node -e 1\` as a kernel guest in a Worker; first run ${Math.round(r.first)} ms` });
        });
        if (!h.quick) await h.try(`node${mode}.require_builtins`, 'ms', async () => {
          const r = await timed(h, `${prefix}node -e "for (const m of ['fs','path','events','util','stream','crypto','http']) require(m); console.log('ok')" > /tmp/node.out`, n, /ok/);
          h.sample(`node${mode}.require_builtins`, r.ms, 'ms', { notes: `require fs/path/events/util/stream/crypto/http, as a guest; first run ${Math.round(r.first)} ms` });
        });
        if (!h.quick) await h.try(`node${mode}.script_file`, 'ms', async () => {
          const r = await timed(h, `${prefix}node /tmp/bench-hello.js > /tmp/node.out`, n, /hello/);
          h.sample(`node${mode}.script_file`, r.ms, 'ms', { notes: `\`node hello.js\` as a guest; first run ${Math.round(r.first)} ms` });
        });
      }
      await h.try(`node${mode}.fs_200`, 'ms', async () => {
        const r = await timed(h, `${prefix}node /tmp/bench-nfs.js > /tmp/node.out`, n, /files 200/);
        h.sample(`node${mode}.fs_200`, r.ms, 'ms', { notes: `write/read/stat 200 files, readdir, unlink them${mode ? ', as a guest' : ''}; first run ${Math.round(r.first)} ms` });
      });
      if (!h.quick) await h.try(`node${mode}.exec_sync_10`, 'ms', async () => {
        const r = await timed(h, `${prefix}node /tmp/bench-nexec.js > /tmp/node.out`, n, /exec 10/);
        h.sample(`node${mode}.exec_sync_10`, r.ms, 'ms', { notes: `10 execSync('echo i') at the top level${mode ? ', really blocking as a guest' : ''}; first run ${Math.round(r.first)} ms` });
      });
    }
  }

  await h.try('npm.install_small', 'ms', async () => {
    const pkgs = 'ms chalk@4 is-number';
    const ms = [];
    let first = null;
    for (let i = 0; i <= (h.quick ? 2 : n); i++) {
      const dir = `/tmp/bench-npm-${Date.now()}-${i}`;
      const r = await h.eval(([c]) => window.__bench.shLimit(c, 180000), [`mkdir -p ${dir} && cd ${dir} && npm init -y > /dev/null && npm install ${pkgs} > /tmp/npm.out 2>&1; echo "exit=$?"; ls node_modules | wc -l`]);
      if (!/exit=0/.test(r.out)) throw new Error(`npm install failed: ${r.out.slice(-200)}`);
      const count = Number(r.out.trim().split('\n').pop());
      if (count < 8) throw new Error(`only ${count} packages in node_modules`);
      if (i === 0) first = r.ms; else ms.push(r.ms);
    }
    h.sample('npm.install_small', ms, 'ms', { notes: `\`npm install ${pkgs}\` (8 packages) in a fresh dir, repeat installs; registry from the bench cache` });
    h.sample('npm.install_small.first', [first], 'ms', { notes: 'the first install of the page (empty npm cache), one sample' });
  });

  await h.try('claude.version', 'ms', async () => {
    // --npm: on the tabcomputer profile plain `claude` is the native build, which the bench doesn't have
    const r = await timed(h, 'claude --npm --version > /tmp/node.out 2>&1', h.quick ? 2 : n, /\d+\.\d+\.\d+/);
    h.sample('claude.version', r.ms, 'ms', { notes: `\`claude --npm --version\` (the npm build: loads its cli.js bundle); first run ${Math.round(r.first)} ms` });
  });

  // What a node costs in memory: renderer RSS (page + every Worker) with 0, 1 and 3 live node
  // processes (each an http server, listening), in the page and as guests, then with the guests
  // gone and their 2 pooled Workers left idle. On a fresh page, so no earlier guest is pooled.
  if (!h.quick) await h.try('node.rss', 'MiB', async () => {
    await h.page?.context().close().catch(() => {});
    await h.boot({});
    await h.eval(() => window.__bench.writeFile('/tmp/bench-live.js', "require('http').createServer((q, s) => s.end('ok')).listen(+process.argv[2]);\n"));
    const rss = async () => { await h.page.waitForTimeout(1500); return (await h.memory({ uasm: false })).rendererRss / MB; };
    // (the page's node holds its stdout until it ends, so the jobs table says they're up)
    let started = 0;
    const live = async (c, k) => {
      await h.eval(async ([c, k, port]) => {
        // (one at a time: two of the page's nodes started together, one may end at once)
        for (let i = 0; i < k; i++) { await window.__bench.sh(`${c}node /tmp/bench-live.js ${port + i} > /dev/null 2>&1 &`); await new Promise((r) => setTimeout(r, 1500)); }
      }, [c, k, 47100 + started]);
      started += k;
      await h.page.waitForTimeout(3000);
      const jobs = (await h.sh('jobs')).out;
      const running = jobs.match(/^\[\d+\] Running/gm)?.length ?? 0;
      // (the page's nodes share its globals: a new one can end one already running)
      if (running !== started && !c.endsWith('=0 ')) throw new Error(`${running} of ${started} live nodes running: ${jobs}`);
      started = running;
      return running;
    };
    const stop = async () => {
      const ids = [...(await h.sh('jobs')).out.matchAll(/^\[(\d+)\] Running/gm)].map((m) => `%${m[1]}`);
      if (ids.length) await h.sh(`kill -9 ${ids.join(' ')}`);
    };
    const out = {};
    const workers = () => h.page.workers().length;
    // Guests first, on the fresh page; each mode against the RSS it started from
    out.base = await rss();
    for (const [mode, prefix] of [['worker', 'TABCOMPUTER_NODE_WORKER=1 '], ['page', 'TABCOMPUTER_NODE_WORKER=0 ']]) {
      const from = mode === 'worker' ? out.base : await rss();
      const w0 = workers();
      out[`${mode}1n`] = await live(prefix, 1); out[`${mode}1`] = (await rss()) - from;
      out[`${mode}3n`] = await live(prefix, 2); out[`${mode}3`] = (await rss()) - from;
      out[`${mode}3w`] = workers() - w0;
      await stop();
      started = 0;
      out[`${mode}0`] = (await rss()) - from;
      if (mode === 'worker') {
        // killed guests' Workers are not pooled; two that end themselves are (host.ts's MAX_IDLE)
        await h.eval(() => Promise.all([0, 1].map(() => window.__bench.sh('node -e "setTimeout(() => {}, 1000)"'))));
        out.idle2 = (await rss()) - from;
        out.idle2w = workers() - w0;
      }
    }
    h.sample('node.rss.base', [out.base], 'MiB', { notes: 'renderer RSS (page + Workers) on a fresh page, no node yet' });
    for (const mode of ['worker', 'page']) {
      const how = mode === 'page' ? 'in the page (TABCOMPUTER_NODE_WORKER=0), after the guest runs' : 'as kernel guests in Workers, from the fresh page';
      h.sample(`node.rss.${mode}1`, [out[`${mode}1`]], 'MiB', { notes: `RSS added by 1 live node (an http server) ${how}` });
      h.sample(`node.rss.${mode}3`, [out[`${mode}3`]], 'MiB', { notes: `after starting 3 (${out[`${mode}3n`]} still running; ${out[`${mode}3w`]} more Workers)` });
      h.sample(`node.rss.${mode}0`, [out[`${mode}0`]], 'MiB', { notes: 'after they are killed' });
    }
    h.sample('node.rss.worker_idle2', [out.idle2], 'MiB', { notes: `then 2 guests that exit on their own: ${out.idle2w} Workers left (pooled idle)` });
  });

  if (!h.quick) await h.try('claude.worker.version', 'ms', async () => {
    const r = await timed(h, 'TABCOMPUTER_NODE_WORKER=1 claude --npm --version > /tmp/node.out 2>&1', n, /\d+\.\d+\.\d+/);
    h.sample('claude.worker.version', r.ms, 'ms', { notes: `\`claude --npm --version\` with node as a kernel guest in a Worker; first run ${Math.round(r.first)} ms` });
  });
}
