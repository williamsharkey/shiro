import '@xterm/xterm/css/xterm.css';
import { FileSystem } from './filesystem';
import { Shell } from './shell';
import { CommandRegistry } from './commands/index';
import { allCoreutils } from './commands/coreutils';
import { grepCmd } from './commands/grep';
import { sedCmd } from './commands/sed';
import { gitCmd } from './commands/git';
import { fetchCmd, curlCmd } from './commands/fetch';
import { findCmd } from './commands/find';
import { diffCmd } from './commands/diff';
import { globCmd } from './commands/glob';
import { spiritCmd } from './commands/spirit';
import { ShiroTerminal } from './terminal';
import { ShiroProvider } from './spirit-provider';

async function main() {
  // Initialize filesystem
  const fs = new FileSystem();
  await fs.init();

  // Set up command registry
  const commands = new CommandRegistry();
  commands.registerAll(allCoreutils);
  commands.register(grepCmd);
  commands.register(sedCmd);
  commands.register(gitCmd);
  commands.register(fetchCmd);
  commands.register(curlCmd);
  commands.register(findCmd);
  commands.register(diffCmd);
  commands.register(globCmd);
  commands.register(spiritCmd);

  // Create shell
  const shell = new Shell(fs, commands);

  // Create terminal
  const container = document.getElementById('terminal')!;
  const terminal = new ShiroTerminal(container, shell);

  // Create Spirit provider and attach to shell for the spirit command to use
  const provider = new ShiroProvider(fs, shell, (text: string) => {
    terminal.writeOutput(text);
  });
  (shell as any)._spiritProvider = provider;

  await terminal.start();
}

main().catch(console.error);
