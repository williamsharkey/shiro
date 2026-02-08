/**
 * Encrypted group networking — peer discovery via WebSocket relay.
 * All crypto uses native Web Crypto API (PBKDF2 + AES-GCM).
 *
 * Subcommands:
 *   group join <name> <password>  — Join a group
 *   group leave                   — Leave current group
 *   group peers                   — List discovered peers
 *   group status                  — Show current group info
 */

import { Command, CommandContext } from './index';
import { createRemotePanel, RemotePanel } from '../remote-panel';

interface PeerInfo {
  peerId: string;
  name: string;
  capabilities: string[];
  mcpUrl?: string;
  remoteCode?: string;
  lastSeen: number;
}

interface GroupState {
  name: string;
  channelId: string;
  key: CryptoKey;
  ws: WebSocket;
  peers: Map<string, PeerInfo>;
  peerId: string;
  peerName: string;
  heartbeatTimer: number;
  pruneTimer: number;
  panel: RemotePanel;
}

declare global {
  interface Window {
    __shiroGroup?: GroupState;
  }
}

const RELAY_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const HEARTBEAT_INTERVAL = 30_000;
const PEER_TIMEOUT = 90_000;

async function deriveKey(password: string, groupName: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('shiro-group-' + groupName), iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function computeChannelId(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('raw', key);
  const hash = await crypto.subtle.digest('SHA-256', exported);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function encrypt(key: CryptoKey, data: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(data),
  );
  // Encode as base64: iv + ciphertext
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(key: CryptoKey, encoded: string): Promise<string> {
  const raw = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const ciphertext = raw.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

function buildAnnouncement(state: GroupState): Record<string, unknown> {
  return {
    type: 'announce',
    peerId: state.peerId,
    name: state.peerName,
    capabilities: ['exec', 'read', 'write', 'eval'],
    mcpUrl: undefined,
    remoteCode: undefined,
    timestamp: Date.now(),
  };
}

async function sendAnnouncement(state: GroupState): Promise<void> {
  if (state.ws.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify(buildAnnouncement(state));
  const encrypted = await encrypt(state.key, payload);
  state.ws.send(encrypted);
}

function pruneStale(state: GroupState): void {
  const now = Date.now();
  for (const [id, peer] of state.peers) {
    if (now - peer.lastSeen > PEER_TIMEOUT) {
      state.peers.delete(id);
      state.panel.log('info', `Peer left: ${peer.name}`);
    }
  }
}

function cleanupGroup(): void {
  const state = window.__shiroGroup;
  if (!state) return;
  clearInterval(state.heartbeatTimer);
  clearInterval(state.pruneTimer);
  if (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING) {
    state.ws.close();
  }
  state.panel.setStatus('disconnected');
  state.panel.close();
  window.__shiroGroup = undefined;
}

export const groupCmd: Command = {
  name: 'group',
  description: 'Encrypted group networking — peer discovery via relay',

  async exec(ctx: CommandContext): Promise<number> {
    const sub = ctx.args[0];

    if (!sub || sub === 'help' || sub === '--help') {
      ctx.stdout =
        'Usage: group <subcommand>\n' +
        '\n' +
        'Subcommands:\n' +
        '  join <name> <password>   Join an encrypted group\n' +
        '  leave                    Leave current group\n' +
        '  peers                    List discovered peers\n' +
        '  status                   Show current group info\n';
      return 0;
    }

    if (sub === 'join') {
      const groupName = ctx.args[1];
      const password = ctx.args[2];
      if (!groupName || !password) {
        ctx.stderr = 'Usage: group join <name> <password>\n';
        return 1;
      }

      if (window.__shiroGroup) {
        ctx.stderr = `Already in group "${window.__shiroGroup.name}". Run: group leave\n`;
        return 1;
      }

      // Derive key and channel ID
      const key = await deriveKey(password, groupName);
      const channelId = await computeChannelId(key);

      // Connect to relay
      const wsUrl = `${RELAY_URL}/channel/${channelId}`;
      const ws = new WebSocket(wsUrl);

      const panel = createRemotePanel(`group-${channelId}`, `Group: ${groupName}`);
      panel.setStatus('connecting');
      panel.log('info', `Joining group "${groupName}"...`);
      panel.log('info', `Channel: ${channelId.slice(0, 8)}...`);

      const peerId = crypto.randomUUID();
      const peerName = ctx.env['USER'] || ctx.env['HOSTNAME'] || 'shiro-' + peerId.slice(0, 6);

      const state: GroupState = {
        name: groupName,
        channelId,
        key,
        ws,
        peers: new Map(),
        peerId,
        peerName,
        heartbeatTimer: 0,
        pruneTimer: 0,
        panel,
      };

      ws.onopen = () => {
        panel.setStatus('connected');
        panel.log('info', 'Connected to relay');
        sendAnnouncement(state);

        // Heartbeat
        state.heartbeatTimer = window.setInterval(() => sendAnnouncement(state), HEARTBEAT_INTERVAL);
        state.pruneTimer = window.setInterval(() => pruneStale(state), HEARTBEAT_INTERVAL);
      };

      ws.onmessage = async (event) => {
        try {
          const plaintext = await decrypt(key, event.data as string);
          const msg = JSON.parse(plaintext);

          if (msg.type === 'announce' && msg.peerId !== peerId) {
            // Validate timestamp (reject messages older than 2 minutes)
            if (Math.abs(Date.now() - msg.timestamp) > 120_000) return;

            const isNew = !state.peers.has(msg.peerId);
            state.peers.set(msg.peerId, {
              peerId: msg.peerId,
              name: msg.name,
              capabilities: msg.capabilities || [],
              mcpUrl: msg.mcpUrl,
              remoteCode: msg.remoteCode,
              lastSeen: Date.now(),
            });

            if (isNew) {
              panel.log('info', `Peer joined: ${msg.name}`);
              // Respond immediately so new peer sees us
              sendAnnouncement(state);
            }
          }
        } catch (err: any) {
          // Decryption failure — likely wrong password or corrupt message
          const msg = err?.message || String(err);
          if (msg.includes('decrypt')) {
            panel.log('info', 'Received message with wrong key (different password?)');
          } else {
            panel.log('error', `Failed to process message: ${msg.slice(0, 80)}`);
          }
        }
      };

      ws.onclose = () => {
        panel.log('error', 'Disconnected from relay');
        panel.setStatus('disconnected');
        // Don't auto-cleanup — let user run `group leave`
      };

      ws.onerror = () => {
        panel.log('error', 'WebSocket error');
      };

      window.__shiroGroup = state;

      ctx.stdout = `Joining group "${groupName}" (channel: ${channelId.slice(0, 8)}...)\n` +
        `Your name: ${peerName}\n` +
        `Peer ID: ${peerId.slice(0, 8)}...\n`;
      return 0;
    }

    if (sub === 'leave') {
      if (!window.__shiroGroup) {
        ctx.stdout = 'Not in a group\n';
        return 0;
      }
      const name = window.__shiroGroup.name;
      cleanupGroup();
      ctx.stdout = `Left group "${name}"\n`;
      return 0;
    }

    if (sub === 'peers') {
      const state = window.__shiroGroup;
      if (!state) {
        ctx.stderr = 'Not in a group. Use: group join <name> <password>\n';
        return 1;
      }

      if (state.peers.size === 0) {
        ctx.stdout = 'No peers discovered yet\n';
        return 0;
      }

      let out = `${state.peers.size} peer(s):\n`;
      const now = Date.now();
      for (const peer of state.peers.values()) {
        const ago = Math.round((now - peer.lastSeen) / 1000);
        out += `  ${peer.name} (${peer.peerId.slice(0, 8)}...)`;
        out += ` — ${ago}s ago`;
        if (peer.capabilities.length) out += ` [${peer.capabilities.join(',')}]`;
        if (peer.mcpUrl) out += ` mcp:${peer.mcpUrl}`;
        if (peer.remoteCode) out += ` remote:${peer.remoteCode}`;
        out += '\n';
      }
      ctx.stdout = out;
      return 0;
    }

    if (sub === 'status') {
      const state = window.__shiroGroup;
      if (!state) {
        ctx.stdout = 'Not in a group\n';
        return 0;
      }
      const wsState = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][state.ws.readyState] || 'UNKNOWN';
      ctx.stdout =
        `Group: ${state.name}\n` +
        `Channel: ${state.channelId.slice(0, 8)}...\n` +
        `Your name: ${state.peerName}\n` +
        `Peer ID: ${state.peerId.slice(0, 8)}...\n` +
        `WebSocket: ${wsState}\n` +
        `Peers: ${state.peers.size}\n`;
      return 0;
    }

    ctx.stderr = `Unknown subcommand: ${sub}. Try: group help\n`;
    return 1;
  },
};
