import { FileSystem } from '../src/filesystem';
import { Shell } from '../src/shell';
import { CommandRegistry, CommandContext } from '../src/commands/index';
import { allCoreutils } from '../src/commands/coreutils';
import { grepCmd } from '../src/commands/grep';
import { sedCmd } from '../src/commands/sed';
import { gitCmd } from '../src/commands/git';
import { findCmd } from '../src/commands/find';
import { diffCmd } from '../src/commands/diff';
import { globCmd } from '../src/commands/glob';
import { jsEvalCmd, nodeCmd } from '../src/commands/jseval';

export async function createTestShell(): Promise<{ fs: FileSystem; shell: Shell }> {
  const fs = new FileSystem();
  await fs.init();

  const commands = new CommandRegistry();
  commands.registerAll(allCoreutils);
  commands.register(grepCmd);
  commands.register(sedCmd);
  commands.register(gitCmd);
  commands.register(findCmd);
  commands.register(diffCmd);
  commands.register(globCmd);
  commands.register(jsEvalCmd);
  commands.register(nodeCmd);

  const shell = new Shell(fs, commands);
  return { fs, shell };
}

export async function run(shell: Shell, cmd: string): Promise<{ output: string; exitCode: number }> {
  let output = '';
  const exitCode = await shell.execute(cmd, (s: string) => { output += s; });
  return { output, exitCode };
}
