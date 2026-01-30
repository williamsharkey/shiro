import { Command, CommandContext } from './index';

/**
 * termcast: Record terminal sessions in asciicast v2 format
 *
 * Creates recordings that can be played back with asciinema-player
 * or converted to animated GIFs.
 *
 * Usage:
 *   termcast start [filename]   Start recording to a .cast file
 *   termcast stop               Stop recording and save
 *   termcast play <file>        Play back a recording
 *   termcast status             Show recording status
 *
 * The asciicast v2 format is newline-delimited JSON:
 *   {"version": 2, "width": 80, "height": 24, ...}
 *   [0.5, "o", "$ "]
 *   [1.2, "o", "echo hello\r\n"]
 *   [1.5, "o", "hello\r\n"]
 */

interface TermcastSession {
  filename: string;
  startTime: number;
  events: Array<[number, string, string]>;
  width: number;
  height: number;
}

// Global recording state (attached to window for persistence)
declare global {
  interface Window {
    __termcastSession?: TermcastSession | null;
    __termcastOriginalWrite?: (data: string) => void;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`;
}

export const termcastCmd: Command = {
  name: 'termcast',
  description: 'Record terminal sessions in asciicast format',

  async exec(ctx: CommandContext): Promise<number> {
    const subcmd = ctx.args[0];

    if (!subcmd || subcmd === '--help' || subcmd === '-h') {
      ctx.stdout += 'Usage: termcast <command> [args]\n\n';
      ctx.stdout += 'Commands:\n';
      ctx.stdout += '  start [filename]   Start recording (default: recording.cast)\n';
      ctx.stdout += '  stop               Stop recording and save to file\n';
      ctx.stdout += '  status             Show recording status\n';
      ctx.stdout += '  play <file>        Play back a recording (prints to terminal)\n';
      ctx.stdout += '  export <file>      Export recording as JSON for embedding\n';
      ctx.stdout += '\n';
      ctx.stdout += 'The output is in asciicast v2 format, compatible with:\n';
      ctx.stdout += '  - asciinema-player (web)\n';
      ctx.stdout += '  - asciinema (CLI)\n';
      ctx.stdout += '  - Various converters (GIF, SVG, etc.)\n';
      return 0;
    }

    switch (subcmd) {
      case 'start': {
        if (window.__termcastSession) {
          ctx.stderr += 'termcast: already recording. Use "termcast stop" first.\n';
          return 1;
        }

        const filename = ctx.args[1] || 'recording.cast';
        const resolvedPath = ctx.fs.resolvePath(filename, ctx.cwd);

        // Get terminal dimensions from xterm if available
        const terminal = (window as any).__shiro?.terminal;
        const width = terminal?.cols || 120;
        const height = terminal?.rows || 30;

        window.__termcastSession = {
          filename: resolvedPath,
          startTime: Date.now(),
          events: [],
          width,
          height,
        };

        // Hook into terminal output if available
        if (terminal && terminal.write && !window.__termcastOriginalWrite) {
          window.__termcastOriginalWrite = terminal.write.bind(terminal);
          terminal.write = (data: string) => {
            // Record the output
            if (window.__termcastSession) {
              const elapsed = (Date.now() - window.__termcastSession.startTime) / 1000;
              window.__termcastSession.events.push([elapsed, 'o', data]);
            }
            // Call original write
            window.__termcastOriginalWrite!(data);
          };
        }

        ctx.stdout += `Recording started: ${resolvedPath}\n`;
        ctx.stdout += `Terminal size: ${width}x${height}\n`;
        ctx.stdout += 'Run commands normally. Use "termcast stop" when done.\n';
        return 0;
      }

      case 'stop': {
        const session = window.__termcastSession;
        if (!session) {
          ctx.stderr += 'termcast: not recording. Use "termcast start" first.\n';
          return 1;
        }

        // Restore original terminal write
        const terminal = (window as any).__shiro?.terminal;
        if (terminal && window.__termcastOriginalWrite) {
          terminal.write = window.__termcastOriginalWrite;
          window.__termcastOriginalWrite = undefined;
        }

        // Build asciicast v2 content
        const header = {
          version: 2,
          width: session.width,
          height: session.height,
          timestamp: Math.floor(session.startTime / 1000),
          title: `Shiro Terminal Recording`,
          env: {
            SHELL: '/bin/sh',
            TERM: 'xterm-256color',
          },
        };

        const lines = [JSON.stringify(header)];
        for (const event of session.events) {
          lines.push(JSON.stringify(event));
        }
        const content = lines.join('\n') + '\n';

        // Save to VFS
        await ctx.fs.writeFile(session.filename, content);

        const duration = formatDuration(Date.now() - session.startTime);
        const eventCount = session.events.length;
        const sizeKB = (content.length / 1024).toFixed(2);

        ctx.stdout += `Recording saved: ${session.filename}\n`;
        ctx.stdout += `Duration: ${duration}\n`;
        ctx.stdout += `Events: ${eventCount}\n`;
        ctx.stdout += `Size: ${sizeKB} KB\n`;

        window.__termcastSession = null;
        return 0;
      }

      case 'status': {
        const session = window.__termcastSession;
        if (!session) {
          ctx.stdout += 'Not recording.\n';
        } else {
          const elapsed = formatDuration(Date.now() - session.startTime);
          ctx.stdout += `Recording: ${session.filename}\n`;
          ctx.stdout += `Duration: ${elapsed}\n`;
          ctx.stdout += `Events: ${session.events.length}\n`;
          ctx.stdout += `Size: ${session.width}x${session.height}\n`;
        }
        return 0;
      }

      case 'play': {
        const filename = ctx.args[1];
        if (!filename) {
          ctx.stderr += 'termcast play: missing filename\n';
          return 1;
        }

        try {
          const content = await ctx.fs.readFile(ctx.fs.resolvePath(filename, ctx.cwd), 'utf8') as string;
          const lines = content.trim().split('\n');

          if (lines.length === 0) {
            ctx.stderr += 'termcast: empty recording\n';
            return 1;
          }

          // Parse header
          const header = JSON.parse(lines[0]);
          ctx.stdout += `Playing: ${filename}\n`;
          ctx.stdout += `Size: ${header.width}x${header.height}\n`;
          ctx.stdout += `---\n`;

          // Parse and play events (for now, just output all at once)
          // A proper player would use setTimeout for timing
          for (let i = 1; i < lines.length; i++) {
            const event = JSON.parse(lines[i]);
            if (event[1] === 'o') {
              ctx.stdout += event[2];
            }
          }
          ctx.stdout += '\n---\nEnd of recording.\n';
          return 0;
        } catch (e: any) {
          ctx.stderr += `termcast play: ${e.message}\n`;
          return 1;
        }
      }

      case 'export': {
        const filename = ctx.args[1];
        if (!filename) {
          ctx.stderr += 'termcast export: missing filename\n';
          return 1;
        }

        try {
          const content = await ctx.fs.readFile(ctx.fs.resolvePath(filename, ctx.cwd), 'utf8') as string;

          // Output as a data URL for easy embedding
          const b64 = btoa(content);
          ctx.stdout += `data:application/json;base64,${b64}\n`;
          return 0;
        } catch (e: any) {
          ctx.stderr += `termcast export: ${e.message}\n`;
          return 1;
        }
      }

      default:
        ctx.stderr += `termcast: unknown command '${subcmd}'\n`;
        return 1;
    }
  },
};
