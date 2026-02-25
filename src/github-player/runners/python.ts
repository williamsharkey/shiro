import type { RunContext, RunnerResult } from '../types';
import type { DetectResult } from '../types';

/**
 * Python runner: pip install → python entry.py or python -m module
 */
export async function runPython(ctx: RunContext, detect: DetectResult): Promise<RunnerResult> {
  const { shell, dir, repoName, log, fs } = ctx;

  shell.cwd = dir;

  // Step 1: Install dependencies
  try {
    const reqStat = await fs.stat(`${dir}/requirements.txt`);
    if (reqStat?.type === 'file') {
      log(`\x1b[36mInstalling Python dependencies...\x1b[0m`);
      const installCode = await exec(ctx, `cd "${dir}" && pip install -r requirements.txt`);
      if (installCode !== 0) {
        log(`\x1b[33mpip install failed (exit ${installCode}), trying to continue...\x1b[0m`);
      } else {
        log(`\x1b[32mDependencies installed\x1b[0m`);
      }
    }
  } catch {}

  // Warn about web framework limitations
  if (detect.kind === 'python-web') {
    log(`\x1b[33mNote: Python web frameworks (Flask/Django/FastAPI) cannot serve HTTP in Shiro.\x1b[0m`);
    log(`\x1b[33mThe script will run but HTTP serving is not supported.\x1b[0m`);
  }

  // Step 2: Determine how to run
  const entry = detect.entry || await findPythonEntry(ctx);
  if (!entry) {
    return { success: false, action: 'python', error: 'No Python entry point found' };
  }

  // If detection flagged moduleRun, use python3 -m <module>
  if (detect.meta?.moduleRun === 'true') {
    log(`\x1b[36mRunning: python3 -m ${entry}\x1b[0m`);
    const runCode = await exec(ctx, `cd "${dir}" && python3 -m "${entry}"`);
    return {
      success: runCode === 0,
      action: `python3 -m ${entry}`,
      error: runCode !== 0 ? `Exited with code ${runCode}` : undefined,
    };
  }

  log(`\x1b[36mRunning: python3 ${entry}\x1b[0m`);
  const runCode = await exec(ctx, `cd "${dir}" && python3 "${entry}"`);

  return {
    success: runCode === 0,
    action: `python3 ${entry}`,
    error: runCode !== 0 ? `Exited with code ${runCode}` : undefined,
  };
}

async function findPythonEntry(ctx: RunContext): Promise<string | null> {
  const { fs, dir, repoName } = ctx;
  const candidates = ['main.py', 'app.py', 'run.py', `${repoName}.py`];
  for (const c of candidates) {
    try {
      if ((await fs.stat(`${dir}/${c}`))?.type === 'file') return c;
    } catch {}
  }
  // First .py file
  try {
    const entries = await fs.readdir(dir);
    const py = entries.find(e => e.endsWith('.py'));
    return py || null;
  } catch { return null; }
}

async function exec(ctx: RunContext, cmd: string): Promise<number> {
  return ctx.shell.execute(
    cmd,
    (out: string) => ctx.terminal.term.write(out.replace(/\n/g, '\r\n')),
    (err: string) => ctx.terminal.term.write(`\x1b[31m${err.replace(/\n/g, '\r\n')}\x1b[0m`),
  );
}
