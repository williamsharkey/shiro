/**
 * doctor (alias tabinfo) — one report to paste into a bug report: the
 * deploy, the browser, the x86 engine, the internet relay, sign-ins,
 * Debian, storage, upgradable packages and the kernel, each line OK, WARN
 * or FAIL. Never prints
 * a token or other secret.
 */

import type { Command, CommandContext } from './index';
import buildNumber from '../../build-number.txt?raw';

export type Status = 'OK' | 'WARN' | 'FAIL' | 'INFO';
export interface Check { label: string; status: Status; detail: string }

const g = globalThis as any;
const ms = (t0: number) => `${Math.round(performance.now() - t0)} ms`;
const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e8 ? 1 : 0)} MB`;

/** `fn`, or a FAIL/WARN line when it throws or takes longer than `timeoutMs` */
async function guard(label: string, fn: () => Promise<Check | Check[]>, timeoutMs = 8000): Promise<Check[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs); }),
    ]);
    return Array.isArray(r) ? r : [r];
  } catch (e: any) {
    return [{ label, status: 'FAIL', detail: String(e?.message ?? e) }];
  } finally {
    clearTimeout(timer);
  }
}

async function buildCheck(): Promise<Check> {
  const host = g.location?.host ?? '(no page)';
  let ui = 'terminal';
  try { ui = (await import('../ui-mode')).uiMode(); } catch { /* not a page */ }
  let deploy = '';
  let status: Status = 'OK';
  try {
    const r = await fetch('/deployed.txt', { cache: 'no-store' });
    const text = r.ok ? (await r.text()).trim() : '';
    // (a dev server answers unknown paths with the app's index.html)
    const page = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : '';
    if (/^[0-9a-f]{7,40}$/.test(text)) {
      deploy = ` · deploy ${text.slice(0, 12)}`;
      // This tab was loaded before the server's latest deploy: reload to get it
      if (page && page !== text) { deploy = ` · this tab ${page.slice(0, 12)}, server ${text.slice(0, 12)} (reload to update)`; status = 'WARN'; }
    }
    else { deploy = ' · no /deployed.txt (dev server?)'; status = 'WARN'; }
  } catch {
    deploy = ' · /deployed.txt unreachable';
    status = 'WARN';
  }
  return { label: 'build', status, detail: `#${buildNumber.trim()}${deploy} · ${host} · ${ui} UI` };
}

function browserChecks(): Check[] {
  const coi = g.crossOriginIsolated;
  const ua = g.navigator?.userAgent ?? 'unknown';
  return [
    coi === undefined
      ? { label: 'isolation', status: 'INFO', detail: 'not a browser page' }
      : coi
        ? { label: 'isolation', status: 'OK', detail: 'crossOriginIsolated (SharedArrayBuffer, threads, x86 programs)' }
        : { label: 'isolation', status: 'FAIL', detail: 'not crossOriginIsolated: x86 (Blink) programs and threads cannot run; check COOP/COEP headers' },
    { label: 'browser', status: 'INFO', detail: ua },
  ];
}

async function engineCheck(ctx: CommandContext): Promise<Check> {
  const blink = await import('../x86-engine/blink');
  const fork = ctx.env.BLINK_SAME_INSTANCE_FORK;
  const forkMode = fork === undefined ? 'on (default)' : fork === '0' ? 'off (BLINK_SAME_INSTANCE_FORK=0)' : `on (BLINK_SAME_INSTANCE_FORK=${fork})`;
  if (!blink.blinkSupported()) return { label: 'x86 engine', status: 'FAIL', detail: `Blink can't run here (needs SharedArrayBuffer); same-instance fork ${forkMode}` };
  let build = '';
  try {
    const r = await fetch(blink.blinkAssetUrl('blink.wasm'), { cache: 'force-cache' });
    if (r.ok) {
      const bytes = new Uint8Array(await r.arrayBuffer());
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      build = ` · blink.wasm ${mb(bytes.length)} sha256 ${[...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    } else build = ` · blink.wasm: HTTP ${r.status}`;
  } catch (e: any) {
    build = ` · blink.wasm unreadable (${e?.message ?? e})`;
  }
  return { label: 'x86 engine', status: build.includes('sha256') ? 'OK' : 'WARN', detail: `Blink${build} · same-instance fork ${forkMode}` };
}

async function relayChecks(ctx: CommandContext): Promise<Check[]> {
  const signin = await import('../net-signin');
  const out: Check[] = [];
  const own = signin.ownRelay();
  const cred = signin.networkCredential();
  // 1. the token the kernel's sockets need
  const t0 = performance.now();
  try {
    const url = own ? own.tokenUrl : '/tcp/token';
    if (!url) out.push({ label: 'relay token', status: 'OK', detail: `own relay ${own!.url} (no token URL)` });
    else {
      const r = await fetch(url, { method: 'POST', credentials: own ? 'omit' : 'same-origin', ...(cred && !own ? { headers: { Authorization: `Bearer ${cred}` } } : {}) });
      const why = r.status === 401 ? ' (sign in to use the internet: Network in the menu bar)' : r.status === 404 ? ' (this server has no internet relay)' : '';
      out.push({ label: 'relay token', status: r.ok ? 'OK' : r.status === 401 ? 'WARN' : 'FAIL', detail: `${own ? `own relay ${own.url}: ` : ''}POST ${url} → ${r.status}${why}, ${ms(t0)}` });
    }
  } catch (e: any) {
    out.push({ label: 'relay token', status: 'FAIL', detail: `request failed: ${e?.message ?? e}` });
  }
  // 2. a TCP connection through the kernel's network stack, as programs make them
  out.push(...await guard('tcp connect', async () => {
    const { kernelForContext } = await import('../wasi/run-command');
    const net = await import('../kernel/net');
    const abi = await import('../kernel/abi');
    const stack = net.netStackOf(kernelForContext(ctx)) ?? net.netStack;
    const s = stack.socket(abi.AF_INET, abi.SOCK_STREAM);
    if (typeof s === 'number') return { label: 'tcp connect', status: 'FAIL', detail: `socket() → ${net.errnoName(-s)}` };
    const t1 = performance.now();
    try {
      const r = await (s as InstanceType<typeof net.KSocket>).connectHost('example.com', 443);
      return r < 0
        ? { label: 'tcp connect', status: 'FAIL', detail: `example.com:443 → ${net.errnoName(-r)} after ${ms(t1)}` }
        : { label: 'tcp connect', status: 'OK', detail: `example.com:443 connected in ${ms(t1)}` };
    } finally {
      void s.close();
    }
  }, 10_000));
  return out;
}

async function githubLogin(token: string): Promise<{ login?: string; status: number }> {
  const { ghApi } = await import('./gh');
  const r = await ghApi(token, 'GET', '/user');
  return { login: r.status === 200 ? r.data?.login : undefined, status: r.status };
}

async function signInChecks(ctx: CommandContext): Promise<Check[]> {
  const out: Check[] = [];
  const signin = await import('../net-signin');
  const netTok = signin.networkCredential();
  const { getToken } = await import('./gh');
  const ghTok = getToken(ctx);
  // One /user lookup per distinct token
  const logins = new Map<string, Promise<{ login?: string; status: number }>>();
  const who = (t: string) => { if (!logins.has(t)) logins.set(t, githubLogin(t)); return logins.get(t)!; };
  if (!netTok) out.push({ label: 'network', status: 'INFO', detail: 'not signed in (the internet relay may ask)' });
  else {
    const r = await who(netTok).catch(() => ({ status: 0 } as { login?: string; status: number }));
    out.push(r.login
      ? { label: 'network', status: 'OK', detail: `signed in as ${r.login}` }
      : { label: 'network', status: 'WARN', detail: `a saved sign-in that GitHub doesn't accept (HTTP ${r.status || 'error'}): sign in again` });
  }
  if (!ghTok) out.push({ label: 'github', status: 'INFO', detail: 'gh: not logged in (gh auth login)' });
  else {
    const r = await who(ghTok).catch(() => ({ status: 0 } as { login?: string; status: number }));
    out.push(r.login
      ? { label: 'github', status: 'OK', detail: `gh: logged in to github.com as ${r.login}` }
      : { label: 'github', status: 'FAIL', detail: `gh: token rejected (HTTP ${r.status || 'error'}): gh auth login` });
  }
  const { hasClaudeCredentials } = await import('../claude-signin');
  out.push(await hasClaudeCredentials(ctx.fs)
    ? { label: 'claude', status: 'OK', detail: 'signed in' }
    : { label: 'claude', status: 'INFO', detail: 'not signed in (claude login)' });
  return out;
}

async function debianCheck(ctx: CommandContext): Promise<Check> {
  const { ROOTFS_STATE } = await import('../debian/rootfs');
  try {
    const raw = await ctx.fs.readFile(ROOTFS_STATE);
    const st = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    return { label: 'debian', status: 'OK', detail: `Debian ${st.version} (${st.suite}, snapshot ${st.snapshot}), installed ${new Date(st.installedAt).toISOString().slice(0, 10)}` };
  } catch {
    return { label: 'debian', status: 'INFO', detail: 'not installed (debian install)' };
  }
}

async function storageCheck(): Promise<Check> {
  const st = g.navigator?.storage;
  if (!st?.estimate) return { label: 'storage', status: 'INFO', detail: 'StorageManager unavailable' };
  const [est, persisted] = await Promise.all([st.estimate(), st.persisted?.().catch(() => false) ?? false]);
  const used = est.usage ?? 0;
  const quota = est.quota ?? 0;
  const frac = quota ? used / quota : 0;
  return {
    label: 'storage',
    status: frac > 0.9 ? 'FAIL' : frac > 0.75 || !persisted ? 'WARN' : 'OK',
    detail: `${mb(used)} of ${mb(quota)} (${(frac * 100).toFixed(1)}%) · ${persisted ? 'persisted' : 'not persisted: the browser may evict it under storage pressure'}`,
  };
}

/** Installed packages with a newer version (`pkg outdated`) */
async function packagesCheck(ctx: CommandContext): Promise<Check> {
  const { runIn } = await import('./doctor-agents');
  const r = await runIn(ctx, 'pkg outdated', 20_000);
  const out = r.out.replace(/\r/g, '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (r.code !== 0 && /unknown|usage|not a command|invalid/i.test(out)) {
    return { label: 'packages', status: 'INFO', detail: '`pkg outdated` is not in this build' };
  }
  if (r.code !== 0) return { label: 'packages', status: 'WARN', detail: `pkg outdated exited ${r.code}${out ? `: ${out.split('\n').pop()!.slice(0, 160)}` : ''}` };
  // One package per line; headers and "up to date" notes are not packages
  const rows = out.split('\n').map((l) => l.trim()).filter((l) => l && !/^(listing|package|name)\b|up[ -]to[ -]date|^[-=\s]+$/i.test(l));
  if (!rows.length) return { label: 'packages', status: 'OK', detail: 'every installed package is up to date' };
  const names = rows.map((l) => l.split(/\s+/)[0]);
  return {
    label: 'packages',
    status: 'INFO',
    detail: `${rows.length} can be upgraded: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''} (pkg outdated; pkg upgrade)`,
  };
}

async function kernelCheck(ctx: CommandContext): Promise<Check> {
  const { kernelForContext } = await import('../wasi/run-command');
  const k = kernelForContext(ctx);
  const procs = [...k.procs.values()].filter((p) => p.alive).length;
  const mem = g.performance?.memory;
  const heap = mem ? ` · JS heap ${mb(mem.usedJSHeapSize)} of ${mb(mem.jsHeapSizeLimit)}` : '';
  const high = mem && mem.usedJSHeapSize / mem.jsHeapSizeLimit > 0.8;
  return { label: 'kernel', status: high ? 'WARN' : 'OK', detail: `${procs} process${procs === 1 ? "" : "es"}${heap}` };
}

/** Every check, in report order (each one guarded: a failure is a line, never a crash) */
export async function runDoctorChecks(ctx: CommandContext): Promise<Check[]> {
  const parts = await Promise.all([
    guard('build', buildCheck),
    Promise.resolve(browserChecks()),
    guard('x86 engine', () => engineCheck(ctx)),
    guard('relay', () => relayChecks(ctx), 15_000),
    guard('sign-in', () => signInChecks(ctx)),
    guard('debian', () => debianCheck(ctx)),
    guard('storage', storageCheck),
    guard('packages', () => packagesCheck(ctx), 25_000),
    guard('kernel', () => kernelCheck(ctx)),
    guard('agents', async () => {
      const { agentChecks, agentSummary } = await import('./doctor-agents');
      return agentSummary(await agentChecks(ctx));
    }, 45_000),
  ]);
  return parts.flat();
}

export function formatChecks(checks: Check[]): string {
  const w = Math.max(...checks.map((c) => c.label.length));
  return checks.map((c) => `${c.status.padEnd(4)}  ${c.label.padEnd(w)}  ${c.detail}`).join('\n') + '\n';
}

export const doctorCmd: Command = {
  name: 'doctor',
  description: 'Check this tab (deploy, browser, engine, network, sign-ins, storage) for a bug report',
  async exec(ctx) {
    if (ctx.args[0] === '--help' || ctx.args[0] === '-h') {
      ctx.stdout = 'Usage: doctor [--agents]\n\nPrints the deploy, browser, x86 engine, internet relay, sign-ins, Debian,\nstorage, upgradable packages, kernel and agent-readiness state, one OK/WARN/FAIL line each, to\npaste into a bug report. No tokens or secrets are printed. Also: tabinfo\n\n--agents: what agent CLIs (Claude Code, Codex) need, step by step, through\nboth runtimes: a native x86-64 probe under Blink and the Node runtime\n(mkdir -p 0700, O_EXCL + rename, stat/lstat/fstat, realpath, a child\nsh -c with output to a file), `node -v` and `node -e` on their own, and the\nnative claude binary\'s --version. A failing node probe runs again with\nstdin on /dev/null, which tells a terminal (stdin) problem from the rest.\n';
      return 0;
    }
    if (ctx.args.includes('--agents')) {
      const { agentChecks } = await import('./doctor-agents');
      const checks = await guard('agents', () => agentChecks(ctx, { claudeVersion: true }), 120_000);
      ctx.stdout = formatChecks(checks);
      return checks.some((c) => c.status === 'FAIL') ? 1 : 0;
    }
    const checks = await runDoctorChecks(ctx);
    ctx.stdout = formatChecks(checks);
    return checks.some((c) => c.status === 'FAIL') ? 1 : 0;
  },
};

export const tabinfoCmd: Command = { ...doctorCmd, name: 'tabinfo', description: 'Same as doctor' };
