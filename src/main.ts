// Console capture - must be first before any other code runs
interface CapturedMessage {
  type: 'error' | 'warn' | 'log' | 'info' | 'debug';
  message: string;
  timestamp: number;
}
const capturedMessages: CapturedMessage[] = [];
const seenMessages = new Set<string>();

function captureMethod(method: 'log' | 'info' | 'warn' | 'error' | 'debug') {
  const original = console[method];
  console[method] = (...args: any[]) => {
    const msg = args.map(a => typeof a === 'string' ? a : (a?.message || String(a))).join(' ').slice(0, 500);
    if (!seenMessages.has(msg)) {
      seenMessages.add(msg);
      capturedMessages.push({ type: method, message: msg, timestamp: Date.now() });
    }
    original.apply(console, args);
  };
}

captureMethod('log');
captureMethod('info');
captureMethod('warn');
captureMethod('error');
captureMethod('debug');

// Also capture unhandled errors
window.addEventListener('error', (event) => {
  const msg = `${event.message} at ${event.filename}:${event.lineno}`.slice(0, 500);
  if (!seenMessages.has(msg)) {
    seenMessages.add(msg);
    capturedMessages.push({ type: 'error', message: msg, timestamp: Date.now() });
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const msg = `Unhandled rejection: ${event.reason?.message || event.reason}`.slice(0, 500);
  if (!seenMessages.has(msg)) {
    seenMessages.add(msg);
    capturedMessages.push({ type: 'error', message: msg, timestamp: Date.now() });
  }
});

// Export for console command and clip-report
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
import { seedCmd } from './commands/seed';
import { remoteCmd, getPersistedRemoteCode, startRemoteWithCode } from './commands/remote';
import { hudCmd } from './commands/hud';
import { faviconCmd } from './commands/favicon';
import { historyCmd } from './commands/history';
import { consoleCmd } from './commands/console';
import { rgCmd } from './commands/rg';
import { mcpCmd } from './commands/mcp-client';
import { groupCmd } from './commands/group';
import { spawnCmd } from './commands/spawn';
import { psCmd, killCmd } from './commands/ps';
import { htmlCmd, imgCmd } from './commands/html';
import { dougCmd } from './commands/doug';
import { becomeCmd, unbecomeCmd, getBecomeConfig, activateBecomeMode, deactivateBecomeMode } from './commands/become';
import { pageCmd } from './commands/page';
import { processTable } from './process-table';
import { iframeServer } from './iframe-server';
import { allCommands } from '../fluffycoreutils/src/index';
import { wrapFluffyCommand } from './fluffy-adapter';
import { ShiroTerminal } from './terminal';
import { ShiroProvider } from '../spirit/src/providers/shiro-provider';
import { initFaviconUpdater, initTitle } from './favicon';
import { initMobileInput } from './mobile-input';
import { initDropHandler } from './drop-handler';
import buildNumber from '../build-number.txt?raw';
import { CLAUDE_MD } from './claude-md-seed';

/**
 * Register a command in both the CommandRegistry (for execution) and
 * the ModuleRegistry (for hot-reload capability).
 */
function registerCommand(commands: CommandRegistry, cmd: Command, sourcePath?: string): void {
  commands.register(cmd);
  registry.register(`commands/${cmd.name}`, cmd, sourcePath);
}

async function main() {
  console.log(`[shiro] Starting... (build #${buildNumber.trim()})`);

  // Request persistent storage so browser never evicts IndexedDB data (credentials, etc.)
  navigator.storage?.persist?.().then(granted => {
    if (granted) console.log('[shiro] Persistent storage granted');
  }).catch(() => {});

  // Initialize filesystem
  const fs = new FileSystem();
  await fs.init();
  // Seed CLAUDE.md for internal Claude Code (always update to latest version)
  try {
    await fs.mkdir('/home/user', { recursive: true });
    await fs.writeFile('/home/user/CLAUDE.md', CLAUDE_MD);
  } catch {}
  console.log('[shiro] Filesystem initialized');

  // Listen for seed hydration from parent (when loaded via seed snippet)
  window.addEventListener('message', async (e) => {
    // Legacy format (v1): single JSON blob
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

    // New format (v2): NDJSON for incremental parsing
    if (e.data && e.data.type === 'shiro-seed-v2') {
      try {
        const { ndjson, storage } = e.data;
        const lines = ndjson.split('\n');
        const nodes: any[] = [];
        const BATCH_SIZE = 100;

        // Parse NDJSON incrementally
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          const node = JSON.parse(line);
          nodes.push({
            ...node,
            content: node.content ? Uint8Array.from(atob(node.content), (c: string) => c.charCodeAt(0)) : null,
          });

          // Yield to browser every BATCH_SIZE entries
          if (nodes.length % BATCH_SIZE === 0) {
            await new Promise(r => setTimeout(r, 0));
          }
        }

        await fs.importAll(nodes);

        // Restore localStorage
        if (storage) {
          const storageObj = typeof storage === 'string' ? JSON.parse(storage) : storage;
          for (const [key, value] of Object.entries(storageObj)) {
            localStorage.setItem(key, value as string);
          }
        }

        // Reload to boot with imported state
        location.reload();
      } catch (err) {
        console.error('Seed v2 hydration failed:', err);
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
  registerCommand(commands, seedCmd, 'src/commands/seed.ts');
  registerCommand(commands, remoteCmd, 'src/commands/remote.ts');
  registerCommand(commands, hudCmd, 'src/commands/hud.ts');
  registerCommand(commands, faviconCmd, 'src/commands/favicon.ts');
  registerCommand(commands, historyCmd, 'src/commands/history.ts');
  registerCommand(commands, consoleCmd, 'src/commands/console.ts');
  registerCommand(commands, rgCmd, 'src/commands/rg.ts');
  registerCommand(commands, mcpCmd, 'src/commands/mcp-client.ts');
  registerCommand(commands, groupCmd, 'src/commands/group.ts');
  registerCommand(commands, spawnCmd, 'src/commands/spawn.ts');
  registerCommand(commands, psCmd, 'src/commands/ps.ts');
  registerCommand(commands, killCmd, 'src/commands/ps.ts');
  registerCommand(commands, htmlCmd, 'src/commands/html.ts');
  registerCommand(commands, imgCmd, 'src/commands/html.ts');
  registerCommand(commands, dougCmd, 'src/commands/doug.ts');
  registerCommand(commands, becomeCmd, 'src/commands/become.ts');
  registerCommand(commands, unbecomeCmd, 'src/commands/become.ts');
  registerCommand(commands, pageCmd, 'src/commands/page.ts');

  // Subscribe to hot-reload events to update CommandRegistry
  registry.subscribe((name, newModule, oldModule) => {
    if (name.startsWith('commands/') && newModule) {
      const cmd = newModule as Command;
      commands.register(cmd); // Re-register updates the command
      console.log(`[HotReload] Updated command: ${cmd.name}`);
    }
  });

  // Create PATH shims for builtins so programs can discover them via `which`, `execFile`, etc.
  // This is how an OS advertises its commands — the PATH mechanism, not the builtin registry.
  const shimCommands = [
    'git', 'node', 'npm', 'npx', 'ls', 'cat', 'grep', 'sed', 'find', 'curl',
    'mkdir', 'rm', 'cp', 'mv', 'echo', 'touch', 'chmod', 'head', 'tail',
    'sort', 'uniq', 'wc', 'tr', 'tee', 'diff', 'env', 'which', 'test',
    'sh', 'bash', 'vi', 'nano', 'rg', 'esbuild',
  ];
  (async () => {
    try {
      await fs.mkdir('/usr/local/bin', { recursive: true });
      for (const cmd of shimCommands) {
        const shimPath = `/usr/local/bin/${cmd}`;
        // Don't overwrite real scripts (like claude bin stub)
        if (await fs.exists(shimPath)) continue;
        await fs.writeFile(shimPath, `#!/bin/sh\n${cmd} "$@"\n`);
      }
    } catch {}
  })();

  // Create shell
  const shell = new Shell(fs, commands);

  // Populate API keys from localStorage so `claude` CLI picks them up
  const storedAnthropicKey = localStorage.getItem('shiro_anthropic_key') || localStorage.getItem('shiro_api_key');
  if (storedAnthropicKey) shell.env['ANTHROPIC_API_KEY'] = storedAnthropicKey;
  const storedOpenaiKey = localStorage.getItem('shiro_openai_key');
  if (storedOpenaiKey) shell.env['OPENAI_API_KEY'] = storedOpenaiKey;
  const storedGoogleKey = localStorage.getItem('shiro_google_key');
  if (storedGoogleKey) shell.env['GOOGLE_API_KEY'] = storedGoogleKey;
  const storedGithubToken = localStorage.getItem('shiro_github_token');
  if (storedGithubToken) shell.env['GITHUB_TOKEN'] = storedGithubToken;

  // Create terminal
  const container = document.getElementById('terminal')!;
  const terminal = new ShiroTerminal(container, shell);

  // Connect terminal to shell for interactive commands (vi, etc.)
  shell.setTerminal(terminal);

  // Create Spirit provider and attach to shell for the spirit command to use
  const provider = new ShiroProvider(fs, shell, terminal);
  (shell as any)._spiritProvider = provider;

  // Listen for font size changes from parent (seed snippet)
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'shiro-fontsize') {
      terminal.term.options.fontSize = e.data.size;
      terminal.fitAddon.fit();
    }
  });

  // Expose global for test automation (windwalker) and programmatic access
  (window as any).__shiro = {
    fs,
    shell,
    terminal,
    provider,
    commands,
    registry, // ModuleRegistry for hot-reload
    iframeServer, // Iframe-based virtual HTTP server
    processTable, // Windowed process registry
    unbecome: deactivateBecomeMode, // Exit app mode from browser console
  };

  // OAuth callback bridge: receive auth codes from /oauth/callback popup
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type !== 'shiro-oauth-callback') return;
    const { code, state, port, params } = event.data;
    if (!port) return;
    // Reconstruct the original callback URL path with query params
    const callbackParams = new URLSearchParams();
    if (code) callbackParams.set('code', code);
    if (state) callbackParams.set('state', state);
    // Forward any extra params the provider sent
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (k !== 'port' && !callbackParams.has(k)) callbackParams.set(k, v as string);
      }
    }
    const path = '/oauth/callback?' + callbackParams.toString();
    iframeServer.fetch(parseInt(port, 10), path).catch(() => {});
  });

  // Cleanup iframe servers on page unload (hot reload)
  window.addEventListener('beforeunload', () => {
    iframeServer.cleanup();
  });

  // Demo mode: lightweight boot for about page iframes
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';

  if (isDemo) {
    // Skip banner, HUD, mobile input, favicon — just show a clean prompt
    terminal.term.options.fontSize = 13;
    terminal.fitAddon.fit();
    // Signal ready
    (window as any).__shiroDemo = true;
    return;
  }

  await terminal.start();

  // Check for become mode (app mode) — restore full-screen app if configured
  const becomeConfig = getBecomeConfig();
  if (becomeConfig) {
    const pathname = location.pathname.replace(/\/$/, '');
    if (pathname === '/' + becomeConfig.slug || pathname === '' || pathname === '/') {
      // Start the server for the app directory, then activate become mode
      const startResult = await shell.execute(
        `serve "${becomeConfig.directory}" ${becomeConfig.port}`,
        () => {}, () => {},
      );
      if (startResult === 0) {
        await activateBecomeMode(becomeConfig);
      } else {
        // Server failed to start — clear become config and show terminal
        localStorage.removeItem('shiro-become');
        console.warn('[shiro] Become mode: server failed to start, falling back to terminal');
      }
    }
  }

  // Initialize drag-and-drop seed GIF import
  initDropHandler(terminal, fs);

  // Initialize mobile virtual keys and voice input
  initMobileInput(terminal);

  // Initialize dynamic favicon (32x32 minimap of terminal content)
  initFaviconUpdater(terminal.term);

  // Initialize dynamic title (shows recent commands)
  initTitle();

  // Auto-reconnect remote session if one was active before page reload
  const persistedCode = getPersistedRemoteCode();
  if (persistedCode) {
    startRemoteWithCode(persistedCode, terminal);
  }
}

main().catch(console.error);
