import { Command, CommandContext } from '../index';
import { runNode } from './node-run';
import { nodeWorkerMode } from '../../node-worker/boot';

/**
 * node: A Node.js-like command that executes JS files from the virtual filesystem.
 *
 * Usage:
 *   node script.js
 *   node -e 'console.log("hello")'
 *   node -p '1 + 2'    (print result)
 *
 * Provides a minimal Node-like environment:
 *   - console.log/warn/error write to stdout/stderr
 *   - process.env, process.cwd(), process.exit()
 *   - require() for CommonJS modules and npm packages
 */
export const nodeCmd: Command = {
  name: 'node',
  description: 'Execute JavaScript files (browser JS VM)',
  async exec(ctx: CommandContext): Promise<number> {
    // As a kernel guest in a Worker (src/node-worker) where the page can, unless this is that
    // guest or TABCOMPUTER_NODE_WORKER=0; otherwise in the page. A terminal without a pty
    // (no keys for a guest to read) keeps it in the page, as boot.ts's nodeKernelProgram does.
    const terminal = ctx.terminal as { tty?: unknown } | undefined;
    if (!(ctx as any).nodeGuest && nodeWorkerMode(ctx.env) && !(terminal && !terminal.tty)) {
      const host = await import('../../node-worker/host');
      return host.runNodeInWorker(ctx);
    }
    return runNode(ctx);
  },
};
