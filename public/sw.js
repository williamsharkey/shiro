// Shiro Virtual Server - Service Worker
// Intercepts ?PORT=N requests and routes them to virtual servers via MessageChannel

const SW_VERSION = 75;
const DEBUG = true;
const log = (...args) => DEBUG && console.log('[SW]', ...args);

// Track connections per client (tab) - Map<clientId, MessagePort>
const clientPorts = new Map();
// Track which client owns which port - Map<serverPort, clientId>
const portOwners = new Map();
// Track which clients are VIEWING which port (for routing subresources) - Map<clientId, serverPort>
const clientViewingPort = new Map();
// Track which URLs were served for which port - Map<urlPath, serverPort>
// This allows dynamic imports to be traced back to their originating port
const urlToPort = new Map();

let pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
let requestIdCounter = 0;

// Handle messages from main thread
self.addEventListener('message', (event) => {
  const { type } = event.data;
  const clientId = event.source?.id;

  if (type === 'INIT' && clientId) {
    // Main thread is setting up the MessageChannel
    const port = event.ports[0];
    clientPorts.set(clientId, port);
    port.onmessage = (e) => handleMainThreadResponse(e, clientId);
    log('Client connected:', clientId);
  }

  if (type === 'REGISTER_PORT' && clientId) {
    // A client is registering that it owns a server port
    const serverPort = event.data.port;
    portOwners.set(serverPort, clientId);
    log('Port', serverPort, 'registered to client', clientId);
  }

  if (type === 'UNREGISTER_PORT') {
    const serverPort = event.data.port;
    portOwners.delete(serverPort);
    log('Port', serverPort, 'unregistered');
  }

  if (type === 'CLEANUP' && clientId) {
    // Hot reload or shutdown - clean up this client
    log('Cleanup for client:', clientId);
    clientPorts.delete(clientId);

    // Remove any ports owned by this client
    for (const [serverPort, ownerId] of portOwners) {
      if (ownerId === clientId) {
        portOwners.delete(serverPort);
      }
    }

    // Reject pending requests from this client
    for (const [id, pending] of pendingRequests) {
      if (pending.clientId === clientId) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Server reloading'));
        pendingRequests.delete(id);
      }
    }
  }
});

function handleMainThreadResponse(event, clientId) {
  const { requestId, response, error } = event.data;
  const pending = pendingRequests.get(requestId);

  if (!pending) {
    log('Response for unknown request:', requestId);
    return;
  }

  clearTimeout(pending.timeout);
  pendingRequests.delete(requestId);

  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve(response);
  }
}

// Intercept fetch requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  let port = url.searchParams.get('PORT');
  let path = url.searchParams.get('PATH') || url.pathname;
  const clientId = event.clientId || event.resultingClientId;

  // Debug: log ALL requests to see what's not being caught
  if (url.pathname.includes('components')) {
    log('DEBUG components request:', url.pathname, 'clientId:', clientId, 'referer:', event.request.referrer);
  }

  // If navigation request with PORT, track this client as viewing that port
  if (port && event.request.mode === 'navigate') {
    if (clientId) {
      clientViewingPort.set(clientId, parseInt(port));
      log('Client', clientId, 'now viewing port', port);
    }
  }

  // If no PORT in URL, check if this client is viewing a virtual server page
  if (!port && clientId) {
    const viewingPort = clientViewingPort.get(clientId);
    if (viewingPort) {
      port = String(viewingPort);
      path = url.pathname;
      log('Subresource from viewing client:', path, 'port:', port);
    }
  }

  // Also check referer as fallback (for when clientId isn't available)
  if (!port) {
    const referer = event.request.referrer;
    if (referer) {
      try {
        const refererUrl = new URL(referer);
        const refPort = refererUrl.searchParams.get('PORT');
        if (refPort) {
          port = refPort;
          path = url.pathname;
          log('Subresource from PORT referer:', path, 'port:', port);
        } else {
          // Check if the referer path was served for a virtual server
          const refererPort = urlToPort.get(refererUrl.pathname);
          if (refererPort) {
            port = String(refererPort);
            path = url.pathname;
            log('Subresource traced via urlToPort:', path, 'referer:', refererUrl.pathname, 'port:', port);
          }
        }
      } catch {}
    }
  }

  if (!port) {
    // Not a virtual server request, let it through
    return;
  }

  // Remember that this URL is being served for this port
  // This allows dynamic imports to be traced back
  urlToPort.set(url.pathname, parseInt(port));
  log('Tracking URL', url.pathname, 'for port', port);

  log('Intercepted request for port', port, path, 'mode:', event.request.mode);
  event.respondWith(handleVirtualServerRequest(event.request, parseInt(port), path));
});

async function handleVirtualServerRequest(request, port, overridePath) {
  // Debug: show all registered ports
  log('Looking up port', port, '(type:', typeof port, ')');
  log('Registered ports:', [...portOwners.entries()].map(([k, v]) => `${k}(${typeof k})->${v}`).join(', ') || 'none');

  // Find which client owns this port
  const clientId = portOwners.get(port);

  if (!clientId) {
    return new Response(`No server registered on port ${port}. Registered: ${[...portOwners.keys()].join(', ') || 'none'}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const clientPort = clientPorts.get(clientId);

  if (!clientPort) {
    return new Response('Server tab disconnected - refresh the server tab', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const url = new URL(request.url);
  const path = overridePath || url.searchParams.get('PATH') || '/';
  const requestId = ++requestIdCounter;

  // Serialize the request
  const serializedRequest = {
    requestId,
    port,
    method: request.method,
    path,
    headers: Object.fromEntries(request.headers.entries()),
    body: request.method !== 'GET' && request.method !== 'HEAD'
      ? await request.text()
      : null,
    query: Object.fromEntries(url.searchParams.entries()),
  };

  // Remove our special params from query
  delete serializedRequest.query.PORT;
  delete serializedRequest.query.PATH;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(new Response('Virtual server timeout', { status: 504 }));
    }, 30000); // 30 second timeout

    pendingRequests.set(requestId, {
      resolve: (resp) => resolve(buildResponse(resp)),
      reject,
      timeout,
      clientId
    });

    clientPort.postMessage(serializedRequest);
  });
}

function buildResponse(resp) {
  const headers = new Headers(resp.headers || {});

  // Default content type if not set
  if (!headers.has('Content-Type')) {
    if (typeof resp.body === 'object') {
      headers.set('Content-Type', 'application/json');
    } else {
      headers.set('Content-Type', 'text/plain');
    }
  }

  let body = resp.body;
  if (typeof body === 'object' && headers.get('Content-Type')?.includes('application/json')) {
    body = JSON.stringify(body);
  }

  return new Response(body, {
    status: resp.status || 200,
    statusText: resp.statusText || 'OK',
    headers,
  });
}

// Install and activate immediately
self.addEventListener('install', (event) => {
  log('Installing SW version', SW_VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  log('Activating...');
  event.waitUntil(
    clients.claim().then(() => {
      // Ask all clients to re-register their servers
      return clients.matchAll().then(allClients => {
        log('Asking', allClients.length, 'clients to re-register');
        allClients.forEach(client => {
          client.postMessage({ type: 'RE_REGISTER' });
        });
      });
    })
  );
});
