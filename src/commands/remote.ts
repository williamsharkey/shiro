import { Command, CommandContext } from './index';

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

// Signaling server URL
const SIGNALING_URL = 'https://remote.shiro.computer';

interface RemoteSession {
  code: string;
  displayCode: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  status: 'connecting' | 'waiting' | 'connected' | 'error';
}

// Store session on window for global access
declare global {
  interface Window {
    __shiroRemoteSession?: RemoteSession;
    __shiro?: any;
  }
}

/**
 * Handle incoming commands from the remote peer
 */
async function handleRemoteCommand(session: RemoteSession, message: string): Promise<string> {
  try {
    const cmd = JSON.parse(message);
    const requestId = cmd.requestId; // Echo back for request/response matching

    switch (cmd.type) {
      case 'ping':
        return JSON.stringify({ type: 'pong', ts: Date.now(), requestId });

      case 'exec': {
        // Execute shell command and display in terminal
        const terminal = window.__shiro?.terminal;
        if (!terminal) {
          return JSON.stringify({ type: 'error', error: 'Terminal not available', requestId });
        }
        const { stdout, stderr, exitCode } = await terminal.executeRemoteCommand(cmd.command);
        return JSON.stringify({ type: 'exec_result', stdout, stderr, exitCode, requestId });
      }

      case 'read': {
        // Read file
        const fs = window.__shiro?.fs;
        if (!fs) {
          return JSON.stringify({ type: 'error', error: 'Filesystem not available', requestId });
        }
        const content = await fs.readFile(cmd.path);
        const base64 = btoa(String.fromCharCode(...content));
        return JSON.stringify({ type: 'read_result', path: cmd.path, content: base64, requestId });
      }

      case 'write': {
        // Write file
        const fs = window.__shiro?.fs;
        if (!fs) {
          return JSON.stringify({ type: 'error', error: 'Filesystem not available', requestId });
        }
        const content = Uint8Array.from(atob(cmd.content), c => c.charCodeAt(0));
        await fs.writeFile(cmd.path, content);
        return JSON.stringify({ type: 'write_result', path: cmd.path, ok: true, requestId });
      }

      case 'list': {
        // List directory
        const fs = window.__shiro?.fs;
        if (!fs) {
          return JSON.stringify({ type: 'error', error: 'Filesystem not available', requestId });
        }
        const entries = await fs.readdir(cmd.path);
        return JSON.stringify({ type: 'list_result', path: cmd.path, entries, requestId });
      }

      case 'eval': {
        // Evaluate JavaScript
        const result = await eval(cmd.code);
        return JSON.stringify({ type: 'eval_result', result: String(result), requestId });
      }

      default:
        return JSON.stringify({ type: 'error', error: `Unknown command type: ${cmd.type}`, requestId });
    }
  } catch (err: any) {
    // Note: requestId may not be available if JSON parsing failed
    return JSON.stringify({ type: 'error', error: err.message || String(err) });
  }
}

/**
 * Start a remote session - create WebRTC offer and register with signaling server
 */
async function startRemote(ctx: CommandContext): Promise<number> {
  if (window.__shiroRemoteSession) {
    ctx.stdout += 'Remote session already active. Use "remote stop" first.\n';
    return 1;
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
  };

  window.__shiroRemoteSession = session;

  // Create data channel
  const dc = pc.createDataChannel('shiro-remote', { ordered: true });
  session.dc = dc;

  dc.onopen = () => {
    session.status = 'connected';
    console.log('[remote] Peer connected');
  };

  dc.onclose = () => {
    console.log('[remote] Peer disconnected');
    const savedCode = session.code;
    cleanupSession();
    // Re-register with same code so MCP can reconnect
    setTimeout(() => {
      if (!window.__shiroRemoteSession) {
        console.log('[remote] Re-registering for reconnection...');
        startRemoteWithCode(savedCode);
      }
    }, 1000);
  };

  dc.onmessage = async (event) => {
    const response = await handleRemoteCommand(session, event.data);
    if (dc.readyState === 'open') {
      dc.send(response);
    }
  };

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
      ctx.terminal.updateHudRemoteCode(displayCode);
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
        // Check if still waiting for answer
        if (data.waiting) {
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
      }
    } catch {
      // Ignore polling errors
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
    ctx.terminal.updateHudRemoteCode(null);
  }

  return 0;
}

/**
 * Clean up the remote session
 */
function cleanupSession() {
  const session = window.__shiroRemoteSession;
  if (session) {
    if (session.dc) {
      session.dc.close();
    }
    session.pc.close();
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
 */
export async function startRemoteWithCode(code: string, terminal?: any): Promise<boolean> {
  if (window.__shiroRemoteSession) {
    console.log('[remote] Session already active');
    return true;
  }

  const displayCode = code.split('-').slice(0, 2).join('-');
  console.log(`[remote] Auto-reconnecting with code: ${displayCode}`);

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
  };

  window.__shiroRemoteSession = session;

  // Create data channel
  const dc = pc.createDataChannel('shiro-remote', { ordered: true });
  session.dc = dc;

  dc.onopen = () => {
    session.status = 'connected';
    console.log('[remote] Peer connected');
  };

  dc.onclose = () => {
    console.log('[remote] Peer disconnected');
    const savedCode = session.code;
    cleanupSession();
    // Re-register with same code so MCP can reconnect
    setTimeout(() => {
      if (!window.__shiroRemoteSession) {
        console.log('[remote] Re-registering for reconnection...');
        startRemoteWithCode(savedCode);
      }
    }, 1000);
  };

  dc.onmessage = async (event) => {
    const response = await handleRemoteCommand(session, event.data);
    if (dc.readyState === 'open') {
      dc.send(response);
    }
  };

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
