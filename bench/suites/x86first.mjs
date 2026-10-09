// x86 first runs (optional suite): Blink's JIT compiles each program's hot
// code into wasm modules that V8 first runs unoptimized and caches by their
// bytes, so the first run of a program after a page load is slower than the
// next. Times the first and second run of gh --version and Vim on a first
// visit, then again after reloading the page in the same browser context
// (its HTTP cache kept: a second visit).
export const name = 'x86first';

async function once(h, cmd) {
  const line = `cd /home/user/x && ${cmd} < /dev/null > /tmp/x86.out 2>&1; echo "exit=$?"`;
  const r = await h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [line, 180_000]);
  const code = r.code === 124 ? 124 : Number(/exit=(\d+)/.exec(r.out)?.[1] ?? -1);
  if (code !== 0) throw new Error(`${cmd}: exit ${code}`);
  return r.ms;
}

async function setup(h, programs) {
  await h.eval(async (names) => {
    for (const n of names) await window.__bench.fetchInto('/__bench/' + n, '/home/user/x/' + n);
  }, programs.filter((p) => p.fixture).map((p) => p.fixture));
  if (programs.some((p) => p.vim)) {
    const inst = await h.sh('pkg install vim 2>&1');
    if (inst.code !== 0) throw new Error('pkg install vim failed');
    await h.sh('echo "int main(void) { return 0; }" > /home/user/x/x.c');
  }
}

export async function run(h) {
  if (!h.isolated) return;
  const programs = [
    { key: 'gh', fixture: h.fixtures.gh ? 'gh' : null, cmd: './gh --version' },
    { key: 'vim', vim: true, cmd: 'vim --not-a-term -c qa x.c' },
  ].filter((p) => (p.fixture || p.vim) && h.wants(`x86first.${p.key}`));
  if (!programs.length) return;
  const context = h.page.context();
  const times = {};
  for (const visit of [1, 2]) {
    if (visit === 2) await h.boot({ context, page: h.page, waitSettled: true });
    await setup(h, programs);
    for (const p of programs) {
      const first = await once(h, p.cmd);
      const second = await once(h, p.cmd);
      times[`${p.key}.visit${visit}`] = [first, second];
    }
  }
  for (const [k, [first, second]] of Object.entries(times)) {
    h.sample(`x86first.${k}.first`, [first], 'ms', { notes: 'first run after the page loaded' });
    h.sample(`x86first.${k}.second`, [second], 'ms', { notes: 'the run right after it' });
  }
}
