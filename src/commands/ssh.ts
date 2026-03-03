/**
 * ssh — Interactive shell over WebRTC
 *
 * Usage: ssh <code>
 *
 * Connects to a remote Shiro instance via its connection code
 * (from `remote start`) and provides an interactive terminal session.
 */

import type { Command, CommandContext, TerminalLike } from './index';

// Signaling server URL (same as remote.ts)
const SIGNAL_SERVER = 'https://shiro.computer/signal';

export const sshCmd: Command = {
  name: 'ssh',
  description: 'Connect to a remote Shiro instance',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      ctx.stdout += 'Usage: ssh <connection-code>\n';
      ctx.stdout += '\nConnect to a remote Shiro instance via WebRTC.\n';
      ctx.stdout += 'The remote must have run `remote start` first.\n';
      ctx.stdout += '\nExamples:\n';
      ctx.stdout += '  ssh fluffy-cloud-shimutako\n';
      ctx.stdout += '  ssh mycode          # short codes work too\n';
      return args[0] === '--help' || args[0] === '-h' ? 0 : 1;
    }

    const terminal = ctx.terminal;
    if (!terminal) {
      ctx.stderr += 'ssh: requires a terminal\n';
      return 1;
    }

    const code = args[0];
    const write = (s: string) => terminal.writeOutput(s);

    write(`Connecting to ${code}...\r\n`);

    // Check if WebRTC is available
    if (typeof RTCPeerConnection === 'undefined') {
      ctx.stderr += 'ssh: WebRTC not available in this environment\n';
      return 1;
    }

    try {
      return await runSSHSession(code, terminal, ctx, write);
    } catch (e: any) {
      write(`\r\nssh: ${e.message}\r\n`);
      return 1;
    }
  },
};

async function runSSHSession(
  code: string,
  terminal: TerminalLike,
  ctx: CommandContext,
  write: (s: string) => void,
): Promise<number> {
  // Create WebRTC peer connection
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  const dc = pc.createDataChannel('shiro-remote', { ordered: true });
  let connected = false;
  let sessionEnded = false;
  let resolveSession: (code: number) => void;

  const sessionPromise = new Promise<number>((resolve) => {
    resolveSession = resolve;
  });

  // Gather ICE candidates
  const candidates: RTCIceCandidate[] = [];
  pc.onicecandidate = (event) => {
    if (event.candidate) candidates.push(event.candidate);
  };

  // Create and set offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

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
    setTimeout(resolve, 5000); // 5s timeout
  });

  // Post offer to signaling server
  try {
    const resp = await fetch(`${SIGNAL_SERVER}/answer/${code}`);
    if (!resp.ok) {
      write(`ssh: Could not reach signaling server\r\n`);
      pc.close();
      return 1;
    }
    const data = await resp.json();
    if (data.expired) {
      write(`ssh: Connection code expired\r\n`);
      pc.close();
      return 1;
    }
  } catch {
    write(`ssh: Could not reach signaling server\r\n`);
    pc.close();
    return 1;
  }

  // Send our answer (we act as the answerer)
  try {
    // First get the offer from the host
    const offerResp = await fetch(`${SIGNAL_SERVER}/offer/${code}`);
    if (!offerResp.ok) {
      write(`ssh: No remote host found for code '${code}'\r\n`);
      pc.close();
      return 1;
    }

    const offerData = await offerResp.json();
    if (!offerData.offer) {
      write(`ssh: No offer available for code '${code}'\r\n`);
      pc.close();
      return 1;
    }

    // Set remote description from host's offer
    await pc.setRemoteDescription(new RTCSessionDescription(offerData.offer));

    // Add host's ICE candidates
    if (offerData.candidates) {
      for (const c of offerData.candidates) {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      }
    }

    // Create answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Send answer back
    await fetch(`${SIGNAL_SERVER}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        answer: pc.localDescription,
        candidates,
      }),
    });
  } catch (e: any) {
    write(`ssh: Signaling failed: ${e.message}\r\n`);
    pc.close();
    return 1;
  }

  // Handle data channel events
  dc.onopen = () => {
    connected = true;
    write(`Connected to ${code}\r\n`);

    // Send hello
    dc.send(JSON.stringify({ type: 'hello', name: 'ssh-client', requestId: 1 }));

    // Start terminal session
    const { cols, rows } = terminal.getSize();
    dc.send(JSON.stringify({ type: 'terminal_start', cols, rows, requestId: 2 }));
  };

  dc.onclose = () => {
    if (!sessionEnded) {
      sessionEnded = true;
      write('\r\nConnection closed.\r\n');
      cleanup();
      resolveSession(0);
    }
  };

  dc.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'terminal_output') {
        write(msg.data);
      } else if (msg.type === 'terminal_end') {
        sessionEnded = true;
        write('\r\nSession ended.\r\n');
        cleanup();
        resolveSession(0);
      }
      // Ignore other message types (hello_ack, terminal_started, etc.)
    } catch {
      // Non-JSON message — display as-is
      write(event.data);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      if (!sessionEnded) {
        sessionEnded = true;
        write('\r\nConnection lost.\r\n');
        cleanup();
        resolveSession(1);
      }
    }
  };

  // Enter raw mode to capture keystrokes
  function cleanup(): void {
    terminal.exitRawMode();
    try { pc.close(); } catch {}
  }

  terminal.enterRawMode((key: string) => {
    if (!connected || sessionEnded) return;

    // Send keystroke to remote
    dc.send(JSON.stringify({ type: 'terminal_input', data: key }));
  });

  // Handle abort signal
  const signal = ctx.shell?.abortController?.signal;
  if (signal) {
    signal.addEventListener('abort', () => {
      if (!sessionEnded) {
        sessionEnded = true;
        try { dc.send(JSON.stringify({ type: 'terminal_end' })); } catch {}
        cleanup();
        resolveSession(130);
      }
    }, { once: true });
  }

  // Wait for connection timeout
  setTimeout(() => {
    if (!connected && !sessionEnded) {
      sessionEnded = true;
      write(`ssh: Connection timed out\r\n`);
      cleanup();
      resolveSession(1);
    }
  }, 30000);

  return sessionPromise;
}
