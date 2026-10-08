
/**
 * trap - Trap signals and execute commands
 *
 * In real shells, trap sets up signal handlers. This implementation provides
 * a stub that shells can recognize for signal handling.
 *
 * Syntax:
 *   trap 'COMMANDS' SIGNAL...
 *   trap - SIGNAL...          (reset to default)
 *   trap -l                   (list signals)
 *   trap -p [SIGNAL...]       (print current traps)
 *
 * Common signals:
 *   EXIT, INT, TERM, HUP, QUIT, USR1, USR2, ERR, DEBUG, RETURN
 */
import type { Command } from './index';
import { parseArgs } from './flags';
export const trap: Command = {
  name: "trap",
  description: "Trap signals and execute commands",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args, ["l", "p"]);

    // -l: list signals
    if (flags.l) {
      const signals = [
        "EXIT", "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS",
        "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM",
        "STKFLT", "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG",
        "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS",
        "ERR", "DEBUG", "RETURN"
      ];

      ctx.stdout += signals.map((sig, i) => `${i}) SIG${sig}`).join("\n") + "\n";
      return 0;
    }

    // -p: print current traps
    if (flags.p) {
      if (positional.length === 0) {
        // In a real shell, this would list all traps
        ctx.stdout += "# Trap handlers would be listed here\n";
        return 0;
      } else {
        // Print specific signal traps
        ctx.stdout += positional.map(sig => `# trap for ${sig} would be shown here`).join("\n") + "\n";
        return 0;
      }
    }

    if (positional.length === 0) {
      ctx.stderr += "trap: usage: trap [-lp] [ACTION] [SIGNAL...]\n";
      return 1;
    }

    // First argument is the action (command string or -)
    const action = positional[0];
    const signals = positional.slice(1);

    if (signals.length === 0) {
      ctx.stderr += "trap: usage: trap ACTION SIGNAL...\n";
      return 1;
    }

    // In a real shell, this would register signal handlers
    // For now, just acknowledge the trap registration
    const actionDesc = action === "-" ? "reset to default" : `set to '${action}'`;

    return 0;
  },
};

/**
 * kill - send a signal (bash builtin semantics).
 *
 *   kill [-s SIG | -n NUM | -SIG] PID | %JOB | -PGID ...
 *   kill -l [SIG | STATUS] ...    kill -L
 *
 * Kernel processes and process groups get real signals through job control.
 * In-page jobs (plain shell `&` jobs) and windowed processes have no stop/
 * continue, so any terminating signal aborts them.
 */
export const kill: Command = {
  name: "kill",
  description: "Send signal to process",
  async exec(ctx) {
    const sigs = await import('../kernel/signals');
    const { jobControl, signalNumber, signalName, defaultAction, SIGTERM, NSIG } = sigs;
    const args = [...ctx.args];
    let sig = SIGTERM;
    const targets: string[] = [];
    let list: 'l' | 'L' | null = null;

    while (args.length) {
      const a = args[0];
      if (a === '--') { args.shift(); break; }
      if (a === '-l' || a === '-L' || a === '--list' || a === '--table') {
        list = a === '-L' || a === '--table' ? 'L' : 'l';
        args.shift();
        continue;
      }
      if (a === '-s' || a === '-n' || a === '--signal') {
        args.shift();
        const spec = args.shift();
        const n = spec === undefined ? undefined : signalNumber(spec);
        if (n === undefined) {
          ctx.stderr += `kill: ${spec ?? ''}: invalid signal specification\n`;
          return 1;
        }
        sig = n;
        continue;
      }
      if (/^-[A-Za-z0-9+]+$/.test(a) && !list && targets.length === 0) {
        const n = signalNumber(a.slice(1));
        // `kill -123` with an unknown signal: bash treats it as an invalid signal
        if (n === undefined) {
          ctx.stderr += `kill: ${a.slice(1)}: invalid signal specification\n`;
          return 1;
        }
        sig = n;
        args.shift();
        continue;
      }
      break;
    }
    targets.push(...args);

    if (list === 'L') {
      const rows: string[] = [];
      for (let n = 1; n < NSIG; n++) {
        if (n === 32 || n === 33) continue;
        rows.push(`${String(n).padStart(2)}) SIG${signalName(n)}`);
      }
      ctx.stdout += rows.join('\n') + '\n';
      return 0;
    }
    if (list === 'l') {
      if (targets.length === 0) {
        const names: string[] = [];
        for (let n = 1; n < 32; n++) names.push(signalName(n));
        ctx.stdout += names.join(' ') + '\n';
        return 0;
      }
      let bad = false;
      for (const t of targets) {
        if (/^\d+$/.test(t)) {
          // A number is a signal number or an exit status (128+sig)
          let n = parseInt(t, 10);
          if (n > 128) n -= 128;
          if (n > 0 && n < NSIG) ctx.stdout += signalName(n) + '\n';
          else { ctx.stderr += `kill: ${t}: invalid signal specification\n`; bad = true; }
        } else {
          const n = signalNumber(t);
          if (n === undefined) { ctx.stderr += `kill: ${t}: invalid signal specification\n`; bad = true; }
          else ctx.stdout += n + '\n';
        }
      }
      return bad ? 1 : 0;
    }

    if (targets.length === 0) {
      ctx.stderr += "kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n";
      return 1;
    }

    const { processTable } = await import('../process-table');
    const { resolveJobSpec } = await import('./jobs');
    const shell = ctx.shell;
    const terminating = sig !== 0 && sig !== sigs.SIGCONT && defaultAction(sig) !== 'stop' && defaultAction(sig) !== 'ign';
    let anyFailed = false;

    const abortInPage = (job: { abortController?: AbortController; status: string; exitCode: number }) => {
      if (!terminating) return;
      if (job.abortController) job.abortController.abort();
      job.status = 'failed';
      job.exitCode = 128 + sig;
    };

    for (const t of targets) {
      if (t.startsWith('%')) {
        const found = resolveJobSpec(shell, t);
        if (!found) {
          ctx.stderr += `kill: ${t}: no such job\n`;
          anyFailed = true;
          continue;
        }
        const [, job] = found;
        if (job.pgid) {
          if (jobControl.kill(-job.pgid, sig) < 0) { ctx.stderr += `kill: ${t}: no such job\n`; anyFailed = true; }
        } else if (job.status === 'running') {
          abortInPage(job);
        } else {
          ctx.stderr += `kill: ${t}: no such job\n`;
          anyFailed = true;
        }
        continue;
      }

      if (!/^-?\d+$/.test(t)) {
        ctx.stderr += `kill: ${t}: arguments must be process or job IDs\n`;
        anyFailed = true;
        continue;
      }
      const pid = parseInt(t, 10);

      // Kernel processes and process groups (negative pid = group)
      if (pid <= 0 || jobControl.get(pid)) {
        if (jobControl.kill(pid, sig) < 0) {
          ctx.stderr += `kill: (${pid}) - No such process\n`;
          anyFailed = true;
        }
        continue;
      }

      // Windowed processes
      const proc = processTable.get(pid);
      if (proc && proc.status === 'running') {
        if (terminating) {
          processTable.kill(pid);
          proc.serverWindow?.close();
        }
        continue;
      }

      // Shell background jobs addressed by job number
      const job = shell.backgroundJobs.get(pid);
      if (job && job.status === 'running' && !job.pgid) {
        abortInPage(job);
        continue;
      }

      ctx.stderr += `kill: (${pid}) - No such process\n`;
      anyFailed = true;
    }

    return anyFailed ? 1 : 0;
  },
};
