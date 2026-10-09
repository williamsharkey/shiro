/**
 * `doctor --agents`: what agent CLIs (Claude Code native and npm, Codex)
 * need from this computer, tried in a scratch directory under
 * /tmp/doctor-UID through both runtimes they use:
 *
 *   native  scripts/agent-probe/agentprobe.c, a static x86-64 binary under
 *           Blink: the syscalls the native Claude binary makes
 *   node    the same steps through the Node runtime (what the npm build uses)
 *
 * The child step runs `sh -c -l 'echo hi'`, the form Claude Code's Bash tool uses.
 *
 * Each step is a line, OK or FAIL with the errno, so a broken layer shows
 * up as the one runtime failing. No network.
 */

import type { CommandContext } from './index';
import type { Check } from './doctor';
import { AGENT_PROBE_BASE64 } from './agent-probe-bin';

export const AGENT_STEPS = ['mkdir', 'atomic-write', 'stat', 'realpath', 'child'] as const;

/** The Node runtime's version of agentprobe.c (same steps, same output lines) */
const NODE_PROBE = String.raw`
const fs = require('fs'), path = require('path'), cp = require('child_process');
const base = process.argv[2];
const deep = path.join(base, 'a/b/c');
const ok = (n, d) => console.log('OK ' + n + ' ' + d);
const fail = (n, e, d) => { console.log('FAIL ' + n + (e && e.code ? ' errno=' + Math.abs(e.errno || 0) + ' ' + e.code : '') + ' ' + d + (e && !e.code ? ': ' + (e.message || e) : '')); return 1; };
function mkdir() {
  try { fs.mkdirSync(deep, { recursive: true, mode: 0o700 }); } catch (e) { fail('mkdir', e, 'mkdirSync recursive'); return 2; }
  let st; try { st = fs.statSync(deep); } catch (e) { fail('mkdir', e, 'statSync'); return 2; }
  const uid = process.getuid ? process.getuid() : -1;
  const d = 'mode ' + (st.mode & 0o7777).toString(8) + ' uid ' + st.uid + ' (getuid ' + uid + ')';
  if (!st.isDirectory() || (st.mode & 0o777) !== 0o700 || st.uid !== uid) return fail('mkdir', null, d);
  ok('mkdir', d); return 0;
}
const tmp = path.join(deep, '.target.tmp'), target = path.join(deep, 'target');
function atomic() {
  let fd; try { fd = fs.openSync(tmp, 'wx', 0o600); } catch (e) { return fail('atomic-write', e, "openSync 'wx'"); }
  try { fs.writeSync(fd, 'data\n'); fs.closeSync(fd); } catch (e) { return fail('atomic-write', e, 'writeSync'); }
  try { fs.closeSync(fs.openSync(tmp, 'wx', 0o600)); return fail('atomic-write', null, "a second 'wx' open succeeded"); }
  catch (e) { if (e.code !== 'EEXIST') return fail('atomic-write', e, "a second 'wx' open (expected EEXIST)"); }
  try { fs.renameSync(tmp, target); } catch (e) { return fail('atomic-write', e, 'renameSync over the target'); }
  if (fs.existsSync(tmp)) return fail('atomic-write', null, 'the temp file still exists after rename');
  let s; try { s = fs.readFileSync(target, 'utf8'); } catch (e) { return fail('atomic-write', e, 'readFileSync the target'); }
  if (s !== 'data\n') return fail('atomic-write', null, "the target's contents");
  ok('atomic-write', "openSync 'wx', EEXIST again, renameSync over the target"); return 0;
}
function stat() {
  try {
    const a = fs.statSync(target), b = fs.lstatSync(target), fd = fs.openSync(target, 'r'), c = fs.fstatSync(fd);
    fs.closeSync(fd);
    const d = 'dev:ino ' + a.dev + ':' + a.ino;
    if (a.dev !== b.dev || a.ino !== b.ino || a.dev !== c.dev || a.ino !== c.ino)
      return fail('stat', null, d + ' lstat ' + b.dev + ':' + b.ino + ' fstat ' + c.dev + ':' + c.ino);
    ok('stat', d + ' (statSync, lstatSync, fstatSync agree)'); return 0;
  } catch (e) { return fail('stat', e, 'stat/lstat/fstat'); }
}
function realpath() {
  try {
    const r = fs.realpathSync(deep), n = fs.realpathSync.native ? fs.realpathSync.native(deep) : r;
    if (r !== deep || n !== deep) return fail('realpath', null, r + (n !== r ? ' (native ' + n + ')' : '') + ' != ' + deep);
    ok('realpath', deep); return 0;
  } catch (e) { return fail('realpath', e, 'realpathSync'); }
}
function child() {
  const outf = path.join(deep, 'child.out');
  return new Promise((resolve) => {
    let fd; try { fd = fs.openSync(outf, 'w'); } catch (e) { resolve(fail('child', e, 'open the output file')); return; }
    let c; try { c = cp.spawn('sh', ['-c', '-l', 'echo hi'], { stdio: ['ignore', fd, 'pipe'] }); } catch (e) { resolve(fail('child', e, 'spawn')); return; }
    const t = setTimeout(() => resolve(fail('child', null, 'sh -c did not exit in 10 s')), 10000);
    c.on('error', (e) => { clearTimeout(t); resolve(fail('child', e, 'spawn')); });
    c.on('close', (code) => {
      clearTimeout(t);
      try { fs.closeSync(fd); } catch {}
      let s = ''; try { s = fs.readFileSync(outf, 'utf8'); } catch (e) { resolve(fail('child', e, 'read the output file')); return; }
      if (code !== 0 || s !== 'hi\n') resolve(fail('child', null, "sh -c -l 'echo hi' exited " + code + ', the file holds ' + JSON.stringify(s)));
      else { ok('child', "spawn sh -c -l 'echo hi' (Claude Code's form) with stdout on a file"); resolve(0); }
    });
  });
}
(async () => {
  const m = mkdir();
  if (m === 2) { process.exitCode = 1; return; } // the rest need the directory (a wrong mode or owner doesn't stop them)
  let bad = m + atomic();
  bad += fs.existsSync(target) ? stat() : 0;
  bad += realpath();
  bad += await child();
  process.exitCode = bad ? 1 : 0;
})();
`;

/** Parse a probe's "OK name detail" / "FAIL name errno=N NAME detail" lines into checks */
export function parseProbe(runtime: string, out: string, code: number): Check[] {
  const checks: Check[] = [];
  const seen = new Set<string>();
  for (const l of out.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^(OK|FAIL) (\S+) ?(.*)$/.exec(l);
    if (!m) continue;
    seen.add(m[2]);
    checks.push({ label: `${runtime} ${m[2]}`, status: m[1] as 'OK' | 'FAIL', detail: m[3] });
  }
  if (!checks.length) {
    const said = out.trim().split('\n').slice(-2).join(' ').slice(0, 200);
    return [{ label: `${runtime} probe`, status: 'FAIL', detail: `exit ${code}${said ? `: ${said}` : ', no output'}` }];
  }
  // Steps the probe skipped because an earlier one failed
  for (const s of AGENT_STEPS) if (!seen.has(s)) checks.push({ label: `${runtime} ${s}`, status: 'WARN', detail: 'not run (an earlier step failed)' });
  const order = (c: Check) => { const i = (AGENT_STEPS as readonly string[]).indexOf(c.label.slice(runtime.length + 1)); return i < 0 ? AGENT_STEPS.length : i; };
  return checks.sort((a, b) => order(a) - order(b));
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function runIn(ctx: CommandContext, line: string, timeoutMs: number): Promise<{ out: string; code: number }> {
  let out = '';
  const sink = (s: string) => { out += s; };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      ctx.shell.execute(line, sink, sink, false, undefined, true),
      new Promise<number>((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs); }),
    ]);
    return { out, code };
  } finally {
    clearTimeout(timer);
  }
}

/** The scratch directory, made fresh: /tmp/doctor-UID */
async function scratch(ctx: CommandContext): Promise<string> {
  const uid = (ctx.shell as { uid?: number }).uid ?? 1000;
  const dir = `/tmp/doctor-${uid}`;
  try { await ctx.fs.rm(dir, { recursive: true, force: true } as any); } catch { /* not there */ }
  await ctx.fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Both probes, native first (they share nothing but the scratch root) */
export async function agentChecks(ctx: CommandContext, opts: { claudeVersion?: boolean } = {}): Promise<Check[]> {
  const dir = await scratch(ctx);
  const checks: Check[] = [];

  // native: the probe binary under Blink
  try {
    const bin = `${dir}/agentprobe`;
    const bytes = Uint8Array.from(atob(AGENT_PROBE_BASE64), (c) => c.charCodeAt(0));
    await ctx.fs.writeFile(bin, bytes, { mode: 0o755 } as any);
    const r = await runIn(ctx, `${quote(bin)} ${quote(`${dir}/native`)}`, 20_000);
    checks.push(...parseProbe('native', r.out, r.code));
  } catch (e: any) {
    checks.push({ label: 'native probe', status: 'FAIL', detail: String(e?.message ?? e) });
  }

  // node: the same steps through the Node runtime
  try {
    const js = `${dir}/agentprobe.js`;
    await ctx.fs.writeFile(js, NODE_PROBE);
    const r = await runIn(ctx, `node ${quote(js)} ${quote(`${dir}/node`)}`, 20_000);
    checks.push(...parseProbe('node', r.out, r.code));
  } catch (e: any) {
    checks.push({ label: 'node probe', status: 'FAIL', detail: String(e?.message ?? e) });
  }

  // the native Claude binary, if installed
  checks.push(await claudeBinaryCheck(ctx, opts.claudeVersion ?? false));
  return checks;
}

async function claudeBinaryCheck(ctx: CommandContext, version: boolean): Promise<Check> {
  const { nativeClaudePath } = await import('./claude');
  const path = nativeClaudePath(ctx.env);
  let size = 0;
  try {
    const st = await ctx.fs.stat(path);
    size = (st as { size?: number }).size ?? 0;
  } catch {
    return { label: 'claude native', status: 'INFO', detail: `not installed (${path}; claude install --native)` };
  }
  const where = `${path}, ${(size / 1e6).toFixed(0)} MB`;
  if (!version) return { label: 'claude native', status: 'OK', detail: `${where} (doctor --agents runs --version)` };
  try {
    const r = await runIn(ctx, `${quote(path)} --version`, 60_000);
    const v = r.out.trim().split('\n').pop() ?? '';
    return r.code === 0 && v
      ? { label: 'claude native', status: 'OK', detail: `${where}: ${v}` }
      : { label: 'claude native', status: 'FAIL', detail: `${where}: --version exited ${r.code}${v ? `: ${v.slice(0, 160)}` : ''}` };
  } catch (e: any) {
    return { label: 'claude native', status: 'FAIL', detail: `${where}: --version: ${e?.message ?? e}` };
  }
}

/** One line for plain `doctor` */
export function agentSummary(checks: Check[]): Check {
  const by = (rt: string) => {
    const mine = checks.filter((c) => c.label.startsWith(`${rt} `) && c.label !== `${rt} probe`);
    const probe = checks.find((c) => c.label === `${rt} probe`);
    if (probe) return { text: `${rt} probe failed`, ok: false };
    const good = mine.filter((c) => c.status === 'OK').length;
    const bad = mine.filter((c) => c.status === 'FAIL').map((c) => c.label.slice(rt.length + 1));
    return { text: `${rt} ${good}/${AGENT_STEPS.length}${bad.length ? ` (${bad.join(', ')} failed)` : ''}`, ok: good === AGENT_STEPS.length };
  };
  const n = by('native');
  const j = by('node');
  return {
    label: 'agents',
    status: n.ok && j.ok ? 'OK' : 'FAIL',
    detail: `${n.text} · ${j.text}${n.ok && j.ok ? '' : ' (doctor --agents for details)'}`,
  };
}
