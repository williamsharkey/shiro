// x86-64 ELF: Blink (wasm, Worker kernel process) when isolated, src/x86
// (TS interpreter) otherwise or with SHIRO_X86_ENGINE=x86. Time and renderer
// RSS peak per program, run at the prompt via the shell (`./prog > file`).
import { MB } from '../lib/harness.mjs';

export const name = 'x86';

const PROGRAMS = [
  // [metric, fixture, args, expected output regexp]
  ['hello_musl', 'hello-musl', '', /hello/i],
  ['hello_glibc', 'hello-glibc', '', /hello/i],
  ['go_hello', 'hello-go', 'a b', /hello/i],
  ['go_cpuloop_5m', 'cpuloop', '5000000', /loop 5000000/],
  ['go_nethttp', 'nethttp', '', /pong/],
  ['gh_version', 'gh', '--version', /gh version/],
];

async function runOnce(h, cmd, limit = 60) {
  const line = `cd /home/user/x && ${cmd} < /dev/null > /tmp/x86.out 2>&1; echo "exit=$?"`;
  const r = await h.withPeakRss(() => h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [line, limit * 1000]));
  const out = await h.sh('cat /tmp/x86.out');
  const code = r.result.code === 124 ? 124 : Number(/exit=(\d+)/.exec(r.result.out)?.[1] ?? -1);
  return { ms: r.result.ms, peak: r.peakDelta / MB, out: out.out, code };
}

export async function run(h) {
  const engines = h.isolated ? (h.quick ? [['blink', '']] : [['blink', ''], ['x86', 'SHIRO_X86_ENGINE=x86 ']]) : [['x86', '']];
  const available = PROGRAMS.filter(([, f]) => h.fixtures[f]);
  await h.eval(async (names) => {
    for (const n of names) await window.__bench.fetchInto('/__bench/' + n, '/home/user/x/' + n);
  }, available.map(([, f]) => f));
  for (const [engine, prefix] of engines) {
    for (const [metric, fixture, args, expect] of PROGRAMS) {
      const nm = `x86.${engine}.${metric}`;
      if (!h.wants(nm)) continue;
      if (h.quick && !['hello_musl', 'go_hello', 'go_nethttp'].includes(metric)) continue;
      if (!h.fixtures[fixture]) { h.skip(nm, 'ms', `fixture ${fixture} unavailable (go/gcc missing, or skipped in --quick)`); continue; }
      // The interpreter can't run Go or glibc (see docs/X86_ENGINES.md); try once and record why
      const heavy = metric === 'gh_version';
      if (engine === 'x86' && heavy) { h.skip(nm, 'ms', 'not attempted on src/x86 (Go)'); continue; }
      await h.try(nm, 'ms', async () => {
        const cmd = `${prefix}./${fixture} ${args}`.trim();
        const limit = heavy ? 120 : 60;
        const first = await runOnce(h, cmd, limit);
        if (first.code !== 0 || !expect.test(first.out)) throw new Error(`${first.code === 124 ? `timed out after ${limit} s` : `exit ${first.code}`}: ${(first.out.match(/^.*(fatal error|Unknown|panic|error).*$/m)?.[0] ?? first.out.trim().split('\n').slice(-1)[0] ?? '').trim().slice(0, 160)}`);
        const runs = heavy ? Math.min(h.runs, 5) : h.runs;
        const res = [];
        for (let i = 0; i < runs; i++) {
          const r = await runOnce(h, cmd, limit);
          if (r.code !== 0) throw new Error(`exit ${r.code} on run ${i + 2}`);
          res.push(r);
        }
        const inproc = /(\d+)ms/.exec(first.out);
        h.sample(nm, res.map((r) => r.ms), 'ms', { notes: `\`${cmd}\` wall time at the prompt; first run ${Math.round(first.ms)} ms${metric.startsWith('go_cpuloop') && inproc ? `; in-guest loop ${inproc[1]} ms` : ''}` });
        h.sample(`x86.${engine}.peak_rss.${metric}`, res.map((r) => r.peak), 'MiB', { notes: 'renderer RSS peak above the pre-run level' });
      });
    }
  }
  // Vim 9.2 (static, from public/pkg) opening a C file: mostly its startup
  // scripts (defaults.vim: filetype.vim, syntax) run by Vim's interpreter
  const vim = 'x86.blink.vim_startup';
  if (h.isolated && h.wants(vim) && !h.quick) {
    await h.try(vim, 'ms', async () => {
      const inst = await h.sh('pkg install vim 2>&1');
      if (inst.code !== 0) throw new Error(`pkg install vim: ${inst.out.trim().split('\n').pop()}`);
      await h.sh('echo "int main(void) { return 0; }" > /home/user/x/x.c');
      const cmd = 'vim --not-a-term -c qa x.c';
      const first = await runOnce(h, cmd);
      if (first.code !== 0) throw new Error(`exit ${first.code}: ${first.out.trim().slice(-160)}`);
      const res = [];
      for (let i = 0; i < h.runs; i++) {
        const r = await runOnce(h, cmd);
        if (r.code !== 0) throw new Error(`exit ${r.code} on run ${i + 2}`);
        res.push(r);
      }
      h.sample(vim, res.map((r) => r.ms), 'ms', { notes: `\`${cmd}\` wall time at the prompt (Blink); first run ${Math.round(first.ms)} ms` });
    });
  }
}
