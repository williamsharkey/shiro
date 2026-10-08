// Node/npm: the node-compat runtime and npm against the registry (served
// from bench/.cache/net, so this measures Shiro, not the network), and
// Claude Code's CLI startup (installed by the background install at boot).
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
  if (!h.quick) await h.try('node.require_builtins', 'ms', async () => {
    const r = await timed(h, `node -e "for (const m of ['fs','path','events','util','stream','crypto','http']) require(m); console.log('ok')" > /tmp/node.out`, n, /ok/);
    h.sample('node.require_builtins', r.ms, 'ms', { notes: `require fs/path/events/util/stream/crypto/http; first run ${Math.round(r.first)} ms` });
  });
  if (!h.quick) await h.try('node.script_file', 'ms', async () => {
    await h.eval(() => window.__bench.writeFile('/tmp/bench-hello.js', "const os = require('os'); console.log('hello', os.platform(), [1,2,3].map(x => x * 2).join(','));\n"));
    const r = await timed(h, 'node /tmp/bench-hello.js > /tmp/node.out', n, /hello/);
    h.sample('node.script_file', r.ms, 'ms', { notes: `\`node hello.js\` (requires os); first run ${Math.round(r.first)} ms` });
  });

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
    const r = await timed(h, 'claude --version > /tmp/node.out 2>&1', h.quick ? 2 : n, /\d+\.\d+\.\d+/);
    h.sample('claude.version', r.ms, 'ms', { notes: `\`claude --version\` (loads the 2.1.112 cli.js bundle); first run ${Math.round(r.first)} ms` });
  });
}
