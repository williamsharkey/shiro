// Shiro Virtual Server - Service Worker
// Intercepts ?PORT=N requests and routes them to virtual servers via MessageChannel

const DEBUG = true;
const log = (...args) => DEBUG && console.log('[SW]', ...args);

// Track connections per client (tab) - Map<clientId, MessagePort>
const clientPorts = new Map();
// Track which client owns which port - Map<serverPort, clientId>
const portOwners = new Map();

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
  const port = url.searchParams.get('PORT');

  if (!port) {
    // Not a virtual server request, let it through
    return;
  }

  log('Intercepted request for port', port, url.searchParams.get('PATH') || '/');
  event.respondWith(handleVirtualServerRequest(event.request, parseInt(port)));
});

async function handleVirtualServerRequest(request, port) {
  // Find which client owns this port
  const clientId = portOwners.get(port);

  if (!clientId) {
    return new Response(`No server registered on port ${port}`, {
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
  const path = url.searchParams.get('PATH') || '/';
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
  log('Installing...');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  log('Activating...');
  event.waitUntil(clients.claim());
});
