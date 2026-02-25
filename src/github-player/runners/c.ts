import type { RunContext, RunnerResult } from '../types';
import type { DetectResult } from '../types';

/**
 * C runner: compile with cc → run the binary.
 * Supports root .c files, subdirectory .c files, and Makefile projects.
 */
export async function runC(ctx: RunContext, detect: DetectResult): Promise<RunnerResult> {
  const { shell, dir, repoName, log, fs } = ctx;

  shell.cwd = dir;

  // Find source files
  let sources: string[];
  if (detect.entry) {
    sources = [detect.entry];
  } else {
    try {
      const entries = await fs.readdir(dir);
      sources = entries.filter(e => e.endsWith('.c'));
    } catch {
      return { success: false, action: 'c', error: 'Cannot read directory' };
    }
  }

  if (sources.length === 0) {
    return { success: false, action: 'c', error: 'No .c source files found' };
  }

  // Prefer main.c if it exists among the sources
  const mainC = sources.find(s => s.endsWith('main.c'));
  if (mainC && sources.length > 1) {
    sources = [mainC];
  }

  const outName = repoName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const srcList = sources.join(' ');

  log(`\x1b[36mCompiling: cc ${srcList} -o ${outName}\x1b[0m`);
  const compileCode = await exec(ctx, `cd "${dir}" && cc ${srcList} -o ${outName}`);
  if (compileCode !== 0) {
    // If single file failed and there are more .c files in the same dir, try all
    if (sources.length === 1 && detect.meta?.subdir) {
      const subPath = `${dir}/${detect.meta.subdir}`;
      try {
        const subEntries = await fs.readdir(subPath);
        const allC = subEntries.filter(e => e.endsWith('.c'));
        if (allC.length > 1) {
          const allSrc = allC.map(f => `${detect.meta!.subdir}/${f}`).join(' ');
          log(`\x1b[33mSingle file failed, trying all .c in ${detect.meta.subdir}/...\x1b[0m`);
          const retryCode = await exec(ctx, `cd "${dir}" && cc ${allSrc} -o ${outName}`);
          if (retryCode !== 0) {
            return { success: false, action: 'cc', error: `Compilation failed (exit ${retryCode})` };
          }
        } else {
          return { success: false, action: 'cc', error: `Compilation failed (exit ${compileCode})` };
        }
      } catch {
        return { success: false, action: 'cc', error: `Compilation failed (exit ${compileCode})` };
      }
    } else {
      return { success: false, action: 'cc', error: `Compilation failed (exit ${compileCode})` };
    }
  }

  log(`\x1b[32mCompiled successfully\x1b[0m`);
  log(`\x1b[36mRunning: ./${outName}\x1b[0m`);
  const runCode = await exec(ctx, `cd "${dir}" && ./${outName}`);

  return {
    success: runCode === 0,
    action: `./${outName}`,
    error: runCode !== 0 ? `Exited with code ${runCode}` : undefined,
  };
}

async function exec(ctx: RunContext, cmd: string): Promise<number> {
  return ctx.shell.execute(
    cmd,
    (out: string) => ctx.terminal.term.write(out.replace(/\n/g, '\r\n')),
    (err: string) => ctx.terminal.term.write(`\x1b[31m${err.replace(/\n/g, '\r\n')}\x1b[0m`),
  );
}
