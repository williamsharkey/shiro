import type { RunContext, RunnerResult } from './types';
import { detectProject } from './detect';

/**
 * Auto-detect a cloned GitHub repo's project type and run it.
 * Web apps go full-screen via become, CLI programs run in terminal.
 */
export async function detectAndRun(ctx: RunContext): Promise<RunnerResult> {
  const { fs, dir, repoName, log } = ctx;

  // Detect project type
  log(`\x1b[90mDetecting project type...\x1b[0m`);
  const detect = await detectProject(fs, dir);
  log(`\x1b[90mDetected: ${detect.kind}${detect.meta?.framework ? ` (${detect.meta.framework})` : ''}\x1b[0m`);

  if (detect.kind === 'unknown') {
    log(`\x1b[33mCould not determine project type. Try running manually.\x1b[0m`);
    return { success: false, action: 'detect', error: 'Unknown project type' };
  }

  // Dispatch to the appropriate runner
  switch (detect.kind) {
    case 'static': {
      const { runStatic } = await import('./runners/static');
      return runStatic(ctx, detect.entry);
    }

    case 'node-web':
    case 'node-cli': {
      const { runNode } = await import('./runners/node');
      return runNode(ctx, detect);
    }

    case 'python-cli':
    case 'python-web': {
      const { runPython } = await import('./runners/python');
      return runPython(ctx, detect);
    }

    case 'c': {
      const { runC } = await import('./runners/c');
      return runC(ctx, detect);
    }

    case 'lua': {
      const { runLua } = await import('./runners/lua');
      return runLua(ctx, detect);
    }

    default:
      return { success: false, action: 'dispatch', error: `No runner for ${detect.kind}` };
  }
}
