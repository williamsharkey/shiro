#!/usr/bin/env node
/**
 * Shiro MCP Server
 *
 * Connect Claude Code to Shiro browser OS via WebRTC.
 * No local server needed - direct peer-to-peer connection.
 *
 * Usage:
 *   npx shiro-mcp           # Run as MCP server
 *   npx shiro-mcp --install # Add to Claude Code config
 *
 * Then use the connect tool with a code from 'remote start' in Shiro.
 */

import { createInterface } from "readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

// Handle --install flag before loading WebRTC (which is slow)
if (process.argv.includes("--install") || process.argv.includes("install")) {
  const mcpEntry = {
    shiro: {
      command: "npx",
      args: ["-y", "shiro-mcp"]
    }
  };

  // Config file locations for different Claude products
  const configPaths = [
    { path: join(homedir(), ".claude.json"), name: "Claude Code CLI" },
    { path: join(homedir(), ".claude", "claude_desktop_config.json"), name: "Claude Code CLI (alt)" },
    { path: join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"), name: "Claude Desktop (macOS)" },
    { path: join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json"), name: "Claude Desktop (Windows)" },
  ];

  let installed = false;

  for (const { path: configPath, name } of configPaths) {
    if (!configPath) continue;

    try {
      let config: any = {};

      if (existsSync(configPath)) {
        const content = readFileSync(configPath, "utf-8");
        config = JSON.parse(content);
      } else {
        // Create config file if it doesn't exist (for primary Claude Code config)
        if (configPath.endsWith(".claude.json")) {
          mkdirSync(dirname(configPath), { recursive: true });
        } else {
          continue; // Skip non-existent paths for other products
        }
      }

      // Add or update mcpServers
      config.mcpServers = { ...config.mcpServers, ...mcpEntry };

      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      console.log(`✓ Added shiro to ${name}`);
      console.log(`  ${configPath}`);
      installed = true;
    } catch (e) {
      // Skip files we can't read/write
    }
  }

  if (installed) {
    console.log("\n✓ Installation complete!");
    console.log("\nNext steps:");
    console.log("  1. Restart Claude Code");
    console.log("  2. In Shiro browser, run: remote start");
    console.log("  3. Use the shiro:connect tool with the code");
    console.log("\nLearn more: https://shiro.computer/mcp.html");
  } else {
    console.log("No Claude config files found.");
    console.log("\nManual installation:");
    console.log("Add this to your Claude config (~/.claude.json or similar):\n");
    console.log(JSON.stringify({ mcpServers: mcpEntry }, null, 2));
  }

  process.exit(0);
}

// WebRTC for Node.js using node-datachannel
import { PeerConnection } from "node-datachannel";

const SIGNALING_URL = process.env.SHIRO_SIGNALING_URL || "https://shiro.computer";

// MCP Protocol types
interface MCPRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// Connection state
interface RemoteConnection {
  code: string;
  pc: any;
  dc: any;
  status: "connecting" | "connected" | "disconnected";
  pendingRequests: Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>;
  requestCounter: number;
}

let activeConnection: RemoteConnection | null = null;

// Console error tracking - accumulates errors pushed from Shiro
let consoleErrors: Array<{ timestamp: number; message: string; source?: string; line?: number }> = [];

// User messages from Shiro panel - accumulate and include in next tool response
let userMessages: Array<{ timestamp: number; message: string }> = [];

// Tool definitions
// Store the last used code for reconnection
let lastCode: string | null = null;

const TOOLS = [
  {
    name: "connect",
    description: "Connect to a Shiro browser OS instance via WebRTC. Get a connection code by running 'remote start' in the Shiro terminal.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Connection code from 'remote start' (e.g., 'fluffy-cloud-shimutako')" }
      },
      required: ["code"]
    }
  },
  {
    name: "reconnect",
    description: "Reconnect to Shiro after the browser page reloads. Uses the last connection code. The browser side must run 'remote start' again after reload.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "disconnect",
    description: "Disconnect from Shiro and clear the saved connection code.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "status",
    description: "Check connection status. Returns { connected: boolean, code?: string, status?: 'connecting'|'connected'|'disconnected' }",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "exec",
    description: `Execute a shell command in Shiro browser OS. Returns { type: "exec_result", stdout, stderr, exitCode }.

Shiro provides 140+ commands including standard Unix tools plus:
- hc: DOM navigation (hc live, hc look, hc q <sel>, hc @N to click)
- serve: Virtual HTTP servers (serve <dir> [port], serve stop <port>)
- image: Filesystem snapshots (image save/load/list/delete)
- npm/node: Install packages and run JavaScript
- console: View browser console (console -e for errors)

Supports pipes (|), redirects (>, >>), &&, ||, and variables.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command (e.g., 'ls -la', 'hc live && hc look', 'cat file.txt | grep pattern')" }
      },
      required: ["command"]
    }
  },
  {
    name: "read",
    description: `Read a file from Shiro's virtual filesystem. Returns { type: "read_result", path, content }.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path (e.g., '/home/user/app.js', '/tmp/data.json')" }
      },
      required: ["path"]
    }
  },
  {
    name: "write",
    description: `Write a file to Shiro's virtual filesystem. Returns { type: "write_result", path, ok: boolean }.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path to write" },
        content: { type: "string", description: "File content (text)" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "list",
    description: `List directory contents. Returns { type: "list_result", path, entries: string[] }.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (e.g., '/', '/home/user')" }
      },
      required: ["path"]
    }
  },
  {
    name: "eval",
    description: `Execute JavaScript in the browser context. Returns { type: "eval_result", result }.

IMPORTANT: Use JSON.stringify() for objects, otherwise they return as "[object Object]".`,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript expression. Wrap objects in JSON.stringify()." }
      },
      required: ["code"]
    }
  },
  {
    name: "errors",
    description: "Get and clear pending console errors from Shiro browser. Errors accumulate passively and show as pendingErrors count in exec results.",
    inputSchema: {
      type: "object",
      properties: {
        clear: { type: "boolean", description: "Clear errors after fetching (default: true)" }
      }
    }
  }
];

async function sendCommand(cmd: object): Promise<any> {
  if (!activeConnection || activeConnection.status !== "connected" || !activeConnection.dc) {
    throw new Error("Not connected to Shiro");
  }

  const requestId = `req-${++activeConnection.requestCounter}`;
  const message = JSON.stringify({ ...cmd, requestId });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      activeConnection?.pendingRequests.delete(requestId);
      reject(new Error("Request timed out"));
    }, 30000);

    activeConnection!.pendingRequests.set(requestId, {
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); }
    });

    // node-datachannel uses sendMessage
    activeConnection!.dc!.sendMessage(message);
  });
}

/**
 * Attempt to reconnect after disconnect (e.g., page reload on Shiro side).
 * Polls for a new offer with the same code.
 */
let reconnectActive = false;

async function attemptReconnect(code: string) {
  // Prevent multiple reconnect loops from racing
  if (reconnectActive) {
    console.error("[shiro-mcp] Reconnect already in progress, skipping");
    return;
  }
  reconnectActive = true;

  const maxAttempts = 60; // 5 minutes at 5-second intervals
  let attempt = 0;

  const reconnect = async () => {
    // Stop if user manually disconnected or connected to different code
    if (activeConnection && activeConnection.code !== code) {
      console.error("[shiro-mcp] Reconnect cancelled - different connection active");
      reconnectActive = false;
      return;
    }

    attempt++;
    if (attempt > maxAttempts) {
      console.error("[shiro-mcp] Reconnect timeout - giving up");
      activeConnection = null;
      reconnectActive = false;
      return;
    }

    console.error(`[shiro-mcp] Reconnect attempt ${attempt}/${maxAttempts}...`);

    try {
      // Check if a new offer is available
      const offerRes = await fetch(`${SIGNALING_URL}/offer/${code}`);
      if (offerRes.ok) {
        // Clean up old connection without triggering another reconnect
        if (activeConnection) {
          try { activeConnection.dc?.close(); } catch {}
          try { activeConnection.pc?.close(); } catch {}
          activeConnection = null;
        }
        // Try to connect with the new offer
        await connectShiro(code);
        console.error("[shiro-mcp] Reconnected successfully!");
        reconnectActive = false;
        return;
      }
    } catch (e) {
      // Ignore errors, keep trying
    }

    // Try again in 5 seconds
    setTimeout(reconnect, 5000);
  };

  // Wait a bit before first attempt (give Shiro time to re-register)
  setTimeout(reconnect, 2000);
}

async function connectShiro(code: string): Promise<string> {
  // Clean up existing connection if any
  if (activeConnection) {
    console.error(`[shiro-mcp] Disconnecting previous session (${activeConnection.code})`);
    try {
      if (activeConnection.dc) activeConnection.dc.close();
      activeConnection.pc.close();
    } catch {
      // Ignore close errors
    }
    activeConnection = null;
  }

  // Save code for future reconnects
  lastCode = code;

  console.error(`[shiro-mcp] Connecting: ${code}`);

  const offerRes = await fetch(`${SIGNALING_URL}/offer/${code}`);
  if (!offerRes.ok) {
    throw new Error(`Code not found: ${code}`);
  }

  const { offer, candidates } = await offerRes.json();

  // node-datachannel PeerConnection
  const pc = new PeerConnection("shiro-mcp", {
    iceServers: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]
  });

  const connection: RemoteConnection = {
    code,
    pc,
    dc: null,
    status: "connecting",
    pendingRequests: new Map(),
    requestCounter: 0
  };

  activeConnection = connection;

  const iceCandidates: any[] = [];

  // node-datachannel uses callback-based events
  pc.onLocalCandidate((candidate: string, mid: string) => {
    iceCandidates.push({ candidate, sdpMid: mid });
  });

  pc.onDataChannel((dc: any) => {
    connection.dc = dc;

    dc.onOpen(() => {
      console.error("[shiro-mcp] Connected!");
      connection.status = "connected";
      // Identify ourselves to the Shiro panel
      dc.sendMessage(JSON.stringify({ type: 'hello', name: 'shiro-mcp' }));
    });

    dc.onClosed(() => {
      console.error("[shiro-mcp] Disconnected");
      connection.status = "disconnected";
      // Start auto-reconnect loop
      attemptReconnect(connection.code);
    });

    dc.onMessage((msg: string | Buffer) => {
      try {
        const data = typeof msg === "string" ? msg : msg.toString();
        const response = JSON.parse(data);

        // Handle console error notifications pushed from Shiro (no requestId)
        if (response.type === "console_error") {
          consoleErrors.push({
            timestamp: Date.now(),
            message: response.message,
            source: response.source,
            line: response.line
          });
          return;
        }

        // Handle user messages from the Shiro panel input
        if (response.type === "user_message") {
          userMessages.push({
            timestamp: Date.now(),
            message: response.message
          });
          return;
        }

        // Ignore hello_ack (no requestId expected)
        if (response.type === "hello_ack") return;

        const { requestId, ...result } = response;

        if (requestId && connection.pendingRequests.has(requestId)) {
          const { resolve, reject } = connection.pendingRequests.get(requestId)!;
          connection.pendingRequests.delete(requestId);

          if (result.type === "error") {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        }
      } catch (e) {
        console.error("[shiro-mcp] Parse error:", e);
      }
    });
  });

  // Set remote description (the offer from Shiro)
  pc.setRemoteDescription(offer.sdp, offer.type);

  // Add remote ICE candidates
  for (const candidate of candidates) {
    if (candidate.candidate) {
      pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid || "0");
    }
  }

  // Wait for ICE gathering to complete
  await new Promise<void>((resolve) => {
    pc.onGatheringStateChange((state: string) => {
      if (state === "complete") resolve();
    });
    setTimeout(resolve, 5000);
  });

  // Get our answer
  const localDesc = pc.localDescription();
  if (!localDesc) {
    throw new Error("Failed to create local description");
  }

  const answerRes = await fetch(`${SIGNALING_URL}/answer/${code}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      answer: { type: localDesc.type, sdp: localDesc.sdp },
      candidates: iceCandidates
    })
  });

  if (!answerRes.ok) {
    throw new Error("Failed to send answer");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timed out")), 30000);
    const check = setInterval(() => {
      if (connection.status === "connected") {
        clearTimeout(timeout);
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  return `Connected to Shiro (${code})`;
}

function disconnectShiro(): string {
  if (!activeConnection) return "Not connected";
  try {
    if (activeConnection.dc) activeConnection.dc.close();
    activeConnection.pc.close();
  } catch {
    // Ignore close errors
  }
  activeConnection = null;
  return "Disconnected";
}

/** Drain any pending user messages and attach them to a tool result */
function attachUserMessages(result: any) {
  if (userMessages.length > 0) {
    result.userMessages = userMessages.map(m => m.message);
    userMessages = [];
  }
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "connect":
      return await connectShiro(args.code as string);

    case "reconnect": {
      if (!lastCode) {
        throw new Error("No previous connection. Use 'connect' with a code first.");
      }
      // Retry with backoff - Shiro may take time to re-register after reload
      const maxAttempts = 5;
      const delays = [1500, 2000, 3000, 4000, 5000];

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        console.error(`[shiro-mcp] Reconnect attempt ${attempt + 1}/${maxAttempts}...`);
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));

        try {
          // Check if offer exists
          const offerRes = await fetch(`${SIGNALING_URL}/offer/${lastCode}`);
          if (offerRes.ok) {
            return await connectShiro(lastCode);
          }
          console.error(`[shiro-mcp] Offer not ready yet (${offerRes.status})`);
        } catch (e: any) {
          console.error(`[shiro-mcp] Attempt failed: ${e.message}`);
        }
      }
      throw new Error("Reconnect failed after 5 attempts. Is Shiro still running?");
    }

    case "disconnect":
      lastCode = null; // Clear saved code on explicit disconnect
      return disconnectShiro();

    case "status":
      if (!activeConnection) {
        return { connected: false, lastCode: lastCode || undefined };
      }
      return {
        connected: activeConnection.status === "connected",
        code: activeConnection.code,
        status: activeConnection.status
      };

    case "exec": {
      const result: any = await sendCommand({ type: "exec", command: args.command });
      if (consoleErrors.length > 0) {
        result.pendingErrors = consoleErrors.length;
      }
      attachUserMessages(result);
      return result;
    }

    case "errors": {
      const errors = [...consoleErrors];
      const shouldClear = args.clear !== false;
      if (shouldClear) consoleErrors = [];
      return { type: "console_errors", count: errors.length, errors, cleared: shouldClear };
    }

    case "read": {
      const result: any = await sendCommand({ type: "read", path: args.path });
      if (result.content) {
        result.content = Buffer.from(result.content, "base64").toString("utf-8");
      }
      attachUserMessages(result);
      return result;
    }

    case "write": {
      const result: any = await sendCommand({ type: "write", path: args.path, content: Buffer.from(args.content as string).toString("base64") });
      attachUserMessages(result);
      return result;
    }

    case "list": {
      const result: any = await sendCommand({ type: "list", path: args.path });
      attachUserMessages(result);
      return result;
    }

    case "eval": {
      const result: any = await sendCommand({ type: "eval", code: args.code });
      attachUserMessages(result);
      return result;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleRequest(request: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "shiro", version: "1.0.0" },
            capabilities: { tools: {} }
          }
        };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const { name, arguments: args } = params as { name: string; arguments: Record<string, unknown> };
        const result = await handleTool(name, args || {});
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
        };
      }

      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
    }
  } catch (error: any) {
    return { jsonrpc: "2.0", id, error: { code: -32000, message: error.message } };
  }
}

// Main
const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  try {
    const request = JSON.parse(line) as MCPRequest;
    const response = await handleRequest(request);
    console.log(JSON.stringify(response));
  } catch (error: any) {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${error.message}` }
    }));
  }
});

process.on("SIGINT", () => { disconnectShiro(); process.exit(0); });
process.on("SIGTERM", () => { disconnectShiro(); process.exit(0); });

console.error("[shiro-mcp] Ready - use 'connect' tool with code from 'remote start' in Shiro");
