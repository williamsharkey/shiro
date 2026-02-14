import { FileSystem } from '@shiro/filesystem';
import { Shell } from '@shiro/shell';
import { CommandRegistry } from '@shiro/commands/index';
import { ShiroTerminal } from '@shiro/terminal';
import { shiroOnlyCommands } from '@shiro/commands/coreutils';
import { gitCmd } from '@shiro/commands/git';
import { globCmd } from '@shiro/commands/glob';
import { jsEvalCmd, nodeCmd } from '@shiro/commands/jseval';
import { npmCmd } from '@shiro/commands/npm';
import { fetchCmd, curlCmd } from '@shiro/commands/fetch';
import { rgCmd } from '@shiro/commands/rg';
import { mkTempCmd } from '@shiro/commands/mktemp';
import { jqCmd } from '@shiro/commands/jq';
import { tputCmd } from '@shiro/commands/tput';
import { sttyCmd } from '@shiro/commands/stty';
import { gzipCmd, gunzipCmd } from '@shiro/commands/gzip';
import { wgetCmd } from '@shiro/commands/wget';
import { pgrepCmd, pkillCmd } from '@shiro/commands/pgrep';
import { nprocCmd } from '@shiro/commands/nproc';
import { getconfCmd } from '@shiro/commands/getconf';
import { edCmd } from '@shiro/commands/ed';
import { iconvCmd } from '@shiro/commands/iconv';
import { zipCmd, unzipCmd } from '@shiro/commands/zip';
import { allCommands } from '@shiro-fluffy/index';
import { wrapFluffyCommand } from '@shiro/fluffy-adapter';

export async function createTestShell(): Promise<{ fs: FileSystem; shell: Shell }> {
  const fs = new FileSystem();
  await fs.init();

  const commands = new CommandRegistry();

  // Register shared fluffycoreutils
  for (const fluffy of Object.values(allCommands)) {
    commands.register(wrapFluffyCommand(fluffy));
  }

  // Register Shiro-only commands (override fluffy where needed)
  commands.registerAll(shiroOnlyCommands);

  // Register additional Shiro commands
  commands.register(gitCmd);
  commands.register(globCmd);
  commands.register(jsEvalCmd);
  commands.register(nodeCmd);
  commands.register(npmCmd);
  commands.register(fetchCmd);
  commands.register(curlCmd);
  commands.register(rgCmd);
  commands.register(mkTempCmd);
  commands.register(jqCmd);
  commands.register(tputCmd);
  commands.register(sttyCmd);
  commands.register(gzipCmd);
  commands.register(gunzipCmd);
  commands.register(wgetCmd);
  commands.register(pgrepCmd);
  commands.register(pkillCmd);
  commands.register(nprocCmd);
  commands.register(getconfCmd);
  commands.register(edCmd);
  commands.register(iconvCmd);
  commands.register(zipCmd);
  commands.register(unzipCmd);

  const shell = new Shell(fs, commands);
  return { fs, shell };
}

/**
 * Create a full Shiro OS with real xterm.js terminal in linkedom.
 * This gives you the complete interactive environment: stdin passthrough,
 * raw mode, resize events — everything ink/React terminal apps need.
 */
export async function createTestOS(): Promise<{
  fs: FileSystem;
  shell: Shell;
  terminal: ShiroTerminal;
  /** Send raw keystrokes to the terminal (as if typed) */
  type: (data: string) => void;
}> {
  const { fs, shell } = await createTestShell();

  // Create a DOM container for the terminal
  const container = document.createElement('div');
  container.id = 'terminal';
  document.body.appendChild(container);

  const terminal = new ShiroTerminal(container, shell);
  shell.setTerminal(terminal);

  return {
    fs,
    shell,
    terminal,
    type: (data: string) => {
      // Feed data into xterm as if typed — triggers onData → handleInput.
      // Deferred to next tick so ProcessExitError from process.exit() inside
      // stdin handlers doesn't propagate back to the caller.
      setTimeout(() => (terminal.term as any)._core._onData.fire(data), 0);
    },
  };
}

export async function run(shell: Shell, cmd: string): Promise<{ output: string; exitCode: number }> {
  let output = '';
  const exitCode = await shell.execute(cmd, (s: string) => { output += s; });
  return { output, exitCode };
}
