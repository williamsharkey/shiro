import { Command } from './index';

export const playCmd: Command = {
  name: 'play',
  description: 'Auto-detect and run current project',
  async exec(ctx) {
    const isTest = ctx.args.includes('--test');

    if (isTest) {
      return runTestSuite(ctx);
    }

    // Normal mode: detect and run current directory
    const dir = ctx.cwd;
    const repoName = dir.split('/').filter(Boolean).pop() || 'project';
    const user = 'local';

    const { detectAndRun } = await import('../github-player/index');

    const log = (msg: string) => {
      if (ctx.terminal) {
        ctx.terminal.term.writeln('\r\n' + msg);
      } else {
        ctx.stdout += msg + '\n';
      }
    };

    if (!ctx.terminal) {
      ctx.stderr = 'play: requires a terminal\n';
      return 1;
    }

    const result = await detectAndRun({
      fs: ctx.fs,
      shell: ctx.shell,
      terminal: ctx.terminal as any,
      dir,
      repoName,
      user,
      log,
    });

    if (!result.success) {
      log(`\x1b[31mFailed: ${result.error || result.action}\x1b[0m`);
      return 1;
    }

    log(`\x1b[32mDone: ${result.action}\x1b[0m`);
    return 0;
  },
};

async function runTestSuite(ctx: any): Promise<number> {
  const { candidates } = await import('../github-player/candidates');
  const { detectProject } = await import('../github-player/detect');
  const { generateReport, emptyResult } = await import('../github-player/report');
  const { detectAndRun } = await import('../github-player/index');

  const results: any[] = [];
  const total = candidates.length;

  const log = (msg: string) => {
    if (ctx.terminal) {
      ctx.terminal.term.writeln('\r\n' + msg);
    } else {
      ctx.stdout += msg + '\n';
    }
  };

  log(`\x1b[36mRunning GitHub Player test suite (${total} repos)...\x1b[0m`);

  for (let i = 0; i < total; i++) {
    const c = candidates[i];
    const label = `${c.user}/${c.repo}`;
    log(`\x1b[90m[${i + 1}/${total}] ${label} (${c.description})\x1b[0m`);

    const result = emptyResult(label, c.expectedKind);
    const start = Date.now();

    try {
      // Clone
      const cloneDir = `/home/user/${c.repo}`;
      const cloneCode = await ctx.shell.execute(
        `git clone https://github.com/${label} ${cloneDir}`,
        (s: string) => ctx.terminal?.term.write(s.replace(/\n/g, '\r\n')),
        (s: string) => ctx.terminal?.term.write(s.replace(/\n/g, '\r\n')),
      );
      result.cloneOk = cloneCode === 0;

      if (result.cloneOk) {
        // Detect
        const detect = await detectProject(ctx.fs, cloneDir);
        result.actualKind = detect.kind;
        result.installOk = true; // Detection succeeded
        result.buildOk = true;

        // Run
        const runResult = await detectAndRun({
          fs: ctx.fs,
          shell: ctx.shell,
          terminal: ctx.terminal,
          dir: cloneDir,
          repoName: c.repo,
          user: c.user,
          log,
        });
        result.runOk = runResult.success;
        if (!runResult.success && runResult.error) {
          result.errors.push(runResult.error);
        }
      } else {
        result.errors.push('Clone failed');
      }
    } catch (err: any) {
      result.errors.push(err.message || String(err));
    }

    result.durationMs = Date.now() - start;
    results.push(result);
  }

  // Generate report
  const report = await generateReport(ctx.fs, results);
  log(`\x1b[32mReport saved to /home/user/github-player-report.md\x1b[0m`);
  ctx.stdout += report;

  const passed = results.filter((r: any) => r.runOk).length;
  return passed === total ? 0 : 1;
}
