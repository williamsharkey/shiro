/**
 * scp — Secure copy over WebRTC
 *
 * Usage:
 *   scp <local-file> <code>:<remote-path>    Upload
 *   scp <code>:<remote-path> <local-file>    Download
 *
 * Uses the existing `remote` protocol's read/write messages
 * over a temporary WebRTC connection.
 */

import type { Command, CommandContext } from './index';

// Signaling server URL (same as remote.ts)
const SIGNAL_SERVER = 'https://shiro.computer/signal';

interface ScpTarget {
  code: string;
  path: string;
}

function parseTarget(arg: string): ScpTarget | null {
  const colon = arg.indexOf(':');
  if (colon < 1) return null;
  return { code: arg.substring(0, colon), path: arg.substring(colon + 1) };
}

export const scpCmd: Command = {
  name: 'scp',
  description: 'Copy files over WebRTC',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;

    if (args.length < 2 || args[0] === '--help' || args[0] === '-h') {
      ctx.stdout += 'Usage: scp <source> <destination>\n';
      ctx.stdout += '\nCopy files to/from a remote Shiro instance.\n';
      ctx.stdout += 'Remote paths use code:path notation.\n';
      ctx.stdout += '\nExamples:\n';
      ctx.stdout += '  scp file.txt fluffy-cloud:~/file.txt     Upload\n';
      ctx.stdout += '  scp fluffy-cloud:/home/user/file.txt .   Download\n';
      return args[0] === '--help' || args[0] === '-h' ? 0 : 1;
    }

    const src = args[0];
    const dst = args[1];

    const srcRemote = parseTarget(src);
    const dstRemote = parseTarget(dst);

    if (srcRemote && dstRemote) {
      ctx.stderr += 'scp: cannot copy between two remote hosts\n';
      return 1;
    }

    if (!srcRemote && !dstRemote) {
      ctx.stderr += 'scp: at least one argument must be remote (code:path)\n';
      return 1;
    }

    // For uploads, verify local file exists before attempting connection
    if (dstRemote) {
      const absPath = src.startsWith('/') ? src : ctx.shell.cwd + '/' + src;
      try {
        await ctx.fs.stat(absPath);
      } catch {
        ctx.stderr += `scp: ${src}: No such file or directory\n`;
        return 1;
      }
    }

    if (typeof RTCPeerConnection === 'undefined') {
      ctx.stderr += 'scp: WebRTC not available in this environment\n';
      return 1;
    }

    if (dstRemote) {
      // Upload: local → remote
      return upload(ctx, src, dstRemote);
    } else {
      // Download: remote → local
      return download(ctx, srcRemote!, dst);
    }
  },
};

async function upload(ctx: CommandContext, localPath: string, remote: ScpTarget): Promise<number> {
  // Read local file
  const absPath = localPath.startsWith('/') ? localPath : ctx.shell.cwd + '/' + localPath;
  let data: Uint8Array;
  try {
    const content = await ctx.fs.readFile(absPath);
    if (content instanceof Uint8Array) {
      data = content;
    } else {
      data = new TextEncoder().encode(content);
    }
  } catch {
    ctx.stderr += `scp: ${localPath}: No such file or directory\n`;
    return 1;
  }

  ctx.stdout += `Uploading ${localPath} to ${remote.code}:${remote.path}...\n`;

  // Connect and send
  try {
    const dc = await connectToRemote(remote.code);

    // Resolve remote path (expand ~ to /home/user)
    const remotePath = remote.path.startsWith('~')
      ? '/home/user' + remote.path.slice(1)
      : remote.path;

    // Send write command
    const base64 = btoa(String.fromCharCode(...data));
    const response = await sendAndReceive(dc, {
      type: 'write',
      path: remotePath,
      content: base64,
      requestId: Date.now(),
    });

    dc.pc.close();

    if (response.type === 'error') {
      ctx.stderr += `scp: remote error: ${response.error}\n`;
      return 1;
    }

    ctx.stdout += `${localPath} → ${remote.code}:${remotePath} (${data.length} bytes)\n`;
    return 0;
  } catch (e: any) {
    ctx.stderr += `scp: ${e.message}\n`;
    return 1;
  }
}

async function download(ctx: CommandContext, remote: ScpTarget, localPath: string): Promise<number> {
  ctx.stdout += `Downloading ${remote.code}:${remote.path}...\n`;

  try {
    const dc = await connectToRemote(remote.code);

    // Resolve remote path
    const remotePath = remote.path.startsWith('~')
      ? '/home/user' + remote.path.slice(1)
      : remote.path;

    // Send read command
    const response = await sendAndReceive(dc, {
      type: 'read',
      path: remotePath,
      requestId: Date.now(),
    });

    dc.pc.close();

    if (response.type === 'error') {
      ctx.stderr += `scp: remote error: ${response.error}\n`;
      return 1;
    }

    // Decode base64 content
    const binary = atob(response.content);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }

    // Write to local filesystem
    let absPath: string;
    if (localPath === '.') {
      // Extract filename from remote path
      const basename = remotePath.split('/').pop() || 'downloaded';
      absPath = ctx.shell.cwd + '/' + basename;
    } else {
      absPath = localPath.startsWith('/') ? localPath : ctx.shell.cwd + '/' + localPath;
    }

    await ctx.fs.writeFile(absPath, data);
    ctx.stdout += `${remote.code}:${remotePath} → ${absPath} (${data.length} bytes)\n`;
    return 0;
  } catch (e: any) {
    ctx.stderr += `scp: ${e.message}\n`;
    return 1;
  }
}

// ── WebRTC connection helper ──────────────────────────────────────

interface DataChannelHandle {
  dc: RTCDataChannel;
  pc: RTCPeerConnection;
}

async function connectToRemote(code: string): Promise<DataChannelHandle> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  const dc = pc.createDataChannel('shiro-remote', { ordered: true });
  const candidates: RTCIceCandidate[] = [];

  pc.onicecandidate = (event) => {
    if (event.candidate) candidates.push(event.candidate);
  };

  // Wait for ICE gathering
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, 5000);
  });

  // Get the host's offer
  const offerResp = await fetch(`${SIGNAL_SERVER}/offer/${code}`);
  if (!offerResp.ok) throw new Error(`No remote host found for code '${code}'`);

  const offerData = await offerResp.json();
  if (!offerData.offer) throw new Error(`No offer available for code '${code}'`);

  await pc.setRemoteDescription(new RTCSessionDescription(offerData.offer));
  if (offerData.candidates) {
    for (const c of offerData.candidates) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    }
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  await fetch(`${SIGNAL_SERVER}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, answer: pc.localDescription, candidates }),
  });

  // Wait for data channel to open
  await new Promise<void>((resolve, reject) => {
    dc.onopen = () => resolve();
    dc.onerror = () => reject(new Error('Data channel failed'));
    setTimeout(() => reject(new Error('Connection timed out')), 15000);
  });

  return { dc, pc };
}

async function sendAndReceive(
  handle: DataChannelHandle,
  message: any,
  timeout = 10000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timed out')), timeout);

    handle.dc.onmessage = (event) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(event.data));
      } catch {
        resolve({ type: 'raw', data: event.data });
      }
    };

    handle.dc.send(JSON.stringify(message));
  });
}
