// Virtual Server Manager
// Manages the MessageChannel connection to the service worker
// and routes incoming requests to registered server handlers

export interface VirtualRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  query: Record<string, string>;
}

export interface VirtualResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | object;
}

export type RequestHandler = (req: VirtualRequest) => Promise<VirtualResponse> | VirtualResponse;

interface RegisteredServer {
  port: number;
  handler: RequestHandler;
  name?: string;
}

class VirtualServerManager {
  private servers: Map<number, RegisteredServer> = new Map();
  private messageChannel: MessageChannel | null = null;
  private swRegistration: ServiceWorkerRegistration | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      console.warn('[VirtualServer] Service workers not supported');
      return;
    }

    // Service workers don't work on file:// protocol
    if (window.location.protocol === 'file:') {
      console.warn('[VirtualServer] Service workers not available on file:// protocol. Virtual servers disabled.');
      console.warn('[VirtualServer] To use virtual servers, serve the page over http:// or https://');
      this.initialized = true; // Mark as initialized to prevent further attempts
      return;
    }

    try {
      // Register the service worker
      const swPath = new URL('./sw.js', window.location.href).pathname;
      this.swRegistration = await navigator.serviceWorker.register(swPath, {
        scope: './'
      });

      console.log('[VirtualServer] Service worker registered');

      // Wait for the service worker to be ready
      await navigator.serviceWorker.ready;

      // Set up MessageChannel
      this.setupMessageChannel();

      this.initialized = true;
      console.log('[VirtualServer] Initialized');
    } catch (err) {
      console.error('[VirtualServer] Failed to initialize:', err);
      throw err;
    }
  }

  private setupMessageChannel(): void {
    if (!navigator.serviceWorker.controller) {
      // Service worker not yet controlling this page, wait for it
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        this.setupMessageChannel();
      });
      return;
    }

    this.messageChannel = new MessageChannel();

    // Handle incoming requests from service worker
    this.messageChannel.port1.onmessage = async (event) => {
      const { requestId, port, method, path, headers, body, query } = event.data;

      const server = this.servers.get(port);
      if (!server) {
        this.messageChannel!.port1.postMessage({
          requestId,
          error: `No server listening on port ${port}`
        });
        return;
      }

      try {
        const response = await server.handler({ method, path, headers, body, query });
        this.messageChannel!.port1.postMessage({
          requestId,
          response
        });
      } catch (err) {
        this.messageChannel!.port1.postMessage({
          requestId,
          error: err instanceof Error ? err.message : 'Handler error'
        });
      }
    };

    // Send the port to the service worker
    navigator.serviceWorker.controller.postMessage(
      { type: 'INIT' },
      [this.messageChannel.port2]
    );
  }

  /**
   * Register a server on a virtual port
   */
  listen(port: number, handler: RequestHandler, name?: string): () => void {
    if (this.servers.has(port)) {
      throw new Error(`Port ${port} already in use`);
    }

    this.servers.set(port, { port, handler, name });

    // Tell service worker this tab owns this port
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'REGISTER_PORT',
        port
      });
    }

    console.log(`[VirtualServer] Server "${name || 'unnamed'}" listening on port ${port}`);
    console.log(`[VirtualServer] Access at: ${this.getUrl(port)}`);

    // Return cleanup function
    return () => this.close(port);
  }

  /**
   * Close a server on a port
   */
  close(port: number): void {
    const server = this.servers.get(port);
    if (server) {
      this.servers.delete(port);

      // Tell service worker this port is no longer owned
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'UNREGISTER_PORT',
          port
        });
      }

      console.log(`[VirtualServer] Server on port ${port} closed`);
    }
  }

  /**
   * Get all active servers
   */
  list(): RegisteredServer[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get the URL for accessing a virtual server
   */
  getUrl(port: number, path: string = '/'): string {
    const base = window.location.origin + window.location.pathname;
    const params = new URLSearchParams();
    params.set('PORT', String(port));
    if (path !== '/') {
      params.set('PATH', path);
    }
    return `${base}?${params.toString()}`;
  }

  /**
   * Cleanup for hot reload
   */
  cleanup(): void {
    // Notify service worker to clear pending requests
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEANUP' });
    }

    // Clear local state
    this.servers.clear();
    this.messageChannel = null;
    this.initialized = false;
    this.initPromise = null;

    console.log('[VirtualServer] Cleaned up');
  }
}

// Singleton instance
export const virtualServer = new VirtualServerManager();

// Simple Express-like router helper
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

    async handle(req: VirtualRequest): Promise<VirtualResponse> {
      for (const route of routes) {
        if (route.method !== req.method) continue;

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

    listen(port: number, callback?: () => void): () => void {
      const cleanup = virtualServer.listen(port, (req) => router.handle(req), `router:${port}`);
      callback?.();
      return cleanup;
    }
  };

  return router;
}

// Export for use in Shiro's window global
if (typeof window !== 'undefined') {
  (window as any).__virtualServer = virtualServer;
  (window as any).__createRouter = createRouter;
}
