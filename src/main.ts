import '@xterm/xterm/css/xterm.css';
import { FileSystem } from './filesystem';
import { Shell } from './shell';
import { CommandRegistry } from './commands/index';
import { shiroOnlyCommands } from './commands/coreutils';
import { gitCmd } from './commands/git';
import { fetchCmd, curlCmd } from './commands/fetch';
import { globCmd } from './commands/glob';
import { spiritCmd } from './commands/spirit';
import { jsEvalCmd, nodeCmd } from './commands/jseval';
import { npmCmd } from './commands/npm';
import { buildCmd } from './commands/build';
import { viCmd } from './commands/vi';
import { uploadCmd, downloadCmd, shiroConfigCmd } from './commands/upload';
import { allCommands } from '../fluffycoreutils/src/index';
import { wrapFluffyCommand } from './fluffy-adapter';
import { ShiroTerminal } from './terminal';
import { ShiroProvider } from '../spirit/src/providers/shiro-provider';

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
  commands.register(gitCmd);
  commands.register(fetchCmd);
  commands.register(curlCmd);
  commands.register(globCmd);
  commands.register(spiritCmd);
  commands.register(jsEvalCmd);
  commands.register(nodeCmd);
  commands.register(npmCmd);
  commands.register(buildCmd);
  commands.register(viCmd);
  commands.register(uploadCmd);
  commands.register(downloadCmd);
  commands.register(shiroConfigCmd);

  // Create shell
  const shell = new Shell(fs, commands);

  // Create terminal
  const container = document.getElementById('terminal')!;
  const terminal = new ShiroTerminal(container, shell);

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
  };

  await terminal.start();
}

main().catch(console.error);
