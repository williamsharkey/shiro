import { Command, CommandContext } from './index';
import { quoteArgsForShell } from '../shell';

/**
 * npx: Execute npm package binaries
 *
 * Looks for the binary in node_modules/.bin first.
 * If not found, runs `npm install <package>` then executes.
 */
export const npxCmd: Command = {
  name: 'npx',
  description: 'Execute npm package binaries',
  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args; // args already excludes the command name

    // Filter flags we handle
    let yesFlag = false;
    const passthrough: string[] = [];
    let packageArg: string | null = null;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!packageArg && (a === '--help' || a === '-h')) {
        ctx.stdout += 'Usage: npx [options] <command> [args...]\n\n';
        ctx.stdout += 'Execute a package binary, installing if needed.\n\n';
        ctx.stdout += 'Options:\n';
        ctx.stdout += '  -y, --yes    Skip install confirmation\n';
        ctx.stdout += '  -h, --help   Show this help\n';
        return 0;
      }
      if (!packageArg && (a === '-y' || a === '--yes')) {
        yesFlag = true;
        continue;
      }
      if (!packageArg) {
        packageArg = a;
      } else {
        passthrough.push(a);
      }
    }

    if (!packageArg) {
      ctx.stderr += 'npx: missing command\nUsage: npx [options] <command> [args...]\n';
      return 1;
    }

    // Parse package@version and scoped packages
    let binName: string;
    let installSpec: string = packageArg;
    if (packageArg.startsWith('@')) {
      // Scoped: @scope/pkg or @scope/pkg@version
      const slashIdx = packageArg.indexOf('/');
      if (slashIdx === -1) {
        ctx.stderr += `npx: invalid scoped package: ${packageArg}\n`;
        return 1;
      }
      const afterSlash = packageArg.slice(slashIdx + 1);
      const atIdx = afterSlash.indexOf('@');
      if (atIdx > 0) {
        binName = afterSlash.slice(0, atIdx);
      } else {
        binName = afterSlash;
      }
    } else {
      // Unscoped: pkg or pkg@version
      const atIdx = packageArg.indexOf('@');
      if (atIdx > 0) {
        binName = packageArg.slice(0, atIdx);
      } else {
        binName = packageArg;
      }
    }

    // Output of a nested execute() is terminal-style (\r\n); ours is a plain
    // stream again, converted once by whoever shows it
    // (as it comes where the shell streams npx's output: a redirect's file)
    const out = (s: string) => { s = s.replace(/\r\n/g, '\n'); if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s; };
    const err = (s: string) => { s = s.replace(/\r\n/g, '\n'); if (ctx.streamStderr) ctx.streamStderr(s); else ctx.stderr += s; };
    const run = (line: string) => ctx.shell.execute(line, out, err, false, ctx.terminal, true);
    // The package's command reads npx's own (piped) stdin
    const runBin = (line: string) => ctx.stdin ? ctx.shell.executeWithStdin(line, ctx.stdin, out, err) : run(line);

    // Check if binary already exists in PATH
    const existingBin = await ctx.shell.findExecutableInPath(binName);
    if (existingBin) {
      // Execute directly
      const cmdLine = buildCmdLine(binName, passthrough);
      return runBin(cmdLine);
    }

    // Install it into npx's cache (~/.npm/_npx/<spec>), as npm does, not the project
    const pkgName = installSpec.startsWith('@') ? '@' + installSpec.slice(1).split('@')[0] : installSpec.split('@')[0];
    const home = ctx.env?.HOME || '/home/user';
    const cacheDir = `${home}/.npm/_npx/${installSpec.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    let pkgJson: any = null;
    const readPkg = async () => {
      try { return JSON.parse(await ctx.fs.readFile(`${cacheDir}/node_modules/${pkgName}/package.json`, 'utf8') as string); } catch { return null; }
    };
    // A tag (latest, next) is looked up again each time; a pinned version is reused
    const pinned = /@\d+\.\d+\.\d+$/.test(installSpec);
    if (pinned) pkgJson = await readPkg();
    if (!pkgJson) {
      await ctx.fs.mkdir(cacheDir, { recursive: true });
      try { await ctx.fs.stat(`${cacheDir}/package.json`); } catch { await ctx.fs.writeFile(`${cacheDir}/package.json`, '{}\n'); }
      const installCode = await run(`(cd ${quoteArgsForShell([cacheDir])} && npm install ${quoteArgsForShell([installSpec])} > /dev/null)`);
      pkgJson = await readPkg();
      if (installCode !== 0 || !pkgJson) {
        ctx.stderr += `npx: could not install ${installSpec}\n`;
        return installCode || 1;
      }
    }
    // The bin named like the package, else its only bin
    const bins: Record<string, string> = typeof pkgJson.bin === 'string' ? { [binName]: pkgJson.bin } : (pkgJson.bin ?? {});
    const chosen = bins[binName] !== undefined ? binName : Object.keys(bins).length === 1 ? Object.keys(bins)[0] : null;
    if (!chosen) {
      ctx.stderr += `npx: ${pkgName} has no bin named ${binName}\n`;
      return 1;
    }
    return runBin(buildCmdLine(`${cacheDir}/node_modules/.bin/${chosen}`, passthrough));
  },
};

function buildCmdLine(binName: string, passthrough: string[]): string {
  // Arguments run again through the shell verbatim: a quoted glob or $ stays as given
  return quoteArgsForShell([binName, ...passthrough]);
}
