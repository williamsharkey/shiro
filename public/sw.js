// Shiro Virtual Server - Service Worker
// Intercepts ?PORT=N requests and routes them to virtual servers via MessageChannel

const DEBUG = true;
const log = (...args) => DEBUG && console.log('[SW]', ...args);

// Track active connections to main thread
let mainThreadPort = null;
let pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
let requestIdCounter = 0;

// Handle messages from main thread
self.addEventListener('message', (event) => {
  const { type, data } = event.data;

  if (type === 'INIT') {
    // Main thread is setting up the MessageChannel
    mainThreadPort = event.ports[0];
    mainThreadPort.onmessage = handleMainThreadResponse;
    log('Connected to main thread');
  }

  if (type === 'CLEANUP') {
    // Hot reload or shutdown - clear pending requests
    log('Cleanup requested');
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Server reloading'));
    }
    pendingRequests.clear();
    mainThreadPort = null;
  }
});

function handleMainThreadResponse(event) {
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
  if (!mainThreadPort) {
    return new Response('Shiro not connected - refresh the page', {
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
      timeout
    });

    mainThreadPort.postMessage(serializedRequest);
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
