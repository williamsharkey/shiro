// serve.ts - Virtual HTTP server using iframe-based approach
// Replaces service worker approach for better compatibility

import { Command, CommandContext } from './index';
import { iframeServer, createStaticServer, VirtualRequest, VirtualResponse } from '../iframe-server';
import { createServerWindow, findServerWindow, ServerWindow } from '../server-window';

// Track active servers and their cleanup functions
const activeServers = new Map<number, {
  cleanup: () => void;
  directory?: string;
  type: 'static' | 'custom';
}>();

/** Get the active servers map (for become command) */
export function getActiveServers() { return activeServers; }

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

  // Optionally open in windowed iframe
  if (openIframe) {
    const openResult = await openInIframe(ctx, port, '/');
    if (openResult !== 0) {
      ctx.stdout += `Note: Could not open window\n`;
    }
  }

  ctx.stdout += `Use 'serve stop ${port}' to stop\n`;
  ctx.stdout += `Use 'serve open ${port}' to open in iframe\n`;

  return 0;
}

/**
 * Open a server's content in a windowed iframe (macOS-style)
 */
async function openInIframe(ctx: CommandContext, port: number, path: string = '/'): Promise<number> {
  if (!iframeServer.isPortInUse(port)) {
    ctx.stderr = `serve: no server on port ${port}\n`;
    return 1;
  }

  // Check if window already exists for this port
  const existing = findServerWindow(port);
  if (existing) {
    // Update the existing window's iframe
    try {
      await iframeServer.navigateIframe(port, path);
      ctx.stdout = `Navigated to ${path}\n`;
      return 0;
    } catch {
      // Window exists but iframe not tracked - close and reopen
      existing.close();
    }
  }

  // Get directory info for title
  const serverInfo = activeServers.get(port);
  const directory = serverInfo?.directory;

  try {
    // Create the windowed UI
    const serverWindow = createServerWindow({
      port,
      path,
      directory,
      width: '36em',
      height: '24em',
      container: document.body,
      onBecome: (p) => {
        const info = activeServers.get(p);
        const dir = info?.directory || '/tmp';
        const slug = dir.split('/').filter(Boolean).pop() || 'app';
        // Dynamic import to avoid circular dependency
        import('./become').then(({ activateBecomeMode }) => {
          activateBecomeMode({ directory: dir, port: p, slug, title: slug.charAt(0).toUpperCase() + slug.slice(1) });
        });
      },
    });

    // Fetch content and set up iframe
    const response = await iframeServer.fetch(port, path);
    let html: string;

    if (typeof response.body === 'string') {
      html = response.body;
    } else if (response.body instanceof Uint8Array) {
      html = new TextDecoder().decode(response.body);
    } else if (response.body && typeof response.body === 'object') {
      html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>JSON</title></head>
<body><pre>${JSON.stringify(response.body, null, 2)}</pre></body>
</html>`;
    } else {
      html = '<!DOCTYPE html><html><body></body></html>';
    }

    // Inject resource interceptor and navigation scripts
    html = injectIframeScripts(html, port);

    // Set iframe content
    serverWindow.iframe.srcdoc = html;

    // Track the iframe in iframeServer for navigation
    const server = iframeServer.getServer(port);
    if (server) {
      (server as any).iframe = serverWindow.iframe;
    }

    // Set up message listener for navigation
    const messageHandler = async (event: MessageEvent) => {
      if (event.source !== serverWindow.iframe.contentWindow) return;

      if (event.data?.type === 'virtual-navigate' && event.data?.port === port) {
        // Navigate and update window
        const newPath = event.data.path;
        const navResponse = await iframeServer.fetch(port, newPath);
        let navHtml = typeof navResponse.body === 'string'
          ? navResponse.body
          : navResponse.body instanceof Uint8Array
            ? new TextDecoder().decode(navResponse.body)
            : '';
        navHtml = injectIframeScripts(navHtml, port);
        serverWindow.iframe.srcdoc = navHtml;
        serverWindow.iframe.setAttribute('data-virtual-path', newPath);
        serverWindow.setTitle(directory ? `${directory}:${port}${newPath}` : `localhost:${port}${newPath}`);
      }
    };

    window.addEventListener('message', messageHandler);

    // Store cleanup handler
    const origClose = serverWindow.close;
    serverWindow.close = () => {
      window.removeEventListener('message', messageHandler);
      origClose();
    };

    ctx.stdout = `Opened port ${port} in window\n`;
    ctx.stdout += `Path: ${path}\n`;
    return 0;
  } catch (err) {
    ctx.stderr = `serve: failed to open window: ${err instanceof Error ? err.message : 'unknown error'}\n`;
    return 1;
  }
}

/**
 * Inject resource interceptor and navigation scripts into HTML
 */
export function injectIframeScripts(html: string, port: number): string {
  const resourceInterceptorScript = `
<script>
(function() {
  var PORT = ${port};
  var pendingResources = new Map();
  var resourceId = 0;

  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'vfs-resource-response' && e.data.id) {
      var pending = pendingResources.get(e.data.id);
      if (pending) {
        pendingResources.delete(e.data.id);
        pending.resolve(e.data);
      }
    }
  });

  function fetchFromParent(url, options) {
    return new Promise(function(resolve, reject) {
      var id = 'res_' + (++resourceId);
      pendingResources.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage({
        type: 'vfs-fetch',
        id: id,
        port: PORT,
        url: url,
        method: (options && options.method) || 'GET',
        headers: options && options.headers,
        body: options && options.body
      }, '*');
      setTimeout(function() {
        if (pendingResources.has(id)) {
          pendingResources.delete(id);
          reject(new Error('Resource fetch timeout: ' + url));
        }
      }, 30000);
    });
  }

  var originalFetch = window.fetch;
  window.fetch = function(url, options) {
    var urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.startsWith('/') || urlStr.startsWith('./') || urlStr.startsWith('../')) {
      return fetchFromParent(urlStr, options).then(function(data) {
        return new Response(data.body, {
          status: data.status || 200,
          headers: data.headers || {}
        });
      });
    }
    return originalFetch.apply(this, arguments);
  };

  // Intercept dynamically added elements
  function loadResourceViaParent(el, attr, type) {
    var url = el.getAttribute(attr);
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('http://') || url.startsWith('https://')) return;
    el.removeAttribute(attr);
    fetchFromParent(url, { method: 'GET' }).then(function(data) {
      if (type === 'css') {
        var style = document.createElement('style');
        style.textContent = data.body || '';
        el.parentNode.replaceChild(style, el);
      } else if (type === 'js') {
        el.textContent = data.body || '';
      }
    }).catch(function(err) { console.error('Failed to load resource:', url, err); });
  }

  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'SCRIPT' && node.src) loadResourceViaParent(node, 'src', 'js');
        if (node.tagName === 'LINK' && node.rel === 'stylesheet') loadResourceViaParent(node, 'href', 'css');
      });
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  function loadDeferredResources() {
    document.querySelectorAll('link[data-vfs-href]').forEach(function(link) {
      var href = link.getAttribute('data-vfs-href');
      link.removeAttribute('data-vfs-href');
      fetchFromParent(href, { method: 'GET' }).then(function(data) {
        var style = document.createElement('style');
        style.textContent = data.body || '';
        link.parentNode.replaceChild(style, link);
      }).catch(function(err) { console.error('Failed to load stylesheet:', href, err); });
    });

    document.querySelectorAll('script[data-vfs-src]').forEach(function(script) {
      var src = script.getAttribute('data-vfs-src');
      script.removeAttribute('data-vfs-src');
      fetchFromParent(src, { method: 'GET' }).then(function(data) {
        var newScript = document.createElement('script');
        newScript.textContent = data.body || '';
        script.parentNode.replaceChild(newScript, script);
      }).catch(function(err) { console.error('Failed to load script:', src, err); });
    });

    // Recursive ES module loader
    var blobCache = {};
    var pendingModules = {};

    function resolveModulePath(base, relative) {
      if (relative.startsWith('/')) return relative;
      var baseParts = base.split('/').slice(0, -1);
      var relParts = relative.split('/');
      for (var i = 0; i < relParts.length; i++) {
        if (relParts[i] === '..') baseParts.pop();
        else if (relParts[i] !== '.') baseParts.push(relParts[i]);
      }
      return '/' + baseParts.filter(Boolean).join('/');
    }

    function extractImports(code) {
      var imports = [];
      var regex = /(?:import|export)\\s+(?:[^'"]*\\s+from\\s+)?['"]([^'"]+)['"]|import\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g;
      var match;
      while ((match = regex.exec(code)) !== null) {
        var path = match[1] || match[2];
        if (path && (path.startsWith('./') || path.startsWith('../') || (path.startsWith('/') && !path.startsWith('//')))) {
          imports.push(path);
        }
      }
      return imports;
    }

    function loadModuleRecursive(modulePath) {
      if (blobCache[modulePath]) return Promise.resolve(blobCache[modulePath]);
      if (pendingModules[modulePath]) return pendingModules[modulePath];

      var promise = fetchFromParent(modulePath, { method: 'GET' }).then(function(data) {
        var code = data.body || '';
        var imports = extractImports(code);

        if (imports.length === 0) {
          var blob = new Blob([code], { type: 'application/javascript' });
          var blobUrl = URL.createObjectURL(blob);
          blobCache[modulePath] = blobUrl;
          return blobUrl;
        }

        return Promise.all(imports.map(function(imp) {
          var resolvedPath = resolveModulePath(modulePath, imp);
          return loadModuleRecursive(resolvedPath).then(function(blobUrl) {
            return { original: imp, blobUrl: blobUrl };
          });
        })).then(function(resolved) {
          var rewrittenCode = code;
          resolved.forEach(function(r) {
            rewrittenCode = rewrittenCode.split('"' + r.original + '"').join('"' + r.blobUrl + '"');
            rewrittenCode = rewrittenCode.split("'" + r.original + "'").join("'" + r.blobUrl + "'");
          });
          var blob = new Blob([rewrittenCode], { type: 'application/javascript' });
          var blobUrl = URL.createObjectURL(blob);
          blobCache[modulePath] = blobUrl;
          return blobUrl;
        });
      });

      pendingModules[modulePath] = promise;
      return promise;
    }

    document.querySelectorAll('script[data-vfs-module-src]').forEach(function(script) {
      var src = script.getAttribute('data-vfs-module-src');
      script.removeAttribute('data-vfs-module-src');
      loadModuleRecursive(src).then(function(blobUrl) {
        var newScript = document.createElement('script');
        newScript.type = 'module';
        newScript.src = blobUrl;
        script.parentNode.replaceChild(newScript, script);
      }).catch(function(err) { console.error('Failed to load module:', src, err); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadDeferredResources);
  } else {
    loadDeferredResources();
  }
})();
</script>`;

  const navigationScript = `
<script>
(function() {
  document.addEventListener('click', function(e) {
    const link = e.target.closest('a[href]');
    if (link && link.href) {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('//')) {
        e.preventDefault();
        window.parent.postMessage({
          type: 'virtual-navigate',
          port: ${port},
          path: href
        }, '*');
      }
    }
  });
})();
</script>`;

  // Rewrite <link href="/..."> and <script src="/..."> to deferred loading
  html = html.replace(/<link([^>]*)\shref=(["'])([^"']+)\2/gi, (match, attrs, quote, href) => {
    if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) {
      return `<link${attrs} data-vfs-href=${quote}${href}${quote}`;
    }
    return match;
  });
  html = html.replace(/<script([^>]*)\ssrc=(["'])([^"']+)\2/gi, (match, attrs, quote, src) => {
    if (src.startsWith('/') || src.startsWith('./') || src.startsWith('../')) {
      if (attrs.includes('type="module"') || attrs.includes("type='module'")) {
        return `<script${attrs} data-vfs-module-src=${quote}${src}${quote}`;
      }
      return `<script${attrs} data-vfs-src=${quote}${src}${quote}`;
    }
    return match;
  });

  // Inject scripts
  if (html.includes('<head>')) {
    html = html.replace('<head>', '<head>' + resourceInterceptorScript);
  } else if (html.includes('<html>')) {
    html = html.replace('<html>', '<html><head>' + resourceInterceptorScript + '</head>');
  } else {
    html = resourceInterceptorScript + html;
  }

  if (html.includes('</body>')) {
    html = html.replace('</body>', navigationScript + '</body>');
  } else if (html.includes('</html>')) {
    html = html.replace('</html>', navigationScript + '</html>');
  } else {
    html += navigationScript;
  }

  return html;
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
    const args = ctx.args; // ctx.args doesn't include command name

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
  // Close server window if exists
  const serverWindow = findServerWindow(port);
  if (serverWindow) {
    serverWindow.close();
  }

  // Check if we have local info (server started via serve command)
  const info = activeServers.get(port);
  if (info) {
    info.cleanup();
    activeServers.delete(port);
    ctx.stdout = `Stopped server on port ${port}\n`;
    return 0;
  }

  // Also handle servers started via node/express (not tracked in activeServers)
  if (iframeServer.isPortInUse(port)) {
    iframeServer.close(port);
    ctx.stdout = `Stopped server on port ${port}\n`;
    return 0;
  }

  ctx.stderr = `serve: no server on port ${port}\n`;
  return 1;
}

// servers command - alias for serve list
export const serversCmd: Command = {
  name: 'servers',
  description: 'List active virtual servers',
  async exec(ctx: CommandContext): Promise<number> {
    return listServers(ctx);
  }
};
