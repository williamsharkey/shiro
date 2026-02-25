import type { RunContext, RunnerResult } from '../types';
import type { DetectResult } from '../types';

/**
 * Lua runner: find entry .lua file and run it.
 */
export async function runLua(ctx: RunContext, detect: DetectResult): Promise<RunnerResult> {
  const { shell, dir, repoName, log, fs } = ctx;

  shell.cwd = dir;

  // Find entry point
  const entry = detect.entry || await findLuaEntry(ctx);
  if (!entry) {
    return { success: false, action: 'lua', error: 'No .lua entry point found' };
  }

  log(`\x1b[36mRunning: lua ${entry}\x1b[0m`);
  const runCode = await exec(ctx, `cd "${dir}" && lua "${entry}"`);

  return {
    success: runCode === 0,
    action: `lua ${entry}`,
    error: runCode !== 0 ? `Exited with code ${runCode}` : undefined,
  };
}

async function findLuaEntry(ctx: RunContext): Promise<string | null> {
  const { fs, dir } = ctx;
  const candidates = ['main.lua', 'init.lua'];
  for (const c of candidates) {
    if ((await fs.stat(`${dir}/${c}`))?.type === 'file') return c;
  }
  try {
    const entries = await fs.readdir(dir);
    const lua = entries.find(e => e.endsWith('.lua'));
    return lua || null;
  } catch { return null; }
}

async function exec(ctx: RunContext, cmd: string): Promise<number> {
  return ctx.shell.execute(
    cmd,
    (out: string) => ctx.terminal.term.write(out.replace(/\n/g, '\r\n')),
    (err: string) => ctx.terminal.term.write(`\x1b[31m${err.replace(/\n/g, '\r\n')}\x1b[0m`),
  );
}
