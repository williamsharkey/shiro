/**
 * Base commands scripts expect on a Linux box (williamsharkey/tabcomputer#9):
 * envsubst, groups, locale, getent, nslookup, dig, flock, and ping/strace
 * that say what the browser can and can't do.
 */

import type { Command, CommandContext } from './index';

// ── /etc/passwd and /etc/group ──────────────────────────────────────────

interface PwEntry { name: string; uid: number; gid: number; gecos: string; home: string; shell: string; line: string }
interface GrEntry { name: string; gid: number; members: string[]; line: string }

async function readLines(ctx: CommandContext, path: string): Promise<string[]> {
  try {
    const t = await ctx.fs.readFile(path, 'utf8');
    return String(t).split('\n').filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

export async function passwdEntries(ctx: CommandContext): Promise<PwEntry[]> {
  return (await readLines(ctx, '/etc/passwd')).map((line) => {
    const [name, , uid, gid, gecos, home, shell] = line.split(':');
    return { name, uid: Number(uid), gid: Number(gid), gecos: gecos ?? '', home: home ?? '', shell: shell ?? '', line };
  });
}

export async function groupEntries(ctx: CommandContext): Promise<GrEntry[]> {
  return (await readLines(ctx, '/etc/group')).map((line) => {
    const [name, , gid, members] = line.split(':');
    return { name, gid: Number(gid), members: members ? members.split(',').filter(Boolean) : [], line };
  });
}

/** The current user's name (root under sudo) */
function currentUser(ctx: CommandContext): string {
  return ctx.shell?.uid === 0 ? 'root' : ctx.env.USER || 'user';
}

/** A user's groups: the primary one first, then those listing the user as a member */
export async function userGroups(ctx: CommandContext, user: string): Promise<GrEntry[] | null> {
  const pw = (await passwdEntries(ctx)).find((p) => p.name === user);
  if (!pw) return null;
  const groups = await groupEntries(ctx);
  const primary = groups.find((g) => g.gid === pw.gid) ?? { name: String(pw.gid), gid: pw.gid, members: [], line: '' };
  return [primary, ...groups.filter((g) => g !== primary && g.members.includes(user))];
}

// ── envsubst ───────────────────────────────────────────────────────────

export const envsubstCmd: Command = {
  name: 'envsubst',
  description: 'Substitute environment variables ($VAR, ${VAR}) in stdin',
  async exec(ctx) {
    const args = ctx.args.filter((a) => a !== '--');
    const listVars = args.includes('-v') || args.includes('--variables');
    const format = args.find((a) => !a.startsWith('-'));
    const namesIn = (s: string) => [...s.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)].map((m) => m[1] ?? m[2]);
    if (listVars) {
      if (format === undefined) { ctx.stderr += 'envsubst: missing arguments\n'; return 1; }
      ctx.stdout += [...new Set(namesIn(format))].map((n) => n + '\n').join('');
      return 0;
    }
    // SHELL-FORMAT: only the variables it names are replaced
    const only = format !== undefined ? new Set(namesIn(format)) : null;
    ctx.stdout += (ctx.stdin ?? '').replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a, b) => {
      const name = a ?? b;
      if (only && !only.has(name)) return m;
      // (exported variables: the shell's unexported ones aren't in a program's environment)
      if (ctx.shell?.localVars?.has(name)) return '';
      return ctx.env[name] ?? '';
    });
    return 0;
  },
};

// ── groups ─────────────────────────────────────────────────────────────

export const groupsCmd: Command = {
  name: 'groups',
  description: 'Print the groups a user is in',
  async exec(ctx) {
    const users = ctx.args.length ? ctx.args : [currentUser(ctx)];
    let rc = 0;
    for (const u of users) {
      const gs = await userGroups(ctx, u);
      if (!gs) { ctx.stderr += `groups: '${u}': no such user\n`; rc = 1; continue; }
      const names = gs.map((g) => g.name).join(' ');
      ctx.stdout += ctx.args.length ? `${u} : ${names}\n` : `${names}\n`;
    }
    return rc;
  },
};

// ── locale ─────────────────────────────────────────────────────────────

const LC_VARS = ['LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_MESSAGES', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION'];

export const localeCmd: Command = {
  name: 'locale',
  description: 'Show locale settings (C.UTF-8)',
  async exec(ctx) {
    const a = ctx.args;
    if (a.includes('-a') || a.includes('--all-locales')) { ctx.stdout += 'C\nC.utf8\nPOSIX\n'; return 0; }
    if (a.includes('-m') || a.includes('--charmaps')) { ctx.stdout += 'UTF-8\n'; return 0; }
    if (a[0] === 'charmap') { ctx.stdout += 'UTF-8\n'; return 0; }
    if (a.length && !a[0].startsWith('-')) {
      // locale KEYWORD...: a few common ones
      const known: Record<string, string> = { charmap: 'UTF-8', decimal_point: '.', thousands_sep: '', codeset: 'UTF-8', yesexpr: '^[yY]', noexpr: '^[nN]' };
      for (const k of a) {
        if (!(k in known)) { ctx.stderr += `locale: unknown name "${k}"\n`; return 1; }
        ctx.stdout += known[k] + '\n';
      }
      return 0;
    }
    const lang = ctx.env.LANG ?? '';
    const all = ctx.env.LC_ALL ?? '';
    ctx.stdout += `LANG=${lang}\nLANGUAGE=${ctx.env.LANGUAGE ?? ''}\n`;
    for (const v of LC_VARS) {
      const set = ctx.env[v];
      ctx.stdout += set !== undefined ? `${v}=${set}\n` : `${v}="${all || lang || 'C.UTF-8'}"\n`;
    }
    ctx.stdout += `LC_ALL=${all}\n`;
    return 0;
  },
};

// ── name resolution: getent hosts, nslookup, dig ─────────────────────

async function hostsFile(ctx: CommandContext): Promise<{ address: string; names: string[] }[]> {
  return (await readLines(ctx, '/etc/hosts')).map((l) => l.trim().split(/\s+/)).filter((p) => p.length > 1).map(([address, ...names]) => ({ address, names }));
}

/** /etc/hosts, then the kernel's resolver (the relay, else DNS over HTTPS) */
async function resolveHost(ctx: CommandContext, name: string, family: 0 | 4 | 6 = 0): Promise<{ address: string; family: 4 | 6 }[] | string> {
  const fromFile = (await hostsFile(ctx)).filter((h) => h.names.includes(name)).map((h) => ({ address: h.address, family: (h.address.includes(':') ? 6 : 4) as 4 | 6 }))
    .filter((a) => !family || a.family === family);
  if (fromFile.length) return fromFile;
  const net = await import('../kernel/net');
  const { kernelForContext } = await import('../wasi/run-command');
  let stack = net.netStack;
  try { stack = net.netStackOf(kernelForContext(ctx)) ?? net.netStack; } catch { /* no kernel: the shared stack */ }
  const r = await stack.resolve(name, family);
  return typeof r === 'number' ? (r === -net.EHOSTUNREACH ? 'not found' : net.errnoName(-r)) : r;
}

export const getentCmd: Command = {
  name: 'getent',
  description: 'Get entries from passwd, group, hosts (Name Service databases)',
  async exec(ctx) {
    const [db, ...keys] = ctx.args;
    if (!db) { ctx.stderr += 'Usage: getent database [key ...]\n'; return 1; }
    const show = (lines: string[]) => { ctx.stdout += lines.map((l) => l + '\n').join(''); };
    switch (db) {
      case 'passwd': {
        const all = await passwdEntries(ctx);
        if (!keys.length) { show(all.map((p) => p.line)); return 0; }
        let rc = 0;
        for (const k of keys) {
          const e = all.find((p) => p.name === k || String(p.uid) === k);
          if (e) show([e.line]); else rc = 2;
        }
        return rc;
      }
      case 'group': {
        const all = await groupEntries(ctx);
        if (!keys.length) { show(all.map((g) => g.line)); return 0; }
        let rc = 0;
        for (const k of keys) {
          const e = all.find((g) => g.name === k || String(g.gid) === k);
          if (e) show([e.line]); else rc = 2;
        }
        return rc;
      }
      case 'hosts':
      case 'ahosts':
      case 'ahostsv4':
      case 'ahostsv6': {
        if (!keys.length) { show((await readLines(ctx, '/etc/hosts'))); return 0; }
        const fam = db === 'ahostsv4' ? 4 : db === 'ahostsv6' ? 6 : 0;
        let rc = 0;
        for (const k of keys) {
          const r = await resolveHost(ctx, k, fam);
          if (typeof r === 'string') { rc = 2; continue; }
          if (db === 'hosts') show([`${r[0].address.padEnd(15)} ${k}`]);
          else for (const a of r) show([`${a.address.padEnd(15)} STREAM ${k}`, `${a.address.padEnd(15)} DGRAM`, `${a.address.padEnd(15)} RAW`]);
        }
        return rc;
      }
      case 'shells': show(await readLines(ctx, '/etc/shells')); return 0;
      case 'services': case 'protocols': case 'networks': case 'netgroup':
        return 0;
      default:
        ctx.stderr += `Unknown database: ${db}\nTry 'getent --help' for more information.\n`;
        return 1;
    }
  },
};

export const nslookupCmd: Command = {
  name: 'nslookup',
  description: 'Look up a host name (through the internet relay or DNS over HTTPS)',
  async exec(ctx) {
    const name = ctx.args.find((a) => !a.startsWith('-'));
    if (!name) { ctx.stderr += 'Usage: nslookup NAME\n'; return 1; }
    const r = await resolveHost(ctx, name);
    ctx.stdout += 'Server:\t\ttabcomputer resolver (relay / DNS over HTTPS)\n\n';
    if (typeof r === 'string') {
      ctx.stdout += `** server can't find ${name}: ${r === 'not found' ? 'NXDOMAIN' : r}\n`;
      return 1;
    }
    ctx.stdout += 'Non-authoritative answer:\n';
    for (const a of r) ctx.stdout += `Name:\t${name}\nAddress: ${a.address}\n`;
    return 0;
  },
};

export const digCmd: Command = {
  name: 'dig',
  description: 'Look up A/AAAA records (minimal; +short supported)',
  async exec(ctx) {
    const short = ctx.args.includes('+short');
    const words = ctx.args.filter((a) => !a.startsWith('+') && !a.startsWith('@') && !a.startsWith('-'));
    const type = (words.find((w) => /^(A|AAAA|ANY)$/i.test(w)) ?? 'A').toUpperCase();
    const name = words.find((w) => !/^(A|AAAA|ANY|IN)$/i.test(w));
    if (!name) { ctx.stderr += 'Usage: dig [+short] NAME [A|AAAA]\n'; return 1; }
    const r = await resolveHost(ctx, name, type === 'AAAA' ? 6 : type === 'A' ? 4 : 0);
    const answers = typeof r === 'string' ? [] : r;
    if (short) { ctx.stdout += answers.map((a) => a.address + '\n').join(''); return 0; }
    ctx.stdout += `; <<>> dig (tabcomputer, relay / DNS over HTTPS) <<>> ${name} ${type}\n;; status: ${answers.length ? 'NOERROR' : 'NXDOMAIN'}\n\n;; ANSWER SECTION:\n`;
    for (const a of answers) ctx.stdout += `${name}.\t\t300\tIN\t${a.family === 6 ? 'AAAA' : 'A'}\t${a.address}\n`;
    return 0;
  },
};

// ── flock ──────────────────────────────────────────────────────────────

/** Advisory locks held by `flock` in this page: path → holders */
const locks = new Map<string, { exclusive: boolean; holders: number; waiters: (() => void)[] }>();

async function acquire(path: string, exclusive: boolean, wait: boolean, timeoutMs: number | null): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const l = locks.get(path);
    if (!l || l.holders === 0 || (!exclusive && !l.exclusive)) {
      if (!l || l.holders === 0) locks.set(path, { exclusive, holders: 1, waiters: l?.waiters ?? [] });
      else l.holders++;
      return true;
    }
    if (!wait) return false;
    const left = timeoutMs === null ? null : timeoutMs - (Date.now() - t0);
    if (left !== null && left <= 0) return false;
    await new Promise<void>((resolve) => {
      l.waiters.push(resolve);
      if (left !== null) setTimeout(resolve, left);
    });
  }
}

function release(path: string): void {
  const l = locks.get(path);
  if (!l) return;
  l.holders = Math.max(0, l.holders - 1);
  if (l.holders === 0) {
    const ws = l.waiters.splice(0);
    for (const w of ws) w();
  }
}

/** Locks `flock FD` took for the shell's fds, released by `flock -u FD` */
const fdLocks = new WeakMap<object, Map<number, string>>();

export const flockCmd: Command = {
  name: 'flock',
  description: 'Run a command holding an advisory lock (flock FILE CMD, flock FD)',
  async exec(ctx) {
    let exclusive = true, wait = true, unlock = false, timeout: number | null = null, conflictCode = 1;
    let i = 0;
    const a = ctx.args;
    for (; i < a.length; i++) {
      const x = a[i];
      if (x === '-s' || x === '--shared') exclusive = false;
      else if (x === '-x' || x === '-e' || x === '--exclusive') exclusive = true;
      else if (x === '-n' || x === '--nb' || x === '--nonblock') wait = false;
      else if (x === '-u' || x === '--unlock') unlock = true;
      else if (x === '-w' || x === '--timeout') timeout = Number(a[++i]) * 1000;
      else if (x === '-E' || x === '--conflict-exit-code') conflictCode = Number(a[++i]);
      else if (x === '-c' || x === '--command') { /* the command string follows */ }
      else if (x === '-o' || x === '--close' || x === '-F' || x === '--no-fork') { /* no fds to close here */ }
      else break;
    }
    const target = a[i];
    if (target === undefined) { ctx.stderr += 'flock: not enough arguments\n'; return 64; }
    const rest = a.slice(i + 1);
    if (rest[0] === '-c') rest.shift();
    if (timeout === 0) wait = false;

    // flock FD: lock the file the shell's fd N has open, until `flock -u N`
    if (/^\d+$/.test(target) && !rest.length) {
      const fd = Number(target);
      const entry = (ctx.shell as any).userFds?.get(fd) as { path?: string } | undefined;
      const path = entry?.path ?? `fd:${fd}`;
      const mine = fdLocks.get(ctx.shell) ?? new Map<number, string>();
      fdLocks.set(ctx.shell, mine);
      if (unlock) { if (mine.has(fd)) { release(mine.get(fd)!); mine.delete(fd); } return 0; }
      if (mine.get(fd) === path) return 0; // already held
      if (!await acquire(path, exclusive, wait, timeout)) return conflictCode;
      mine.set(fd, path);
      return 0;
    }

    // flock FILE CMD...: hold the lock while the command runs
    if (!rest.length) { ctx.stderr += 'flock: no command given\n'; return 64; }
    const path = ctx.fs.resolvePath(target, ctx.cwd);
    try { if (!(await ctx.fs.exists(path))) await ctx.fs.writeFile(path, ''); } catch { /* a directory, or read-only: lock the name anyway */ }
    if (!await acquire(path, exclusive, wait, timeout)) return conflictCode;
    try {
      const line = rest.length === 1 && a.includes('-c') ? rest[0] : rest.map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(' ');
      return await ctx.shell.execute(line, (s) => { ctx.stdout += s.replace(/\r\n/g, '\n'); }, (s) => { ctx.stderr += s.replace(/\r\n/g, '\n'); }, false, ctx.terminal, true);
    } finally {
      release(path);
    }
  },
};

// ── ping, strace ───────────────────────────────────────────────────────

export const pingCmd: Command = {
  name: 'ping',
  description: "ICMP isn't available in a browser: say so (try curl)",
  async exec(ctx) {
    const host = ctx.args.filter((a) => !a.startsWith('-')).pop() ?? '';
    ctx.stderr += `ping: ICMP isn't available in the browser (pages can't send raw packets).\n` +
      `To check that ${host || 'a host'} is reachable, try: curl -sS -o /dev/null -w '%{http_code} %{time_total}s\\n' https://${host || 'example.com'}/\n` +
      `${host ? `or resolve it: getent hosts ${host}\n` : ''}`;
    return 2;
  },
};

export const straceCmd: Command = {
  name: 'strace',
  description: "Trace a kernel program's system calls (x86 and WASM programs)",
  async exec(ctx) {
    let i = 0;
    let follow = false;
    let outFile: string | undefined;
    const a = ctx.args;
    for (; i < a.length && a[i].startsWith('-'); i++) {
      if (a[i] === '-f' || a[i] === '-ff') follow = true;
      else if (a[i] === '-o') outFile = a[++i];
      else if (a[i] === '--') { i++; break; }
    }
    const cmd = a.slice(i);
    if (!cmd.length) {
      ctx.stderr += "strace: must have PROG [ARGS]\nTraces the system calls of x86-64 (Blink) and WASM programs; Shiro's builtins run in the page and make none.\n";
      return 1;
    }
    const { kernelForContext } = await import('../wasi/run-command');
    const abi = await import('../kernel/abi');
    const { errnoName } = await import('../kernel/net');
    const kernel = kernelForContext(ctx);
    const names = new Map<number, string>();
    for (const [k, v] of Object.entries(abi)) if (k.startsWith('SYS_') && typeof v === 'number' && !names.has(v)) names.set(v, k.slice(4));
    const firstPid = ((kernel as any).lastPid ?? 0) + 1;
    const traced = new Set<number>();
    const want = (p: { pid: number; ppid: number }) => {
      if (traced.has(p.pid)) return true;
      if (p.pid >= firstPid && (traced.size === 0 || (follow && traced.has(p.ppid)))) { traced.add(p.pid); return true; }
      return false;
    };
    let trace = '';
    const fmt = (p: { pid: number }, nr: number, args: ArrayLike<number>, r: number) => {
      const name = names.get(nr) ?? `syscall_${nr}`;
      const shown = Array.from(args).slice(0, 3).map((x) => (x < 0 || x > 0xffff ? '0x' + (x >>> 0).toString(16) : String(x))).join(', ');
      const res = r < 0 ? `-1 ${errnoName(-r)}` : String(r);
      trace += `${follow ? `[pid ${p.pid}] ` : ''}${name}(${shown}) = ${res}\n`;
    };
    const k = kernel as any;
    const sync0 = k.syscallSync.bind(k);
    const async0 = k.syscall.bind(k);
    k.syscallSync = (proc: any, nr: number, args: ArrayLike<number>, data: Uint8Array) => {
      const r = sync0(proc, nr, args, data);
      if (r !== undefined && want(proc)) fmt(proc, nr, args, r);
      return r;
    };
    k.syscall = (proc: any, nr: number, args: ArrayLike<number>, data: Uint8Array) => {
      const p: Promise<number> = async0(proc, nr, args, data);
      if (want(proc)) p.then((r) => fmt(proc, nr, args, r), () => {});
      return p;
    };
    let code: number;
    try {
      code = await ctx.shell.execute(cmd.map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(' '),
        (s) => { ctx.stdout += s.replace(/\r\n/g, '\n'); }, (s) => { ctx.stderr += s.replace(/\r\n/g, '\n'); }, false, ctx.terminal, true);
    } finally {
      k.syscallSync = sync0;
      k.syscall = async0;
    }
    if (!traced.size) trace += `strace: ${cmd[0]} made no system calls: it is a tabcomputer builtin (it runs in the page); strace sees x86-64 and WASM programs\n`;
    trace += `+++ exited with ${code} +++\n`;
    if (outFile) await ctx.fs.writeFile(ctx.fs.resolvePath(outFile, ctx.cwd), trace);
    else ctx.stderr += trace;
    return code;
  },
};
