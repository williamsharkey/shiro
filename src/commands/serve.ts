// serve.ts - Virtual HTTP server for browser-based serving
// Uses service worker to intercept ?PORT=N requests

import { Command, CommandContext } from './index';
import { virtualServer, createRouter, VirtualRequest, VirtualResponse } from '../virtual-server';

// Track active servers and their cleanup functions
const activeServers = new Map<number, {
  cleanup: () => void;
  directory?: string;
  type: 'static' | 'custom';
}>();

/**
 * Serve static files from a directory
 */
async function serveStatic(ctx: CommandContext, port: number, directory: string): Promise<number> {
  const fs = ctx.fs;
  const absDir = fs.resolvePath(directory, ctx.cwd);

  // Verify directory exists
  const stat = await fs.stat(absDir);
  if (!stat || stat.type !== 'dir') {
    ctx.stderr = `serve: ${directory}: Not a directory\n`;
    return 1;
  }

  // Make sure virtual server is ready
  await virtualServer.init();

  const handler = async (req: VirtualRequest): Promise<VirtualResponse> => {
    let filePath = req.path;
    if (filePath === '/') filePath = '/index.html';

    const fullPath = absDir + filePath;

    try {
      const stat = await fs.stat(fullPath);
      if (!stat) {
        return { status: 404, body: `Not found: ${filePath}` };
      }

      if (stat.type === 'dir') {
        // Try index.html in directory
        const indexPath = fullPath + '/index.html';
        const indexStat = await fs.stat(indexPath);
        if (indexStat) {
          const content = await fs.readFile(indexPath, 'utf8');
          return {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
            body: content as string
          };
        }

        // List directory
        const entries = await fs.readdir(fullPath);
        const html = `<!DOCTYPE html>
<html><head><title>Index of ${filePath}</title></head>
<body>
<h1>Index of ${filePath}</h1>
<ul>
${entries.map(e => `<li><a href="${filePath}/${e}">${e}</a></li>`).join('\n')}
</ul>
</body></html>`;
        return {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
          body: html
        };
      }

      const content = await fs.readFile(fullPath, 'utf8');
      const contentType = getContentType(fullPath);

      return {
        status: 200,
        headers: { 'Content-Type': contentType },
        body: content as string
      };
    } catch (err) {
      return {
        status: 500,
        body: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
      };
    }
  };

  const cleanup = virtualServer.listen(port, handler, `static:${directory}`);
  activeServers.set(port, { cleanup, directory: absDir, type: 'static' });

  const url = virtualServer.getUrl(port);
  ctx.stdout = `Serving ${directory} on port ${port}\n`;
  ctx.stdout += `Access at: ${url}\n`;
  ctx.stdout += `Use 'serve stop ${port}' to stop\n`;

  return 0;
}

function getContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    'html': 'text/html',
    'htm': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'mjs': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'txt': 'text/plain',
    'md': 'text/markdown',
    'xml': 'application/xml',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject',
  };
  return types[ext || ''] || 'application/octet-stream';
}

const SERVE_USAGE = `serve [options] [directory]
  serve <directory> [port]    Serve static files from directory (default port: 8080)
  serve stop <port>           Stop server on port
  serve list                  List active servers

Options:
  -p, --port <n>    Port number (default: 8080)

Examples:
  serve .                     Serve current directory on port 8080
  serve ./dist 3000           Serve ./dist on port 3000
  serve -p 9000 /var/www      Serve /var/www on port 9000
  serve stop 8080             Stop the server on port 8080`;

export const serveCmd: Command = {
  name: 'serve',
  description: 'Start a virtual HTTP server (browser-based)',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args.slice(1); // Remove 'serve'

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      ctx.stdout = SERVE_USAGE + '\n';
      return 0;
    }

    // serve list
    if (args[0] === 'list') {
      return listServers(ctx);
    }

    // serve stop <port>
    if (args[0] === 'stop') {
      if (args.length < 2) {
        ctx.stderr = 'serve stop: missing port number\n';
        return 1;
      }
      return stopServer(ctx, parseInt(args[1]));
    }

    // Parse options
    let port = 8080;
    let directory = '.';
    let i = 0;

    while (i < args.length) {
      if (args[i] === '-p' || args[i] === '--port') {
        port = parseInt(args[++i]);
        i++;
      } else if (!args[i].startsWith('-')) {
        directory = args[i];
        // Check if next arg is a port number
        if (args[i + 1] && /^\d+$/.test(args[i + 1])) {
          port = parseInt(args[++i]);
        }
        i++;
      } else {
        ctx.stderr = `serve: unknown option: ${args[i]}\n`;
        return 1;
      }
    }

    return serveStatic(ctx, port, directory);
  }
};

function listServers(ctx: CommandContext): number {
  const servers = virtualServer.list();
  if (servers.length === 0) {
    ctx.stdout = 'No active servers\n';
    return 0;
  }

  ctx.stdout = 'Active servers:\n';
  for (const server of servers) {
    const info = activeServers.get(server.port);
    const url = virtualServer.getUrl(server.port);
    ctx.stdout += `  :${server.port} ${info?.type || 'unknown'} ${info?.directory || ''}\n`;
    ctx.stdout += `    ${url}\n`;
  }
  return 0;
}

function stopServer(ctx: CommandContext, port: number): number {
  const info = activeServers.get(port);
  if (!info) {
    ctx.stderr = `serve: no server on port ${port}\n`;
    return 1;
  }

  info.cleanup();
  activeServers.delete(port);
  ctx.stdout = `Stopped server on port ${port}\n`;
  return 0;
}

// servers command - alias for serve list
export const serversCmd: Command = {
  name: 'servers',
  description: 'List active virtual servers',
  async exec(ctx: CommandContext): Promise<number> {
    return listServers(ctx);
  }
};
