import { Command, CommandContext } from './index';
import type { Shell, BackgroundJob } from '../shell';
import {
  jobControl, shellStatus, signalName, WIFEXITED, WTERMSIG, SIGCONT, SIGINT, SIGPIPE,
} from '../kernel/signals';
import type { TtySession, TtyJob, JobResult, ProcessTty } from '../kernel/pty';

/** Resolve %N, %%, %+, %-, %string, %?string (or a bare job number) to a job. */
export function resolveJobSpec(shell: Shell, spec: string | undefined): [number, BackgroundJob] | undefined {
  const ids = [...shell.backgroundJobs.keys()];
  if (ids.length === 0) return undefined;
  const current = currentJobId(shell);
  const s = spec === undefined ? '%%' : spec;
  const body = s.startsWith('%') ? s.slice(1) : s;
  let id: number | undefined;
  if (body === '' || body === '%' || body === '+') id = current;
  else if (body === '-') id = ids.length > 1 ? ids.filter((i) => i !== current).pop() : current;
  else if (/^\d+$/.test(body)) id = parseInt(body, 10);
  else if (body.startsWith('?')) id = ids.find((i) => shell.backgroundJobs.get(i)!.command.includes(body.slice(1)));
  else id = ids.find((i) => shell.backgroundJobs.get(i)!.command.startsWith(body));
  if (id === undefined) return undefined;
  const job = shell.backgroundJobs.get(id);
  return job ? [id, job] : undefined;
}

/** bash's "current job": the most recently stopped job, else the newest */
function currentJobId(shell: Shell): number | undefined {
  const entries = [...shell.backgroundJobs.entries()];
  const stopped = entries.filter(([, j]) => j.status === 'stopped');
  const pick = stopped.length ? stopped : entries;
  return pick.length ? pick[pick.length - 1][0] : undefined;
}

/** The tty jobs take over: the page terminal's, or the pty of a shell running as a kernel process */
function terminalTty(ctx: { terminal?: { tty?: TtySession }; shell?: { kernelTty?: { tty: ProcessTty } } }): TtySession | ProcessTty | undefined {
  return ctx.terminal?.tty ?? ctx.shell?.kernelTty?.tty;
}

/** Text bash prints when a foreground job dies from a signal */
function signalDescription(sig: number): string {
  const names: Record<number, string> = {
    1: 'Hangup', 2: '', 3: 'Quit', 4: 'Illegal instruction', 6: 'Aborted', 7: 'Bus error',
    8: 'Floating point exception', 9: 'Killed', 10: 'User defined signal 1', 11: 'Segmentation fault',
    12: 'User defined signal 2', 13: '', 14: 'Alarm clock', 15: 'Terminated',
  };
  return names[sig] ?? `Signal ${sig}`;
}

function stoppedLine(id: number, job: BackgroundJob, sig: number): string {
  const what = sig === 20 ? 'Stopped' : `Stopped (SIG${signalName(sig)})`;
  return `[${id}]+  ${what.padEnd(24)}${job.command}\n`;
}

/** Resolves with the shell status when every process of a kernel job has exited (stops don't end it). */
function kernelJobExit(job: BackgroundJob, reap?: () => Promise<void>): Promise<number> {
  return new Promise((resolve) => {
    const loop = async () => {
      for (;;) {
        const r = await jobControl.waitJob(job.pgid!, job.pids);
        if (r.type === 'exited') {
          // reaped at once, as bash's SIGCHLD handler does: no zombie under the shell
          await reap?.().catch(() => {});
          job.status = WIFEXITED(r.status) && r.status === 0 ? 'done' : 'failed';
          job.exitCode = shellStatus(r.status);
          resolve(job.exitCode);
          return;
        }
        job.status = 'stopped';
        await new Promise<void>((res) => {
          const unsub = jobControl.subscribe((ev) => {
            if ((ev.type === 'continued' || ev.type === 'exited') && (job.pids ?? []).concat(job.pgid!).includes(ev.pid)) {
              unsub();
              res();
            }
          });
        });
        if (job.status === 'stopped') job.status = 'running';
      }
    };
    void loop();
  });
}

/**
 * Handle a kernel job's foreground result: a stopped job joins the job table
 * (printing `[N]+ Stopped`), a signalled one prints bash's description.
 */
function finishForeground(shell: Shell, job: BackgroundJob, r: JobResult, write: (s: string) => void): number {
  if (r.type === 'stopped') {
    job.status = 'stopped';
    let id = [...shell.backgroundJobs.entries()].find(([, j]) => j === job)?.[0];
    if (id === undefined) {
      id = shell.allocJobId();
      job.id = id;
      job.promise = kernelJobExit(job);
      shell.backgroundJobs.set(id, job);
    }
    write('\n' + stoppedLine(id, job, r.sig));
    return 128 + r.sig;
  }
  const status = r.status;
  if (!WIFEXITED(status)) {
    const sig = WTERMSIG(status);
    const desc = signalDescription(sig);
    if (sig === SIGINT || sig === SIGPIPE) { if (sig === SIGINT) write('\n'); }
    else write(`${desc}${status & 0x80 ? ' (core dumped)' : ''}\n`);
  }
  job.status = WIFEXITED(status) && status === 0 ? 'done' : 'failed';
  job.exitCode = shellStatus(status);
  for (const [id, j] of shell.backgroundJobs) if (j === job) shell.backgroundJobs.delete(id);
  return job.exitCode;
}

/**
 * Run a kernel job (a process group whose members are registered with
 * jobControl) under the shell's job control: foreground jobs own the terminal
 * until they exit or stop (Ctrl-Z), background jobs go in the job table.
 * This is the hook for kernel.spawn integration.
 */
export async function runKernelJob(shell: Shell, opts: {
  command: string;
  pgid: number;
  pids?: number[];
  background?: boolean;
  tty?: TtySession;
  write?: (s: string) => void;
  /** Collect the job's exited processes (waitpid), so they don't stay zombies */
  reap?: () => Promise<void>;
}): Promise<number> {
  const write = opts.write ?? (() => {});
  const job: BackgroundJob = {
    id: 0,
    command: opts.command,
    status: 'running',
    exitCode: 0,
    pgid: opts.pgid,
    pids: opts.pids,
    promise: Promise.resolve(0),
  };
  if (opts.background) {
    const id = shell.allocJobId();
    job.id = id;
    job.promise = kernelJobExit(job, opts.reap);
    shell.backgroundJobs.set(id, job);
    // ($!: the last process; without job control the group is the shell's)
    write(`[${id}] ${opts.pids?.[opts.pids.length - 1] ?? opts.pgid}\n`);
    return 0;
  }
  const tty = opts.tty;
  const r = tty ? await tty.foreground(job as TtyJob) : await jobControl.waitJob(opts.pgid, opts.pids);
  return finishForeground(shell, job, r, write);
}

function statusText(job: BackgroundJob): string {
  switch (job.status) {
    case 'running': return 'Running';
    case 'stopped': return 'Stopped';
    case 'done': return 'Done';
    default:
      return job.pgid && job.exitCode > 128 ? signalDescription(job.exitCode - 128) || 'Interrupt' : `Exit ${job.exitCode}`;
  }
}

/**
 * jobs - List background jobs
 */
export const jobsCmd: Command = {
  name: 'jobs',
  description: 'List background jobs',
  async exec(ctx: CommandContext): Promise<number> {
    const shell = ctx.shell;
    const pOnly = ctx.args.includes('-p');
    const longFormat = ctx.args.includes('-l');
    const runningOnly = ctx.args.includes('-r');
    const stoppedOnly = ctx.args.includes('-s');

    if (shell.backgroundJobs.size === 0) return 0; // bash prints nothing

    const current = currentJobId(shell);
    const ids = [...shell.backgroundJobs.keys()];
    const previous = ids.filter((i) => i !== current).pop();
    for (const [id, job] of shell.backgroundJobs) {
      if (runningOnly && job.status !== 'running') continue;
      if (stoppedOnly && job.status !== 'stopped') continue;
      if (pOnly) {
        // (the job's first process: without job control its group is the shell's)
        ctx.stdout += `${job.pids?.[0] ?? job.pgid ?? job.pid ?? id}\n`;
        continue;
      }
      const mark = id === current ? '+' : id === previous ? '-' : ' ';
      if (job.pgid) {
        const status = statusText(job).padEnd(24);
        ctx.stdout += longFormat
          ? `[${id}]${mark} ${job.pids?.[0] ?? job.pgid} ${status}${job.command}\n`
          : `[${id}]${mark}  ${status}${job.command}\n`;
      } else {
        const status = job.status === 'running' ? 'Running'
          : job.status === 'done' ? `Done (${job.exitCode})`
          : `Failed (${job.exitCode})`;
        ctx.stdout += longFormat
          ? `[${id}] ${job.pid ?? id}\t${status}\t${job.command}\n`
          : `[${id}] ${status}\t${job.command}\n`;
      }
    }

    // Clean up completed jobs after displaying
    for (const [id, job] of shell.backgroundJobs) {
      if (job.status === 'done' || job.status === 'failed') {
        shell.backgroundJobs.delete(id);
      }
    }

    return 0;
  },
};

/**
 * fg - Bring a background job to the foreground
 */
export const fgCmd: Command = {
  name: 'fg',
  description: 'Bring background job to foreground',
  async exec(ctx: CommandContext): Promise<number> {
    const shell = ctx.shell;
    const spec = ctx.args[0];
    const found = resolveJobSpec(shell, spec);
    if (!found) {
      ctx.stderr = spec ? `fg: ${spec}: no such job\n` : 'fg: current: no such job\n';
      return 1;
    }
    const [jobId, job] = found;

    if (job.pgid) {
      // Kernel job: hand it the terminal and SIGCONT it
      const term = ctx.terminal ?? ctx.shell.kernelTty;
      const write = (s: string) => { if (term) term.writeOutput(s.replace(/\r?\n/g, '\r\n')); else ctx.stdout += s; };
      write(`${job.command}\n`);
      job.status = 'running';
      const tty = terminalTty(ctx);
      let r: JobResult;
      if (tty) r = await tty.foreground(job as TtyJob, true);
      else {
        jobControl.kill(-job.pgid, SIGCONT);
        r = await jobControl.waitJob(job.pgid, job.pids);
      }
      return finishForeground(shell, job, r, write);
    }

    if (job.status !== 'running') {
      ctx.stdout = `[${jobId}] Already ${job.status}\n`;
      shell.backgroundJobs.delete(jobId);
      return job.exitCode;
    }

    ctx.stdout = `[${jobId}] ${job.command}\n`;
    const exitCode = await job.promise;
    shell.backgroundJobs.delete(jobId);
    return exitCode;
  },
};

/**
 * bg - Resume stopped jobs in the background (SIGCONT to the job's group)
 */
export const bgCmd: Command = {
  name: 'bg',
  description: 'Resume a stopped job in the background',
  async exec(ctx: CommandContext): Promise<number> {
    const shell = ctx.shell;
    const specs = ctx.args.length ? ctx.args : [undefined];
    let status = 0;
    for (const spec of specs) {
      const found = resolveJobSpec(shell, spec);
      if (!found) {
        ctx.stderr += spec ? `bg: ${spec}: no such job\n` : 'bg: current: no such job\n';
        status = 1;
        continue;
      }
      const [id, job] = found;
      if (!job.pgid) {
        // In-page jobs never stop, so they are already running in the background
        ctx.stderr += `bg: job ${id} already in background\n`;
        continue;
      }
      if (job.status === 'running') {
        ctx.stderr += `bg: job ${id} already in background\n`;
        continue;
      }
      job.status = 'running';
      jobControl.kill(-job.pgid, SIGCONT);
      ctx.stdout += `[${id}]+ ${job.command} &\n`;
    }
    return status;
  },
};

/**
 * wait - Wait for background jobs to complete
 */
export const waitCmd: Command = {
  name: 'wait',
  description: 'Wait for background jobs to complete',
  async exec(ctx: CommandContext): Promise<number> {
    const shell = ctx.shell;
    let lastExitCode = 0;

    // wait -n: wait for any one job to complete
    if (ctx.args.includes('-n')) {
      if (shell.backgroundJobs.size === 0) return 127;
      const entries = [...shell.backgroundJobs.entries()];
      const result = await Promise.race(entries.map(([id, job]) => job.promise.then(code => ({ id, code }))));
      shell.backgroundJobs.delete(result.id);
      return result.code;
    }

    if (ctx.args.some((a) => a !== '-f')) {
      // Wait for specific job(s) or pids
      for (const arg of ctx.args.filter((a) => a !== '-f')) {
        let entry: [number, BackgroundJob] | undefined;
        if (arg.startsWith('%')) entry = resolveJobSpec(shell, arg);
        else {
          const n = parseInt(arg, 10);
          entry = [...shell.backgroundJobs.entries()].find(([, j]) => j.pid === n || j.pgid === n || (j.pids ?? []).includes(n))
            ?? (shell.backgroundJobs.has(n) ? [n, shell.backgroundJobs.get(n)!] : undefined);
          if (!entry && jobControl.get(n)) {
            const r = await jobControl.waitJob(jobControl.get(n)!.pgid, [n]);
            lastExitCode = r.type === 'exited' ? shellStatus(r.status) : 128 + r.sig;
            continue;
          }
        }
        if (!entry) {
          if (arg.startsWith('%')) ctx.stderr += `wait: ${arg}: no such job\n`;
          lastExitCode = 127;
          continue;
        }
        const [jobId, job] = entry;
        // With job control (a terminal, or set -m), wait also returns when a
        // kernel job stops: 128 + the stop signal, the job stays (bash; -f waits for its end)
        if (job.pgid && (ctx.terminal || shell.kernelTty || shell.options.has('monitor')) && !ctx.args.includes('-f')) {
          await new Promise((r) => setTimeout(r, 0)); // a kill %N just before: let its SIGCONT land
          if (job.status === 'stopped') { lastExitCode = 128 + 20; continue; }
          const members = (job.pids ?? []).concat(job.pgid);
          let unsub = () => {};
          const stopped = new Promise<number>((res) => {
            unsub = jobControl.subscribe((ev) => { if (ev.type === 'stopped' && members.includes(ev.pid)) res(128 + ev.sig); });
          });
          const r = await Promise.race([job.promise.then((c) => ({ c, done: true })), stopped.then((c) => ({ c, done: false }))]);
          unsub();
          lastExitCode = r.c;
          if (r.done) shell.backgroundJobs.delete(jobId);
          continue;
        }
        lastExitCode = await job.promise;
        shell.backgroundJobs.delete(jobId);
      }
    } else {
      // Wait for all jobs
      for (const [id, job] of shell.backgroundJobs) {
        lastExitCode = await job.promise;
        shell.backgroundJobs.delete(id);
      }
      lastExitCode = 0;
    }

    return lastExitCode;
  },
};
