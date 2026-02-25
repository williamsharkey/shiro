import type { RunContext, RunnerResult } from '../types';

/**
 * Static runner: serve a directory containing index.html, then become full-screen.
 */
export async function runStatic(ctx: RunContext, serveDir?: string): Promise<RunnerResult> {
  const { shell, dir, repoName, log } = ctx;
  const target = serveDir || dir;

  log(`\x1b[36mServing static files from ${target}\x1b[0m`);

  // Pick a port (3000, or next available)
  const port = await pickPort(ctx);

  // Start the server
  const serveCode = await exec(ctx, `serve "${target}" ${port}`);
  if (serveCode !== 0) {
    return { success: false, action: 'serve', error: `serve exited with code ${serveCode}` };
  }

  log(`\x1b[32mServer running on port ${port}\x1b[0m`);

  // Enter full-screen app mode
  const becomeCode = await exec(ctx, `become ${port} ${repoName}`);
  if (becomeCode !== 0) {
    return { success: true, action: `serve:${port}`, error: 'become failed (server still running)' };
  }

  return { success: true, action: `become:${repoName}` };
}

async function exec(ctx: RunContext, cmd: string): Promise<number> {
  return ctx.shell.execute(
    cmd,
    (out: string) => ctx.terminal.term.write(out.replace(/\n/g, '\r\n')),
    (err: string) => ctx.terminal.term.write(`\x1b[31m${err.replace(/\n/g, '\r\n')}\x1b[0m`),
  );
}

async function pickPort(ctx: RunContext): Promise<number> {
  // Try 3000, then increment
  const { iframeServer } = await import('../../iframe-server');
  for (let p = 3000; p < 3100; p++) {
    if (!iframeServer.isPortInUse(p)) return p;
  }
  return 3000;
}
