// Iframe-Based Virtual Server
// Replaces service worker approach for better compatibility with:
// - file:// protocol (no service worker support)
// - linkedom (server-side DOM testing)
// - Simpler architecture (no MessageChannel, no SW lifecycle)

export interface VirtualRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  query?: Record<string, string>;
}

export interface VirtualResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | object;
  contentType?: string;
}

export type RequestHandler = (req: VirtualRequest) => Promise<VirtualResponse> | VirtualResponse;

interface RegisteredServer {
  port: number;
  handler: RequestHandler;
  name?: string;
  iframe?: HTMLIFrameElement;
}

/**
 * IframeServer - A virtual server that renders content in iframes
 *
 * Unlike service workers, this approach:
 * - Works on file:// protocol
 * - Has no caching issues
 * - Is compatible with linkedom for testing
 * - Supports immediate cleanup (just remove the iframe)
 */
class IframeServerManager {
  private servers: Map<number, RegisteredServer> = new Map();
  private defaultContainer: HTMLElement | null = null;
  private resourceProxySetup = false;

  /**
   * Set the default container where iframes will be spawned
   */
  setDefaultContainer(container: HTMLElement): void {
    this.defaultContainer = container;
  }

  /**
   * Register a server handler on a virtual port
   */
  serve(port: number, handler: RequestHandler, name?: string): () => void {
    if (this.servers.has(port)) {
      throw new Error(`Port ${port} already in use`);
    }

    this.servers.set(port, { port, handler, name });
    console.log(`[IframeServer] Server "${name || 'unnamed'}" listening on port ${port}`);

    // Return cleanup function
    return () => this.close(port);
  }

  /**
   * Fetch content from a virtual server
   */
  async fetch(port: number, path: string = '/', options?: Partial<VirtualRequest>): Promise<VirtualResponse> {
    const server = this.servers.get(port);
    if (!server) {
      return { status: 404, body: `No server listening on port ${port}` };
    }

    // Parse query string from path
    let pathname = path;
    let query: Record<string, string> = {};
    const queryIndex = path.indexOf('?');
    if (queryIndex >= 0) {
      pathname = path.substring(0, queryIndex);
      const params = new URLSearchParams(path.substring(queryIndex + 1));
      params.forEach((value, key) => {
        query[key] = value;
      });
    }

    const request: VirtualRequest = {
      method: options?.method || 'GET',
      path: pathname,
      headers: options?.headers || {},
      body: options?.body || null,
      query,
    };

    try {
      return await server.handler(request);
    } catch (err) {
      return {
        status: 500,
        body: err instanceof Error ? err.message : 'Internal server error',
      };
    }
  }

  /**
   * Create an iframe that displays content from a virtual server
   *
   * @param port - Virtual port to connect to
   * @param container - Where to append the iframe (uses default if not specified)
   * @param options - Iframe configuration options
   */
  async createIframe(
    port: number,
    container?: HTMLElement,
    options?: {
      path?: string;
      width?: string;
      height?: string;
      style?: Partial<CSSStyleDeclaration>;
    }
  ): Promise<HTMLIFrameElement> {
    const targetContainer = container || this.defaultContainer;
    if (!targetContainer) {
      throw new Error('No container specified and no default container set');
    }

    const server = this.servers.get(port);
    if (!server) {
      throw new Error(`No server listening on port ${port}`);
    }

    // Fetch the content
    const path = options?.path || '/';
    const response = await this.fetch(port, path);

    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-virtual-port', String(port));
    iframe.setAttribute('data-virtual-path', path);

    // Apply styles
    iframe.style.border = 'none';
    iframe.style.width = options?.width || '100%';
    iframe.style.height = options?.height || '400px';
    if (options?.style) {
      Object.assign(iframe.style, options.style);
    }

    // Convert response body to HTML string
    let html: string;
    if (typeof response.body === 'string') {
      html = response.body;
    } else if (response.body instanceof Uint8Array) {
      html = new TextDecoder().decode(response.body);
    } else if (response.body && typeof response.body === 'object') {
      // JSON response - wrap in HTML
      html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>JSON</title></head>
<body><pre>${JSON.stringify(response.body, null, 2)}</pre></body>
</html>`;
    } else {
      html = '<!DOCTYPE html><html><body></body></html>';
    }

    // Setup resource proxy listener (once per page)
    this.setupResourceProxy();

    // Resource interceptor script - MUST run first to catch resource loads
    // This intercepts fetch, XHR, and dynamically added script/link/img tags
    const resourceInterceptorScript = `
<script>
(function() {
  var PORT = ${port};
  var pendingResources = new Map();
  var resourceId = 0;

  // Listen for resource responses from parent
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'vfs-resource-response' && e.data.id) {
      var pending = pendingResources.get(e.data.id);
      if (pending) {
        pendingResources.delete(e.data.id);
        pending.resolve(e.data);
      }
    }
  });

  // Request resource from parent
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
      // Timeout after 30s
      setTimeout(function() {
        if (pendingResources.has(id)) {
          pendingResources.delete(id);
          reject(new Error('Resource fetch timeout: ' + url));
        }
      }, 30000);
    });
  }

  // Override fetch
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

  // Override XMLHttpRequest
  var OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    var xhr = new OrigXHR();
    var openArgs = null;
    var origOpen = xhr.open;
    xhr.open = function(method, url) {
      openArgs = { method: method, url: url };
      if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
        // Will intercept in send()
      }
      return origOpen.apply(xhr, arguments);
    };
    var origSend = xhr.send;
    xhr.send = function(body) {
      if (openArgs && (openArgs.url.startsWith('/') || openArgs.url.startsWith('./') || openArgs.url.startsWith('../'))) {
        fetchFromParent(openArgs.url, { method: openArgs.method, body: body }).then(function(data) {
          Object.defineProperty(xhr, 'status', { value: data.status || 200 });
          Object.defineProperty(xhr, 'responseText', { value: data.body || '' });
          Object.defineProperty(xhr, 'response', { value: data.body || '' });
          Object.defineProperty(xhr, 'readyState', { value: 4 });
          if (xhr.onload) xhr.onload();
          if (xhr.onreadystatechange) xhr.onreadystatechange();
        }).catch(function(err) {
          if (xhr.onerror) xhr.onerror(err);
        });
        return;
      }
      return origSend.apply(xhr, arguments);
    };
    return xhr;
  };

  // Intercept dynamically added elements
  function loadResourceViaParent(el, attr, type) {
    var url = el.getAttribute(attr);
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('http://') || url.startsWith('https://')) {
      return;
    }
    el.removeAttribute(attr);
    fetchFromParent(url, { method: 'GET' }).then(function(data) {
      if (type === 'css') {
        var style = document.createElement('style');
        style.textContent = data.body || '';
        el.parentNode.replaceChild(style, el);
      } else if (type === 'js') {
        el.textContent = data.body || '';
      } else if (type === 'img') {
        el.src = 'data:image/png;base64,' + btoa(data.body || '');
      }
    }).catch(function(err) {
      console.error('Failed to load resource:', url, err);
    });
  }

  // MutationObserver for dynamic elements
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'SCRIPT' && node.src) loadResourceViaParent(node, 'src', 'js');
        if (node.tagName === 'LINK' && node.rel === 'stylesheet') loadResourceViaParent(node, 'href', 'css');
        if (node.tagName === 'IMG' && node.src) loadResourceViaParent(node, 'src', 'img');
      });
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Load deferred resources (converted from href/src to data-vfs-href/data-vfs-src)
  function loadDeferredResources() {
    // Load deferred stylesheets
    document.querySelectorAll('link[data-vfs-href]').forEach(function(link) {
      var href = link.getAttribute('data-vfs-href');
      link.removeAttribute('data-vfs-href');
      fetchFromParent(href, { method: 'GET' }).then(function(data) {
        var style = document.createElement('style');
        style.textContent = data.body || '';
        link.parentNode.replaceChild(style, link);
      }).catch(function(err) {
        console.error('Failed to load stylesheet:', href, err);
      });
    });

    // Load deferred scripts
    document.querySelectorAll('script[data-vfs-src]').forEach(function(script) {
      var src = script.getAttribute('data-vfs-src');
      script.removeAttribute('data-vfs-src');
      fetchFromParent(src, { method: 'GET' }).then(function(data) {
        var newScript = document.createElement('script');
        newScript.textContent = data.body || '';
        script.parentNode.replaceChild(newScript, script);
      }).catch(function(err) {
        console.error('Failed to load script:', src, err);
      });
    });

    // Load deferred ES module scripts using blob URLs
    document.querySelectorAll('script[data-vfs-module-src]').forEach(function(script) {
      var src = script.getAttribute('data-vfs-module-src');
      script.removeAttribute('data-vfs-module-src');
      fetchFromParent(src, { method: 'GET' }).then(function(data) {
        // Create blob URL with correct MIME type for ES modules
        var blob = new Blob([data.body || ''], { type: 'application/javascript' });
        var blobUrl = URL.createObjectURL(blob);
        var newScript = document.createElement('script');
        newScript.type = 'module';
        newScript.src = blobUrl;
        script.parentNode.replaceChild(newScript, script);
      }).catch(function(err) {
        console.error('Failed to load module:', src, err);
      });
    });
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadDeferredResources);
  } else {
    loadDeferredResources();
  }
})();
</script>`;

    // Navigation helper script (end of body)
    const navigationScript = `
<script>
(function() {
  // Intercept link clicks for virtual navigation
  document.addEventListener('click', function(e) {
    const link = e.target.closest('a[href]');
    if (link && link.href) {
      const href = link.getAttribute('href');
      // Only intercept relative and same-origin links
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

  // Intercept form submissions
  document.addEventListener('submit', function(e) {
    const form = e.target;
    if (form.tagName === 'FORM') {
      e.preventDefault();
      const formData = new FormData(form);
      const data = {};
      formData.forEach((value, key) => data[key] = value);
      window.parent.postMessage({
        type: 'virtual-submit',
        port: ${port},
        path: form.getAttribute('action') || '/',
        method: form.method || 'GET',
        data: data
      }, '*');
    }
  });
})();
</script>
`;

    // Pre-process HTML to defer initial resource loading
    // Convert <link href="/..."> to <link data-vfs-href="/..."> so our interceptor can load them
    // Convert <script src="/..."> to <script data-vfs-src="/..."> for the same reason
    html = html.replace(/<link([^>]*)\shref=(["'])([^"']+)\2/gi, (match, attrs, quote, href) => {
      // Only defer relative URLs
      if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) {
        return `<link${attrs} data-vfs-href=${quote}${href}${quote}`;
      }
      return match;
    });
    html = html.replace(/<script([^>]*)\ssrc=(["'])([^"']+)\2/gi, (match, attrs, quote, src) => {
      // Defer relative URLs (including type="module" scripts)
      if (src.startsWith('/') || src.startsWith('./') || src.startsWith('../')) {
        // Mark module scripts with data-vfs-module for special handling
        if (attrs.includes('type="module"') || attrs.includes("type='module'")) {
          return `<script${attrs} data-vfs-module-src=${quote}${src}${quote}`;
        }
        return `<script${attrs} data-vfs-src=${quote}${src}${quote}`;
      }
      return match;
    });

    // Inject resource interceptor at START of head (before any resources load)
    if (html.includes('<head>')) {
      html = html.replace('<head>', '<head>' + resourceInterceptorScript);
    } else if (html.includes('<html>')) {
      html = html.replace('<html>', '<html><head>' + resourceInterceptorScript + '</head>');
    } else {
      html = resourceInterceptorScript + html;
    }

    // Inject navigation script before closing body/html tag
    if (html.includes('</body>')) {
      html = html.replace('</body>', navigationScript + '</body>');
    } else if (html.includes('</html>')) {
      html = html.replace('</html>', navigationScript + '</html>');
    } else {
      html += navigationScript;
    }

    // Use srcdoc for same-origin access
    iframe.srcdoc = html;

    // Track the iframe
    server.iframe = iframe;

    // Append to container
    targetContainer.appendChild(iframe);

    // Set up message listener for navigation
    const messageHandler = async (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;

      if (event.data?.type === 'virtual-navigate' && event.data?.port === port) {
        await this.navigateIframe(port, event.data.path);
      } else if (event.data?.type === 'virtual-submit' && event.data?.port === port) {
        // Handle form submission
        const formResponse = await this.fetch(port, event.data.path, {
          method: event.data.method,
          body: JSON.stringify(event.data.data),
        });
        // Reload iframe with response
        if (typeof formResponse.body === 'string') {
          let responseHtml = formResponse.body;
          if (responseHtml.includes('</body>')) {
            responseHtml = responseHtml.replace('</body>', navigationScript + '</body>');
          }
          iframe.srcdoc = responseHtml;
        }
      }
    };

    window.addEventListener('message', messageHandler);

    // Store cleanup handler
    (iframe as any)._messageHandler = messageHandler;

    return iframe;
  }

  /**
   * Navigate an existing iframe to a new path
   */
  async navigateIframe(port: number, path: string): Promise<void> {
    const server = this.servers.get(port);
    if (!server?.iframe) {
      throw new Error(`No iframe for port ${port}`);
    }

    const response = await this.fetch(port, path);
    let html: string;

    if (typeof response.body === 'string') {
      html = response.body;
    } else if (response.body instanceof Uint8Array) {
      html = new TextDecoder().decode(response.body);
    } else {
      html = `<pre>${JSON.stringify(response.body, null, 2)}</pre>`;
    }

    // Update iframe path attribute
    server.iframe.setAttribute('data-virtual-path', path);
    server.iframe.srcdoc = html;
  }

  /**
   * Close a server and remove its iframe
   */
  close(port: number): void {
    const server = this.servers.get(port);
    if (server) {
      // Remove message handler
      if (server.iframe) {
        const handler = (server.iframe as any)._messageHandler;
        if (handler) {
          window.removeEventListener('message', handler);
        }
        server.iframe.remove();
      }

      this.servers.delete(port);
      console.log(`[IframeServer] Server on port ${port} closed`);
    }
  }

  /**
   * List all active servers
   */
  list(): { port: number; name?: string; hasIframe: boolean }[] {
    return Array.from(this.servers.values()).map(s => ({
      port: s.port,
      name: s.name,
      hasIframe: !!s.iframe,
    }));
  }

  /**
   * Check if a port is in use
   */
  isPortInUse(port: number): boolean {
    return this.servers.has(port);
  }

  /**
   * Setup the resource proxy message listener (called once)
   * This handles vfs-fetch messages from iframes and serves resources from the virtual server
   */
  private setupResourceProxy(): void {
    if (this.resourceProxySetup) return;
    this.resourceProxySetup = true;

    window.addEventListener('message', async (event: MessageEvent) => {
      if (event.data?.type !== 'vfs-fetch') return;

      const { id, port, url, method, headers, body } = event.data;
      const source = event.source as Window;

      try {
        // Fetch from the virtual server
        const response = await this.fetch(port, url, {
          method: method || 'GET',
          headers: headers || {},
          body: body || null,
        });

        // Convert response body to string
        let responseBody: string;
        if (typeof response.body === 'string') {
          responseBody = response.body;
        } else if (response.body instanceof Uint8Array) {
          responseBody = new TextDecoder().decode(response.body);
        } else if (response.body) {
          responseBody = JSON.stringify(response.body);
        } else {
          responseBody = '';
        }

        // Send response back to iframe
        source.postMessage({
          type: 'vfs-resource-response',
          id: id,
          status: response.status || 200,
          headers: response.headers || {},
          body: responseBody,
        }, '*');

      } catch (err) {
        // Send error response
        source.postMessage({
          type: 'vfs-resource-response',
          id: id,
          status: 500,
          body: `Error fetching resource: ${err}`,
        }, '*');
      }
    });

    console.log('[IframeServer] Resource proxy enabled');
  }

  /**
   * Get server info for a port
   */
  getServer(port: number): RegisteredServer | undefined {
    return this.servers.get(port);
  }

  /**
   * Clean up all servers
   */
  cleanup(): void {
    for (const [port] of this.servers) {
      this.close(port);
    }
    console.log('[IframeServer] All servers cleaned up');
  }
}

// Singleton instance
export const iframeServer = new IframeServerManager();

/**
 * Create a static file server from the virtual filesystem
 *
 * @param fs - FileSystem instance
 * @param rootDir - Root directory to serve from
 * @param options - Server options
 */
export function createStaticServer(
  fs: { readFile: (path: string) => Promise<Uint8Array | string>; stat: (path: string) => Promise<{ isDirectory(): boolean } | null> },
  rootDir: string,
  options?: {
    index?: string[];  // Default index files to look for
    mimeTypes?: Record<string, string>;
  }
): RequestHandler {
  const indexFiles = options?.index || ['index.html', 'index.htm'];
  const defaultMimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    ...options?.mimeTypes,
  };

  return async (req: VirtualRequest): Promise<VirtualResponse> => {
    let filePath = rootDir + (req.path === '/' ? '' : req.path);

    // Check if path is a directory
    try {
      const stat = await fs.stat(filePath);
      if (stat?.isDirectory()) {
        // Try index files
        for (const index of indexFiles) {
          const indexPath = filePath + (filePath.endsWith('/') ? '' : '/') + index;
          try {
            const indexStat = await fs.stat(indexPath);
            if (indexStat && !indexStat.isDirectory()) {
              filePath = indexPath;
              break;
            }
          } catch {
            // Index file doesn't exist, continue
          }
        }
      }
    } catch {
      // Path doesn't exist
    }

    try {
      const content = await fs.readFile(filePath);

      // Determine content type
      const ext = filePath.substring(filePath.lastIndexOf('.'));
      const contentType = defaultMimeTypes[ext] || 'application/octet-stream';

      return {
        status: 200,
        contentType,
        headers: { 'Content-Type': contentType },
        body: content,
      };
    } catch (err) {
      return {
        status: 404,
        contentType: 'text/html',
        body: `<!DOCTYPE html>
<html>
<head><title>404 Not Found</title></head>
<body>
<h1>404 Not Found</h1>
<p>The requested path "${req.path}" was not found.</p>
</body>
</html>`,
      };
    }
  };
}

/**
 * Express-like router for virtual servers
 */
export function createRouter() {
  const routes: {
    method: string;
    pattern: RegExp;
    keys: string[];
    handler: (req: VirtualRequest & { params: Record<string, string> }) => Promise<VirtualResponse> | VirtualResponse;
  }[] = [];

  function addRoute(method: string, path: string, handler: typeof routes[0]['handler']) {
    // Convert Express-style path to regex
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      }) + '$'
    );
    routes.push({ method, pattern, keys, handler });
  }

  const router = {
    get: (path: string, handler: typeof routes[0]['handler']) => addRoute('GET', path, handler),
    post: (path: string, handler: typeof routes[0]['handler']) => addRoute('POST', path, handler),
    put: (path: string, handler: typeof routes[0]['handler']) => addRoute('PUT', path, handler),
    delete: (path: string, handler: typeof routes[0]['handler']) => addRoute('DELETE', path, handler),
    all: (path: string, handler: typeof routes[0]['handler']) => {
      addRoute('GET', path, handler);
      addRoute('POST', path, handler);
      addRoute('PUT', path, handler);
      addRoute('DELETE', path, handler);
    },

    async handle(req: VirtualRequest): Promise<VirtualResponse> {
      for (const route of routes) {
        if (route.method !== req.method && route.method !== '*') continue;

        const match = req.path.match(route.pattern);
        if (match) {
          const params: Record<string, string> = {};
          route.keys.forEach((key, i) => {
            params[key] = match[i + 1];
          });
          return route.handler({ ...req, params });
        }
      }

      return { status: 404, body: 'Not Found' };
    },

    serve(port: number, name?: string): () => void {
      return iframeServer.serve(port, (req) => router.handle(req), name || `router:${port}`);
    },
  };

  return router;
}

// Export for window global
if (typeof window !== 'undefined') {
  (window as any).__iframeServer = iframeServer;
  (window as any).__createStaticServer = createStaticServer;
  (window as any).__createRouter = createRouter;
}
