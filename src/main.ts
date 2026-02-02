// Error/warning capture - must be first before any other code runs
interface CapturedMessage {
  type: 'error' | 'warn';
  message: string;
  timestamp: number;
}
const capturedMessages: CapturedMessage[] = [];
const seenMessages = new Set<string>();

// Intercept console.error and console.warn
const originalError = console.error;
const originalWarn = console.warn;

console.error = (...args: any[]) => {
  const msg = args.map(a => typeof a === 'string' ? a : (a?.message || String(a))).join(' ').slice(0, 200);
  if (!seenMessages.has(msg)) {
    seenMessages.add(msg);
    capturedMessages.push({ type: 'error', message: msg, timestamp: Date.now() });
  }
  originalError.apply(console, args);
};

console.warn = (...args: any[]) => {
  const msg = args.map(a => typeof a === 'string' ? a : (a?.message || String(a))).slice(0, 200).join(' ');
  if (!seenMessages.has(msg)) {
    seenMessages.add(msg);
    capturedMessages.push({ type: 'warn', message: msg, timestamp: Date.now() });
  }
  originalWarn.apply(console, args);
};

// Also capture unhandled errors
window.addEventListener('error', (event) => {
  const msg = `${event.message} at ${event.filename}:${event.lineno}`.slice(0, 200);
  if (!seenMessages.has(msg)) {
    seenMessages.add(msg);
    capturedMessages.push({ type: 'error', message: msg, timestamp: Date.now() });
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const msg = `Unhandled rejection: ${event.reason?.message || event.reason}`.slice(0, 200);
  if (!seenMessages.has(msg)) {
    seenMessages.add(msg);
    capturedMessages.push({ type: 'error', message: msg, timestamp: Date.now() });
  }
});

// Export for clip-report command
(window as any).__shiroCapturedMessages = capturedMessages;
(window as any).__shiroClearMessages = () => {
  capturedMessages.length = 0;
  seenMessages.clear();
};

import '@xterm/xterm/css/xterm.css';
import { FileSystem } from './filesystem';
import { Shell } from './shell';
import { CommandRegistry, Command } from './commands/index';
import { registry } from './registry';
import { shiroOnlyCommands } from './commands/coreutils';
import { gitCmd } from './commands/git';
import { fetchCmd, curlCmd } from './commands/fetch';
import { globCmd } from './commands/glob';
import { spiritCmd } from './commands/spirit';
import { jsEvalCmd, nodeCmd } from './commands/jseval';
import { npmCmd } from './commands/npm';
import { buildCmd } from './commands/build';
import { viCmd } from './commands/vi';
import { nanoCmd } from './commands/nano';
import { uploadCmd, downloadCmd, shiroConfigCmd } from './commands/upload';
import { sourceCmd } from './commands/source';
import { jobsCmd, fgCmd, bgCmd, waitCmd } from './commands/jobs';
import { hcCmd } from './commands/hc';
import { testCmd } from './commands/test';
import { reloadCmd } from './commands/reload';
import { termcastCmd } from './commands/termcast';
import { serveCmd, serversCmd } from './commands/serve';
import { imageCmd } from './commands/image';
import { clipReportCmd } from './commands/clip-report';
import { seedCmd } from './commands/inject';
import { iframeServer } from './iframe-server';
import { allCommands } from '../fluffycoreutils/src/index';
import { wrapFluffyCommand } from './fluffy-adapter';
import { ShiroTerminal } from './terminal';
import { ShiroProvider } from '../spirit/src/providers/shiro-provider';

/**
 * Register a command in both the CommandRegistry (for execution) and
 * the ModuleRegistry (for hot-reload capability).
 */
function registerCommand(commands: CommandRegistry, cmd: Command, sourcePath?: string): void {
  commands.register(cmd);
  registry.register(`commands/${cmd.name}`, cmd, sourcePath);
}

async function main() {
  // Initialize filesystem
  const fs = new FileSystem();
  await fs.init();

  // Listen for seed hydration from parent (when loaded via seed snippet)
  window.addEventListener('message', async (e) => {
    if (e.data && e.data.type === 'shiro-seed') {
      try {
        const { fs: nodes, localStorage: storage } = e.data.data;
        // Decode base64 content back to Uint8Array
        const decoded = nodes.map((n: any) => ({
          ...n,
          content: n.content ? Uint8Array.from(atob(n.content), (c: string) => c.charCodeAt(0)) : null,
        }));
        await fs.importAll(decoded);
        // Restore localStorage
        if (storage) {
          for (const [key, value] of Object.entries(storage)) {
            localStorage.setItem(key, value as string);
          }
        }
        // Reload to boot with imported state
        location.reload();
      } catch (err) {
        console.error('Seed hydration failed:', err);
      }
    }
  });

  // Set up command registry
  const commands = new CommandRegistry();

  // Register shared fluffycoreutils (37 commands: cat, ls, grep, sed, find, diff, etc.)
  for (const fluffy of Object.values(allCommands)) {
    commands.register(wrapFluffyCommand(fluffy));
  }

  // Register Shiro-only commands (cd, export, help, sleep, seq, which, rmdir)
  commands.registerAll(shiroOnlyCommands);

  // Register additional Shiro commands not in fluffycoreutils
  // These are registered in both CommandRegistry and ModuleRegistry for hot-reload
  registerCommand(commands, gitCmd, 'src/commands/git.ts');
  registerCommand(commands, fetchCmd, 'src/commands/fetch.ts');
  registerCommand(commands, curlCmd, 'src/commands/fetch.ts');
  registerCommand(commands, globCmd, 'src/commands/glob.ts');
  registerCommand(commands, spiritCmd, 'src/commands/spirit.ts');
  registerCommand(commands, jsEvalCmd, 'src/commands/jseval.ts');
  registerCommand(commands, nodeCmd, 'src/commands/jseval.ts');
  registerCommand(commands, npmCmd, 'src/commands/npm.ts');
  registerCommand(commands, buildCmd, 'src/commands/build.ts');
  registerCommand(commands, viCmd, 'src/commands/vi.ts');
  registerCommand(commands, nanoCmd, 'src/commands/nano.ts');
  registerCommand(commands, uploadCmd, 'src/commands/upload.ts');
  registerCommand(commands, downloadCmd, 'src/commands/upload.ts');
  registerCommand(commands, shiroConfigCmd, 'src/commands/upload.ts');
  registerCommand(commands, sourceCmd, 'src/commands/source.ts');
  registerCommand(commands, jobsCmd, 'src/commands/jobs.ts');
  registerCommand(commands, fgCmd, 'src/commands/jobs.ts');
  registerCommand(commands, bgCmd, 'src/commands/jobs.ts');
  registerCommand(commands, waitCmd, 'src/commands/jobs.ts');
  registerCommand(commands, hcCmd, 'src/commands/hc.ts');
  registerCommand(commands, testCmd, 'src/commands/test.ts');
  registerCommand(commands, reloadCmd, 'src/commands/reload.ts');
  registerCommand(commands, termcastCmd, 'src/commands/termcast.ts');
  registerCommand(commands, serveCmd, 'src/commands/serve.ts');
  registerCommand(commands, serversCmd, 'src/commands/serve.ts');
  registerCommand(commands, imageCmd, 'src/commands/image.ts');
  registerCommand(commands, clipReportCmd, 'src/commands/clip-report.ts');
  registerCommand(commands, seedCmd, 'src/commands/inject.ts');

  // Subscribe to hot-reload events to update CommandRegistry
  registry.subscribe((name, newModule, oldModule) => {
    if (name.startsWith('commands/') && newModule) {
      const cmd = newModule as Command;
      commands.register(cmd); // Re-register updates the command
      console.log(`[HotReload] Updated command: ${cmd.name}`);
    }
  });

  // Create shell
  const shell = new Shell(fs, commands);

  // Create terminal
  const container = document.getElementById('terminal')!;
  const terminal = new ShiroTerminal(container, shell);

  // Connect terminal to shell for interactive commands (vi, etc.)
  shell.setTerminal(terminal);

  // Create Spirit provider and attach to shell for the spirit command to use
  const provider = new ShiroProvider(fs, shell, terminal);
  (shell as any)._spiritProvider = provider;

  // Expose global for test automation (windwalker) and programmatic access
  (window as any).__shiro = {
    fs,
    shell,
    terminal,
    provider,
    commands,
    registry, // ModuleRegistry for hot-reload
    iframeServer, // Iframe-based virtual HTTP server
  };

  // Cleanup iframe servers on page unload (hot reload)
  window.addEventListener('beforeunload', () => {
    iframeServer.cleanup();
  });

  await terminal.start();
}

main().catch(console.error);
