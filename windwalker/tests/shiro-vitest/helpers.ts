import { FileSystem } from '@shiro/filesystem';
import { Shell } from '@shiro/shell';
import { CommandRegistry } from '@shiro/commands/index';
import { shiroOnlyCommands } from '@shiro/commands/coreutils';
import { gitCmd } from '@shiro/commands/git';
import { globCmd } from '@shiro/commands/glob';
import { jsEvalCmd, nodeCmd } from '@shiro/commands/jseval';
import { npmCmd } from '@shiro/commands/npm';
import { fetchCmd, curlCmd } from '@shiro/commands/fetch';
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

  const shell = new Shell(fs, commands);
  return { fs, shell };
}

export async function run(shell: Shell, cmd: string): Promise<{ output: string; exitCode: number }> {
  let output = '';
  const exitCode = await shell.execute(cmd, (s: string) => { output += s; });
  return { output, exitCode };
}
