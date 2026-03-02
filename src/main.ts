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
import { lazyCommand } from './utils/lazy-command';
import { shellBuiltins } from './commands/shell-builtins';
import { shiroCmds } from './commands/shiro-cmds';
import { gitCmd } from './commands/git';
import { grepCmd } from './commands/grep';
import { sedCmd } from './commands/sed';
import { fetchCmd, curlCmd } from './commands/fetch';
import { globCmd } from './commands/glob';
import { jsEvalCmd, nodeCmd } from './commands/jseval';
import { npmCmd } from './commands/npm';
import { viCmd } from './commands/vi';
import { uploadCmd, downloadCmd, shiroConfigCmd } from './commands/upload';
import { sourceCmd, dotCmd } from './commands/source';
import { jobsCmd, fgCmd, bgCmd, waitCmd } from './commands/jobs';
import { hcCmd } from './commands/hc';
import { testCmd } from './commands/test';
import { reloadCmd } from './commands/reload';
import { serveCmd, serversCmd } from './commands/serve';
import { clipReportCmd } from './commands/clip-report';
import { remoteCmd, getPersistedRemoteCode, startRemoteWithCode } from './commands/remote';
import { hudCmd } from './commands/hud';
import { faviconCmd } from './commands/favicon';
import { historyCmd } from './commands/history';
import { consoleCmd } from './commands/console';
import { rgCmd } from './commands/rg';
import { spawnCmd } from './commands/spawn';
import { scCmd } from './commands/sc';
import { cwCmd } from './commands/cw';
import { setupCmd } from './commands/setup';
import { psCmd, killCmd } from './commands/ps';
import { htmlCmd, imgCmd } from './commands/html';
import { dougCmd } from './commands/doug';
import { becomeCmd, unbecomeCmd, getBecomeConfig, activateBecomeMode, deactivateBecomeMode } from './commands/become';
import { pageCmd } from './commands/page';
import { titleCmd } from './commands/title';

import { mkTempCmd } from './commands/mktemp';
import { tputCmd } from './commands/tput';
import { sttyCmd } from './commands/stty';
import { gzipCmd, gunzipCmd } from './commands/gzip';
import { wgetCmd } from './commands/wget';
import { pgrepCmd, pkillCmd } from './commands/pgrep';
import { nprocCmd } from './commands/nproc';
import { getconfCmd } from './commands/getconf';
import { iconvCmd } from './commands/iconv';
// wasi and pkg are lazy-loaded (pulls in ~960-line wasi-runtime.ts)
import { processTable } from './process-table';
import { iframeServer } from './iframe-server';
import { unixCommands } from './commands/unix';
import { ShiroTerminal } from './terminal';

import { initFaviconUpdater, initTitle } from './favicon';
import { initMobileInput } from './mobile-input';
import { initDropHandler } from './drop-handler';
import { closeSplitView } from './split-view';
import { initFileAssociations } from './file-associations';
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

  // Initialize file associations (extension → command mappings for `open`)
  initFileAssociations();

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

  // Register Unix commands (standard coreutils)
  for (const cmd of unixCommands) {
    commands.register(cmd);
  }

  // Register shell builtins (cd, export, help, command, sh, bash, grep/sed/diff overrides)
  commands.registerAll(shellBuiltins);

  // Register Shiro-specific commands (rm, ln, uname, which, type, etc.)
  commands.registerAll(shiroCmds);

  // Register additional Shiro commands
  // These are registered in both CommandRegistry and ModuleRegistry for hot-reload
  registerCommand(commands, gitCmd, 'src/commands/git.ts');
  registerCommand(commands, grepCmd, 'src/commands/grep.ts');
  registerCommand(commands, sedCmd, 'src/commands/sed.ts');
  registerCommand(commands, fetchCmd, 'src/commands/fetch.ts');
  registerCommand(commands, curlCmd, 'src/commands/fetch.ts');
  registerCommand(commands, globCmd, 'src/commands/glob.ts');
  registerCommand(commands, jsEvalCmd, 'src/commands/jseval.ts');
  registerCommand(commands, nodeCmd, 'src/commands/jseval.ts');
  registerCommand(commands, npmCmd, 'src/commands/npm.ts');
  registerCommand(commands, lazyCommand('build', 'Bundle TypeScript/JavaScript using esbuild-wasm',
    () => import('./commands/build').then(m => m.buildCmd)), 'src/commands/build.ts');
  registerCommand(commands, viCmd, 'src/commands/vi.ts');
  registerCommand(commands, lazyCommand('nano', 'Simple text editor (Ctrl+O save, Ctrl+X exit)',
    () => import('./commands/nano').then(m => m.nanoCmd)), 'src/commands/nano.ts');
  registerCommand(commands, uploadCmd, 'src/commands/upload.ts');
  registerCommand(commands, downloadCmd, 'src/commands/upload.ts');
  registerCommand(commands, shiroConfigCmd, 'src/commands/upload.ts');
  registerCommand(commands, sourceCmd, 'src/commands/source.ts');
  registerCommand(commands, dotCmd, 'src/commands/source.ts');
  registerCommand(commands, jobsCmd, 'src/commands/jobs.ts');
  registerCommand(commands, fgCmd, 'src/commands/jobs.ts');
  registerCommand(commands, bgCmd, 'src/commands/jobs.ts');
  registerCommand(commands, waitCmd, 'src/commands/jobs.ts');
  registerCommand(commands, hcCmd, 'src/commands/hc.ts');
  registerCommand(commands, testCmd, 'src/commands/test.ts');
  registerCommand(commands, reloadCmd, 'src/commands/reload.ts');
  registerCommand(commands, lazyCommand('termcast', 'Record terminal sessions in asciicast format',
    () => import('./commands/termcast').then(m => m.termcastCmd)), 'src/commands/termcast.ts');
  registerCommand(commands, serveCmd, 'src/commands/serve.ts');
  registerCommand(commands, serversCmd, 'src/commands/serve.ts');
  registerCommand(commands, lazyCommand('image', 'Manage shiro images (filesystem snapshots)',
    () => import('./commands/image').then(m => m.imageCmd)), 'src/commands/image.ts');
  registerCommand(commands, clipReportCmd, 'src/commands/clip-report.ts');
  registerCommand(commands, lazyCommand('seed', 'Export Shiro state (seed [blob|gif|html] [subdomain])',
    () => import('./commands/seed').then(m => m.seedCmd)), 'src/commands/seed.ts');
  registerCommand(commands, remoteCmd, 'src/commands/remote.ts');
  registerCommand(commands, hudCmd, 'src/commands/hud.ts');
  registerCommand(commands, faviconCmd, 'src/commands/favicon.ts');
  registerCommand(commands, historyCmd, 'src/commands/history.ts');
  registerCommand(commands, consoleCmd, 'src/commands/console.ts');
  registerCommand(commands, rgCmd, 'src/commands/rg.ts');
  registerCommand(commands, lazyCommand('mcp', 'MCP Streamable HTTP client',
    () => import('./commands/mcp-client').then(m => m.mcpCmd)), 'src/commands/mcp-client.ts');
  registerCommand(commands, lazyCommand('group', 'Encrypted group networking',
    () => import('./commands/group').then(m => m.groupCmd)), 'src/commands/group.ts');
  registerCommand(commands, spawnCmd, 'src/commands/spawn.ts');
  registerCommand(commands, scCmd, 'src/commands/sc.ts');
  registerCommand(commands, cwCmd, 'src/commands/cw.ts');
  registerCommand(commands, setupCmd, 'src/commands/setup.ts');
  registerCommand(commands, psCmd, 'src/commands/ps.ts');
  registerCommand(commands, killCmd, 'src/commands/ps.ts');
  registerCommand(commands, htmlCmd, 'src/commands/html.ts');
  registerCommand(commands, imgCmd, 'src/commands/html.ts');
  registerCommand(commands, dougCmd, 'src/commands/doug.ts');
  registerCommand(commands, becomeCmd, 'src/commands/become.ts');
  registerCommand(commands, unbecomeCmd, 'src/commands/become.ts');
  registerCommand(commands, pageCmd, 'src/commands/page.ts');
  registerCommand(commands, titleCmd, 'src/commands/title.ts');

  registerCommand(commands, lazyCommand('gh', 'GitHub CLI',
    () => import('./commands/gh').then(m => m.ghCmd)), 'src/commands/gh.ts');
  registerCommand(commands, lazyCommand('x86', 'Run x86-64 ELF binaries',
    () => import('./commands/x86').then(m => m.x86Cmd)), 'src/commands/x86.ts');
  registerCommand(commands, mkTempCmd, 'src/commands/mktemp.ts');
  registerCommand(commands, lazyCommand('jq', 'JSON processor',
    () => import('./commands/jq').then(m => m.jqCmd)), 'src/commands/jq.ts');
  registerCommand(commands, tputCmd, 'src/commands/tput.ts');
  registerCommand(commands, sttyCmd, 'src/commands/stty.ts');
  registerCommand(commands, gzipCmd, 'src/commands/gzip.ts');
  registerCommand(commands, gunzipCmd, 'src/commands/gzip.ts');
  registerCommand(commands, wgetCmd, 'src/commands/wget.ts');
  registerCommand(commands, pgrepCmd, 'src/commands/pgrep.ts');
  registerCommand(commands, pkillCmd, 'src/commands/pgrep.ts');
  registerCommand(commands, nprocCmd, 'src/commands/nproc.ts');
  registerCommand(commands, getconfCmd, 'src/commands/getconf.ts');
  registerCommand(commands, lazyCommand('ed', 'Line editor',
    () => import('./commands/ed').then(m => m.edCmd)), 'src/commands/ed.ts');
  registerCommand(commands, iconvCmd, 'src/commands/iconv.ts');
  registerCommand(commands, lazyCommand('zip', 'Create ZIP archives',
    () => import('./commands/zip').then(m => m.zipCmd)), 'src/commands/zip.ts');
  registerCommand(commands, lazyCommand('unzip', 'Extract ZIP archives',
    () => import('./commands/zip').then(m => m.unzipCmd)), 'src/commands/zip.ts');
  registerCommand(commands, lazyCommand('cc', 'C compiler (xcc/wcc)',
    () => import('./commands/cc').then(m => m.ccCmd)), 'src/commands/cc.ts');
  registerCommand(commands, lazyCommand('gcc', 'C compiler (alias for cc)',
    () => import('./commands/cc').then(m => m.gccCmd)), 'src/commands/cc.ts');

  // Lazy-loaded new capabilities (WASM runtimes from CDN)
  registerCommand(commands, lazyCommand('python', 'Python interpreter (Pyodide)',
    () => import('./commands/python').then(m => m.pythonCmd)), 'src/commands/python.ts');
  registerCommand(commands, lazyCommand('python3', 'Python 3 interpreter (Pyodide)',
    () => import('./commands/python').then(m => m.python3Cmd)), 'src/commands/python.ts');
  registerCommand(commands, lazyCommand('pip', 'Python package manager',
    () => import('./commands/python').then(m => m.pipCmd)), 'src/commands/python.ts');
  registerCommand(commands, lazyCommand('sqlite3', 'SQLite database engine',
    () => import('./commands/sqlite').then(m => m.sqlite3Cmd)), 'src/commands/sqlite.ts');
  registerCommand(commands, lazyCommand('finder', 'Visual file manager',
    () => import('./commands/finder').then(m => m.finderCmd)), 'src/commands/finder.ts');
  registerCommand(commands, lazyCommand('code', 'Rich code editor (CodeMirror)',
    () => import('./commands/code-editor').then(m => m.codeEditorCmd)), 'src/commands/code-editor.ts');
  registerCommand(commands, lazyCommand('monaco', 'VS Code editor (Monaco)',
    () => import('./commands/monaco-editor').then(m => m.monacoEditorCmd)), 'src/commands/monaco-editor.ts');
  registerCommand(commands, lazyCommand('mdview', 'Render markdown as formatted HTML',
    () => import('./commands/mdview').then(m => m.mdviewCmd)), 'src/commands/mdview.ts');
  registerCommand(commands, lazyCommand('builder', 'AI app builder (chat + live preview)',
    () => import('./commands/builder').then(m => m.builderCmd)), 'src/commands/builder.ts');
  registerCommand(commands, lazyCommand('ffmpeg', 'Video/audio processing (ffmpeg.wasm)',
    () => import('./commands/ffmpeg').then(m => m.ffmpegCmd)), 'src/commands/ffmpeg.ts');
  registerCommand(commands, lazyCommand('lua', 'Lua 5.4 interpreter (wasmoon)',
    () => import('./commands/lua').then(m => m.luaCmd)), 'src/commands/lua.ts');
  registerCommand(commands, lazyCommand('play', 'Auto-detect and run current project',
    () => import('./commands/play').then(m => m.playCmd)), 'src/commands/play.ts');
  registerCommand(commands, lazyCommand('psql', 'PostgreSQL database (PGlite)',
    () => import('./commands/postgres').then(m => m.psqlCmd)), 'src/commands/postgres.ts');
  registerCommand(commands, lazyCommand('convert', 'ImageMagick image conversion (magick-wasm)',
    () => import('./commands/magick').then(m => m.convertCmd)), 'src/commands/magick.ts');
  registerCommand(commands, lazyCommand('magick', 'ImageMagick (magick-wasm)',
    () => import('./commands/magick').then(m => m.magickCmd)), 'src/commands/magick.ts');
  registerCommand(commands, lazyCommand('wasi', 'Run WASM+WASI binaries',
    () => import('./commands/wasi').then(m => m.wasiCmd)), 'src/commands/wasi.ts');
  registerCommand(commands, lazyCommand('pkg', 'WASM package manager',
    () => import('./commands/pkg').then(m => m.pkgCmd)), 'src/commands/pkg.ts');

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
    'mktemp', 'jq', 'tput', 'stty', 'gzip', 'gunzip', 'wget',
    'pgrep', 'pkill', 'nproc', 'getconf', 'ed', 'iconv', 'zip', 'unzip',
    'cc', 'gcc', 'python', 'python3', 'pip', 'sqlite3',
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
      // Create /bin/sh, /bin/bash, /usr/bin/env so stat() checks pass
      await fs.mkdir('/bin', { recursive: true });
      await fs.mkdir('/usr/bin', { recursive: true });
      if (!await fs.exists('/bin/sh')) await fs.writeFile('/bin/sh', '#!/bin/sh\n');
      if (!await fs.exists('/bin/bash')) await fs.writeFile('/bin/bash', '#!/bin/bash\n');
      if (!await fs.exists('/usr/bin/env')) await fs.writeFile('/usr/bin/env', '#!/bin/sh\n');
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

  // Listen for font size changes from parent (seed snippet)
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'shiro-fontsize') {
      terminal.term.options.fontSize = e.data.size;
      terminal.fitAddon.fit();
    }
  });

  // Expose global for test automation and programmatic access
  (window as any).__shiro = {
    fs,
    shell,
    terminal,

    commands,
    registry, // ModuleRegistry for hot-reload
    iframeServer, // Iframe-based virtual HTTP server
    processTable, // Windowed process registry
    unbecome: deactivateBecomeMode, // Exit app mode from browser console
    closeSplit: closeSplitView, // Close split pane from browser console
    lastSeedGif: null as Uint8Array | null, // Last generated seed GIF bytes (for demos/drag)
  };

  // OAuth callback bridge: receive auth codes from /oauth/callback popup
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type !== 'shiro-oauth-callback') return;
    const { code, state, params } = event.data;
    let port = event.data.port;
    // Extract port from state parameter (setup command encodes it as port_XXXXX_random)
    if (!port && state) {
      const m = state.match(/^port_(\d+)_/);
      if (m) port = m[1];
    }
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
    // Init drop handler so seed GIF drag-and-drop works in demos
    initDropHandler(terminal, fs);
    // Signal ready
    (window as any).__shiroDemo = true;
    return;
  }

  // Pre-hide terminal if we'll enter become/IDE mode (prevents flash)
  const becomeConfig = getBecomeConfig();
  if (becomeConfig) {
    document.body.classList.add('become-active');
  }

  await terminal.start();

  // Check for become mode (app mode) — restore full-screen app if configured
  if (becomeConfig) {
    const pathname = location.pathname.replace(/\/$/, '');
    const params = new URLSearchParams(location.search);

    // ?unbecome escape hatch — clear become config and show terminal
    if (params.has('unbecome')) {
      localStorage.removeItem('shiro-become');
      document.body.classList.remove('become-active');
      history.replaceState({}, '', '/');
    } else if (pathname === '/' + becomeConfig.slug) {
      // Only re-enter become mode on the slug path, NOT on root /
      let startResult: number;
      startResult = await shell.execute(
          `serve "${becomeConfig.directory}" ${becomeConfig.port}`,
          () => {}, () => {},
        );
        if (startResult === 0) {
          await activateBecomeMode(becomeConfig);
        }
      if (startResult !== 0) {
        // Server failed to start — clear become config and show terminal
        localStorage.removeItem('shiro-become');
        document.body.classList.remove('become-active');
        console.warn('[shiro] Become mode: server failed to start, falling back to terminal');
      }
    } else {
      // Pathname doesn't match slug — show terminal (stale config)
      document.body.classList.remove('become-active');
    }
  }

  // Check for shared seed URL: /s/:id
  const seedMatch = location.pathname.match(/^\/s\/([a-z0-9]{4,16})$/);
  if (seedMatch) {
    const seedId = seedMatch[1];
    terminal.term.writeln(`\r\nLoading shared seed ${seedId}...`);
    try {
      const res = await fetch(`/api/seed/${seedId}`);
      if (res.ok) {
        const compressed = new Uint8Array(await res.arrayBuffer());
        // Decompress
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(compressed);
        writer.close();
        const reader = ds.readable.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const full = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { full.set(c, offset); offset += c.length; }
        const envelope = JSON.parse(new TextDecoder().decode(full));

        // Hydrate filesystem
        const lines = envelope.ndjson.split('\n');
        const nodes: any[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const node = JSON.parse(trimmed);
          nodes.push({
            ...node,
            content: node.content ? Uint8Array.from(atob(node.content), (c: string) => c.charCodeAt(0)) : null,
          });
        }
        await fs.importAll(nodes);

        // Restore localStorage
        if (envelope.storage) {
          const storageObj = typeof envelope.storage === 'string' ? JSON.parse(envelope.storage) : envelope.storage;
          for (const [key, value] of Object.entries(storageObj)) {
            localStorage.setItem(key, value as string);
          }
        }

        terminal.term.writeln(`Loaded ${envelope.files} files. Reloading...`);
        // Redirect to root so we don't re-import on reload
        setTimeout(() => { location.href = '/'; }, 500);
        return;
      } else {
        terminal.term.writeln(`Seed not found (${res.status})`);
      }
    } catch (e: any) {
      terminal.term.writeln(`Failed to load seed: ${e.message}`);
    }
  }

  // Check for GitHub import URL: /:user/:repo
  const ghMatch = location.pathname.match(/^\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/?$/);
  if (ghMatch && !seedMatch) {
    const [, user, repo] = ghMatch;
    // Avoid collision with reserved paths
    const reserved = ['api', 'oauth', 'offer', 'answer', 'git-proxy', 'channel', 'assets'];
    if (!reserved.includes(user.toLowerCase())) {
      const repoUrl = `https://github.com/${user}/${repo}`;
      terminal.term.writeln(`\r\nCloning ${repoUrl}...`);
      const cloneDir = `/home/user/${repo}`;
      shell.execute(
        `git clone ${repoUrl} ${cloneDir} && cd ${cloneDir}`,
        (out: string) => terminal.term.write(out.replace(/\n/g, '\r\n')),
        (err: string) => terminal.term.write(err.replace(/\n/g, '\r\n')),
      ).then(async (code: number) => {
        if (code === 0) {
          shell.cwd = cloneDir;
          terminal.term.writeln(`\r\nCloned to ${cloneDir}`);
          // Auto-detect and run the project
          try {
            const { detectAndRun } = await import('./github-player/index');
            await detectAndRun({
              fs, shell, terminal, dir: cloneDir, repoName: repo, user,
              log: (msg) => terminal.term.writeln('\r\n' + msg),
            });
          } catch (err: any) {
            terminal.term.writeln(`\r\n\x1b[33mAuto-run failed: ${err.message}\x1b[0m`);
          }
        }
        // Replace URL to root so refresh doesn't re-clone
        history.replaceState({}, '', '/');
      });
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
  // Skip only if become mode is actually active (not just config in localStorage)
  if (!document.body.classList.contains('become-active')) {
    const persistedCode = getPersistedRemoteCode();
    if (persistedCode) {
      startRemoteWithCode(persistedCode, terminal);
    }
  }
}

// Guard: the entry chunk is inlined into HTML AND kept as a file for lazy chunk
// imports. The browser evaluates it twice (inline script ≠ file module). The boot
// flag prevents main() from running a second time when lazy chunks load.
if (!(window as any).__shiroBooted) {
  (window as any).__shiroBooted = true;
  main().catch(console.error);
}
