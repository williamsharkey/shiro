/**
 * Utilities conformance: busybox's testsuite (fetched by
 * scripts/conformance/fetch.sh, not vendored) run inside Shiro.
 *
 * - `NAME.tests` scripts run under Shiro's shell as in upstream; `testing`
 *   is a harness builtin (feeds the case's input file and stdin, runs the
 *   command with `eval` semantics, compares stdout). Every optional feature
 *   is on.
 * - Old-style `APPLET/CASE` scripts run as `sh -e CASE` in an empty
 *   directory; exit status 0 is a pass. `busybox APPLET ARGS` runs APPLET.
 *
 * Only cases that pass with the host's GNU tools (busybox/gnu-baseline.json)
 * are scored. Results: results/utils-busybox.json.
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Shell, quoteArgsForShell } from '@shiro/shell';
import { createTestShell } from '../tests/shiro-vitest/helpers';

const CONF = resolve(__dirname, 'busybox');
const SUITE = resolve(__dirname, '.cache/busybox/testsuite');
const RESULTS = resolve(__dirname, 'results');
const CASE_TIMEOUT = 15_000;
const selection: { scripts: string[]; applets: string[] } = JSON.parse(readFileSync(join(CONF, 'selection.json'), 'utf8'));
const baseline: { scripts: Record<string, string[]>; applets: Record<string, string[]> } = JSON.parse(readFileSync(join(CONF, 'gnu-baseline.json'), 'utf8'));
// Cases that hang Shiro (scored as failures, not run)
const HANGS: string[] = JSON.parse(readFileSync(join(CONF, 'hangs.json'), 'utf8'));
const only = process.env.BB_ONLY ? process.env.BB_ONLY.split(',') : null;
// BB_PROGRESS=file logs each case before it runs, to find hangs
const progress = (s: string) => { if (process.env.BB_PROGRESS) appendFileSync(process.env.BB_PROGRESS, s + '\n'); };

type Failure = { name: string; reason?: string; got?: string; want?: string; timeout?: boolean };
type AreaResult = { pass: number; total: number; failures: Failure[] };

/** bash `echo -ne` escape processing */
function echoNe(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) { out += c; continue; }
    const n = s[++i];
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\' };
    if (simple[n] !== undefined) { out += simple[n]; continue; }
    if (n === 'c') break;
    if (n === '0') {
      const m = /^[0-7]{0,3}/.exec(s.slice(i + 1))![0];
      out += String.fromCharCode(parseInt(m || '0', 8));
      i += m.length;
      continue;
    }
    if (n === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
      if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; continue; }
    }
    out += '\\' + n;
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let t: any;
  return Promise.race([p, new Promise<T>((res) => { t = setTimeout(() => res(onTimeout()), ms); })]).finally(() => clearTimeout(t));
}

async function copyTree(fs: any, from: string, to: string) {
  await fs.mkdir(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const p = join(from, name);
    if (statSync(p).isDirectory()) await copyTree(fs, p, `${to}/${name}`);
    else await fs.writeFile(`${to}/${name}`, new Uint8Array(readFileSync(p)), { mode: 0o755 });
  }
}

async function setup() {
  const { fs, shell: base } = await createTestShell();
  await copyTree(fs, SUITE, '/bb/testsuite');
  // Shiro's own `testing` is the builtin below; keep the script from redefining it
  await fs.writeFile('/bb/testsuite/testing.sh', 'ECHO=${ECHO:-echo}\noptional() { :; }\n');
  base.commands.register({
    name: 'busybox', description: 'run an applet (harness)',
    async exec(ctx: any) {
      if (!ctx.args.length) return 0;
      let out = '';
      let err = '';
      const code = await ctx.shell.executeWithStdin(quoteArgsForShell(ctx.args), ctx.stdin || '', (s: string) => { out += s; }, (s: string) => { err += s; });
      ctx.stdout += out.replace(/\r\n/g, '\n');
      ctx.stderr += err.replace(/\r\n/g, '\n');
      return code;
    },
  } as any);
  return { fs, base };
}

/** Run the `.tests` scripts, collecting each `testing` case */
async function runScripts(): Promise<Record<string, AreaResult>> {
  const { fs, base } = await setup();
  const out: Record<string, AreaResult> = {};
  let current: { file: string; seen: Map<string, number> } | null = null;
  const record = (name: string, ok: boolean, f: Omit<Failure, 'name'> = {}) => {
    const area = out[current!.file];
    const want = baseline.scripts[current!.file] || [];
    const n = (current!.seen.get(name) || 0) + 1;
    current!.seen.set(name, n);
    // Scored only if GNU passed it (as many times as the name occurs there)
    if (want.filter((w) => w === name).length < n) return;
    area.total++;
    if (ok) area.pass++;
    else area.failures.push({ name, ...f });
  };
  base.commands.register({
    name: 'testing', description: 'busybox testsuite case (harness)',
    async exec(ctx: any) {
      const [n, cmd, expect, input, stdin] = ctx.args;
      const name = n || cmd;
      progress(`  case ${name} ${process.env.BB_ARGS ? JSON.stringify(ctx.args) : ""}`);
      // Upstream refuses any other arity; here it means the shell mis-parsed the call
      if (ctx.args.length !== 5) {
        record(name, false, { reason: `testing got ${ctx.args.length} arguments (shell parse error)` });
        return 0;
      }
      if (HANGS.includes(name)) {
        record(name, false, { timeout: true, reason: 'skipped: hangs Shiro' });
        return 0;
      }
      await ctx.fs.writeFile(ctx.fs.resolvePath('input', ctx.cwd), echoNe(input ?? ''));
      let got = '';
      let err = '';
      let timedOut = false;
      const status = await withTimeout(
        ctx.shell.executeWithStdin(`eval ${quoteArgsForShell([cmd])}`, echoNe(stdin ?? ''), (s: string) => { got += s; }, (s: string) => { err += s; }),
        CASE_TIMEOUT, () => { timedOut = true; return -2; });
      got = got.replace(/\r\n/g, '\n');
      const want = echoNe(expect ?? '');
      const ok = !timedOut && got === want;
      record(name, ok, ok ? {} : { got: got.slice(0, 300), want: want.slice(0, 300), ...(timedOut ? { timeout: true } : {}), ...(err ? { reason: err.replace(/\r\n/g, '\n').slice(0, 200) } : {}) });
      ctx.stdout += `${ok ? 'PASS' : 'FAIL'}: ${name}\n`;
      void status;
      return 0;
    },
  } as any);
  for (const file of selection.scripts) {
    if (only && !only.includes(file)) continue;
    out[file] = { pass: 0, total: 0, failures: [] };
    progress(`script ${file}`);
    current = { file, seen: new Map() };
    const shell = new Shell(fs, base.commands);
    shell.cwd = '/bb/testsuite';
    Object.assign(shell.env, { PWD: '/bb/testsuite', ECHO: 'echo', TZ: 'UTC' });
    let err = '';
    await withTimeout(shell.execute(`sh ${file}.tests`, () => {}, (s) => { err += s; }, false, undefined, true).catch((e) => { err += String(e); return -1; }),
      300_000, () => -2);
    // Cases the script never reached count as failures
    const want = baseline.scripts[file] || [];
    const reached = new Map(current.seen);
    for (const name of want) {
      const left = reached.get(name) || 0;
      if (left > 0) { reached.set(name, left - 1); continue; }
      out[file].total++;
      out[file].failures.push({ name, reason: `not reached ${err.replace(/\r\n/g, ' ').slice(0, 120)}` });
    }
  }
  return out;
}

/** Run the old-style APPLET/CASE scripts */
async function runApplets(): Promise<Record<string, AreaResult>> {
  const { fs, base } = await setup();
  const out: Record<string, AreaResult> = {};
  for (const applet of selection.applets) {
    if (only && !only.includes(applet)) continue;
    const want = new Set(baseline.applets[applet] || []);
    out[`${applet} (old-style)`] = { pass: 0, total: 0, failures: [] };
    const area = out[`${applet} (old-style)`];
    for (const t of [...want].sort()) {
      const dir = `/bb/run/${applet}-${t}`;
      progress(`applet ${applet}/${t}`);
      await fs.mkdir(dir, { recursive: true });
      const shell = new Shell(fs, base.commands);
      shell.cwd = dir;
      Object.assign(shell.env, { PWD: dir, ECHO: 'echo', d: '/bb/testsuite', TZ: 'UTC' });
      let text = '';
      let timedOut = false;
      const code = await withTimeout(
        shell.execute(`sh -e /bb/testsuite/${applet}/${t}`, (s) => { text += s; }, (s) => { text += s; }, false, undefined, true).catch(() => -1),
        CASE_TIMEOUT, () => { timedOut = true; return -2; });
      area.total++;
      if (code === 0) area.pass++;
      else area.failures.push({ name: t, ...(timedOut ? { timeout: true } : { reason: `exit ${code}: ${text.replace(/\r\n/g, ' ').slice(0, 160)}` }) });
    }
  }
  return out;
}

describe.skipIf(!existsSync(SUITE))('busybox testsuite (utilities)', () => {
  const files: Record<string, AreaResult> = {};
  it('NAME.tests scripts', async () => { Object.assign(files, await runScripts()); }, 1_800_000);
  it('old-style APPLET/CASE scripts', async () => { Object.assign(files, await runApplets()); }, 1_800_000);
  it('writes results', () => {
    mkdirSync(RESULTS, { recursive: true });
    const name = only ? 'utils-busybox.partial.json' : 'utils-busybox.json';
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
    // Outputs of failing cases go to results/detail (not committed); the summary keeps names
    mkdirSync(join(RESULTS, 'detail'), { recursive: true });
    writeFileSync(join(RESULTS, 'detail', name), JSON.stringify(sorted, null, 1));
    const summary = Object.fromEntries(Object.entries(sorted).map(([k, v]) => [k, {
      ...v, failures: v.failures.map((f) => ({ name: f.name, ...(f.timeout ? { timeout: true } : {}) })),
    }]));
    writeFileSync(join(RESULTS, name), JSON.stringify({
      suite: 'busybox testsuite',
      title: 'Utilities: busybox testsuite',
      note: 'busybox `testsuite/` (pinned, fetched by scripts/conformance/fetch.sh) run in Shiro; only cases the host GNU tools pass are scored.',
      files: summary,
    }, null, 1) + '\n');
  });
});
