import { Command, CommandContext } from './index';

/**
 * jobs - List background jobs
 */
export const jobsCmd: Command = {
  name: 'jobs',
  description: 'List background jobs',
  async exec(ctx: CommandContext): Promise<number> {
    const shell = ctx.shell;
    if (shell.backgroundJobs.size === 0) {
      ctx.stdout = 'No background jobs.\n';
      return 0;
    }

    for (const [id, job] of shell.backgroundJobs) {
      const status = job.status === 'running' ? 'Running'
        : job.status === 'done' ? `Done (${job.exitCode})`
        : `Failed (${job.exitCode})`;
      ctx.stdout += `[${id}] ${status}\t${job.command}\n`;
    }

    // Clean up completed jobs after displaying
    for (const [id, job] of shell.backgroundJobs) {
      if (job.status !== 'running') {
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

    // Parse job ID: fg %1 or fg 1
    let jobId: number;
    if (ctx.args.length === 0) {
      // Default to most recent job
      const ids = [...shell.backgroundJobs.keys()];
      if (ids.length === 0) {
        ctx.stderr = 'fg: no current job\n';
        return 1;
      }
      jobId = ids[ids.length - 1];
    } else {
      jobId = parseInt(ctx.args[0].replace('%', ''), 10);
    }

    const job = shell.backgroundJobs.get(jobId);
    if (!job) {
      ctx.stderr = `fg: %${jobId}: no such job\n`;
      return 1;
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
 * bg - Resume a stopped job in the background (no-op in browser since there's no SIGSTOP)
 */
export const bgCmd: Command = {
  name: 'bg',
  description: 'Resume a stopped job in the background',
  async exec(ctx: CommandContext): Promise<number> {
    ctx.stdout = 'bg: job control not fully supported in browser environment\n';
    return 0;
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

    if (ctx.args.length > 0) {
      // Wait for specific job
      const jobId = parseInt(ctx.args[0].replace('%', ''), 10);
      const job = shell.backgroundJobs.get(jobId);
      if (job) {
        lastExitCode = await job.promise;
        shell.backgroundJobs.delete(jobId);
      }
    } else {
      // Wait for all jobs
      for (const [id, job] of shell.backgroundJobs) {
        lastExitCode = await job.promise;
        shell.backgroundJobs.delete(id);
      }
    }

    return lastExitCode;
  },
};
