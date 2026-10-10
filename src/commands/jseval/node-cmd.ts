import { Command, CommandContext } from '../index';
import { runNode } from './node-run';

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
    // TABCOMPUTER_NODE_WORKER=1: as a kernel guest in a Worker (src/node-worker), unless this is that guest
    if (ctx.env.TABCOMPUTER_NODE_WORKER === '1' && !(ctx as any).nodeGuest) {
      const host = await import('../../node-worker/host');
      if (host.nodeWorkerMode(ctx.env)) return host.runNodeInWorker(ctx);
    }
    return runNode(ctx);
  },
};
