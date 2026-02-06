import { FileSystem } from '../src/filesystem';
import { Shell } from '../src/shell';
import { CommandRegistry } from '../src/commands/index';
import { shiroOnlyCommands } from '../src/commands/coreutils';
import { gitCmd } from '../src/commands/git';
import { globCmd } from '../src/commands/glob';
import { jsEvalCmd, nodeCmd } from '../src/commands/jseval';
import { npmCmd } from '../src/commands/npm';
import { fetchCmd, curlCmd } from '../src/commands/fetch';
import { allCommands } from '../fluffycoreutils/src/index';
import { wrapFluffyCommand } from '../src/fluffy-adapter';

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

  const shell = new Shell(fs, commands);
  return { fs, shell };
}

export async function run(shell: Shell, cmd: string): Promise<{ output: string; exitCode: number }> {
  let output = '';
  const exitCode = await shell.execute(cmd, (s: string) => { output += s; });
  return { output, exitCode };
}
