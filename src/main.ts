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
