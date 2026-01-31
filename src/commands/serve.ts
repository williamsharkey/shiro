// serve.ts - Virtual HTTP server using iframe-based approach
// Replaces service worker approach for better compatibility

import { Command, CommandContext } from './index';
import { iframeServer, createStaticServer, VirtualRequest, VirtualResponse } from '../iframe-server';

// Track active servers and their cleanup functions
const activeServers = new Map<number, {
  cleanup: () => void;
  directory?: string;
  type: 'static' | 'custom';
}>();

/**
 * Serve static files from a directory
 */
async function serveStatic(ctx: CommandContext, port: number, directory: string, openIframe: boolean): Promise<number> {
  const fs = ctx.fs;
  const absDir = fs.resolvePath(directory, ctx.cwd);

  // Verify directory exists
  const stat = await fs.stat(absDir);
  if (!stat || stat.type !== 'dir') {
    ctx.stderr = `serve: ${directory}: Not a directory\n`;
    return 1;
  }

  // Check if port is already in use
  if (iframeServer.isPortInUse(port)) {
    ctx.stderr = `serve: port ${port} already in use\n`;
    ctx.stderr += `Use 'serve stop ${port}' to stop the existing server\n`;
    return 1;
  }

  // Create static file handler using the filesystem
  const handler = createStaticServer(
    {
      readFile: (path: string) => fs.readFile(path),
      stat: async (path: string) => {
        const s = await fs.stat(path);
        return s ? { isDirectory: () => s.type === 'dir' } : null;
      },
    },
    absDir,
    {
      index: ['index.html', 'index.htm'],
    }
  );

  // Register the server
  const cleanup = iframeServer.serve(port, handler, `static:${directory}`);
  activeServers.set(port, { cleanup, directory: absDir, type: 'static' });

  ctx.stdout = `Serving ${directory} on port ${port}\n`;

  // Optionally open an iframe
  if (openIframe) {
    // Get the terminal's iframe container (if available)
    const terminal = (ctx.shell as any)._terminal;
    if (terminal && typeof terminal.getIframeContainer === 'function') {
      const container = terminal.getIframeContainer();
      try {
        const iframe = await iframeServer.createIframe(port, container, {
          height: '300px',
        });
        ctx.stdout += `Iframe opened (${iframe.style.width} x ${iframe.style.height})\n`;
      } catch (err) {
        ctx.stdout += `Note: Could not open iframe: ${err instanceof Error ? err.message : 'unknown error'}\n`;
      }
    } else {
      ctx.stdout += `To view in iframe, run: serve open ${port}\n`;
    }
  }

  ctx.stdout += `Use 'serve stop ${port}' to stop\n`;
  ctx.stdout += `Use 'serve open ${port}' to open in iframe\n`;

  return 0;
}

/**
 * Open a server's content in an iframe
 */
async function openInIframe(ctx: CommandContext, port: number, path: string = '/'): Promise<number> {
  if (!iframeServer.isPortInUse(port)) {
    ctx.stderr = `serve: no server on port ${port}\n`;
    return 1;
  }

  // Get terminal's iframe container
  const terminal = (ctx.shell as any)._terminal;
  if (!terminal || typeof terminal.getIframeContainer !== 'function') {
    ctx.stderr = `serve: terminal does not support iframes\n`;
    ctx.stderr += `You can use __iframeServer.createIframe(${port}, document.body) in the browser console\n`;
    return 1;
  }

  const container = terminal.getIframeContainer();
  try {
    const iframe = await iframeServer.createIframe(port, container, {
      path,
      height: '300px',
    });
    ctx.stdout = `Opened port ${port} in iframe\n`;
    ctx.stdout += `Path: ${path}\n`;
    return 0;
  } catch (err) {
    ctx.stderr = `serve: failed to open iframe: ${err instanceof Error ? err.message : 'unknown error'}\n`;
    return 1;
  }
}

/**
 * Fetch content from a virtual server (for testing/debugging)
 */
async function fetchFromServer(ctx: CommandContext, port: number, path: string): Promise<number> {
  if (!iframeServer.isPortInUse(port)) {
    ctx.stderr = `serve: no server on port ${port}\n`;
    return 1;
  }

  const response = await iframeServer.fetch(port, path);
  ctx.stdout = `Status: ${response.status || 200}\n`;

  if (response.headers) {
    for (const [key, value] of Object.entries(response.headers)) {
      ctx.stdout += `${key}: ${value}\n`;
    }
  }

  ctx.stdout += '\n';

  if (typeof response.body === 'string') {
    ctx.stdout += response.body;
    if (!response.body.endsWith('\n')) ctx.stdout += '\n';
  } else if (response.body instanceof Uint8Array) {
    ctx.stdout += `[Binary data: ${response.body.length} bytes]\n`;
  } else if (response.body) {
    ctx.stdout += JSON.stringify(response.body, null, 2) + '\n';
  }

  return 0;
}

const SERVE_USAGE = `serve [options] [directory]
  serve <directory> [port]    Serve static files from directory (default port: 8080)
  serve stop <port>           Stop server on port
  serve list                  List active servers
  serve open <port> [path]    Open server content in iframe
  serve fetch <port> <path>   Fetch content from server (for debugging)

Options:
  -p, --port <n>    Port number (default: 8080)
  -i, --iframe      Immediately open in iframe after starting

Examples:
  serve .                     Serve current directory on port 8080
  serve ./dist 3000           Serve ./dist on port 3000
  serve -p 9000 /var/www      Serve /var/www on port 9000
  serve -i . 8080             Serve and open iframe
  serve open 8080             Open existing server in iframe
  serve fetch 8080 /          Fetch root from server
  serve stop 8080             Stop the server on port 8080`;

export const serveCmd: Command = {
  name: 'serve',
  description: 'Start a virtual HTTP server (iframe-based)',

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

    // serve open <port> [path]
    if (args[0] === 'open') {
      if (args.length < 2) {
        ctx.stderr = 'serve open: missing port number\n';
        return 1;
      }
      const port = parseInt(args[1]);
      const path = args[2] || '/';
      return openInIframe(ctx, port, path);
    }

    // serve fetch <port> <path>
    if (args[0] === 'fetch') {
      if (args.length < 3) {
        ctx.stderr = 'serve fetch: usage: serve fetch <port> <path>\n';
        return 1;
      }
      const port = parseInt(args[1]);
      const path = args[2];
      return fetchFromServer(ctx, port, path);
    }

    // Parse options
    let port = 8080;
    let directory = '.';
    let openIframe = false;
    let i = 0;

    while (i < args.length) {
      if (args[i] === '-p' || args[i] === '--port') {
        port = parseInt(args[++i]);
        i++;
      } else if (args[i] === '-i' || args[i] === '--iframe') {
        openIframe = true;
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

    return serveStatic(ctx, port, directory, openIframe);
  }
};

function listServers(ctx: CommandContext): number {
  const servers = iframeServer.list();
  if (servers.length === 0) {
    ctx.stdout = 'No active servers\n';
    return 0;
  }

  ctx.stdout = 'Active servers:\n';
  for (const server of servers) {
    const info = activeServers.get(server.port);
    ctx.stdout += `  :${server.port} ${info?.type || 'unknown'} ${info?.directory || ''}\n`;
    ctx.stdout += `    iframe: ${server.hasIframe ? 'open' : 'not open'}\n`;
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
