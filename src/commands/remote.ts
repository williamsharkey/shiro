import { Command, CommandContext } from './index';
import { Shell } from '../shell';
import { createRemotePanel, type RemotePanel } from '../remote-panel';

// LocalStorage key for persisting remote session code across page reloads
const REMOTE_CODE_KEY = 'shiro-remote-code';

// Word lists for generating memorable codes
// ~200 adjectives × ~200 nouns × 64^4 syllables = ~46 bits of entropy
const ADJECTIVES = [
  'tiny', 'fluffy', 'cozy', 'swift', 'bright', 'calm', 'happy', 'lazy', 'brave', 'clever',
  'gentle', 'fierce', 'quiet', 'loud', 'warm', 'cool', 'soft', 'bold', 'shy', 'wild',
  'sleepy', 'bouncy', 'fuzzy', 'crisp', 'fresh', 'golden', 'silver', 'ruby', 'jade', 'coral',
  'misty', 'sunny', 'stormy', 'snowy', 'rainy', 'windy', 'dusty', 'foggy', 'dewy', 'frosty',
  'sweet', 'spicy', 'salty', 'tangy', 'zesty', 'mellow', 'rich', 'light', 'dark', 'pale',
  'vivid', 'pastel', 'neon', 'matte', 'glossy', 'rustic', 'sleek', 'plush', 'silky', 'velvet',
  'cosmic', 'lunar', 'solar', 'stellar', 'astral', 'mystic', 'magic', 'dreamy', 'hazy', 'ethereal',
  'peppy', 'perky', 'chipper', 'jolly', 'merry', 'gleeful', 'blissful', 'serene', 'tranquil', 'peaceful',
  'rapid', 'speedy', 'hasty', 'nimble', 'agile', 'spry', 'lithe', 'graceful', 'elegant', 'dainty',
  'chunky', 'pudgy', 'plump', 'round', 'lanky', 'slender', 'petite', 'grand', 'mighty', 'humble',
  'ancient', 'modern', 'retro', 'vintage', 'classic', 'novel', 'young', 'elder', 'primal', 'neo',
  'azure', 'amber', 'crimson', 'emerald', 'violet', 'indigo', 'scarlet', 'teal', 'cyan', 'magenta',
  'lucky', 'plucky', 'gutsy', 'feisty', 'sassy', 'zany', 'quirky', 'funky', 'groovy', 'jazzy',
  'pixel', 'cyber', 'quantum', 'atomic', 'nano', 'mega', 'ultra', 'hyper', 'super', 'mini',
  'royal', 'noble', 'regal', 'fancy', 'posh', 'swanky', 'ritzy', 'snazzy', 'dapper', 'natty',
  'rusty', 'mossy', 'leafy', 'woody', 'earthy', 'sandy', 'rocky', 'stony', 'pebbly', 'grassy',
  'wavy', 'curly', 'spiky', 'bumpy', 'smooth', 'rough', 'jagged', 'sharp', 'blunt', 'pointy',
  'striped', 'spotted', 'dotted', 'checked', 'plain', 'ornate', 'simple', 'complex', 'basic', 'prime',
  'alpha', 'beta', 'gamma', 'delta', 'omega', 'zero', 'null', 'void', 'flux', 'core',
  'nifty', 'spiffy', 'dandy', 'keen', 'neat', 'rad', 'epic', 'ace', 'top', 'pro',
];

const NOUNS = [
  'cat', 'dog', 'fox', 'wolf', 'bear', 'deer', 'frog', 'toad', 'fish', 'bird',
  'owl', 'hawk', 'crow', 'swan', 'duck', 'goose', 'dove', 'wren', 'lark', 'finch',
  'bee', 'ant', 'moth', 'wasp', 'fly', 'bug', 'snail', 'slug', 'worm', 'spider',
  'tree', 'leaf', 'root', 'bark', 'seed', 'bloom', 'petal', 'stem', 'vine', 'moss',
  'rock', 'stone', 'gem', 'crystal', 'pearl', 'shell', 'sand', 'dust', 'clay', 'mud',
  'cloud', 'rain', 'snow', 'frost', 'hail', 'fog', 'mist', 'dew', 'storm', 'wind',
  'sun', 'moon', 'star', 'comet', 'nova', 'nebula', 'quasar', 'pulsar', 'void', 'cosmos',
  'flame', 'spark', 'ember', 'ash', 'smoke', 'steam', 'vapor', 'ice', 'blaze', 'glow',
  'wave', 'tide', 'surf', 'foam', 'reef', 'coral', 'kelp', 'algae', 'plankton', 'drift',
  'peak', 'cliff', 'cave', 'gorge', 'canyon', 'valley', 'hill', 'dune', 'mesa', 'ridge',
  'brook', 'creek', 'stream', 'river', 'lake', 'pond', 'pool', 'spring', 'well', 'falls',
  'path', 'trail', 'road', 'lane', 'bridge', 'gate', 'door', 'wall', 'tower', 'spire',
  'coin', 'key', 'lock', 'box', 'chest', 'bag', 'pouch', 'sack', 'crate', 'barrel',
  'cup', 'bowl', 'plate', 'pot', 'pan', 'jar', 'vase', 'jug', 'flask', 'bottle',
  'book', 'page', 'scroll', 'map', 'chart', 'note', 'letter', 'card', 'badge', 'seal',
  'sword', 'shield', 'helm', 'bow', 'arrow', 'spear', 'axe', 'hammer', 'staff', 'wand',
  'ring', 'chain', 'crown', 'orb', 'prism', 'cube', 'sphere', 'cone', 'pyramid', 'disc',
  'pixel', 'byte', 'bit', 'node', 'link', 'port', 'socket', 'packet', 'frame', 'block',
  'core', 'chip', 'wire', 'fuse', 'coil', 'grid', 'mesh', 'web', 'net', 'array',
  'pulse', 'beam', 'ray', 'flash', 'arc', 'bolt', 'surge', 'loop', 'cycle', 'wave',
];

// Japanese-ish syllables for the compound word (64 options = 6 bits each, 4 syllables = 24 bits)
const SYLLABLES = [
  'ka', 'ki', 'ku', 'ke', 'ko', 'sa', 'shi', 'su', 'se', 'so',
  'ta', 'chi', 'tsu', 'te', 'to', 'na', 'ni', 'nu', 'ne', 'no',
  'ha', 'hi', 'fu', 'he', 'ho', 'ma', 'mi', 'mu', 'me', 'mo',
  'ya', 'yu', 'yo', 'ra', 'ri', 'ru', 're', 'ro', 'wa', 'wo',
  'ba', 'bi', 'bu', 'be', 'bo', 'pa', 'pi', 'pu', 'pe', 'po',
  'za', 'ji', 'zu', 'ze', 'zo', 'da', 'de', 'do', 'ga', 'gi',
  'gu', 'ge', 'go', 'sha',
];

/**
 * Generate a cryptographically secure random code.
 * Format: adjective-noun-syllables (e.g., "fluffy-cloud-shimutako")
 * ~46 bits of entropy (secure for 5-minute TTL with rate limiting)
 */
function generateCode(): { full: string; display: string } {
  const bytes = new Uint16Array(6);
  crypto.getRandomValues(bytes);

  const adj = ADJECTIVES[bytes[0] % ADJECTIVES.length];
  const noun = NOUNS[bytes[1] % NOUNS.length];
  const syl1 = SYLLABLES[bytes[2] % SYLLABLES.length];
  const syl2 = SYLLABLES[bytes[3] % SYLLABLES.length];
  const syl3 = SYLLABLES[bytes[4] % SYLLABLES.length];
  const syl4 = SYLLABLES[bytes[5] % SYLLABLES.length];

  const compound = syl1 + syl2 + syl3 + syl4;
  return {
    full: `${adj}-${noun}-${compound}`,
    display: `${adj}-${noun}`, // Safe to show on screen
  };
}

// Signaling server URL — same origin, server.mjs handles /offer and /answer routes
const SIGNALING_URL = location.origin;

interface RemoteSession {
  code: string;
  displayCode: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  status: 'connecting' | 'waiting' | 'connected' | 'error';
  shadowShell: Shell | null;
  panel: RemotePanel | null;
}

// Store session on window for global access
declare global {
  interface Window {
    __shiroRemoteSession?: RemoteSession;
    __shiro?: any;
  }
}

/**
 * Create a shadow shell for headless command execution.
 * Shares the same filesystem and commands as the main shell.
 */
function createShadowShell(): Shell {
  const { fs, commands } = window.__shiro;
  return new Shell(fs, commands);
}

/**
 * Handle incoming commands from the remote peer.
 * Uses shadow shell for exec (headless, no terminal corruption).
 */
async function handleRemoteCommand(session: RemoteSession, message: string): Promise<string> {
  try {
    const cmd = JSON.parse(message);
    const requestId = cmd.requestId; // Echo back for request/response matching

    switch (cmd.type) {
      case 'ping':
        return JSON.stringify({ type: 'pong', ts: Date.now(), requestId });

      case 'hello': {
        // MCP client identifies itself — update panel title
        const name = cmd.name || 'remote';
        session.panel?.setTitle(`${name} \u2194 ${session.displayCode}`);
        session.panel?.log('info', `${name} connected`);
        return JSON.stringify({ type: 'hello_ack', requestId });
      }

      case 'exec': {
        const shell = session.shadowShell;
        if (!shell) {
          return JSON.stringify({ type: 'error', error: 'Shell not available', requestId });
        }
        session.panel?.log('exec', `$ ${cmd.command}`);

        let stdout = '';
        let stderr = '';
        const exitCode = await shell.execute(
          cmd.command,
          (s: string) => { stdout += s; },
          (s: string) => { stderr += s; },
          false, undefined, true, // skipHistory — remote commands shouldn't pollute user history
        );

        if (stdout) session.panel?.log('info', stdout.trimEnd());
        if (stderr) session.panel?.log('error', stderr.trimEnd());

        return JSON.stringify({ type: 'exec_result', stdout, stderr, exitCode, requestId });
      }

      case 'read': {
        const fs = window.__shiro?.fs;
        if (!fs) {
          return JSON.stringify({ type: 'error', error: 'Filesystem not available', requestId });
        }
        session.panel?.log('read', cmd.path);
        const content = await fs.readFile(cmd.path);
        const base64 = btoa(String.fromCharCode(...content));
        return JSON.stringify({ type: 'read_result', path: cmd.path, content: base64, requestId });
      }

      case 'write': {
        const fs = window.__shiro?.fs;
        if (!fs) {
          return JSON.stringify({ type: 'error', error: 'Filesystem not available', requestId });
        }
        session.panel?.log('write', cmd.path);
        const content = Uint8Array.from(atob(cmd.content), c => c.charCodeAt(0));
        await fs.writeFile(cmd.path, content);
        return JSON.stringify({ type: 'write_result', path: cmd.path, ok: true, requestId });
      }

      case 'list': {
        const fs = window.__shiro?.fs;
        if (!fs) {
          return JSON.stringify({ type: 'error', error: 'Filesystem not available', requestId });
        }
        session.panel?.log('read', `ls ${cmd.path}`);
        const entries = await fs.readdir(cmd.path);
        return JSON.stringify({ type: 'list_result', path: cmd.path, entries, requestId });
      }

      case 'eval': {
        session.panel?.log('eval', cmd.code);
        const result = await eval(cmd.code);
        const resultStr = String(result);
        session.panel?.log('info', resultStr);
        return JSON.stringify({ type: 'eval_result', result: resultStr, requestId });
      }

      default:
        return JSON.stringify({ type: 'error', error: `Unknown command type: ${cmd.type}`, requestId });
    }
  } catch (err: any) {
    session.panel?.log('error', err.message || String(err));
    // Note: requestId may not be available if JSON parsing failed
    return JSON.stringify({ type: 'error', error: err.message || String(err) });
  }
}

/**
 * Wire up a session with shadow shell, panel, and data channel handlers.
 */
function wireSession(session: RemoteSession, dc: RTCDataChannel) {
  session.dc = dc;
  let closeFired = false;

  dc.onopen = () => {
    session.status = 'connected';
    session.panel?.setStatus('connected');
    session.panel?.log('info', 'Peer connected');
    console.log('[remote] Peer connected');
  };

  dc.onclose = () => {
    // Guard against re-entrant/duplicate onclose fires
    if (closeFired) return;
    closeFired = true;

    console.log('[remote] Peer disconnected');
    session.panel?.setStatus('disconnected');
    session.panel?.log('info', 'Peer disconnected — waiting for reconnect...');
    const savedCode = session.code;
    // Keep panel alive across reconnect
    const savedPanel = session.panel;
    const savedShell = session.shadowShell;
    // Null out dc before cleanup to prevent re-entrant close
    session.dc = null;
    cleanupSession(true); // keepPanel=true
    // Re-register with same code so MCP can reconnect
    setTimeout(() => {
      if (!window.__shiroRemoteSession) {
        console.log('[remote] Re-registering for reconnection...');
        startRemoteWithCode(savedCode, undefined, savedPanel, savedShell);
      }
    }, 1000);
  };

  dc.onmessage = async (event) => {
    const response = await handleRemoteCommand(session, event.data);
    if (dc.readyState === 'open') {
      dc.send(response);
    }
  };

  // Wire panel input → data channel
  if (session.panel) {
    session.panel.onUserMessage = (text: string) => {
      if (dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'user_message', message: text }));
        session.panel?.log('user', text);
      }
    };
  }
}

/**
 * Start a remote session - create WebRTC offer and register with signaling server
 */
async function startRemote(ctx: CommandContext): Promise<number> {
  // Auto-cleanup existing session if any
  if (window.__shiroRemoteSession) {
    ctx.stdout += 'Cleaning up existing session...\n';
    // Deactivate old panel (dim it, keep log visible) instead of closing
    window.__shiroRemoteSession.panel?.deactivate();
    window.__shiroRemoteSession.panel = null; // detach so cleanupSession won't close it
    cleanupSession();
    localStorage.removeItem(REMOTE_CODE_KEY);
    // Clear HUD if terminal available
    if (ctx.terminal) {
      (ctx.terminal as any).updateHudRemoteCode?.(null);
    }
  }

  const { full: code, display: displayCode } = generateCode();

  // Copy to clipboard immediately (before async work breaks user gesture chain)
  // Save old clipboard value so we can restore on failure
  let oldClipboard: string | null = null;
  let clipboardCopied = false;
  try {
    oldClipboard = await navigator.clipboard.readText();
  } catch {
    // Can't read clipboard, that's fine
  }
  try {
    await navigator.clipboard.writeText(code);
    clipboardCopied = true;
  } catch {
    // Will report failure later
  }

  ctx.stdout += 'Starting remote session...\n';

  // Create shadow shell and panel
  const shadowShell = createShadowShell();
  const panel = createRemotePanel(code, `remote \u2194 ${displayCode}`);
  panel.log('info', `Waiting for connection...`);
  panel.setStatus('connecting');

  // Create peer connection
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  });

  const session: RemoteSession = {
    code,
    displayCode,
    pc,
    dc: null,
    status: 'connecting',
    shadowShell,
    panel,
  };

  window.__shiroRemoteSession = session;

  // Create data channel and wire up handlers
  const dc = pc.createDataChannel('shiro-remote', { ordered: true });
  wireSession(session, dc);

  // Gather ICE candidates
  const iceCandidates: RTCIceCandidate[] = [];
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      iceCandidates.push(event.candidate);
    }
  };

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to complete
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
    } else {
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        }
      };
      // Timeout after 5 seconds
      setTimeout(resolve, 5000);
    }
  });

  // Register with signaling server
  try {
    const res = await fetch(`${SIGNALING_URL}/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        offer: pc.localDescription,
        candidates: iceCandidates,
      }),
    });

    if (!res.ok) {
      throw new Error(`Signaling server error: ${res.status}`);
    }

    session.status = 'waiting';

    // Persist code for auto-reconnect after page reload
    localStorage.setItem(REMOTE_CODE_KEY, code);

    // Report clipboard status (copy happened earlier, before async work)
    if (clipboardCopied) {
      ctx.stdout += `\x1b[32mConnection code copied to clipboard!\x1b[0m\n`;
    } else {
      ctx.stdout += `\x1b[33mCouldn't copy to clipboard. Code: ${code}\x1b[0m\n`;
    }

    ctx.stdout += `\nRemote session active. Waiting for connection...\n`;
    ctx.stdout += `Display code: \x1b[93m${displayCode}\x1b[0m\n`;
    ctx.stdout += `Run \x1b[36mremote stop\x1b[0m to end the session.\n\n`;

    // Update HUD to show the code (if visible)
    if (ctx.terminal) {
      (ctx.terminal as any).updateHudRemoteCode?.(displayCode);
    }

    // Start polling for answer in background
    pollForAnswer(session);

    return 0;
  } catch (err: any) {
    // Restore old clipboard if we overwrote it
    if (clipboardCopied && oldClipboard !== null) {
      try {
        await navigator.clipboard.writeText(oldClipboard);
      } catch {
        // Best effort
      }
    }
    ctx.stderr += `Failed to start remote: ${err.message}\n`;
    cleanupSession();
    return 1;
  }
}

/**
 * Poll signaling server for an answer from a connecting peer
 */
async function pollForAnswer(session: RemoteSession) {
  const maxAttempts = 60; // 5 minutes at 5-second intervals
  let attempts = 0;

  const poll = async () => {
    if (!window.__shiroRemoteSession || session.status === 'connected') {
      return;
    }

    attempts++;
    if (attempts > maxAttempts) {
      console.log('[remote] Session timed out');
      cleanupSession();
      return;
    }

    try {
      const res = await fetch(`${SIGNALING_URL}/answer/${session.code}`);
      if (res.ok) {
        const data = await res.json();
        if (data.expired) {
          // Offer expired on signaling server - stop polling
          console.log('[remote] Session expired on signaling server');
          cleanupSession();
          return;
        } else if (data.waiting) {
          // No answer yet, continue polling
        } else if (data.answer) {
          await session.pc.setRemoteDescription(data.answer);

          // Add ICE candidates from peer
          if (data.candidates) {
            for (const candidate of data.candidates) {
              await session.pc.addIceCandidate(candidate);
            }
          }

          console.log('[remote] Received answer, establishing connection...');
          return;
        }
      } else if (res.status === 404) {
        // Code no longer exists on signaling server - stop polling
        console.log('[remote] Session no longer valid (404), stopping poll');
        cleanupSession();
        return;
      }
    } catch {
      // Network error - continue polling (transient failure)
    }

    // Continue polling
    setTimeout(poll, 5000);
  };

  poll();
}

/**
 * Stop the current remote session
 */
function stopRemote(ctx: CommandContext): number {
  if (!window.__shiroRemoteSession) {
    ctx.stdout += 'No active remote session.\n';
    return 1;
  }

  cleanupSession();

  // Clear persisted code so it won't auto-reconnect
  localStorage.removeItem(REMOTE_CODE_KEY);

  ctx.stdout += 'Remote session stopped.\n';

  // Clear the remote code from HUD (if visible)
  if (ctx.terminal) {
    (ctx.terminal as any).updateHudRemoteCode?.(null);
  }

  return 0;
}

/**
 * Clean up the remote session.
 * @param keepPanel If true, don't close the panel (used during reconnect)
 */
function cleanupSession(keepPanel = false) {
  const session = window.__shiroRemoteSession;
  if (session) {
    if (session.dc) {
      session.dc.close();
    }
    session.pc.close();
    if (!keepPanel && session.panel) {
      session.panel.close();
    }
    session.shadowShell = null;
    delete window.__shiroRemoteSession;
  }
}

/**
 * Show status of current remote session
 */
function statusRemote(ctx: CommandContext): number {
  const session = window.__shiroRemoteSession;
  if (!session) {
    ctx.stdout += 'No active remote session.\n';
    ctx.stdout += 'Run \x1b[36mremote start\x1b[0m to begin.\n';
    return 0;
  }

  ctx.stdout += `Remote session status: \x1b[93m${session.status}\x1b[0m\n`;
  ctx.stdout += `Display code: \x1b[93m${session.displayCode}\x1b[0m\n`;

  if (session.dc) {
    ctx.stdout += `Data channel: \x1b[93m${session.dc.readyState}\x1b[0m\n`;
  }

  const pcState = session.pc.connectionState;
  ctx.stdout += `Connection: \x1b[93m${pcState}\x1b[0m\n`;

  return 0;
}

export const remoteCmd: Command = {
  name: 'remote',
  description: 'Start/stop remote development session for external Claude Code access',
  async exec(ctx) {
    const subcommand = ctx.args[0] || 'status';

    switch (subcommand) {
      case 'start':
        return startRemote(ctx);
      case 'stop':
        return stopRemote(ctx);
      case 'status':
        return statusRemote(ctx);
      default:
        ctx.stderr += `Unknown subcommand: ${subcommand}\n`;
        ctx.stdout += 'Usage: remote [start|stop|status]\n';
        return 1;
    }
  },
};

/**
 * Check for persisted remote code and return it if present.
 * Used by main.ts to auto-reconnect after page reload.
 */
export function getPersistedRemoteCode(): string | null {
  return localStorage.getItem(REMOTE_CODE_KEY);
}

/**
 * Start a remote session with a specific code (for auto-reconnect).
 * Silently starts without command-line output.
 * Optionally reuses an existing panel and shell (for reconnect after disconnect).
 */
export async function startRemoteWithCode(
  code: string,
  terminal?: any,
  existingPanel?: RemotePanel | null,
  existingShell?: Shell | null,
): Promise<boolean> {
  if (window.__shiroRemoteSession) {
    console.log('[remote] Session already active');
    return true;
  }

  const displayCode = code.split('-').slice(0, 2).join('-');
  console.log(`[remote] Auto-reconnecting with code: ${displayCode}`);

  // Create or reuse shadow shell and panel
  const shadowShell = existingShell || createShadowShell();
  const panel = existingPanel || createRemotePanel(code, `remote \u2194 ${displayCode}`);
  if (!existingPanel) {
    panel.log('info', `Session resumed: ${displayCode}`);
  }
  panel.setStatus('connecting');

  // Create peer connection
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  });

  const session: RemoteSession = {
    code,
    displayCode,
    pc,
    dc: null,
    status: 'connecting',
    shadowShell,
    panel,
  };

  window.__shiroRemoteSession = session;

  // Create data channel and wire up handlers
  const dc = pc.createDataChannel('shiro-remote', { ordered: true });
  wireSession(session, dc);

  // Gather ICE candidates
  const iceCandidates: RTCIceCandidate[] = [];
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      iceCandidates.push(event.candidate);
    }
  };

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
    } else {
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        }
      };
      setTimeout(resolve, 5000);
    }
  });

  // Register with signaling server
  try {
    const res = await fetch(`${SIGNALING_URL}/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        offer: pc.localDescription,
        candidates: iceCandidates,
      }),
    });

    if (!res.ok) {
      throw new Error(`Signaling server error: ${res.status}`);
    }

    session.status = 'waiting';

    // Update HUD if terminal available
    if (terminal) {
      terminal.updateHudRemoteCode(displayCode);
    }

    // Start polling for answer
    pollForAnswer(session);

    console.log('[remote] Auto-reconnect successful, waiting for peer');
    return true;
  } catch (err: any) {
    console.error(`[remote] Auto-reconnect failed: ${err.message}`);
    // Clear persisted code on failure
    localStorage.removeItem(REMOTE_CODE_KEY);
    cleanupSession();
    return false;
  }
}
