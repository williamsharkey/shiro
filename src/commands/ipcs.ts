/**
 * ipcs, ipcrm: the System V IPC objects of the page's kernel (shared memory,
 * semaphore arrays, message queues: src/kernel/sysv*.ts), in util-linux's
 * layout. Removal goes through the kernel's own IPC_RMID, with its
 * permission checks, as the calling shell's user.
 */
import type { Command, CommandContext } from './index';

async function kernelOf(ctx: CommandContext) {
  const { kernelForContext } = await import('../wasi/run-command');
  return kernelForContext(ctx);
}

/** A process to make calls as: the shell's user, not in the process table. */
async function caller(ctx: CommandContext, name: string) {
  const { Process } = await import('../kernel/process');
  const p = new Process({ pid: -1, ppid: 1, path: name, argv: [name], env: ctx.env, cwd: ctx.cwd });
  const uid = (ctx.shell as any)?.uid;
  if (typeof uid === 'number') { p.uid = uid; p.gid = uid === 0 ? 0 : p.gid; }
  return p;
}

const userName = (uid: number) => (uid === 0 ? 'root' : uid === 1000 ? 'user' : String(uid));
const hexKey = (k: number) => '0x' + (k >>> 0).toString(16).padStart(8, '0');
const col = (s: string | number, w = 10) => String(s).padEnd(w) + ' ';

export const ipcsCmd: Command = {
  name: 'ipcs',
  description: 'Show System V IPC objects (message queues, shared memory, semaphores)',
  async exec(ctx) {
    let q = false, m = false, s = false;
    for (const a of ctx.args) {
      if (a === '-h' || a === '--help') {
        ctx.stdout += 'Usage: ipcs [-q|-m|-s|-a]\n  -q  message queues\n  -m  shared memory segments\n  -s  semaphore arrays\n  -a  all (default)\n';
        return 0;
      }
      if (/^-[qmsa]+$/.test(a)) {
        q ||= a.includes('q') || a.includes('a');
        m ||= a.includes('m') || a.includes('a');
        s ||= a.includes('s') || a.includes('a');
      } else if (a === '--queues') q = true;
      else if (a === '--shmems') m = true;
      else if (a === '--semaphores') s = true;
      else if (a === '--all') q = m = s = true;
      else { ctx.stderr += `ipcs: invalid option -- '${a.replace(/^-+/, '')}'\n`; return 1; }
    }
    if (!q && !m && !s) q = m = s = true;
    const k = await kernelOf(ctx);
    let out = '';
    if (q) {
      out += '\n------ Message Queues --------\n' + col('key') + col('msqid') + col('owner') + col('perms') + col('used-bytes', 12) + col('messages', 12) + '\n';
      for (const x of k.msg.list()) out += col(hexKey(x.key)) + col(x.id) + col(userName(x.uid)) + col(x.mode.toString(8)) + col(x.bytes, 12) + col(x.qnum, 12) + '\n';
    }
    if (m) {
      out += '\n------ Shared Memory Segments --------\n' + col('key') + col('shmid') + col('owner') + col('perms') + col('bytes') + col('nattch') + col('status', 12) + '\n';
      for (const x of k.shm.list()) {
        const status = [x.removed ? 'dest' : '', x.locked ? 'locked' : ''].filter(Boolean).join(' ');
        out += col(hexKey(x.removed ? 0 : x.key)) + col(x.id) + col(userName(x.uid)) + col(x.mode.toString(8)) + col(x.size) + col(x.nattch) + col(status, 12) + '\n';
      }
    }
    if (s) {
      out += '\n------ Semaphore Arrays --------\n' + col('key') + col('semid') + col('owner') + col('perms') + col('nsems') + '\n';
      for (const x of k.sem.list()) out += col(hexKey(x.key)) + col(x.id) + col(userName(x.uid)) + col(x.mode.toString(8)) + col(x.vals.length) + '\n';
    }
    ctx.stdout += out + '\n';
    return 0;
  },
};

export const ipcrmCmd: Command = {
  name: 'ipcrm',
  description: 'Remove System V IPC objects (by id or key)',
  async exec(ctx) {
    const k = await kernelOf(ctx);
    const proc = await caller(ctx, 'ipcrm');
    const A = await import('../kernel/abi');
    const { IPC_RMID } = await import('../kernel/sysvshm');
    const data = new Uint8Array(128);
    const rm = (kind: 'q' | 'm' | 's', id: number) =>
      kind === 'q' ? k.msg.msgctl(proc, id, IPC_RMID, data)
        : kind === 'm' ? k.shm.shmctl(proc, id, IPC_RMID, data)
          : k.sem.semctl(proc, id, 0, IPC_RMID, 0, data);
    const ids = (kind: 'q' | 'm' | 's') => (kind === 'q' ? k.msg.list() : kind === 'm' ? k.shm.list() : k.sem.list());
    const what = { q: 'msqid', m: 'shmid', s: 'semid' } as const;
    const keyWhat = { q: 'msqkey', m: 'shmkey', s: 'semkey' } as const;
    const fail = (msg: string) => { ctx.stderr += `ipcrm: ${msg}\n`; return 1; };
    const errText = (r: number) => (r === -A.EPERM ? 'permission denied' : r === -A.EACCES ? 'permission denied' : r === -A.EINVAL ? 'invalid id' : `error ${-r}`);
    const num = (s: string | undefined) => (s !== undefined && /^(0x[0-9a-f]+|-?\d+)$/i.test(s) ? Number(s) | 0 : NaN);
    let args = [...ctx.args];
    // Old form: ipcrm shm|msg|sem ID...
    if (args.length && ['shm', 'msg', 'sem'].includes(args[0])) {
      const kind = ({ shm: 'm', msg: 'q', sem: 's' } as const)[args[0] as 'shm' | 'msg' | 'sem'];
      args = args.slice(1).flatMap((id) => [`-${kind}`, id]);
    }
    if (!args.length) {
      ctx.stderr += 'Usage: ipcrm [-q|-m|-s ID] [-Q|-M|-S KEY] [-a [shm|msg|sem]]\n';
      return 1;
    }
    let status = 0;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-a' || a === '--all') {
        const only = args[i + 1] && ['shm', 'msg', 'sem'].includes(args[i + 1]) ? args[++i] : null;
        const kinds = only ? [({ shm: 'm', msg: 'q', sem: 's' } as const)[only as 'shm' | 'msg' | 'sem']] : (['q', 'm', 's'] as const);
        for (const kind of kinds) for (const x of [...ids(kind)]) { const r = rm(kind, x.id); if (r < 0) status = fail(`${what[kind]} ${x.id}: ${errText(r)}`); }
        continue;
      }
      const m = /^-([qmsQMS])$/.exec(a);
      if (!m) return fail(`invalid option -- '${a.replace(/^-+/, '')}'`);
      const v = num(args[++i]);
      if (Number.isNaN(v)) return fail(`option requires an argument -- '${m[1]}'`);
      const kind = m[1].toLowerCase() as 'q' | 'm' | 's';
      if (m[1] === m[1].toUpperCase()) {
        const x = ids(kind).find((o) => o.key === v && !('removed' in o && o.removed));
        if (!x || v === 0) { status = fail(`invalid key (${args[i]})`); continue; }
        const r = rm(kind, x.id);
        if (r < 0) status = fail(`${keyWhat[kind]} (${args[i]}): ${errText(r)}`);
      } else {
        const r = rm(kind, v);
        if (r < 0) status = fail(`${what[kind]} (${v}): ${errText(r)}`);
      }
    }
    return status;
  },
};
