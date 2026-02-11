// skyeyes.js - Browser-side bridge for remote JS execution
// Injected into proxied GitHub Pages iframes by Nimbus server.
// Connects via WebSocket to allow Claude workers to execute JS in the page context.
(function () {
  "use strict";

  // Get script tag - document.currentScript can be null after dynamic loads or reloads
  let scriptTag = document.currentScript;
  if (!scriptTag) {
    // Fallback: find script tag by data-page attribute (handles reload edge cases)
    scriptTag = document.querySelector('script[data-page]');
  }
  const page = scriptTag?.getAttribute("data-page") || "unknown";
  const wsHost = scriptTag?.getAttribute("data-ws") || location.host;
  const wsUrl = `ws://${wsHost}/skyeyes?page=${encodeURIComponent(page)}`;

  // Log page ID for debugging reconnection issues
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };
  originalConsole.log(`[skyeyes] Initializing with page="${page}", wsUrl="${wsUrl}"`);

  let ws = null;
  let reconnectTimer = null;
  let isConnecting = false;
  let heartbeatTimer = null;
  let messageQueue = [];
  const RECONNECT_DELAY = 2000;
  const HEARTBEAT_INTERVAL = 5000; // Send ping every 5 seconds

  // Performance monitoring and health metrics
  const healthMetrics = {
    connectTime: Date.now(),
    reconnectCount: 0,
    totalMessages: 0,
    totalErrors: 0,
    lastPingTime: null,
    lastPongTime: null,
    latency: null,
    executions: {
      eval: { count: 0, totalTime: 0, errors: 0 },
      terminal: { count: 0, totalTime: 0, errors: 0 },
      dom: { count: 0, totalTime: 0, errors: 0 },
      batch: { count: 0, totalTime: 0, errors: 0 },
      file: { count: 0, totalTime: 0, errors: 0 },
    }
  };

  // Network Interception Layer - Capture HTTP requests
  const networkLog = [];
  const MAX_NETWORK_LOG_SIZE = 100;
  const MAX_BODY_LENGTH = 1000; // Truncate bodies to 1KB

  // Store original fetch and XMLHttpRequest
  const originalFetch = window.fetch;
  const OriginalXHR = window.XMLHttpRequest;

  // Intercept fetch
  window.fetch = function(...args) {
    const startTime = Date.now();
    const url = args[0] instanceof Request ? args[0].url : args[0];
    const init = args[0] instanceof Request ? args[0] : args[1] || {};
    const method = (args[0] instanceof Request ? args[0].method : init.method) || 'GET';

    const logEntry = {
      id: networkLog.length + 1,
      type: 'fetch',
      url,
      method,
      timestamp: startTime,
      status: null,
      statusText: null,
      duration: null,
      requestHeaders: {},
      responseHeaders: {},
      requestBody: null,
      responseBody: null,
      error: null,
    };

    // Capture request headers
    if (args[0] instanceof Request) {
      args[0].headers.forEach((value, key) => {
        logEntry.requestHeaders[key] = value;
      });
    } else if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          logEntry.requestHeaders[key] = value;
        });
      } else {
        logEntry.requestHeaders = { ...init.headers };
      }
    }

    // Capture request body (if present)
    if (init.body) {
      try {
        logEntry.requestBody = truncateString(String(init.body), MAX_BODY_LENGTH);
      } catch (e) {
        logEntry.requestBody = '[Unable to stringify body]';
      }
    }

    // Call original fetch
    return originalFetch.apply(this, args)
      .then(async (response) => {
        const duration = Date.now() - startTime;
        logEntry.status = response.status;
        logEntry.statusText = response.statusText;
        logEntry.duration = duration;

        // Capture response headers
        response.headers.forEach((value, key) => {
          logEntry.responseHeaders[key] = value;
        });

        // Clone response to read body without consuming it
        const clone = response.clone();
        try {
          const text = await clone.text();
          logEntry.responseBody = truncateString(text, MAX_BODY_LENGTH);
        } catch (e) {
          logEntry.responseBody = '[Unable to read response body]';
        }

        addToNetworkLog(logEntry);
        return response;
      })
      .catch((error) => {
        const duration = Date.now() - startTime;
        logEntry.duration = duration;
        logEntry.error = error.message || String(error);
        addToNetworkLog(logEntry);
        throw error;
      });
  };

  // Intercept XMLHttpRequest
  window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    const logEntry = {
      id: networkLog.length + 1,
      type: 'xhr',
      url: null,
      method: null,
      timestamp: Date.now(),
      status: null,
      statusText: null,
      duration: null,
      requestHeaders: {},
      responseHeaders: {},
      requestBody: null,
      responseBody: null,
      error: null,
    };

    let startTime = null;

    // Intercept open
    const originalOpen = xhr.open;
    xhr.open = function(method, url, ...rest) {
      logEntry.method = method;
      logEntry.url = url;
      startTime = Date.now();
      logEntry.timestamp = startTime;
      return originalOpen.call(this, method, url, ...rest);
    };

    // Intercept setRequestHeader
    const originalSetRequestHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function(name, value) {
      logEntry.requestHeaders[name] = value;
      return originalSetRequestHeader.call(this, name, value);
    };

    // Intercept send
    const originalSend = xhr.send;
    xhr.send = function(body) {
      if (body) {
        try {
          logEntry.requestBody = truncateString(String(body), MAX_BODY_LENGTH);
        } catch (e) {
          logEntry.requestBody = '[Unable to stringify body]';
        }
      }
      return originalSend.call(this, body);
    };

    // Listen for completion
    xhr.addEventListener('load', function() {
      const duration = Date.now() - startTime;
      logEntry.status = xhr.status;
      logEntry.statusText = xhr.statusText;
      logEntry.duration = duration;

      // Capture response headers
      const headerString = xhr.getAllResponseHeaders();
      const headers = headerString.split('\r\n');
      for (const header of headers) {
        const [key, value] = header.split(': ');
        if (key) logEntry.responseHeaders[key] = value;
      }

      // Capture response body
      try {
        logEntry.responseBody = truncateString(xhr.responseText, MAX_BODY_LENGTH);
      } catch (e) {
        logEntry.responseBody = '[Unable to read response]';
      }

      addToNetworkLog(logEntry);
    });

    xhr.addEventListener('error', function() {
      const duration = Date.now() - startTime;
      logEntry.duration = duration;
      logEntry.error = 'Network error';
      addToNetworkLog(logEntry);
    });

    xhr.addEventListener('timeout', function() {
      const duration = Date.now() - startTime;
      logEntry.duration = duration;
      logEntry.error = 'Request timeout';
      addToNetworkLog(logEntry);
    });

    return xhr;
  };

  // Copy static properties from original XHR
  Object.setPrototypeOf(window.XMLHttpRequest.prototype, OriginalXHR.prototype);
  Object.setPrototypeOf(window.XMLHttpRequest, OriginalXHR);

  // Helper: Add entry to network log
  function addToNetworkLog(entry) {
    networkLog.push(entry);
    // Limit log size
    if (networkLog.length > MAX_NETWORK_LOG_SIZE) {
      networkLog.shift();
    }
  }

  // Helper: Truncate string to max length
  function truncateString(str, maxLength) {
    if (!str) return null;
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '... [truncated]';
  }

  // Monkey-patch console to forward output (originalConsole defined above)

  function forwardConsole(level, args) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        const serialized = Array.from(args).map((a) => {
          try {
            return typeof a === "object" ? JSON.stringify(a) : String(a);
          } catch {
            return String(a);
          }
        });
        ws.send(JSON.stringify({ type: "skyeyes_console", level, args: serialized }));
      } catch {}
    }
  }

  ["log", "warn", "error", "info"].forEach((level) => {
    console[level] = function (...args) {
      originalConsole[level](...args);
      forwardConsole(level, args);
    };
  });

  // Capture uncaught errors
  window.addEventListener("error", (e) => {
    forwardConsole("error", [`Uncaught: ${e.message} at ${e.filename}:${e.lineno}`]);
  });

  window.addEventListener("unhandledrejection", (e) => {
    forwardConsole("error", [`Unhandled rejection: ${e.reason}`]);
  });

  function connect() {
    if (isConnecting) {
      return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    isConnecting = true;
    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      isConnecting = false;
      originalConsole.log(`[skyeyes] Connected as "${page}"`);
      ws.send(JSON.stringify({ type: "skyeyes_ready", page }));

      // Set shell username from page ID (e.g. "shiro-spirit" → USER=spirit)
      var dashIdx = page.indexOf("-");
      if (dashIdx !== -1) {
        var username = page.substring(dashIdx + 1);
        function trySetUser() {
          var set = false;
          if (window.__shiro && window.__shiro.shell) {
            window.__shiro.shell.env.USER = username;
            // Redraw prompt with new username
            if (window.__shiro.terminal) {
              window.__shiro.terminal.redrawLine();
            }
            set = true;
          }
          if (window.__foam && window.__foam.shell) {
            window.__foam.shell.vfs.env.USER = username;
            // Redraw prompt with new username
            if (window.__foam.terminal) {
              window.__foam.terminal._updatePrompt();
            }
            set = true;
          }
          return set;
        }
        if (!trySetUser()) {
          // Shell may not be ready yet — retry a few times
          var attempts = 0;
          var retryInterval = setInterval(function() {
            attempts++;
            if (trySetUser() || attempts >= 10) {
              clearInterval(retryInterval);
            }
          }, 500);
        }
      }

      // Start heartbeat
      startHeartbeat();

      // Send any queued messages
      flushMessageQueue();
    };

    ws.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        healthMetrics.totalMessages++;

        if (msg.type === "pong") {
          // Server acknowledged our ping - calculate latency
          healthMetrics.lastPongTime = Date.now();
          if (healthMetrics.lastPingTime) {
            healthMetrics.latency = healthMetrics.lastPongTime - healthMetrics.lastPingTime;
          }
          return;
        } else if (msg.type === "eval") {
          executeEval(msg.id, msg.code, msg.timeout);
        } else if (msg.type === "terminal_exec") {
          executeTerminalCommand(msg.id, msg.command, msg.timeout);
        } else if (msg.type === "terminal_read") {
          readTerminalOutput(msg.id);
        } else if (msg.type === "terminal_status") {
          getTerminalStatus(msg.id);
        } else if (msg.type === "dom_snapshot") {
          getDOMSnapshot(msg.id, msg.options);
        } else if (msg.type === "query_selector") {
          querySelector(msg.id, msg.selector, msg.all);
        } else if (msg.type === "element_click") {
          elementClick(msg.id, msg.selector);
        } else if (msg.type === "element_type") {
          elementType(msg.id, msg.selector, msg.text, msg.options);
        } else if (msg.type === "element_scroll") {
          elementScroll(msg.id, msg.selector, msg.options);
        } else if (msg.type === "batch_eval") {
          executeBatchEval(msg.id, msg.commands, msg.timeout);
        } else if (msg.type === "file_upload") {
          fileUpload(msg.id, msg.path, msg.content, msg.options);
        } else if (msg.type === "file_download") {
          fileDownload(msg.id, msg.path);
        } else if (msg.type === "diagnostics") {
          getDiagnostics(msg.id);
        } else if (msg.type === "session_create") {
          createTerminalSession(msg.id, msg.name, msg.options);
        } else if (msg.type === "session_list") {
          listTerminalSessions(msg.id);
        } else if (msg.type === "session_attach") {
          attachTerminalSession(msg.id, msg.sessionId);
        } else if (msg.type === "session_detach") {
          detachTerminalSession(msg.id, msg.sessionId);
        } else if (msg.type === "session_exec") {
          executeInSession(msg.id, msg.sessionId, msg.command, msg.timeout);
        } else if (msg.type === "session_kill") {
          killTerminalSession(msg.id, msg.sessionId);
        } else if (msg.type === "element_paste") {
          elementPaste(msg.id, msg.selector, msg.text);
        } else if (msg.type === "element_keypress") {
          elementKeypress(msg.id, msg.selector, msg.key, msg.options);
        } else if (msg.type === "element_focus") {
          elementFocus(msg.id, msg.selector);
        } else if (msg.type === "visual_snapshot") {
          getVisualSnapshot(msg.id, msg.options);
        } else if (msg.type === "snapshot_capture") {
          captureSnapshot(msg.id, msg.snapshotId, msg.options);
        } else if (msg.type === "snapshot_diff") {
          computeSnapshotDiff(msg.id, msg.beforeId, msg.afterId);
        } else if (msg.type === "snapshot_list") {
          listSnapshots(msg.id);
        } else if (msg.type === "snapshot_clear") {
          clearSnapshots(msg.id, msg.snapshotId);
        } else if (msg.type === "accessibility_tree") {
          getAccessibilityTree(msg.id, msg.options);
        } else if (msg.type === "network_log") {
          getNetworkLog(msg.id, msg.options);
        } else if (msg.type === "network_clear") {
          clearNetworkLog(msg.id);
        } else if (msg.type === "mutation_start") {
          startMutationObserver(msg.id, msg.options);
        } else if (msg.type === "mutation_stop") {
          stopMutationObserver(msg.id);
        } else if (msg.type === "mutation_log") {
          getMutationLog(msg.id, msg.options);
        } else if (msg.type === "mutation_clear") {
          clearMutationLog(msg.id);
        } else if (msg.type === "performance_start") {
          startPerformanceMonitoring(msg.id, msg.options);
        } else if (msg.type === "performance_stop") {
          stopPerformanceMonitoring(msg.id);
        } else if (msg.type === "performance_metrics") {
          getPerformanceMetrics(msg.id, msg.options);
        } else if (msg.type === "performance_clear") {
          clearPerformanceLog(msg.id);
        } else if (msg.type === "performance_snapshot") {
          getPerformanceSnapshot(msg.id);
        } else if (msg.type === "screenshot_capture") {
          captureScreenshot(msg.id, msg.options);
        } else if (msg.type === "screenshot_get") {
          getScreenshot(msg.id, msg.screenshotId);
        } else if (msg.type === "screenshot_list") {
          listScreenshots(msg.id);
        } else if (msg.type === "screenshot_clear") {
          clearScreenshots(msg.id, msg.screenshotId);
        } else if (msg.type === "screenshot_compare") {
          compareScreenshots(msg.id, msg.screenshot1Id, msg.screenshot2Id);
        } else if (msg.type === "storage_usage") {
          getStorageUsage(msg.id);
        } else if (msg.type === "storage_start") {
          startStorageMonitoring(msg.id, msg.options);
        } else if (msg.type === "storage_stop") {
          stopStorageMonitoring(msg.id);
        } else if (msg.type === "storage_log") {
          getStorageLog(msg.id, msg.options);
        } else if (msg.type === "storage_clear_log") {
          clearStorageLog(msg.id);
        } else if (msg.type === "storage_set") {
          setStorageItem(msg.id, msg.storageType, msg.key, msg.value);
        } else if (msg.type === "storage_get") {
          getStorageItem(msg.id, msg.storageType, msg.key);
        } else if (msg.type === "storage_remove") {
          removeStorageItem(msg.id, msg.storageType, msg.key);
        } else if (msg.type === "storage_clear") {
          clearStorage(msg.id, msg.storageType);
        }
      } catch (err) {
        originalConsole.error("[skyeyes] Failed to parse message:", err);
        healthMetrics.totalErrors++;
      }
    };

    ws.onclose = function () {
      isConnecting = false;
      stopHeartbeat();
      healthMetrics.reconnectCount++;
      originalConsole.log("[skyeyes] Disconnected, reconnecting...");
      scheduleReconnect();
    };

    ws.onerror = function () {
      isConnecting = false;
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY);
  }

  function startHeartbeat() {
    stopHeartbeat(); // Clear any existing timer
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          healthMetrics.lastPingTime = Date.now();
          ws.send(JSON.stringify({ type: "ping", page, timestamp: healthMetrics.lastPingTime }));
        } catch (err) {
          originalConsole.error("[skyeyes] Failed to send ping:", err);
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function queueMessage(message) {
    messageQueue.push({
      message,
      timestamp: Date.now(),
    });
    // Limit queue size to prevent memory issues
    if (messageQueue.length > 100) {
      messageQueue.shift(); // Remove oldest message
    }
  }

  function flushMessageQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const queue = messageQueue.slice(); // Copy queue
    messageQueue = []; // Clear original queue

    for (const item of queue) {
      try {
        ws.send(JSON.stringify(item.message));
        originalConsole.log(`[skyeyes] Sent queued message from ${item.timestamp}`);
      } catch (err) {
        originalConsole.error("[skyeyes] Failed to send queued message:", err);
        // Re-queue failed message
        queueMessage(item.message);
      }
    }
  }

  function executeEval(id, code, timeout) {
    const startTime = Date.now();
    healthMetrics.executions.eval.count++;
    let result = null;
    let error = null;

    try {
      // Execute in the page's global scope
      result = new Function(code)();

      // Handle promises with optional timeout
      if (result && typeof result.then === "function") {
        const timeoutMs = timeout || 30000; // Default 30s timeout
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Execution timeout after ${timeoutMs}ms`)), timeoutMs);
        });

        Promise.race([result, timeoutPromise])
          .then((resolved) => {
            const duration = Date.now() - startTime;
            healthMetrics.executions.eval.totalTime += duration;
            sendResultWithTiming(id, serialize(resolved), null, startTime);
          })
          .catch((err) => {
            const duration = Date.now() - startTime;
            healthMetrics.executions.eval.totalTime += duration;
            healthMetrics.executions.eval.errors++;
            healthMetrics.totalErrors++;
            sendResultWithTiming(id, null, serializeError(err), startTime);
          });
        return;
      }

      result = serialize(result);
    } catch (err) {
      error = serializeError(err);
      healthMetrics.executions.eval.errors++;
      healthMetrics.totalErrors++;
    }

    const duration = Date.now() - startTime;
    healthMetrics.executions.eval.totalTime += duration;
    sendResultWithTiming(id, result, error, startTime);
  }

  function serialize(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value instanceof HTMLElement) return value.outerHTML.substring(0, 2000);
    if (value instanceof NodeList || value instanceof HTMLCollection) {
      return `[${Array.from(value).length} elements]`;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function serializeError(err) {
    // Create structured error with stack trace
    const errorObj = {
      message: err.message || String(err),
      name: err.name || 'Error',
      stack: err.stack || null,
      type: err.constructor?.name || 'Error',
      timestamp: Date.now(),
    };

    // Add additional error properties if available
    if (err.fileName) errorObj.fileName = err.fileName;
    if (err.lineNumber) errorObj.lineNumber = err.lineNumber;
    if (err.columnNumber) errorObj.columnNumber = err.columnNumber;

    // Return as JSON string for sendResult
    try {
      return JSON.stringify(errorObj);
    } catch {
      return String(err);
    }
  }

  function sendResult(id, result, error) {
    sendResultWithTiming(id, result, error, null);
  }

  function sendResultWithTiming(id, result, error, startTime) {
    const timing = startTime ? {
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    } : null;

    const message = {
      type: "skyeyes_result",
      id,
      result,
      error,
      timing
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        originalConsole.error("[skyeyes] Failed to send result, queuing:", err);
        queueMessage(message);
      }
    } else {
      // Queue message for later delivery
      originalConsole.log("[skyeyes] WebSocket not ready, queuing result");
      queueMessage(message);
    }
  }

  // Terminal command execution with timeout and exit code detection
  let terminalState = {
    lastCommand: null,
    lastOutput: '',
    lastError: '',
    exitCode: null,
    isReady: true,
    startTime: null,
  };

  // Multiplexed terminal sessions (like tmux)
  const terminalSessions = new Map();
  let sessionIdCounter = 0;
  const DEFAULT_SESSION = 'default';

  async function executeTerminalCommand(id, command, timeout) {
    const startTime = Date.now();
    healthMetrics.executions.terminal.count++;
    const timeoutMs = timeout || 30000; // Default 30s timeout
    terminalState.lastCommand = command;
    terminalState.lastOutput = '';
    terminalState.lastError = '';
    terminalState.exitCode = null;
    terminalState.isReady = false;
    terminalState.startTime = startTime;

    try {
      // Try to find terminal instance (Shiro or Foam)
      const terminal = window.shiro?.terminal || window.foam?.shell?.terminal;

      if (!terminal) {
        sendResult(id, null, 'No terminal instance found');
        terminalState.isReady = true;
        return;
      }

      // Capture output
      const outputBuffer = [];
      const errorBuffer = [];

      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Terminal command timeout after ${timeoutMs}ms`)), timeoutMs);
      });

      // Execute command with output capture
      const execPromise = new Promise(async (resolve, reject) => {
        try {
          // For Shiro (TypeScript)
          if (window.shiro?.shell) {
            const shell = window.shiro.shell;
            let exitCode = 0;

            await shell.execute(command, (output) => {
              outputBuffer.push(output);
            });

            // Detect exit code from shell if available
            if (shell.lastExitCode !== undefined) {
              exitCode = shell.lastExitCode;
            }

            terminalState.exitCode = exitCode;
            terminalState.lastOutput = outputBuffer.join('');
            resolve({ exitCode, output: terminalState.lastOutput });
          }
          // For Foam (JavaScript)
          else if (window.foam?.shell) {
            const shell = window.foam.shell;

            await shell.execLive(command, {
              stdout: (text) => outputBuffer.push(text),
              stderr: (text) => errorBuffer.push(text),
            });

            // Try to detect exit code
            const exitCode = shell.lastExitCode || 0;
            terminalState.exitCode = exitCode;
            terminalState.lastOutput = outputBuffer.join('');
            terminalState.lastError = errorBuffer.join('');

            resolve({
              exitCode,
              output: terminalState.lastOutput,
              error: terminalState.lastError
            });
          }
        } catch (err) {
          terminalState.exitCode = 1;
          reject(err);
        }
      });

      const result = await Promise.race([execPromise, timeoutPromise]);
      terminalState.isReady = true;
      const duration = Date.now() - startTime;
      healthMetrics.executions.terminal.totalTime += duration;

      sendResultWithTiming(id, {
        exitCode: result.exitCode,
        output: result.output,
        error: result.error || '',
        duration,
      }, null, startTime);

    } catch (err) {
      terminalState.isReady = true;
      terminalState.exitCode = 1;
      const duration = Date.now() - startTime;
      healthMetrics.executions.terminal.totalTime += duration;
      healthMetrics.executions.terminal.errors++;
      healthMetrics.totalErrors++;
      sendResultWithTiming(id, null, String(err), startTime);
    }
  }

  function readTerminalOutput(id) {
    try {
      sendResult(id, {
        lastCommand: terminalState.lastCommand,
        output: terminalState.lastOutput,
        error: terminalState.lastError,
        exitCode: terminalState.exitCode,
        isReady: terminalState.isReady,
      }, null);
    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  function getTerminalStatus(id) {
    try {
      const terminal = window.shiro?.terminal || window.foam?.shell?.terminal;
      const shell = window.shiro?.shell || window.foam?.shell;

      sendResult(id, {
        available: !!terminal,
        ready: terminalState.isReady,
        busy: terminal?.busy || terminal?.running || false,
        cwd: shell?.cwd || shell?.vfs?.cwd || '/',
        lastExitCode: terminalState.exitCode,
        uptime: terminalState.startTime ? Date.now() - terminalState.startTime : null,
        promptPattern: detectPromptPattern(terminal),
      }, null);
    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  function detectPromptPattern(terminal) {
    // Detect prompt pattern for better terminal interaction
    if (window.shiro) {
      return /user@shiro:.*\$\s*$/;
    } else if (window.foam) {
      return /user@foam:.*\$\s*$/;
    }
    return null;
  }

  // Spirit Integration: DOM Snapshot for visual inspection
  function getDOMSnapshot(id, options = {}) {
    try {
      const includeStyles = options.includeStyles !== false; // Default true
      const includeScripts = options.includeScripts || false; // Default false
      const maxDepth = options.maxDepth || -1; // -1 = unlimited

      // Capture full HTML
      const html = document.documentElement.outerHTML;

      // Capture viewport information
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
      };

      // Capture computed styles for visible elements if requested
      let styles = null;
      if (includeStyles) {
        styles = {};
        const visibleElements = document.querySelectorAll('body *');
        let count = 0;
        const maxElements = 1000; // Limit to prevent huge payloads

        for (const el of visibleElements) {
          if (count >= maxElements) break;

          // Only capture visible elements
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const computedStyle = window.getComputedStyle(el);
            const selector = generateSelector(el);
            styles[selector] = {
              display: computedStyle.display,
              position: computedStyle.position,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              left: rect.left,
              color: computedStyle.color,
              backgroundColor: computedStyle.backgroundColor,
              fontSize: computedStyle.fontSize,
            };
            count++;
          }
        }
      }

      sendResult(id, {
        html,
        viewport,
        styles,
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
      }, null);
    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  // Spirit Integration: CSS Selector Query
  function querySelector(id, selector, all = false) {
    const startTime = Date.now();
    healthMetrics.executions.dom.count++;

    try {
      if (!selector) {
        healthMetrics.executions.dom.errors++;
        healthMetrics.totalErrors++;
        sendResultWithTiming(id, null, 'No selector provided', startTime);
        return;
      }

      const elements = all
        ? Array.from(document.querySelectorAll(selector))
        : [document.querySelector(selector)].filter(Boolean);

      const results = elements.map(el => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: Array.from(el.classList),
        text: el.textContent?.trim().substring(0, 200) || '',
        html: el.outerHTML.substring(0, 500),
        attributes: getElementAttributes(el),
        rect: el.getBoundingClientRect(),
        visible: isElementVisible(el),
        selector: generateSelector(el),
      }));

      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;

      sendResultWithTiming(id, {
        count: results.length,
        elements: results,
        selector,
      }, null, startTime);
    } catch (err) {
      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;
      healthMetrics.executions.dom.errors++;
      healthMetrics.totalErrors++;
      sendResultWithTiming(id, null, String(err), startTime);
    }
  }

  // Spirit Integration: Click element
  function elementClick(id, selector) {
    try {
      const element = document.querySelector(selector);

      if (!element) {
        sendResult(id, null, `Element not found: ${selector}`);
        return;
      }

      // Scroll element into view first
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Wait a bit for scroll, then click
      setTimeout(() => {
        try {
          // Try multiple click methods for compatibility
          if (element.click) {
            element.click();
          } else {
            const clickEvent = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window
            });
            element.dispatchEvent(clickEvent);
          }

          sendResult(id, {
            success: true,
            selector,
            element: {
              tag: element.tagName.toLowerCase(),
              text: element.textContent?.trim().substring(0, 100),
            }
          }, null);
        } catch (clickErr) {
          sendResult(id, null, String(clickErr));
        }
      }, 300);

    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  // Spirit Integration: Type into element
  function elementType(id, selector, text, options = {}) {
    try {
      const element = document.querySelector(selector);

      if (!element) {
        sendResult(id, null, `Element not found: ${selector}`);
        return;
      }

      // Scroll into view
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      setTimeout(() => {
        try {
          // Focus the element
          element.focus();

          // Clear existing value if requested
          if (options.clear !== false) {
            element.value = '';
          }

          // Type the text
          if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
            element.value = (options.clear === false ? element.value : '') + text;

            // Trigger input event
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            // For contenteditable elements
            if (element.isContentEditable) {
              element.textContent = (options.clear === false ? element.textContent : '') + text;
              element.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              sendResult(id, null, 'Element is not typeable');
              return;
            }
          }

          sendResult(id, {
            success: true,
            selector,
            text,
            value: element.value || element.textContent,
          }, null);
        } catch (typeErr) {
          sendResult(id, null, String(typeErr));
        }
      }, 300);

    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  // Spirit Integration: Scroll element or window
  function elementScroll(id, selector, options = {}) {
    try {
      const x = options.x || 0;
      const y = options.y || 0;
      const behavior = options.smooth ? 'smooth' : 'auto';

      if (selector) {
        const element = document.querySelector(selector);
        if (!element) {
          sendResult(id, null, `Element not found: ${selector}`);
          return;
        }

        if (options.intoView) {
          element.scrollIntoView({ behavior, block: options.block || 'center' });
        } else {
          element.scrollBy({ left: x, top: y, behavior });
        }

        sendResult(id, {
          success: true,
          selector,
          scrollPosition: {
            x: element.scrollLeft,
            y: element.scrollTop,
          }
        }, null);
      } else {
        // Scroll window
        window.scrollBy({ left: x, top: y, behavior });

        sendResult(id, {
          success: true,
          scrollPosition: {
            x: window.scrollX,
            y: window.scrollY,
          }
        }, null);
      }
    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  // Helper: Generate unique CSS selector for an element
  function generateSelector(element) {
    if (element.id) {
      return `#${element.id}`;
    }

    const path = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let selector = current.tagName.toLowerCase();

      if (current.className) {
        const classes = Array.from(current.classList)
          .filter(c => c && !c.includes(' '))
          .slice(0, 2); // Limit classes
        if (classes.length) {
          selector += '.' + classes.join('.');
        }
      }

      // Add nth-child if needed for uniqueness
      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children);
        const index = siblings.indexOf(current);
        if (siblings.length > 1) {
          selector += `:nth-child(${index + 1})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;

      // Limit depth to keep selector reasonable
      if (path.length >= 5) break;
    }

    return path.join(' > ');
  }

  // Helper: Get element attributes as object
  function getElementAttributes(element) {
    const attrs = {};
    for (const attr of element.attributes) {
      attrs[attr.name] = attr.value;
    }
    return attrs;
  }

  // Helper: Check if element is visible
  function isElementVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  }

  // Batch command execution - execute multiple commands in sequence
  async function executeBatchEval(id, commands, timeout) {
    if (!Array.isArray(commands)) {
      sendResult(id, null, serializeError(new Error('Commands must be an array')));
      return;
    }

    const results = [];
    const timeoutMs = timeout || 30000;
    const startTime = Date.now();

    try {
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];

        // Check if we've exceeded timeout
        if (Date.now() - startTime > timeoutMs) {
          results.push({
            index: i,
            code: cmd,
            result: null,
            error: serializeError(new Error(`Batch timeout after ${timeoutMs}ms at command ${i}`)),
            skipped: true
          });
          break;
        }

        try {
          const result = new Function(cmd)();

          // Handle promises
          if (result && typeof result.then === "function") {
            const remainingTime = timeoutMs - (Date.now() - startTime);
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error(`Command ${i} timeout`)), remainingTime);
            });

            const resolved = await Promise.race([result, timeoutPromise]);
            results.push({
              index: i,
              code: cmd.substring(0, 100),
              result: serialize(resolved),
              error: null,
              duration: Date.now() - startTime
            });
          } else {
            results.push({
              index: i,
              code: cmd.substring(0, 100),
              result: serialize(result),
              error: null,
              duration: Date.now() - startTime
            });
          }
        } catch (err) {
          results.push({
            index: i,
            code: cmd.substring(0, 100),
            result: null,
            error: serializeError(err),
            duration: Date.now() - startTime
          });

          // Stop on error unless continueOnError is set
          if (!commands[i].continueOnError) {
            break;
          }
        }
      }

      sendResult(id, {
        totalCommands: commands.length,
        executedCommands: results.length,
        results,
        totalDuration: Date.now() - startTime
      }, null);

    } catch (err) {
      sendResult(id, {
        totalCommands: commands.length,
        executedCommands: results.length,
        results,
        totalDuration: Date.now() - startTime
      }, serializeError(err));
    }
  }

  // File upload - write file to browser filesystem (Shiro/Foam VFS)
  async function fileUpload(id, path, content, options = {}) {
    try {
      // Try to access VFS from Shiro or Foam
      const vfs = window.shiro?.vfs || window.foam?.shell?.vfs;

      if (!vfs) {
        sendResult(id, null, serializeError(new Error('No VFS available (not in Shiro/Foam)')));
        return;
      }

      // Decode base64 content if specified
      let fileContent = content;
      if (options.encoding === 'base64') {
        fileContent = atob(content);
      }

      // Write file to VFS
      const resolvedPath = vfs.resolvePath(path);
      await vfs.writeFile(resolvedPath, fileContent);

      sendResult(id, {
        success: true,
        path: resolvedPath,
        size: fileContent.length,
        encoding: options.encoding || 'utf8',
        timestamp: Date.now()
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // File download - read file from browser filesystem (Shiro/Foam VFS)
  async function fileDownload(id, path) {
    try {
      // Try to access VFS from Shiro or Foam
      const vfs = window.shiro?.vfs || window.foam?.shell?.vfs;

      if (!vfs) {
        sendResult(id, null, serializeError(new Error('No VFS available (not in Shiro/Foam)')));
        return;
      }

      // Read file from VFS
      const resolvedPath = vfs.resolvePath(path);
      const content = await vfs.readFile(resolvedPath);

      // Try to determine if binary content
      const isBinary = content.some ? content.some(byte => byte === 0) : false;

      sendResult(id, {
        success: true,
        path: resolvedPath,
        content: isBinary ? btoa(content) : content,
        encoding: isBinary ? 'base64' : 'utf8',
        size: content.length,
        timestamp: Date.now()
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Diagnostics endpoint - comprehensive bridge health reporting
  function getDiagnostics(id) {
    const now = Date.now();
    const uptime = now - healthMetrics.connectTime;

    // Calculate averages
    const avgLatency = healthMetrics.latency || 0;
    const avgEvalTime = healthMetrics.executions.eval.count > 0
      ? healthMetrics.executions.eval.totalTime / healthMetrics.executions.eval.count
      : 0;
    const avgTerminalTime = healthMetrics.executions.terminal.count > 0
      ? healthMetrics.executions.terminal.totalTime / healthMetrics.executions.terminal.count
      : 0;
    const avgDomTime = healthMetrics.executions.dom.count > 0
      ? healthMetrics.executions.dom.totalTime / healthMetrics.executions.dom.count
      : 0;

    const diagnostics = {
      page,
      timestamp: now,
      uptime,
      uptimeFormatted: formatDuration(uptime),

      connection: {
        status: ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
        reconnectCount: healthMetrics.reconnectCount,
        lastPingTime: healthMetrics.lastPingTime,
        lastPongTime: healthMetrics.lastPongTime,
        latency: avgLatency,
        messageQueueSize: messageQueue.length,
      },

      traffic: {
        totalMessages: healthMetrics.totalMessages,
        totalErrors: healthMetrics.totalErrors,
        errorRate: healthMetrics.totalMessages > 0
          ? (healthMetrics.totalErrors / healthMetrics.totalMessages * 100).toFixed(2) + '%'
          : '0%',
      },

      performance: {
        eval: {
          count: healthMetrics.executions.eval.count,
          totalTime: healthMetrics.executions.eval.totalTime,
          avgTime: Math.round(avgEvalTime),
          errors: healthMetrics.executions.eval.errors,
          errorRate: healthMetrics.executions.eval.count > 0
            ? (healthMetrics.executions.eval.errors / healthMetrics.executions.eval.count * 100).toFixed(2) + '%'
            : '0%',
        },
        terminal: {
          count: healthMetrics.executions.terminal.count,
          totalTime: healthMetrics.executions.terminal.totalTime,
          avgTime: Math.round(avgTerminalTime),
          errors: healthMetrics.executions.terminal.errors,
          errorRate: healthMetrics.executions.terminal.count > 0
            ? (healthMetrics.executions.terminal.errors / healthMetrics.executions.terminal.count * 100).toFixed(2) + '%'
            : '0%',
        },
        dom: {
          count: healthMetrics.executions.dom.count,
          totalTime: healthMetrics.executions.dom.totalTime,
          avgTime: Math.round(avgDomTime),
          errors: healthMetrics.executions.dom.errors,
          errorRate: healthMetrics.executions.dom.count > 0
            ? (healthMetrics.executions.dom.errors / healthMetrics.executions.dom.count * 100).toFixed(2) + '%'
            : '0%',
        },
      },

      system: {
        userAgent: navigator.userAgent,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        memory: performance.memory ? {
          usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + ' MB',
          totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024) + ' MB',
          jsHeapSizeLimit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024) + ' MB',
        } : 'not available',
        pageUrl: location.href,
        pageTitle: document.title,
      },
    };

    sendResult(id, diagnostics, null);
  }

  function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  // Multiplexed Terminal Sessions (tmux-like functionality)

  function createTerminalSession(id, name, options = {}) {
    try {
      const sessionId = name || `session-${++sessionIdCounter}`;

      if (terminalSessions.has(sessionId)) {
        sendResult(id, null, serializeError(new Error(`Session '${sessionId}' already exists`)));
        return;
      }

      const session = {
        id: sessionId,
        name: sessionId,
        created: Date.now(),
        lastActivity: Date.now(),
        attached: false,
        running: false,
        currentCommand: null,
        history: [],
        output: [],
        exitCode: null,
        cwd: options.cwd || '~',
        env: options.env || {},
      };

      terminalSessions.set(sessionId, session);

      sendResult(id, {
        success: true,
        sessionId,
        session: {
          id: session.id,
          name: session.name,
          created: session.created,
          attached: session.attached,
        }
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  function listTerminalSessions(id) {
    try {
      const sessions = Array.from(terminalSessions.values()).map(session => ({
        id: session.id,
        name: session.name,
        created: session.created,
        lastActivity: session.lastActivity,
        attached: session.attached,
        running: session.running,
        currentCommand: session.currentCommand,
        historySize: session.history.length,
        outputLines: session.output.length,
        uptime: Date.now() - session.created,
      }));

      sendResult(id, {
        count: sessions.length,
        sessions,
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  function attachTerminalSession(id, sessionId) {
    try {
      const session = terminalSessions.get(sessionId);

      if (!session) {
        sendResult(id, null, serializeError(new Error(`Session '${sessionId}' not found`)));
        return;
      }

      session.attached = true;
      session.lastActivity = Date.now();

      sendResult(id, {
        success: true,
        sessionId,
        output: session.output.slice(-100), // Last 100 lines
        running: session.running,
        currentCommand: session.currentCommand,
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  function detachTerminalSession(id, sessionId) {
    try {
      const session = terminalSessions.get(sessionId);

      if (!session) {
        sendResult(id, null, serializeError(new Error(`Session '${sessionId}' not found`)));
        return;
      }

      session.attached = false;
      session.lastActivity = Date.now();

      sendResult(id, {
        success: true,
        sessionId,
        message: `Detached from session '${sessionId}'`,
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  async function executeInSession(id, sessionId, command, timeout) {
    const startTime = Date.now();

    try {
      // Get or create session
      let session = terminalSessions.get(sessionId || DEFAULT_SESSION);
      if (!session) {
        // Auto-create default session if it doesn't exist
        if (!sessionId || sessionId === DEFAULT_SESSION) {
          session = {
            id: DEFAULT_SESSION,
            name: DEFAULT_SESSION,
            created: Date.now(),
            lastActivity: Date.now(),
            attached: false,
            running: false,
            currentCommand: null,
            history: [],
            output: [],
            exitCode: null,
            cwd: '~',
            env: {},
          };
          terminalSessions.set(DEFAULT_SESSION, session);
        } else {
          sendResult(id, null, serializeError(new Error(`Session '${sessionId}' not found`)));
          return;
        }
      }

      // Mark session as running
      session.running = true;
      session.currentCommand = command;
      session.lastActivity = Date.now();
      session.history.push({
        command,
        timestamp: startTime,
      });

      // Try to access shell
      const shell = window.shiro?.shell || window.foam?.shell;

      if (!shell) {
        session.running = false;
        session.currentCommand = null;
        sendResult(id, null, serializeError(new Error('No shell available')));
        return;
      }

      const timeoutMs = timeout || 30000;
      const outputBuffer = [];
      const errorBuffer = [];

      // Execute command with output capture
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Command timeout after ${timeoutMs}ms`)), timeoutMs);
      });

      const execPromise = new Promise(async (resolve, reject) => {
        try {
          await shell.execLive(command, {
            stdout: (text) => {
              outputBuffer.push(text);
              session.output.push({ type: 'stdout', text, timestamp: Date.now() });
            },
            stderr: (text) => {
              errorBuffer.push(text);
              session.output.push({ type: 'stderr', text, timestamp: Date.now() });
            },
          });

          const exitCode = shell.lastExitCode || 0;
          resolve({
            exitCode,
            output: outputBuffer.join(''),
            error: errorBuffer.join(''),
          });
        } catch (err) {
          reject(err);
        }
      });

      const result = await Promise.race([execPromise, timeoutPromise]);

      // Update session state
      session.running = false;
      session.currentCommand = null;
      session.exitCode = result.exitCode;
      session.lastActivity = Date.now();

      // Trim output history if too large
      if (session.output.length > 1000) {
        session.output = session.output.slice(-1000);
      }

      const duration = Date.now() - startTime;

      sendResultWithTiming(id, {
        sessionId: session.id,
        exitCode: result.exitCode,
        output: result.output,
        error: result.error,
        duration,
      }, null, startTime);

    } catch (err) {
      // Update session state on error
      const session = terminalSessions.get(sessionId || DEFAULT_SESSION);
      if (session) {
        session.running = false;
        session.currentCommand = null;
        session.exitCode = 1;
        session.lastActivity = Date.now();
      }

      const duration = Date.now() - startTime;
      sendResultWithTiming(id, null, serializeError(err), startTime);
    }
  }

  function killTerminalSession(id, sessionId) {
    try {
      const session = terminalSessions.get(sessionId);

      if (!session) {
        sendResult(id, null, serializeError(new Error(`Session '${sessionId}' not found`)));
        return;
      }

      // Mark as not running (can't actually kill processes, just mark session)
      session.running = false;
      session.currentCommand = null;

      // Remove session
      terminalSessions.delete(sessionId);

      sendResult(id, {
        success: true,
        sessionId,
        message: `Session '${sessionId}' killed`,
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Keyboard and Clipboard Integration for Terminal UIs

  // Paste text into focused element (or element by selector)
  function elementPaste(id, selector, text) {
    try {
      let element;

      if (selector) {
        element = document.querySelector(selector);
        if (!element) {
          sendResult(id, null, serializeError(new Error(`Element not found: ${selector}`)));
          return;
        }
        element.focus();
      } else {
        element = document.activeElement;
        if (!element || element === document.body) {
          sendResult(id, null, serializeError(new Error('No focused element to paste into')));
          return;
        }
      }

      // Scroll into view if selector provided
      if (selector) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      setTimeout(() => {
        try {
          // For input/textarea elements
          if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
            const start = element.selectionStart || 0;
            const end = element.selectionEnd || 0;
            const currentValue = element.value || '';

            // Insert text at cursor position
            element.value = currentValue.substring(0, start) + text + currentValue.substring(end);

            // Move cursor to end of pasted text
            const newPos = start + text.length;
            element.setSelectionRange(newPos, newPos);

            // Trigger events
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));

          } else if (element.isContentEditable) {
            // For contenteditable elements
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
              const range = selection.getRangeAt(0);
              range.deleteContents();
              range.insertNode(document.createTextNode(text));
              range.collapse(false);
              selection.removeAllRanges();
              selection.addRange(range);
            } else {
              element.textContent += text;
            }

            element.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            sendResult(id, null, serializeError(new Error('Element is not editable')));
            return;
          }

          sendResult(id, {
            success: true,
            selector: selector || 'activeElement',
            pastedText: text.substring(0, 100),
            pastedLength: text.length,
            element: {
              tag: element.tagName.toLowerCase(),
              id: element.id || null,
              value: (element.value || element.textContent || '').substring(0, 100),
            }
          }, null);
        } catch (pasteErr) {
          sendResult(id, null, serializeError(pasteErr));
        }
      }, selector ? 300 : 0);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Simulate keypress events (Enter, Tab, Ctrl+C, arrow keys, etc.)
  function elementKeypress(id, selector, key, options = {}) {
    try {
      let element;

      if (selector) {
        element = document.querySelector(selector);
        if (!element) {
          sendResult(id, null, serializeError(new Error(`Element not found: ${selector}`)));
          return;
        }
      } else {
        element = document.activeElement;
        if (!element || element === document.body) {
          sendResult(id, null, serializeError(new Error('No focused element for keypress')));
          return;
        }
      }

      // Focus element if selector provided
      if (selector) {
        element.focus();
      }

      setTimeout(() => {
        try {
          // Parse key and modifiers
          const keyInfo = parseKey(key);

          // Create keyboard events (keydown, keypress, keyup)
          const eventOptions = {
            key: keyInfo.key,
            code: keyInfo.code,
            keyCode: keyInfo.keyCode,
            which: keyInfo.keyCode,
            bubbles: true,
            cancelable: true,
            ctrlKey: options.ctrlKey || keyInfo.ctrlKey || false,
            shiftKey: options.shiftKey || keyInfo.shiftKey || false,
            altKey: options.altKey || keyInfo.altKey || false,
            metaKey: options.metaKey || keyInfo.metaKey || false,
          };

          // Dispatch events in order
          const keydownEvent = new KeyboardEvent('keydown', eventOptions);
          const keypressEvent = new KeyboardEvent('keypress', eventOptions);
          const keyupEvent = new KeyboardEvent('keyup', eventOptions);

          element.dispatchEvent(keydownEvent);

          // Only dispatch keypress for printable characters
          if (keyInfo.key.length === 1) {
            element.dispatchEvent(keypressEvent);
          }

          element.dispatchEvent(keyupEvent);

          // Trigger input event for content changes
          if (keyInfo.key.length === 1 || keyInfo.key === 'Backspace' || keyInfo.key === 'Delete') {
            element.dispatchEvent(new Event('input', { bubbles: true }));
          }

          sendResult(id, {
            success: true,
            selector: selector || 'activeElement',
            key: keyInfo.key,
            modifiers: {
              ctrl: eventOptions.ctrlKey,
              shift: eventOptions.shiftKey,
              alt: eventOptions.altKey,
              meta: eventOptions.metaKey,
            },
            element: {
              tag: element.tagName.toLowerCase(),
              id: element.id || null,
            }
          }, null);
        } catch (keypressErr) {
          sendResult(id, null, serializeError(keypressErr));
        }
      }, selector ? 50 : 0);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Focus element by selector
  function elementFocus(id, selector) {
    try {
      const element = document.querySelector(selector);

      if (!element) {
        sendResult(id, null, serializeError(new Error(`Element not found: ${selector}`)));
        return;
      }

      // Scroll into view first
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      setTimeout(() => {
        try {
          element.focus();

          // Get focus state
          const hasFocus = document.activeElement === element;

          sendResult(id, {
            success: true,
            selector,
            focused: hasFocus,
            element: {
              tag: element.tagName.toLowerCase(),
              id: element.id || null,
              classes: Array.from(element.classList),
              focusable: element.tabIndex >= 0 || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable,
            },
            previousFocus: {
              tag: document.activeElement?.tagName?.toLowerCase() || null,
              id: document.activeElement?.id || null,
            }
          }, null);
        } catch (focusErr) {
          sendResult(id, null, serializeError(focusErr));
        }
      }, 300);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Helper: Parse key string into key event properties
  function parseKey(keyString) {
    // Handle special key combinations (e.g., "Ctrl+C", "Shift+Enter")
    const parts = keyString.split('+').map(s => s.trim());

    let ctrlKey = false;
    let shiftKey = false;
    let altKey = false;
    let metaKey = false;
    let key = keyString;

    // Extract modifiers
    if (parts.length > 1) {
      for (let i = 0; i < parts.length - 1; i++) {
        const mod = parts[i].toLowerCase();
        if (mod === 'ctrl' || mod === 'control') ctrlKey = true;
        else if (mod === 'shift') shiftKey = true;
        else if (mod === 'alt') altKey = true;
        else if (mod === 'meta' || mod === 'cmd' || mod === 'command') metaKey = true;
      }
      key = parts[parts.length - 1];
    }

    // Map common key names to KeyboardEvent properties
    const keyMap = {
      'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
      'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
      'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
      'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
      'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      'Home': { key: 'Home', code: 'Home', keyCode: 36 },
      'End': { key: 'End', code: 'End', keyCode: 35 },
      'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
      'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
      'Space': { key: ' ', code: 'Space', keyCode: 32 },
      'F1': { key: 'F1', code: 'F1', keyCode: 112 },
      'F2': { key: 'F2', code: 'F2', keyCode: 113 },
      'F3': { key: 'F3', code: 'F3', keyCode: 114 },
      'F4': { key: 'F4', code: 'F4', keyCode: 115 },
      'F5': { key: 'F5', code: 'F5', keyCode: 116 },
      'F6': { key: 'F6', code: 'F6', keyCode: 117 },
      'F7': { key: 'F7', code: 'F7', keyCode: 118 },
      'F8': { key: 'F8', code: 'F8', keyCode: 119 },
      'F9': { key: 'F9', code: 'F9', keyCode: 120 },
      'F10': { key: 'F10', code: 'F10', keyCode: 121 },
      'F11': { key: 'F11', code: 'F11', keyCode: 122 },
      'F12': { key: 'F12', code: 'F12', keyCode: 123 },
    };

    let keyInfo;
    if (keyMap[key]) {
      keyInfo = keyMap[key];
    } else if (key.length === 1) {
      // Single character key
      const charCode = key.charCodeAt(0);
      keyInfo = {
        key: key,
        code: 'Key' + key.toUpperCase(),
        keyCode: charCode,
      };
    } else {
      // Unknown key, use as-is
      keyInfo = {
        key: key,
        code: key,
        keyCode: 0,
      };
    }

    return {
      ...keyInfo,
      ctrlKey,
      shiftKey,
      altKey,
      metaKey,
    };
  }

  // Visual Snapshot - Capture page visual state as structured description

  function getVisualSnapshot(id, options = {}) {
    const startTime = Date.now();
    healthMetrics.executions.dom.count++;

    try {
      const maxDepth = options.maxDepth || 10;
      const includeHidden = options.includeHidden || false;
      const includeStyles = options.includeStyles !== false; // default true
      const maxElements = options.maxElements || 200;

      // Capture viewport information
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio || 1,
      };

      // Capture document dimensions
      const documentInfo = {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        title: document.title,
        url: location.href,
        readyState: document.readyState,
      };

      // Build visual DOM tree
      const visualTree = buildVisualTree(document.body, 0, maxDepth, includeHidden, includeStyles, maxElements);

      // Extract visible text content
      const visibleText = extractVisibleText(document.body, maxElements);

      // Find interactive elements
      const interactiveElements = findInteractiveElements(maxElements);

      // Calculate layout zones
      const layoutZones = calculateLayoutZones(viewport);

      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;

      sendResultWithTiming(id, {
        viewport,
        document: documentInfo,
        visualTree,
        visibleText,
        interactiveElements,
        layoutZones,
        timestamp: Date.now(),
      }, null, startTime);

    } catch (err) {
      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;
      healthMetrics.executions.dom.errors++;
      healthMetrics.totalErrors++;
      sendResultWithTiming(id, null, serializeError(err), startTime);
    }
  }

  // Helper: Build visual DOM tree with layout information
  function buildVisualTree(element, depth, maxDepth, includeHidden, includeStyles, maxElements) {
    if (!element || depth > maxDepth) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(element);
    const isVisible = isElementVisible(element);

    // Skip hidden elements unless includeHidden is true
    if (!isVisible && !includeHidden) {
      return null;
    }

    const node = {
      tag: element.tagName?.toLowerCase() || 'unknown',
      depth,
      visible: isVisible,
      rect: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      text: getElementText(element),
    };

    // Add ID and classes if present
    if (element.id) node.id = element.id;
    if (element.className && typeof element.className === 'string') {
      const classes = element.className.trim().split(/\s+/).filter(c => c);
      if (classes.length > 0) node.classes = classes;
    }

    // Add styles if requested and visible
    if (includeStyles && isVisible) {
      node.styles = {
        display: computedStyle.display,
        position: computedStyle.position,
        zIndex: computedStyle.zIndex,
        backgroundColor: computedStyle.backgroundColor,
        color: computedStyle.color,
        fontSize: computedStyle.fontSize,
        fontWeight: computedStyle.fontWeight,
      };
    }

    // Add interactive attributes
    if (element.tagName === 'A' && element.href) {
      node.href = element.href;
    }
    if (element.tagName === 'INPUT') {
      node.inputType = element.type;
      node.value = element.value?.substring(0, 50);
      node.placeholder = element.placeholder;
    }
    if (element.tagName === 'BUTTON' || element.tagName === 'A' || element.onclick) {
      node.interactive = true;
    }
    if (element.getAttribute('role')) {
      node.role = element.getAttribute('role');
    }

    // Recursively build children for visible elements
    if (isVisible && element.children && element.children.length > 0) {
      const children = [];
      let elementCount = 0;

      for (const child of element.children) {
        if (elementCount >= maxElements) break;

        const childNode = buildVisualTree(child, depth + 1, maxDepth, includeHidden, includeStyles, maxElements - elementCount);
        if (childNode) {
          children.push(childNode);
          elementCount++;
        }
      }

      if (children.length > 0) {
        node.children = children;
        node.childCount = children.length;
      }
    }

    return node;
  }

  // Helper: Get text content of element (first 200 chars)
  function getElementText(element) {
    if (!element) return '';

    // For input elements, get value
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      return element.value?.trim().substring(0, 200) || '';
    }

    // Get direct text content (not from children)
    let text = '';
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }

    return text.trim().substring(0, 200);
  }

  // Helper: Extract all visible text from page
  function extractVisibleText(root, maxElements) {
    const textBlocks = [];
    let count = 0;

    function traverse(element) {
      if (!element || count >= maxElements) return;

      if (isElementVisible(element)) {
        const text = getElementText(element);
        if (text.length > 0) {
          const rect = element.getBoundingClientRect();
          textBlocks.push({
            text,
            tag: element.tagName?.toLowerCase(),
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            fontSize: window.getComputedStyle(element).fontSize,
          });
          count++;
        }

        for (const child of element.children || []) {
          traverse(child);
        }
      }
    }

    traverse(root);
    return textBlocks;
  }

  // Helper: Find all interactive elements
  function findInteractiveElements(maxElements) {
    const interactive = [];
    const selectors = [
      'button',
      'a[href]',
      'input',
      'textarea',
      'select',
      '[onclick]',
      '[role="button"]',
      '[role="link"]',
      '[tabindex]',
    ];

    const elements = document.querySelectorAll(selectors.join(','));
    let count = 0;

    for (const el of elements) {
      if (count >= maxElements) break;

      if (isElementVisible(el)) {
        const rect = el.getBoundingClientRect();
        interactive.push({
          tag: el.tagName?.toLowerCase(),
          type: el.type || el.getAttribute('role') || 'interactive',
          id: el.id || null,
          classes: Array.from(el.classList).slice(0, 3),
          text: getElementText(el),
          rect: {
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          selector: generateSelector(el),
        });
        count++;
      }
    }

    return interactive;
  }

  // Helper: Calculate layout zones (header, sidebar, main, footer)
  function calculateLayoutZones(viewport) {
    const zones = {
      header: null,
      sidebar: null,
      main: null,
      footer: null,
    };

    // Heuristics for common layout patterns
    const headerCandidates = document.querySelectorAll('header, [role="banner"], nav');
    const footerCandidates = document.querySelectorAll('footer, [role="contentinfo"]');
    const mainCandidates = document.querySelectorAll('main, [role="main"], article');
    const asideCandidates = document.querySelectorAll('aside, [role="complementary"]');

    // Find header (top 20% of viewport)
    for (const el of headerCandidates) {
      const rect = el.getBoundingClientRect();
      if (rect.top < viewport.height * 0.2 && isElementVisible(el)) {
        zones.header = {
          y: Math.round(rect.top + window.scrollY),
          height: Math.round(rect.height),
          width: Math.round(rect.width),
        };
        break;
      }
    }

    // Find footer (bottom 20% of viewport)
    for (const el of footerCandidates) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > viewport.height * 0.8 && isElementVisible(el)) {
        zones.footer = {
          y: Math.round(rect.top + window.scrollY),
          height: Math.round(rect.height),
          width: Math.round(rect.width),
        };
        break;
      }
    }

    // Find main content area
    for (const el of mainCandidates) {
      if (isElementVisible(el)) {
        const rect = el.getBoundingClientRect();
        zones.main = {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        break;
      }
    }

    // Find sidebar (left or right 30% of viewport)
    for (const el of asideCandidates) {
      if (isElementVisible(el)) {
        const rect = el.getBoundingClientRect();
        if (rect.width < viewport.width * 0.3) {
          zones.sidebar = {
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            position: rect.left < viewport.width / 2 ? 'left' : 'right',
          };
          break;
        }
      }
    }

    return zones;
  }

  // Page State Diffing System - Track DOM changes between snapshots

  // Snapshot storage
  const snapshots = new Map();
  let snapshotCounter = 0;

  // Capture a lightweight DOM snapshot for diffing
  function captureSnapshot(id, snapshotId, options = {}) {
    const startTime = Date.now();
    healthMetrics.executions.dom.count++;

    try {
      const autoId = snapshotId || `snapshot-${++snapshotCounter}`;
      const includeText = options.includeText !== false; // default true
      const includeAttributes = options.includeAttributes !== false; // default true
      const maxElements = options.maxElements || 500;

      // Build lightweight snapshot
      const snapshot = {
        id: autoId,
        timestamp: Date.now(),
        tree: buildSnapshotTree(document.body, includeText, includeAttributes, maxElements),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
        url: location.href,
        title: document.title,
      };

      // Store snapshot
      snapshots.set(autoId, snapshot);

      // Limit snapshot storage (keep last 10)
      if (snapshots.size > 10) {
        const firstKey = snapshots.keys().next().value;
        snapshots.delete(firstKey);
      }

      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;

      sendResultWithTiming(id, {
        snapshotId: autoId,
        timestamp: snapshot.timestamp,
        elementCount: countElements(snapshot.tree),
        stored: true,
      }, null, startTime);

    } catch (err) {
      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;
      healthMetrics.executions.dom.errors++;
      healthMetrics.totalErrors++;
      sendResultWithTiming(id, null, serializeError(err), startTime);
    }
  }

  // Compute diff between two snapshots
  function computeSnapshotDiff(id, beforeId, afterId) {
    const startTime = Date.now();
    healthMetrics.executions.dom.count++;

    try {
      const before = snapshots.get(beforeId);
      const after = snapshots.get(afterId);

      if (!before) {
        sendResultWithTiming(id, null, serializeError(new Error(`Snapshot '${beforeId}' not found`)), startTime);
        return;
      }

      if (!after) {
        sendResultWithTiming(id, null, serializeError(new Error(`Snapshot '${afterId}' not found`)), startTime);
        return;
      }

      // Compute diff
      const diff = computeTreeDiff(before.tree, after.tree);

      // Detect viewport changes
      const viewportChanged =
        before.viewport.scrollX !== after.viewport.scrollX ||
        before.viewport.scrollY !== after.viewport.scrollY ||
        before.viewport.width !== after.viewport.width ||
        before.viewport.height !== after.viewport.height;

      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;

      sendResultWithTiming(id, {
        beforeId,
        afterId,
        beforeTimestamp: before.timestamp,
        afterTimestamp: after.timestamp,
        timeDelta: after.timestamp - before.timestamp,
        added: diff.added,
        removed: diff.removed,
        modified: diff.modified,
        unchanged: diff.unchanged,
        viewportChanged,
        viewportDiff: viewportChanged ? {
          before: before.viewport,
          after: after.viewport,
        } : null,
        urlChanged: before.url !== after.url,
        titleChanged: before.title !== after.title,
        summary: {
          totalChanges: diff.added.length + diff.removed.length + diff.modified.length,
          addedCount: diff.added.length,
          removedCount: diff.removed.length,
          modifiedCount: diff.modified.length,
          unchangedCount: diff.unchanged,
        }
      }, null, startTime);

    } catch (err) {
      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;
      healthMetrics.executions.dom.errors++;
      healthMetrics.totalErrors++;
      sendResultWithTiming(id, null, serializeError(err), startTime);
    }
  }

  // List all stored snapshots
  function listSnapshots(id) {
    try {
      const list = Array.from(snapshots.values()).map(snap => ({
        id: snap.id,
        timestamp: snap.timestamp,
        url: snap.url,
        title: snap.title,
        elementCount: countElements(snap.tree),
        viewport: snap.viewport,
      }));

      sendResult(id, {
        count: list.length,
        snapshots: list,
        maxSnapshots: 10,
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Clear snapshots
  function clearSnapshots(id, snapshotId) {
    try {
      if (snapshotId) {
        // Clear specific snapshot
        const existed = snapshots.has(snapshotId);
        snapshots.delete(snapshotId);
        sendResult(id, {
          cleared: existed ? 1 : 0,
          snapshotId,
          remaining: snapshots.size,
        }, null);
      } else {
        // Clear all snapshots
        const count = snapshots.size;
        snapshots.clear();
        snapshotCounter = 0;
        sendResult(id, {
          cleared: count,
          remaining: 0,
        }, null);
      }
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Helper: Build lightweight snapshot tree for diffing
  function buildSnapshotTree(element, includeText, includeAttributes, maxElements, count = { value: 0 }) {
    if (!element || count.value >= maxElements) {
      return null;
    }

    count.value++;

    const node = {
      tag: element.tagName?.toLowerCase() || 'unknown',
      id: element.id || null,
      classes: element.className && typeof element.className === 'string'
        ? element.className.trim().split(/\s+/).filter(c => c)
        : [],
    };

    // Add text content if requested
    if (includeText) {
      const text = getElementText(element);
      if (text) node.text = text;
    }

    // Add attributes if requested
    if (includeAttributes) {
      const attrs = {};
      for (const attr of element.attributes || []) {
        if (attr.name !== 'class' && attr.name !== 'id') {
          attrs[attr.name] = attr.value;
        }
      }
      if (Object.keys(attrs).length > 0) {
        node.attrs = attrs;
      }
    }

    // Add value for form elements
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
      node.value = element.value;
    }

    // Generate path for identification
    node.path = generateElementPath(element);

    // Recursively build children
    if (element.children && element.children.length > 0) {
      const children = [];
      for (const child of element.children) {
        if (count.value >= maxElements) break;
        const childNode = buildSnapshotTree(child, includeText, includeAttributes, maxElements, count);
        if (childNode) {
          children.push(childNode);
        }
      }
      if (children.length > 0) {
        node.children = children;
      }
    }

    return node;
  }

  // Helper: Generate unique path for element
  function generateElementPath(element) {
    const path = [];
    let current = element;

    while (current && current !== document.body) {
      let selector = current.tagName?.toLowerCase() || 'unknown';

      if (current.id) {
        selector += '#' + current.id;
        path.unshift(selector);
        break; // ID is unique, no need to go further
      }

      // Add nth-child for disambiguation
      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children);
        const index = siblings.indexOf(current);
        if (siblings.length > 1) {
          selector += `:nth-child(${index + 1})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;

      // Limit path depth
      if (path.length >= 10) break;
    }

    return path.join(' > ');
  }

  // Helper: Compute diff between two trees
  function computeTreeDiff(before, after) {
    const added = [];
    const removed = [];
    const modified = [];
    let unchanged = 0;

    // Create maps for faster lookup
    const beforeMap = new Map();
    const afterMap = new Map();

    // Flatten trees into maps
    flattenTree(before, beforeMap);
    flattenTree(after, afterMap);

    // Find removed elements
    for (const [path, node] of beforeMap) {
      if (!afterMap.has(path)) {
        removed.push({
          path,
          tag: node.tag,
          id: node.id,
          classes: node.classes,
          text: node.text?.substring(0, 100),
        });
      }
    }

    // Find added and modified elements
    for (const [path, afterNode] of afterMap) {
      const beforeNode = beforeMap.get(path);

      if (!beforeNode) {
        // Element was added
        added.push({
          path,
          tag: afterNode.tag,
          id: afterNode.id,
          classes: afterNode.classes,
          text: afterNode.text?.substring(0, 100),
          value: afterNode.value,
        });
      } else {
        // Check if element was modified
        const changes = compareNodes(beforeNode, afterNode);
        if (changes.length > 0) {
          modified.push({
            path,
            tag: afterNode.tag,
            id: afterNode.id,
            changes,
          });
        } else {
          unchanged++;
        }
      }
    }

    return { added, removed, modified, unchanged };
  }

  // Helper: Flatten tree into map for easier comparison
  function flattenTree(node, map, prefix = '') {
    if (!node) return;

    const path = node.path || prefix;
    map.set(path, node);

    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        flattenTree(node.children[i], map, `${path}[${i}]`);
      }
    }
  }

  // Helper: Compare two nodes and return list of changes
  function compareNodes(before, after) {
    const changes = [];

    // Check text changes
    if (before.text !== after.text) {
      changes.push({
        field: 'text',
        before: before.text?.substring(0, 100),
        after: after.text?.substring(0, 100),
      });
    }

    // Check value changes (for form elements)
    if (before.value !== after.value) {
      changes.push({
        field: 'value',
        before: before.value,
        after: after.value,
      });
    }

    // Check class changes
    const beforeClasses = new Set(before.classes || []);
    const afterClasses = new Set(after.classes || []);
    const addedClasses = [...afterClasses].filter(c => !beforeClasses.has(c));
    const removedClasses = [...beforeClasses].filter(c => !afterClasses.has(c));

    if (addedClasses.length > 0 || removedClasses.length > 0) {
      changes.push({
        field: 'classes',
        added: addedClasses,
        removed: removedClasses,
      });
    }

    // Check attribute changes
    if (before.attrs || after.attrs) {
      const beforeAttrs = before.attrs || {};
      const afterAttrs = after.attrs || {};
      const attrChanges = [];

      // Find changed/removed attributes
      for (const [key, beforeVal] of Object.entries(beforeAttrs)) {
        const afterVal = afterAttrs[key];
        if (afterVal === undefined) {
          attrChanges.push({ attr: key, before: beforeVal, after: null });
        } else if (beforeVal !== afterVal) {
          attrChanges.push({ attr: key, before: beforeVal, after: afterVal });
        }
      }

      // Find added attributes
      for (const [key, afterVal] of Object.entries(afterAttrs)) {
        if (beforeAttrs[key] === undefined) {
          attrChanges.push({ attr: key, before: null, after: afterVal });
        }
      }

      if (attrChanges.length > 0) {
        changes.push({
          field: 'attributes',
          changes: attrChanges,
        });
      }
    }

    return changes;
  }

  // Helper: Count elements in tree
  function countElements(node) {
    if (!node) return 0;
    let count = 1;
    if (node.children) {
      for (const child of node.children) {
        count += countElements(child);
      }
    }
    return count;
  }

  // Accessibility Tree Extraction - AI-friendly page structure

  function getAccessibilityTree(id, options = {}) {
    const startTime = Date.now();
    healthMetrics.executions.dom.count++;

    try {
      const maxDepth = options.maxDepth || 20;
      const includeHidden = options.includeHidden || false;
      const includePositions = options.includePositions !== false; // default true

      // Build accessibility tree
      const tree = buildAccessibilityTree(document.body, 0, maxDepth, includeHidden, includePositions);

      // Extract landmarks
      const landmarks = extractLandmarks();

      // Extract headings in order
      const headings = extractHeadings();

      // Extract all interactive elements with roles
      const interactive = extractInteractiveWithRoles();

      // Extract forms and form fields
      const forms = extractForms();

      // Extract navigation elements
      const navigation = extractNavigation();

      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;

      sendResultWithTiming(id, {
        tree,
        landmarks,
        headings,
        interactive,
        forms,
        navigation,
        metadata: {
          title: document.title,
          url: location.href,
          lang: document.documentElement.lang || null,
          dir: document.documentElement.dir || 'ltr',
        },
        timestamp: Date.now(),
      }, null, startTime);

    } catch (err) {
      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;
      healthMetrics.executions.dom.errors++;
      healthMetrics.totalErrors++;
      sendResultWithTiming(id, null, serializeError(err), startTime);
    }
  }

  // Helper: Build accessibility tree node
  function buildAccessibilityTree(element, depth, maxDepth, includeHidden, includePositions) {
    if (!element || depth > maxDepth) {
      return null;
    }

    // Get computed role and name
    const role = getAccessibleRole(element);
    const name = getAccessibleName(element);
    const description = getAccessibleDescription(element);

    // Skip elements without semantic meaning unless they have children
    const isSemanticallySig = role || name || element.children.length > 0;
    if (!isSemanticallySig && !includeHidden) {
      return null;
    }

    // Check visibility
    const visible = isElementVisible(element);
    if (!visible && !includeHidden) {
      return null;
    }

    const node = {
      role: role || 'generic',
      name: name || null,
      tag: element.tagName?.toLowerCase(),
      depth,
      visible,
    };

    // Add description if present
    if (description) {
      node.description = description;
    }

    // Add states and properties
    const states = getAriaStates(element);
    if (Object.keys(states).length > 0) {
      node.states = states;
    }

    // Add position if requested and visible
    if (includePositions && visible) {
      const rect = element.getBoundingClientRect();
      node.rect = {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    // Add interactive properties
    if (isInteractive(element)) {
      node.interactive = true;
      node.focusable = element.tabIndex >= 0 || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(element.tagName);
    }

    // Add value for form elements
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) {
      node.value = element.value;
      if (element.type) node.inputType = element.type;
      if (element.placeholder) node.placeholder = element.placeholder;
      if (element.required) node.required = true;
    }

    // Add href for links
    if (element.tagName === 'A' && element.href) {
      node.href = element.href;
    }

    // Add level for headings
    if (element.tagName?.match(/^H[1-6]$/)) {
      node.level = parseInt(element.tagName[1]);
    }

    // Add ID and classes for identification
    if (element.id) node.id = element.id;
    if (element.className && typeof element.className === 'string') {
      const classes = element.className.trim().split(/\s+/).filter(c => c);
      if (classes.length > 0) node.classes = classes.slice(0, 3);
    }

    // Generate selector for targeting
    node.selector = generateSelector(element);

    // Recursively build children
    if (element.children && element.children.length > 0) {
      const children = [];
      for (const child of element.children) {
        const childNode = buildAccessibilityTree(child, depth + 1, maxDepth, includeHidden, includePositions);
        if (childNode) {
          children.push(childNode);
        }
      }
      if (children.length > 0) {
        node.children = children;
        node.childCount = children.length;
      }
    }

    return node;
  }

  // Helper: Get accessible role
  function getAccessibleRole(element) {
    // Explicit ARIA role
    const ariaRole = element.getAttribute('role');
    if (ariaRole) return ariaRole;

    // Implicit roles from HTML semantics
    const tag = element.tagName?.toLowerCase();
    const roleMap = {
      'nav': 'navigation',
      'main': 'main',
      'header': 'banner',
      'footer': 'contentinfo',
      'aside': 'complementary',
      'section': 'region',
      'article': 'article',
      'form': 'form',
      'button': 'button',
      'a': element.href ? 'link' : null,
      'img': 'img',
      'input': getInputRole(element),
      'textarea': 'textbox',
      'select': 'combobox',
      'h1': 'heading',
      'h2': 'heading',
      'h3': 'heading',
      'h4': 'heading',
      'h5': 'heading',
      'h6': 'heading',
      'ul': 'list',
      'ol': 'list',
      'li': 'listitem',
      'table': 'table',
      'tr': 'row',
      'td': 'cell',
      'th': 'columnheader',
    };

    return roleMap[tag] || null;
  }

  // Helper: Get input role based on type
  function getInputRole(element) {
    const type = element.type?.toLowerCase();
    const inputRoleMap = {
      'checkbox': 'checkbox',
      'radio': 'radio',
      'button': 'button',
      'submit': 'button',
      'reset': 'button',
      'search': 'searchbox',
      'text': 'textbox',
      'email': 'textbox',
      'tel': 'textbox',
      'url': 'textbox',
      'number': 'spinbutton',
      'range': 'slider',
    };
    return inputRoleMap[type] || 'textbox';
  }

  // Helper: Get accessible name
  function getAccessibleName(element) {
    // aria-label
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    // aria-labelledby
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent?.trim();
    }

    // Associated label (for form elements)
    if (element.id && ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) return label.textContent?.trim();
    }

    // Parent label
    const parentLabel = element.closest('label');
    if (parentLabel) {
      return parentLabel.textContent?.trim();
    }

    // alt attribute (for images)
    if (element.tagName === 'IMG') {
      return element.alt?.trim() || null;
    }

    // title attribute
    const title = element.getAttribute('title');
    if (title) return title.trim();

    // placeholder (for inputs)
    if (element.placeholder) return element.placeholder.trim();

    // Text content for buttons and links
    if (['BUTTON', 'A'].includes(element.tagName)) {
      return element.textContent?.trim().substring(0, 100) || null;
    }

    // Heading text
    if (element.tagName?.match(/^H[1-6]$/)) {
      return element.textContent?.trim().substring(0, 200) || null;
    }

    return null;
  }

  // Helper: Get accessible description
  function getAccessibleDescription(element) {
    // aria-describedby
    const describedBy = element.getAttribute('aria-describedby');
    if (describedBy) {
      const descEl = document.getElementById(describedBy);
      if (descEl) return descEl.textContent?.trim();
    }

    // aria-description
    const ariaDesc = element.getAttribute('aria-description');
    if (ariaDesc) return ariaDesc.trim();

    return null;
  }

  // Helper: Get ARIA states and properties
  function getAriaStates(element) {
    const states = {};

    // Common ARIA states
    const ariaAttrs = [
      'aria-expanded',
      'aria-selected',
      'aria-checked',
      'aria-pressed',
      'aria-disabled',
      'aria-readonly',
      'aria-required',
      'aria-invalid',
      'aria-hidden',
      'aria-current',
      'aria-live',
      'aria-atomic',
      'aria-busy',
      'aria-haspopup',
      'aria-level',
      'aria-valuemin',
      'aria-valuemax',
      'aria-valuenow',
      'aria-valuetext',
    ];

    for (const attr of ariaAttrs) {
      const value = element.getAttribute(attr);
      if (value !== null) {
        const key = attr.replace('aria-', '');
        // Convert string booleans to actual booleans
        if (value === 'true') states[key] = true;
        else if (value === 'false') states[key] = false;
        else states[key] = value;
      }
    }

    // HTML states
    if (element.disabled) states.disabled = true;
    if (element.readOnly) states.readonly = true;
    if (element.required) states.required = true;

    return states;
  }

  // Helper: Check if element is interactive
  function isInteractive(element) {
    const tag = element.tagName?.toLowerCase();
    const interactiveTags = ['button', 'a', 'input', 'textarea', 'select'];

    if (interactiveTags.includes(tag)) return true;
    if (element.onclick) return true;
    if (element.getAttribute('role') === 'button') return true;
    if (element.tabIndex >= 0) return true;

    return false;
  }

  // Helper: Extract landmarks
  function extractLandmarks() {
    const landmarks = [];
    const landmarkRoles = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region'];

    // Find elements with landmark roles
    const landmarkSelectors = landmarkRoles.map(role => `[role="${role}"]`).join(',');
    const explicitLandmarks = document.querySelectorAll(landmarkSelectors);

    // Also find semantic HTML landmarks
    const semanticLandmarks = document.querySelectorAll('header, nav, main, aside, footer, section[aria-label], section[aria-labelledby]');

    const allLandmarks = new Set([...explicitLandmarks, ...semanticLandmarks]);

    for (const el of allLandmarks) {
      if (isElementVisible(el)) {
        const role = getAccessibleRole(el);
        const name = getAccessibleName(el);

        landmarks.push({
          role,
          name,
          tag: el.tagName?.toLowerCase(),
          selector: generateSelector(el),
          rect: {
            x: Math.round(el.getBoundingClientRect().left + window.scrollX),
            y: Math.round(el.getBoundingClientRect().top + window.scrollY),
            width: Math.round(el.getBoundingClientRect().width),
            height: Math.round(el.getBoundingClientRect().height),
          }
        });
      }
    }

    return landmarks;
  }

  // Helper: Extract headings in order
  function extractHeadings() {
    const headings = [];
    const headingElements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');

    for (const el of headingElements) {
      if (isElementVisible(el)) {
        let level = 1;

        if (el.tagName?.match(/^H[1-6]$/)) {
          level = parseInt(el.tagName[1]);
        } else {
          const ariaLevel = el.getAttribute('aria-level');
          if (ariaLevel) level = parseInt(ariaLevel);
        }

        headings.push({
          level,
          text: el.textContent?.trim().substring(0, 200),
          tag: el.tagName?.toLowerCase(),
          selector: generateSelector(el),
          rect: {
            x: Math.round(el.getBoundingClientRect().left + window.scrollX),
            y: Math.round(el.getBoundingClientRect().top + window.scrollY),
          }
        });
      }
    }

    return headings;
  }

  // Helper: Extract interactive elements with roles
  function extractInteractiveWithRoles() {
    const interactive = [];
    const selectors = [
      'button',
      'a[href]',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[tabindex]',
    ];

    const elements = document.querySelectorAll(selectors.join(','));

    for (const el of elements) {
      if (isElementVisible(el)) {
        const role = getAccessibleRole(el);
        const name = getAccessibleName(el);
        const states = getAriaStates(el);

        interactive.push({
          role,
          name,
          tag: el.tagName?.toLowerCase(),
          states,
          selector: generateSelector(el),
          focusable: el.tabIndex >= 0 || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(el.tagName),
        });
      }
    }

    return interactive;
  }

  // Helper: Extract forms and form fields
  function extractForms() {
    const forms = [];
    const formElements = document.querySelectorAll('form');

    for (const form of formElements) {
      if (isElementVisible(form)) {
        const fields = [];

        // Find all form fields
        const inputs = form.querySelectorAll('input, textarea, select');
        for (const input of inputs) {
          if (isElementVisible(input)) {
            fields.push({
              role: getAccessibleRole(input),
              name: getAccessibleName(input),
              tag: input.tagName?.toLowerCase(),
              type: input.type || null,
              value: input.value || null,
              placeholder: input.placeholder || null,
              required: input.required || false,
              selector: generateSelector(input),
            });
          }
        }

        forms.push({
          name: getAccessibleName(form),
          action: form.action || null,
          method: form.method || 'get',
          fieldCount: fields.length,
          fields,
          selector: generateSelector(form),
        });
      }
    }

    return forms;
  }

  // Helper: Extract navigation elements
  function extractNavigation() {
    const navigation = [];
    const navElements = document.querySelectorAll('nav, [role="navigation"]');

    for (const nav of navElements) {
      if (isElementVisible(nav)) {
        const links = [];

        // Find all links within navigation
        const linkElements = nav.querySelectorAll('a[href]');
        for (const link of linkElements) {
          if (isElementVisible(link)) {
            links.push({
              text: link.textContent?.trim().substring(0, 100),
              href: link.href,
              current: link.getAttribute('aria-current') || null,
              selector: generateSelector(link),
            });
          }
        }

        navigation.push({
          name: getAccessibleName(nav),
          linkCount: links.length,
          links,
          selector: generateSelector(nav),
        });
      }
    }

    return navigation;
  }

  // Network Log Retrieval

  function getNetworkLog(id, options = {}) {
    try {
      const limit = options.limit || 50;
      const offset = options.offset || 0;
      const filter = options.filter || {};

      let filtered = networkLog.slice();

      // Apply filters
      if (filter.method) {
        filtered = filtered.filter(entry =>
          entry.method?.toLowerCase() === filter.method.toLowerCase()
        );
      }

      if (filter.status) {
        filtered = filtered.filter(entry => entry.status === filter.status);
      }

      if (filter.url) {
        filtered = filtered.filter(entry =>
          entry.url?.includes(filter.url)
        );
      }

      if (filter.type) {
        filtered = filtered.filter(entry => entry.type === filter.type);
      }

      // Apply offset and limit
      const results = filtered.slice(offset, offset + limit);

      sendResult(id, {
        total: networkLog.length,
        filtered: filtered.length,
        returned: results.length,
        offset,
        limit,
        entries: results,
        summary: {
          totalRequests: networkLog.length,
          byMethod: summarizeByMethod(networkLog),
          byStatus: summarizeByStatus(networkLog),
          byType: summarizeByType(networkLog),
          avgDuration: calculateAvgDuration(networkLog),
        }
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  function clearNetworkLog(id) {
    try {
      const count = networkLog.length;
      networkLog.length = 0; // Clear array
      sendResult(id, {
        cleared: count,
        remaining: networkLog.length,
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Helper: Summarize requests by method
  function summarizeByMethod(entries) {
    const summary = {};
    for (const entry of entries) {
      const method = entry.method || 'UNKNOWN';
      summary[method] = (summary[method] || 0) + 1;
    }
    return summary;
  }

  // Helper: Summarize requests by status code
  function summarizeByStatus(entries) {
    const summary = {};
    for (const entry of entries) {
      const status = entry.status || 'pending';
      summary[status] = (summary[status] || 0) + 1;
    }
    return summary;
  }

  // Helper: Summarize requests by type
  function summarizeByType(entries) {
    const summary = {};
    for (const entry of entries) {
      const type = entry.type || 'unknown';
      summary[type] = (summary[type] || 0) + 1;
    }
    return summary;
  }

  // Helper: Calculate average duration
  function calculateAvgDuration(entries) {
    const withDuration = entries.filter(e => e.duration !== null);
    if (withDuration.length === 0) return 0;
    const total = withDuration.reduce((sum, e) => sum + e.duration, 0);
    return Math.round(total / withDuration.length);
  }

  // DOM Mutation Observer - Track live DOM changes for Spirit
  const mutationLog = [];
  const MAX_MUTATION_LOG_SIZE = 200;
  let mutationObserver = null;
  let observerActive = false;

  // Start observing DOM mutations
  function startMutationObserver(id, options = {}) {
    try {
      // Stop existing observer if any
      if (mutationObserver) {
        mutationObserver.disconnect();
      }

      const observeOptions = {
        childList: options.childList !== false, // default true
        attributes: options.attributes !== false, // default true
        characterData: options.characterData !== false, // default true
        subtree: options.subtree !== false, // default true
        attributeOldValue: options.attributeOldValue || false,
        characterDataOldValue: options.characterDataOldValue || false,
        attributeFilter: options.attributeFilter || undefined,
      };

      // Create observer
      mutationObserver = new MutationObserver((mutations) => {
        const timestamp = Date.now();

        // Process each mutation
        for (const mutation of mutations) {
          const logEntry = {
            id: mutationLog.length + 1,
            timestamp,
            type: mutation.type,
            target: getElementSelector(mutation.target),
            targetTag: mutation.target.tagName?.toLowerCase(),
          };

          // Add type-specific details
          if (mutation.type === 'childList') {
            logEntry.addedNodes = Array.from(mutation.addedNodes).map(node => ({
              type: node.nodeType,
              tag: node.tagName?.toLowerCase(),
              selector: node.nodeType === 1 ? getElementSelector(node) : null,
              text: node.nodeType === 3 ? truncateString(node.textContent, 100) : null,
            }));
            logEntry.removedNodes = Array.from(mutation.removedNodes).map(node => ({
              type: node.nodeType,
              tag: node.tagName?.toLowerCase(),
              selector: node.nodeType === 1 ? getElementSelector(node) : null,
              text: node.nodeType === 3 ? truncateString(node.textContent, 100) : null,
            }));
          } else if (mutation.type === 'attributes') {
            logEntry.attributeName = mutation.attributeName;
            logEntry.oldValue = mutation.oldValue;
            logEntry.newValue = mutation.target.getAttribute(mutation.attributeName);
          } else if (mutation.type === 'characterData') {
            logEntry.oldValue = mutation.oldValue;
            logEntry.newValue = truncateString(mutation.target.textContent, 200);
          }

          addToMutationLog(logEntry);
        }
      });

      // Start observing
      const targetElement = options.target ?
        (typeof options.target === 'string' ? document.querySelector(options.target) : options.target) :
        document.body;

      if (!targetElement) {
        sendResult(id, null, serializeError(new Error('Target element not found')));
        return;
      }

      mutationObserver.observe(targetElement, observeOptions);
      observerActive = true;

      sendResult(id, {
        started: true,
        target: getElementSelector(targetElement),
        options: observeOptions,
        timestamp: Date.now(),
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Stop observing DOM mutations
  function stopMutationObserver(id) {
    try {
      if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
        observerActive = false;
      }

      sendResult(id, {
        stopped: true,
        wasActive: observerActive,
        capturedMutations: mutationLog.length,
        timestamp: Date.now(),
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Get mutation log
  function getMutationLog(id, options = {}) {
    try {
      const limit = options.limit || mutationLog.length;
      const offset = options.offset || 0;
      const type = options.type; // filter by mutation type
      const target = options.target; // filter by target selector

      let filtered = mutationLog;

      // Apply filters
      if (type) {
        filtered = filtered.filter(m => m.type === type);
      }
      if (target) {
        filtered = filtered.filter(m => m.target?.includes(target));
      }

      const slice = filtered.slice(offset, offset + limit);

      sendResult(id, {
        mutations: slice,
        total: filtered.length,
        offset,
        limit,
        observerActive,
        filters: { type, target },
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Clear mutation log
  function clearMutationLog(id) {
    try {
      const count = mutationLog.length;
      mutationLog.length = 0; // Clear array
      sendResult(id, {
        cleared: count,
        remaining: mutationLog.length,
        observerActive,
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Add mutation to log
  function addToMutationLog(entry) {
    mutationLog.push(entry);
    // Limit log size (FIFO)
    if (mutationLog.length > MAX_MUTATION_LOG_SIZE) {
      mutationLog.shift();
    }
  }

  // Helper: Get a CSS selector for an element
  function getElementSelector(element) {
    if (!element || element.nodeType !== 1) return null;

    if (element.id) {
      return `#${element.id}`;
    }

    if (element.className && typeof element.className === 'string') {
      const classes = element.className.trim().split(/\s+/).join('.');
      if (classes) {
        return `${element.tagName.toLowerCase()}.${classes}`;
      }
    }

    return element.tagName.toLowerCase();
  }

  // Performance Profiler - Measure page performance metrics
  const performanceLog = [];
  const MAX_PERFORMANCE_LOG_SIZE = 500;
  let performanceObservers = [];
  let performanceMonitoringActive = false;

  // Start performance monitoring
  function startPerformanceMonitoring(id, options = {}) {
    try {
      // Stop existing observers if any
      stopAllPerformanceObservers();

      const types = options.types || ['navigation', 'resource', 'paint', 'layout-shift', 'largest-contentful-paint', 'longtask'];
      const observers = [];

      // Create observers for each type
      for (const type of types) {
        try {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              addToPerformanceLog({
                type,
                name: entry.name,
                startTime: entry.startTime,
                duration: entry.duration,
                entryType: entry.entryType,
                timestamp: Date.now(),
                details: extractEntryDetails(entry, type),
              });
            }
          });

          observer.observe({ type, buffered: true });
          observers.push({ type, observer });
        } catch (err) {
          // Some entry types might not be supported
          originalConsole.warn(`[skyeyes] PerformanceObserver type '${type}' not supported:`, err.message);
        }
      }

      performanceObservers = observers;
      performanceMonitoringActive = true;

      sendResult(id, {
        started: true,
        observing: observers.map(o => o.type),
        timestamp: Date.now(),
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Stop performance monitoring
  function stopPerformanceMonitoring(id) {
    try {
      stopAllPerformanceObservers();

      sendResult(id, {
        stopped: true,
        capturedEntries: performanceLog.length,
        timestamp: Date.now(),
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Get performance metrics
  function getPerformanceMetrics(id, options = {}) {
    try {
      const type = options.type; // filter by type
      const limit = options.limit || performanceLog.length;
      const offset = options.offset || 0;

      let filtered = performanceLog;

      // Apply type filter
      if (type) {
        filtered = filtered.filter(e => e.type === type);
      }

      const slice = filtered.slice(offset, offset + limit);

      // Calculate summary statistics
      const summary = {
        total: filtered.length,
        byType: {},
        navigation: null,
        paint: null,
        layoutShifts: null,
        longTasks: null,
      };

      // Count by type
      for (const entry of filtered) {
        summary.byType[entry.type] = (summary.byType[entry.type] || 0) + 1;
      }

      // Navigation timing (page load)
      const navEntries = filtered.filter(e => e.type === 'navigation');
      if (navEntries.length > 0) {
        const nav = navEntries[0].details;
        summary.navigation = {
          domContentLoaded: nav.domContentLoadedEventEnd - nav.domContentLoadedEventStart,
          loadComplete: nav.loadEventEnd - nav.loadEventStart,
          domInteractive: nav.domInteractive,
          domComplete: nav.domComplete,
          transferSize: nav.transferSize,
          encodedBodySize: nav.encodedBodySize,
          decodedBodySize: nav.decodedBodySize,
        };
      }

      // Paint timing
      const paintEntries = filtered.filter(e => e.type === 'paint');
      if (paintEntries.length > 0) {
        summary.paint = {};
        for (const entry of paintEntries) {
          summary.paint[entry.name] = entry.startTime;
        }
      }

      // Layout shifts (CLS - Cumulative Layout Shift)
      const layoutShifts = filtered.filter(e => e.type === 'layout-shift');
      if (layoutShifts.length > 0) {
        const totalScore = layoutShifts.reduce((sum, e) => sum + (e.details.value || 0), 0);
        summary.layoutShifts = {
          count: layoutShifts.length,
          cumulativeScore: totalScore,
          averageScore: totalScore / layoutShifts.length,
        };
      }

      // Long tasks (>50ms blocking tasks)
      const longTasks = filtered.filter(e => e.type === 'longtask');
      if (longTasks.length > 0) {
        const totalDuration = longTasks.reduce((sum, e) => sum + e.duration, 0);
        summary.longTasks = {
          count: longTasks.length,
          totalDuration,
          averageDuration: totalDuration / longTasks.length,
          maxDuration: Math.max(...longTasks.map(e => e.duration)),
        };
      }

      sendResult(id, {
        entries: slice,
        total: filtered.length,
        offset,
        limit,
        monitoringActive: performanceMonitoringActive,
        summary,
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Clear performance log
  function clearPerformanceLog(id) {
    try {
      const count = performanceLog.length;
      performanceLog.length = 0;
      sendResult(id, {
        cleared: count,
        remaining: performanceLog.length,
        monitoringActive: performanceMonitoringActive,
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Get current performance snapshot
  function getPerformanceSnapshot(id) {
    try {
      const timing = performance.timing;
      const navigation = performance.navigation;
      const memory = performance.memory;

      const snapshot = {
        timestamp: Date.now(),
        timing: {
          navigationStart: timing.navigationStart,
          domContentLoadedEventEnd: timing.domContentLoadedEventEnd - timing.navigationStart,
          loadEventEnd: timing.loadEventEnd - timing.navigationStart,
          domInteractive: timing.domInteractive - timing.navigationStart,
          domComplete: timing.domComplete - timing.navigationStart,
          responseEnd: timing.responseEnd - timing.navigationStart,
          requestStart: timing.requestStart - timing.navigationStart,
        },
        navigation: {
          type: navigation.type,
          redirectCount: navigation.redirectCount,
        },
        memory: memory ? {
          usedJSHeapSize: memory.usedJSHeapSize,
          totalJSHeapSize: memory.totalJSHeapSize,
          jsHeapSizeLimit: memory.jsHeapSizeLimit,
        } : null,
        resources: performance.getEntriesByType('resource').length,
        marks: performance.getEntriesByType('mark').length,
        measures: performance.getEntriesByType('measure').length,
      };

      sendResult(id, snapshot, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Helper: Stop all performance observers
  function stopAllPerformanceObservers() {
    for (const { observer } of performanceObservers) {
      try {
        observer.disconnect();
      } catch (err) {
        // Ignore errors during disconnect
      }
    }
    performanceObservers = [];
    performanceMonitoringActive = false;
  }

  // Helper: Extract details from performance entry
  function extractEntryDetails(entry, type) {
    const details = {};

    if (type === 'navigation') {
      details.domContentLoadedEventStart = entry.domContentLoadedEventStart;
      details.domContentLoadedEventEnd = entry.domContentLoadedEventEnd;
      details.loadEventStart = entry.loadEventStart;
      details.loadEventEnd = entry.loadEventEnd;
      details.domInteractive = entry.domInteractive;
      details.domComplete = entry.domComplete;
      details.transferSize = entry.transferSize;
      details.encodedBodySize = entry.encodedBodySize;
      details.decodedBodySize = entry.decodedBodySize;
      details.redirectCount = entry.redirectCount;
    } else if (type === 'resource') {
      details.initiatorType = entry.initiatorType;
      details.transferSize = entry.transferSize;
      details.encodedBodySize = entry.encodedBodySize;
      details.decodedBodySize = entry.decodedBodySize;
      details.responseEnd = entry.responseEnd;
    } else if (type === 'paint') {
      // Paint entries have minimal details
      details.paintType = entry.name;
    } else if (type === 'layout-shift') {
      details.value = entry.value;
      details.hadRecentInput = entry.hadRecentInput;
    } else if (type === 'largest-contentful-paint') {
      details.renderTime = entry.renderTime;
      details.loadTime = entry.loadTime;
      details.size = entry.size;
      details.elementType = entry.element?.tagName?.toLowerCase();
    } else if (type === 'longtask') {
      details.attribution = entry.attribution?.map(attr => ({
        name: attr.name,
        entryType: attr.entryType,
        containerType: attr.containerType,
        containerName: attr.containerName,
      }));
    }

    return details;
  }

  // Helper: Add to performance log
  function addToPerformanceLog(entry) {
    performanceLog.push(entry);
    // Limit log size (FIFO)
    if (performanceLog.length > MAX_PERFORMANCE_LOG_SIZE) {
      performanceLog.shift();
    }
  }

  // Screenshot Capability - Visual regression testing
  const screenshotCache = new Map();
  const MAX_SCREENSHOT_CACHE = 10;

  // Capture screenshot of element or viewport
  function captureScreenshot(id, options = {}) {
    const startTime = Date.now();
    healthMetrics.executions.dom.count++;

    try {
      const selector = options.selector || null;
      const fullPage = options.fullPage || false;
      const quality = options.quality || 0.92;
      const format = options.format || 'png'; // png or jpeg
      const screenshotId = options.screenshotId || `screenshot-${Date.now()}`;

      let element = selector ? document.querySelector(selector) : document.documentElement;

      if (!element) {
        sendResultWithTiming(id, null, serializeError(new Error(`Element not found: ${selector}`)), startTime);
        return;
      }

      // Create canvas
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // Get element dimensions
      const rect = element.getBoundingClientRect();
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;

      let width, height, x, y;

      if (fullPage && element === document.documentElement) {
        // Full page screenshot
        width = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
        x = 0;
        y = 0;
      } else {
        // Element screenshot
        width = rect.width;
        height = rect.height;
        x = rect.left + scrollX;
        y = rect.top + scrollY;
      }

      canvas.width = width;
      canvas.height = height;

      // Set background
      ctx.fillStyle = window.getComputedStyle(element).backgroundColor || '#ffffff';
      ctx.fillRect(0, 0, width, height);

      // Render element as SVG foreignObject (works for most DOM content)
      const svgData = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
          <foreignObject width="100%" height="100%">
            <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;overflow:hidden;">
              ${element.outerHTML}
            </div>
          </foreignObject>
        </svg>
      `;

      const img = new Image();
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);

      img.onload = function() {
        try {
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);

          // Convert to data URL
          const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
          const dataUrl = canvas.toDataURL(mimeType, quality);

          // Store in cache
          screenshotCache.set(screenshotId, {
            id: screenshotId,
            dataUrl,
            width,
            height,
            format,
            size: dataUrl.length,
            timestamp: Date.now(),
            selector: selector || 'viewport',
            fullPage,
          });

          // Limit cache size
          if (screenshotCache.size > MAX_SCREENSHOT_CACHE) {
            const firstKey = screenshotCache.keys().next().value;
            screenshotCache.delete(firstKey);
          }

          const duration = Date.now() - startTime;
          healthMetrics.executions.dom.totalTime += duration;

          sendResultWithTiming(id, {
            screenshotId,
            width,
            height,
            format,
            size: dataUrl.length,
            sizeKB: Math.round(dataUrl.length / 1024),
            cached: true,
            dataUrl: options.returnData ? dataUrl : undefined,
          }, null, startTime);

        } catch (err) {
          const duration = Date.now() - startTime;
          healthMetrics.executions.dom.totalTime += duration;
          healthMetrics.executions.dom.errors++;
          healthMetrics.totalErrors++;
          sendResultWithTiming(id, null, serializeError(err), startTime);
        }
      };

      img.onerror = function() {
        URL.revokeObjectURL(url);
        const duration = Date.now() - startTime;
        healthMetrics.executions.dom.totalTime += duration;
        healthMetrics.executions.dom.errors++;
        healthMetrics.totalErrors++;
        sendResultWithTiming(id, null, serializeError(new Error('Failed to render screenshot')), startTime);
      };

      img.src = url;

    } catch (err) {
      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;
      healthMetrics.executions.dom.errors++;
      healthMetrics.totalErrors++;
      sendResultWithTiming(id, null, serializeError(err), startTime);
    }
  }

  // Get screenshot from cache
  function getScreenshot(id, screenshotId) {
    try {
      const screenshot = screenshotCache.get(screenshotId);

      if (!screenshot) {
        sendResult(id, null, serializeError(new Error(`Screenshot '${screenshotId}' not found`)));
        return;
      }

      sendResult(id, screenshot, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // List cached screenshots
  function listScreenshots(id) {
    try {
      const list = Array.from(screenshotCache.values()).map(s => ({
        id: s.id,
        timestamp: s.timestamp,
        width: s.width,
        height: s.height,
        format: s.format,
        sizeKB: Math.round(s.size / 1024),
        selector: s.selector,
        fullPage: s.fullPage,
      }));

      sendResult(id, {
        count: list.length,
        screenshots: list,
        maxScreenshots: MAX_SCREENSHOT_CACHE,
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Clear screenshot cache
  function clearScreenshots(id, screenshotId) {
    try {
      if (screenshotId) {
        const existed = screenshotCache.has(screenshotId);
        screenshotCache.delete(screenshotId);
        sendResult(id, {
          cleared: existed ? 1 : 0,
          remaining: screenshotCache.size,
        }, null);
      } else {
        const count = screenshotCache.size;
        screenshotCache.clear();
        sendResult(id, {
          cleared: count,
          remaining: screenshotCache.size,
        }, null);
      }
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Compare two screenshots (simple pixel difference)
  function compareScreenshots(id, screenshot1Id, screenshot2Id) {
    try {
      const s1 = screenshotCache.get(screenshot1Id);
      const s2 = screenshotCache.get(screenshot2Id);

      if (!s1) {
        sendResult(id, null, serializeError(new Error(`Screenshot '${screenshot1Id}' not found`)));
        return;
      }

      if (!s2) {
        sendResult(id, null, serializeError(new Error(`Screenshot '${screenshot2Id}' not found`)));
        return;
      }

      // Basic comparison - dimensions and size
      const dimensionsMatch = s1.width === s2.width && s1.height === s2.height;
      const dataMatch = s1.dataUrl === s2.dataUrl;

      sendResult(id, {
        screenshot1: screenshot1Id,
        screenshot2: screenshot2Id,
        dimensionsMatch,
        identical: dataMatch,
        sizeDiff: s2.size - s1.size,
        sizeDiffKB: Math.round((s2.size - s1.size) / 1024),
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Storage Monitoring - Track localStorage and sessionStorage usage
  const storageLog = [];
  const MAX_STORAGE_LOG_SIZE = 200;
  let storageMonitoringActive = false;
  let storageInterval = null;

  // Get current storage usage
  function getStorageUsage(id) {
    try {
      const localStorage = calculateStorageSize(window.localStorage);
      const sessionStorage = calculateStorageSize(window.sessionStorage);

      const result = {
        timestamp: Date.now(),
        localStorage: {
          itemCount: window.localStorage.length,
          sizeBytes: localStorage.totalSize,
          sizeKB: Math.round(localStorage.totalSize / 1024),
          quota: localStorage.quota,
          percentUsed: localStorage.percentUsed,
          items: localStorage.items,
        },
        sessionStorage: {
          itemCount: window.sessionStorage.length,
          sizeBytes: sessionStorage.totalSize,
          sizeKB: Math.round(sessionStorage.totalSize / 1024),
          quota: sessionStorage.quota,
          percentUsed: sessionStorage.percentUsed,
          items: sessionStorage.items,
        },
        monitoringActive: storageMonitoringActive,
      };

      sendResult(id, result, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Start monitoring storage changes
  function startStorageMonitoring(id, options = {}) {
    try {
      // Stop existing monitoring if any
      if (storageInterval) {
        clearInterval(storageInterval);
      }

      const interval = options.interval || 1000; // Default 1 second
      const trackChanges = options.trackChanges !== false; // Default true

      // Take initial snapshot
      const initialLocal = captureStorageSnapshot(window.localStorage, 'localStorage');
      const initialSession = captureStorageSnapshot(window.sessionStorage, 'sessionStorage');
      let lastSnapshot = { localStorage: initialLocal, sessionStorage: initialSession };

      // Poll for changes
      storageInterval = setInterval(() => {
        const currentLocal = captureStorageSnapshot(window.localStorage, 'localStorage');
        const currentSession = captureStorageSnapshot(window.sessionStorage, 'sessionStorage');

        if (trackChanges) {
          // Detect changes
          const changes = detectStorageChanges(lastSnapshot, {
            localStorage: currentLocal,
            sessionStorage: currentSession
          });

          if (changes.length > 0) {
            for (const change of changes) {
              addToStorageLog(change);
            }
          }
        }

        lastSnapshot = { localStorage: currentLocal, sessionStorage: currentSession };
      }, interval);

      storageMonitoringActive = true;

      sendResult(id, {
        started: true,
        interval,
        trackChanges,
        timestamp: Date.now(),
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Stop monitoring storage
  function stopStorageMonitoring(id) {
    try {
      if (storageInterval) {
        clearInterval(storageInterval);
        storageInterval = null;
      }
      storageMonitoringActive = false;

      sendResult(id, {
        stopped: true,
        capturedChanges: storageLog.length,
        timestamp: Date.now(),
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Get storage change log
  function getStorageLog(id, options = {}) {
    try {
      const storageType = options.storageType; // 'localStorage' or 'sessionStorage'
      const changeType = options.changeType; // 'set', 'remove', 'clear'
      const key = options.key; // filter by key name
      const limit = options.limit || storageLog.length;
      const offset = options.offset || 0;

      let filtered = storageLog;

      // Apply filters
      if (storageType) {
        filtered = filtered.filter(e => e.storageType === storageType);
      }
      if (changeType) {
        filtered = filtered.filter(e => e.changeType === changeType);
      }
      if (key) {
        filtered = filtered.filter(e => e.key && e.key.includes(key));
      }

      const slice = filtered.slice(offset, offset + limit);

      sendResult(id, {
        changes: slice,
        total: filtered.length,
        offset,
        limit,
        monitoringActive: storageMonitoringActive,
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Clear storage log
  function clearStorageLog(id) {
    try {
      const count = storageLog.length;
      storageLog.length = 0;
      sendResult(id, {
        cleared: count,
        remaining: storageLog.length,
        monitoringActive: storageMonitoringActive,
      }, null);
    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Set storage item
  function setStorageItem(id, storageType, key, value) {
    try {
      const storage = storageType === 'sessionStorage' ? window.sessionStorage : window.localStorage;
      storage.setItem(key, value);

      sendResult(id, {
        success: true,
        storageType,
        key,
        valueLength: value.length,
        newSize: calculateStorageSize(storage).totalSize,
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Get storage item
  function getStorageItem(id, storageType, key) {
    try {
      const storage = storageType === 'sessionStorage' ? window.sessionStorage : window.localStorage;
      const value = storage.getItem(key);

      sendResult(id, {
        key,
        value,
        exists: value !== null,
        valueLength: value ? value.length : 0,
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Remove storage item
  function removeStorageItem(id, storageType, key) {
    try {
      const storage = storageType === 'sessionStorage' ? window.sessionStorage : window.localStorage;
      const existed = storage.getItem(key) !== null;
      storage.removeItem(key);

      sendResult(id, {
        success: true,
        storageType,
        key,
        existed,
        newSize: calculateStorageSize(storage).totalSize,
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Clear storage
  function clearStorage(id, storageType) {
    try {
      const storage = storageType === 'sessionStorage' ? window.sessionStorage : window.localStorage;
      const itemCount = storage.length;
      storage.clear();

      sendResult(id, {
        success: true,
        storageType,
        clearedItems: itemCount,
        newSize: 0,
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Helper: Calculate storage size
  function calculateStorageSize(storage) {
    let totalSize = 0;
    const items = [];

    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const value = storage.getItem(key);
      const size = (key.length + value.length) * 2; // UTF-16 encoding (2 bytes per char)

      totalSize += size;
      items.push({
        key,
        sizeBytes: size,
        sizeKB: Math.round(size / 1024),
        valueLength: value.length,
      });
    }

    // Estimate quota (typically 5-10MB for localStorage, varies by browser)
    const estimatedQuota = 5 * 1024 * 1024; // 5MB estimate
    const percentUsed = Math.round((totalSize / estimatedQuota) * 100);

    return {
      totalSize,
      quota: estimatedQuota,
      percentUsed,
      items: items.sort((a, b) => b.sizeBytes - a.sizeBytes), // Sort by size descending
    };
  }

  // Helper: Capture storage snapshot
  function captureStorageSnapshot(storage, storageType) {
    const snapshot = {};
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      snapshot[key] = storage.getItem(key);
    }
    return snapshot;
  }

  // Helper: Detect storage changes
  function detectStorageChanges(before, after) {
    const changes = [];
    const timestamp = Date.now();

    // Check localStorage
    const localChanges = compareStorageSnapshots(
      before.localStorage,
      after.localStorage,
      'localStorage',
      timestamp
    );
    changes.push(...localChanges);

    // Check sessionStorage
    const sessionChanges = compareStorageSnapshots(
      before.sessionStorage,
      after.sessionStorage,
      'sessionStorage',
      timestamp
    );
    changes.push(...sessionChanges);

    return changes;
  }

  // Helper: Compare storage snapshots
  function compareStorageSnapshots(before, after, storageType, timestamp) {
    const changes = [];
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const key of allKeys) {
      const beforeValue = before[key];
      const afterValue = after[key];

      if (beforeValue === undefined && afterValue !== undefined) {
        // Item added
        changes.push({
          storageType,
          changeType: 'set',
          key,
          oldValue: null,
          newValue: truncateString(afterValue, 200),
          valueLength: afterValue.length,
          timestamp,
        });
      } else if (beforeValue !== undefined && afterValue === undefined) {
        // Item removed
        changes.push({
          storageType,
          changeType: 'remove',
          key,
          oldValue: truncateString(beforeValue, 200),
          newValue: null,
          timestamp,
        });
      } else if (beforeValue !== afterValue) {
        // Item modified
        changes.push({
          storageType,
          changeType: 'set',
          key,
          oldValue: truncateString(beforeValue, 200),
          newValue: truncateString(afterValue, 200),
          valueLength: afterValue.length,
          timestamp,
        });
      }
    }

    return changes;
  }

  // Helper: Add to storage log
  function addToStorageLog(entry) {
    storageLog.push(entry);
    // Limit log size (FIFO)
    if (storageLog.length > MAX_STORAGE_LOG_SIZE) {
      storageLog.shift();
    }
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", function () {
    stopHeartbeat();
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    stopAllPerformanceObservers();
    if (storageInterval) {
      clearInterval(storageInterval);
      storageInterval = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
    }
  });

  // Connect on load
  connect();
})();
