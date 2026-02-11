#!/usr/bin/env node
/**
 * Shiro MCP server for Claude Code CLI.
 *
 * Connects to a Shiro browser instance via WebRTC for remote shell,
 * file, and JavaScript execution.
 *
 * Tools:
 *   connect(code)    — Connect using code from `remote start`
 *   reconnect()      — Reconnect using saved code
 *   disconnect()     — Disconnect and clear saved code
 *   status()         — Check connection status
 *   exec(command)    — Execute shell command
 *   read(path)       — Read file
 *   write(path, content) — Write file
 *   list(path)       — List directory
 *   eval(code)       — Execute JavaScript in browser
 */

const { PeerConnection, DataChannel } = require('node-datachannel');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- CLI flags ---
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`shiro-mcp - MCP server for connecting Claude Code to Shiro browser OS

Usage:
  shiro-mcp              Start MCP server (stdin/stdout JSON-RPC)
  shiro-mcp --install    Add shiro to Claude Code config
  shiro-mcp --help       Show this help

For more info: https://shiro.computer/mcp`);
  process.exit(0);
}

if (process.argv.includes('--install')) {
  installConfig();
  process.exit(0);
}

// --- Config file handling ---
const CONFIG_DIR = path.join(os.homedir(), '.shiro-mcp');
const CODE_FILE = path.join(CONFIG_DIR, 'last-code');

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function saveCode(code) {
  ensureConfigDir();
  fs.writeFileSync(CODE_FILE, code, 'utf8');
}

function loadCode() {
  try {
    return fs.readFileSync(CODE_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function clearCode() {
  try {
    fs.unlinkSync(CODE_FILE);
  } catch {
    // ignore
  }
}

function installConfig() {
  // Try Claude Code CLI config first
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');

  let config = {};
  try {
    const existing = fs.readFileSync(claudeJsonPath, 'utf8');
    config = JSON.parse(existing);
  } catch {
    // No existing config
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  config.mcpServers.shiro = {
    command: 'npx',
    args: ['-y', 'shiro-mcp']
  };

  fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`Added shiro to ${claudeJsonPath}`);
  console.log('Restart Claude Code to activate.');
}

// --- Signaling server ---
const SIGNALING_URL = 'https://remote.shiro.computer';

// --- Connection state ---
let pc = null;
let dc = null;
let connectionCode = null;
let connectionStatus = 'disconnected'; // disconnected, connecting, connected

// Pending requests awaiting response
const pendingRequests = new Map();
let requestCounter = 0;

// Console error tracking
let consoleErrors = [];
let lastErrorCheck = Date.now();

// --- WebRTC connection ---

async function connect(code) {
  if (dc && dc.isOpen()) {
    return { success: true, message: 'Already connected' };
  }

  connectionCode = code;
  connectionStatus = 'connecting';

  try {
    // Fetch offer from signaling server
    const offerRes = await fetch(`${SIGNALING_URL}/offer/${code}`);
    if (!offerRes.ok) {
      if (offerRes.status === 404) {
        throw new Error('Connection code not found or expired. Run `remote start` in Shiro to get a new code.');
      }
      throw new Error(`Signaling error: ${offerRes.status}`);
    }

    const { offer, candidates } = await offerRes.json();

    // Create peer connection
    pc = new PeerConnection('shiro-mcp', {
      iceServers: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
      ],
    });

    // Collect our ICE candidates
    const ourCandidates = [];
    pc.onLocalCandidate((candidate, mid) => {
      ourCandidates.push({ candidate, sdpMid: mid });
    });

    // Handle incoming data channel
    pc.onDataChannel((channel) => {
      dc = channel;
      setupDataChannel();
    });

    // Set remote description (the offer from browser)
    pc.setRemoteDescription(offer.sdp, offer.type);

    // Add remote ICE candidates
    for (const c of candidates || []) {
      pc.addRemoteCandidate(c.candidate, c.sdpMid || '0');
    }

    // Create answer
    const answer = pc.localDescription();

    // Wait a bit for ICE gathering
    await new Promise(r => setTimeout(r, 1000));

    // Send answer to signaling server
    const answerRes = await fetch(`${SIGNALING_URL}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        answer: { type: 'answer', sdp: answer.sdp },
        candidates: ourCandidates,
      }),
    });

    if (!answerRes.ok) {
      throw new Error(`Failed to send answer: ${answerRes.status}`);
    }

    // Wait for connection
    const timeout = 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (dc && dc.isOpen()) {
        connectionStatus = 'connected';
        saveCode(code);
        return { success: true, message: 'Connected to Shiro' };
      }
      await new Promise(r => setTimeout(r, 100));
    }

    throw new Error('Connection timeout - WebRTC handshake did not complete');

  } catch (err) {
    connectionStatus = 'disconnected';
    cleanup();
    throw err;
  }
}

function setupDataChannel() {
  dc.onMessage((msg) => {
    try {
      const data = JSON.parse(msg);

      // Handle console error notifications from Shiro
      if (data.type === 'console_error') {
        consoleErrors.push({
          timestamp: Date.now(),
          message: data.message,
          source: data.source,
          line: data.line
        });
        return;
      }

      const pending = pendingRequests.get(data.requestId);
      if (pending) {
        pendingRequests.delete(data.requestId);
        pending.resolve(data);
      }
    } catch (err) {
      process.stderr.write(`[shiro-mcp] Message parse error: ${err.message}\n`);
    }
  });

  dc.onClosed(() => {
    connectionStatus = 'disconnected';
    process.stderr.write('[shiro-mcp] Connection closed\n');
  });

  dc.onError((err) => {
    process.stderr.write(`[shiro-mcp] Channel error: ${err}\n`);
  });
}

function cleanup() {
  if (dc) {
    try { dc.close(); } catch {}
    dc = null;
  }
  if (pc) {
    try { pc.close(); } catch {}
    pc = null;
  }
}

function disconnect() {
  cleanup();
  clearCode();
  connectionCode = null;
  connectionStatus = 'disconnected';
}

async function sendCommand(type, payload = {}) {
  if (!dc || !dc.isOpen()) {
    throw new Error('Not connected. Use connect tool first.');
  }

  const requestId = `req-${++requestCounter}`;
  const message = JSON.stringify({ type, requestId, ...payload });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Request timeout'));
    }, 30000);

    pendingRequests.set(requestId, {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
    });

    dc.sendMessage(message);
  });
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'connect',
    description: 'Connect to a Shiro browser instance using a connection code from `remote start`',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Connection code (e.g., fluffy-cloud-shimutako)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'reconnect',
    description: 'Reconnect to Shiro using the last saved connection code',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'disconnect',
    description: 'Disconnect from Shiro and clear the saved connection code',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'Check Shiro connection status',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'exec',
    description: 'Execute a shell command in Shiro terminal',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read',
    description: 'Read a file from Shiro filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (e.g., /home/user/file.txt)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: 'Write a file to Shiro filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content (text)' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list',
    description: 'List directory contents in Shiro filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: /home/user)' },
      },
    },
  },
  {
    name: 'eval',
    description: 'Execute JavaScript code in the Shiro browser context',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute' },
      },
      required: ['code'],
    },
  },
  {
    name: 'errors',
    description: 'Get and clear pending console errors from Shiro browser',
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Clear errors after fetching (default: true)' },
      },
    },
  },
];

// --- Tool handlers ---

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

async function handleToolCall(name, args) {
  try {
    switch (name) {
      case 'connect': {
        const result = await connect(args.code);
        return textResult(result.message);
      }

      case 'reconnect': {
        const code = loadCode();
        if (!code) {
          return errorResult('No saved connection code. Use connect with a code from `remote start`.');
        }
        const result = await connect(code);
        return textResult(result.message);
      }

      case 'disconnect': {
        disconnect();
        return textResult('Disconnected from Shiro');
      }

      case 'status': {
        const displayCode = connectionCode ? connectionCode.split('-').slice(0, 2).join('-') : null;
        return textResult(JSON.stringify({
          status: connectionStatus,
          code: displayCode,
          connected: dc && dc.isOpen(),
        }, null, 2));
      }

      case 'exec': {
        const result = await sendCommand('exec', { command: args.command });
        if (result.type === 'error') {
          return errorResult(result.error);
        }
        const errorCount = consoleErrors.length;
        const response = {
          type: 'exec_result',
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          exitCode: result.exitCode,
        };
        if (errorCount > 0) {
          response.pendingErrors = errorCount;
        }
        if (result.exitCode !== 0) {
          return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
      }

      case 'read': {
        const result = await sendCommand('read', { path: args.path });
        if (result.type === 'error') {
          return errorResult(result.error);
        }
        // Decode base64 content
        const content = Buffer.from(result.content, 'base64').toString('utf8');
        return textResult(content);
      }

      case 'write': {
        // Encode content as base64
        const base64 = Buffer.from(args.content, 'utf8').toString('base64');
        const result = await sendCommand('write', { path: args.path, content: base64 });
        if (result.type === 'error') {
          return errorResult(result.error);
        }
        return textResult(`Wrote ${args.path}`);
      }

      case 'list': {
        const listPath = args.path || '/home/user';
        const result = await sendCommand('list', { path: listPath });
        if (result.type === 'error') {
          return errorResult(result.error);
        }
        return textResult(result.entries.join('\n') || '(empty directory)');
      }

      case 'eval': {
        const result = await sendCommand('eval', { code: args.code });
        if (result.type === 'error') {
          return errorResult(result.error);
        }
        return textResult(result.result);
      }

      case 'errors': {
        const errors = [...consoleErrors];
        const shouldClear = args.clear !== false;
        if (shouldClear) {
          consoleErrors = [];
        }
        return textResult(JSON.stringify({
          type: 'console_errors',
          count: errors.length,
          errors: errors,
          cleared: shouldClear
        }, null, 2));
      }

      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err.message);
  }
}

// --- MCP stdio protocol ---

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (line) {
      handleMessage(line).catch((err) => {
        process.stderr.write(`[shiro-mcp] Error: ${err.message}\n`);
      });
    }
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'shiro', version: '1.0.0' },
        },
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      break;

    case 'tools/call': {
      const { name, arguments: args } = params;
      const result = await handleToolCall(name, args || {});
      send({ jsonrpc: '2.0', id, result });
      break;
    }

    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      break;

    default:
      if (id) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown method: ${method}` },
        });
      }
  }
}

process.stderr.write('[shiro-mcp] Started - use connect tool with code from `remote start`\n');
