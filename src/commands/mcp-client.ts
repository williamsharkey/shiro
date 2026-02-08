/**
 * MCP Streamable HTTP client — connects Shiro to external MCP servers.
 * Uses fetch() POST with JSON-RPC 2.0 to any MCP server endpoint.
 *
 * Subcommands:
 *   mcp connect <url>        — Initialize session, list tools
 *   mcp disconnect [url]     — Close session
 *   mcp tools [url]          — List tools on a connection
 *   mcp call <tool> [json]   — Call a tool, print result
 *   mcp status               — Show all active connections
 */

import { Command, CommandContext } from './index';

interface MCPConnection {
  url: string;
  sessionId: string | null;
  tools: MCPTool[];
  connectedAt: number;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

declare global {
  interface Window {
    __shiroMCPConnections?: Map<string, MCPConnection>;
  }
}

function getConnections(): Map<string, MCPConnection> {
  if (!window.__shiroMCPConnections) {
    window.__shiroMCPConnections = new Map();
  }
  return window.__shiroMCPConnections;
}

let nextId = 1;

async function jsonRpcRequest(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string | null,
): Promise<{ result: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: nextId++,
    method,
    ...(params !== undefined ? { params } : {}),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Request timed out (30s)');
    throw err;
  }
  clearTimeout(timeout);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const newSessionId = resp.headers.get('Mcp-Session-Id') || sessionId || null;

  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    // Parse SSE — collect all JSON-RPC messages, return the response (has id)
    const text = await resp.text();
    const lines = text.split('\n');
    const messages: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          messages.push(JSON.parse(line.slice(6)));
        } catch { /* skip non-JSON lines */ }
      }
    }
    // Find the JSON-RPC response (has 'id' field matching our request)
    const response = messages.find(m => 'id' in m && 'result' in m) as Record<string, unknown> | undefined;
    if (response) {
      return { result: response.result, sessionId: newSessionId };
    }
    // Check for error response
    const errResp = messages.find(m => 'id' in m && 'error' in m) as Record<string, unknown> | undefined;
    if (errResp) {
      const err = errResp.error as Record<string, unknown>;
      throw new Error(`MCP error ${err.code}: ${err.message}`);
    }
    // Fallback: return last message
    return { result: messages[messages.length - 1] ?? null, sessionId: newSessionId };
  }

  const json = await resp.json() as Record<string, unknown>;
  if (json.error) {
    const err = json.error as Record<string, unknown>;
    throw new Error(`MCP error ${err.code}: ${err.message}`);
  }
  return { result: json.result, sessionId: newSessionId };
}

async function mcpConnect(url: string): Promise<{ conn: MCPConnection; output: string }> {
  const conns = getConnections();

  // Initialize handshake
  const initResp = await jsonRpcRequest(url, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'shiro', version: '1.0.0' },
  });

  const sessionId = initResp.sessionId;

  // Send initialized notification (no id field = notification)
  const notifHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionId) notifHeaders['Mcp-Session-Id'] = sessionId;
  await fetch(url, {
    method: 'POST',
    headers: notifHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  // List tools
  const toolsResp = await jsonRpcRequest(url, 'tools/list', {}, sessionId);
  const toolsList = (toolsResp.result as Record<string, unknown>)?.tools;
  const tools: MCPTool[] = Array.isArray(toolsList) ? toolsList as MCPTool[] : [];

  const conn: MCPConnection = { url, sessionId, tools, connectedAt: Date.now() };
  conns.set(url, conn);

  let out = `Connected to ${url}\n`;
  if (sessionId) out += `Session: ${sessionId}\n`;
  out += `${tools.length} tool(s) available:\n`;
  for (const t of tools) {
    out += `  ${t.name}`;
    if (t.description) out += ` — ${t.description}`;
    out += '\n';
  }
  return { conn, output: out };
}

async function mcpDisconnect(url: string): Promise<string> {
  const conns = getConnections();
  const conn = conns.get(url);
  if (!conn) return `Not connected to ${url}\n`;

  // Send DELETE to close session
  try {
    const headers: Record<string, string> = {};
    if (conn.sessionId) headers['Mcp-Session-Id'] = conn.sessionId;
    await fetch(url, { method: 'DELETE', headers });
  } catch { /* ignore close errors */ }

  conns.delete(url);
  return `Disconnected from ${url}\n`;
}

function findConnectionForTool(toolName: string): MCPConnection | null {
  const conns = getConnections();
  for (const conn of conns.values()) {
    if (conn.tools.some(t => t.name === toolName)) return conn;
  }
  return null;
}

export const mcpCmd: Command = {
  name: 'mcp',
  description: 'MCP Streamable HTTP client — connect to external MCP servers',

  async exec(ctx: CommandContext): Promise<number> {
    const sub = ctx.args[0];

    if (!sub || sub === 'help' || sub === '--help') {
      ctx.stdout =
        'Usage: mcp <subcommand>\n' +
        '\n' +
        'Subcommands:\n' +
        '  connect <url>        Connect to an MCP server\n' +
        '  disconnect [url]     Disconnect from a server\n' +
        '  tools [url]          List tools (all or for a specific server)\n' +
        '  call <tool> [json]   Call a tool with optional JSON arguments\n' +
        '  status               Show all active connections\n' +
        '\n' +
        'Note: Only works with CORS-enabled MCP servers (e.g. *.shiro.computer).\n' +
        'Localhost servers won\'t work from browser due to CORS restrictions.\n';
      return 0;
    }

    if (sub === 'connect') {
      const url = ctx.args[1];
      if (!url) {
        ctx.stderr = 'Usage: mcp connect <url>\n';
        return 1;
      }
      try {
        const { output } = await mcpConnect(url);
        ctx.stdout = output;
        return 0;
      } catch (err: unknown) {
        ctx.stderr = `Failed to connect: ${(err as Error).message}\n`;
        return 1;
      }
    }

    if (sub === 'disconnect') {
      const conns = getConnections();
      let url = ctx.args[1];
      if (!url) {
        // Disconnect all
        if (conns.size === 0) {
          ctx.stdout = 'No active connections\n';
          return 0;
        }
        let out = '';
        for (const u of [...conns.keys()]) {
          out += await mcpDisconnect(u);
        }
        ctx.stdout = out;
        return 0;
      }
      ctx.stdout = await mcpDisconnect(url);
      return 0;
    }

    if (sub === 'tools') {
      const conns = getConnections();
      const url = ctx.args[1];
      if (url) {
        const conn = conns.get(url);
        if (!conn) {
          ctx.stderr = `Not connected to ${url}\n`;
          return 1;
        }
        let out = `Tools on ${url}:\n`;
        for (const t of conn.tools) {
          out += `  ${t.name}`;
          if (t.description) out += ` — ${t.description}`;
          out += '\n';
        }
        ctx.stdout = out;
        return 0;
      }
      // List all tools across all connections
      if (conns.size === 0) {
        ctx.stdout = 'No active connections. Use: mcp connect <url>\n';
        return 0;
      }
      let out = '';
      for (const [u, conn] of conns) {
        out += `${u} (${conn.tools.length} tools):\n`;
        for (const t of conn.tools) {
          out += `  ${t.name}`;
          if (t.description) out += ` — ${t.description}`;
          out += '\n';
        }
      }
      ctx.stdout = out;
      return 0;
    }

    if (sub === 'call') {
      const toolName = ctx.args[1];
      if (!toolName) {
        ctx.stderr = 'Usage: mcp call <tool> [json-args]\n';
        return 1;
      }

      const conn = findConnectionForTool(toolName);
      if (!conn) {
        ctx.stderr = `Tool "${toolName}" not found on any connection\n`;
        return 1;
      }

      let args: Record<string, unknown> = {};
      const jsonStr = ctx.args.slice(2).join(' ');
      if (jsonStr) {
        try {
          args = JSON.parse(jsonStr);
        } catch {
          ctx.stderr = `Invalid JSON arguments: ${jsonStr}\n`;
          return 1;
        }
      }

      try {
        const resp = await jsonRpcRequest(
          conn.url,
          'tools/call',
          { name: toolName, arguments: args },
          conn.sessionId,
        );
        // Update session if it changed
        if (resp.sessionId) conn.sessionId = resp.sessionId;

        const result = resp.result as Record<string, unknown> | undefined;
        if (result && Array.isArray(result.content)) {
          // Standard MCP tool result with content array
          for (const item of result.content as Array<Record<string, unknown>>) {
            if (item.type === 'text') {
              ctx.stdout += (item.text as string) + '\n';
            } else {
              ctx.stdout += JSON.stringify(item, null, 2) + '\n';
            }
          }
        } else {
          ctx.stdout = JSON.stringify(resp.result, null, 2) + '\n';
        }
        return 0;
      } catch (err: unknown) {
        ctx.stderr = `Tool call failed: ${(err as Error).message}\n`;
        return 1;
      }
    }

    if (sub === 'status') {
      const conns = getConnections();
      if (conns.size === 0) {
        ctx.stdout = 'No active MCP connections\n';
        return 0;
      }
      let out = `${conns.size} active connection(s):\n`;
      for (const [url, conn] of conns) {
        const age = Math.round((Date.now() - conn.connectedAt) / 1000);
        out += `  ${url} — ${conn.tools.length} tools, ${age}s ago`;
        if (conn.sessionId) out += `, session: ${conn.sessionId.slice(0, 12)}...`;
        out += '\n';
      }
      ctx.stdout = out;
      return 0;
    }

    ctx.stderr = `Unknown subcommand: ${sub}. Try: mcp help\n`;
    return 1;
  },
};
