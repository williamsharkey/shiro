import { Command, CommandContext } from './index';

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

    // Check if binary already exists in PATH
    const existingBin = await ctx.shell.findExecutableInPath(binName);
    if (existingBin) {
      // Execute directly
      const cmdLine = buildCmdLine(binName, passthrough);
      return ctx.shell.execute(cmdLine, (s) => ctx.stdout += s, (s) => ctx.stderr += s);
    }

    // Install the package first
    ctx.stdout += `Installing ${installSpec}...\n`;
    const installCode = await ctx.shell.execute(
      `npm install ${installSpec}`,
      (s) => ctx.stdout += s,
      (s) => ctx.stderr += s,
    );
    if (installCode !== 0) {
      ctx.stderr += `npx: npm install failed with exit code ${installCode}\n`;
      return installCode;
    }

    // Now execute the binary
    const cmdLine = buildCmdLine(binName, passthrough);
    return ctx.shell.execute(cmdLine, (s) => ctx.stdout += s, (s) => ctx.stderr += s);
  },
};

function buildCmdLine(binName: string, passthrough: string[]): string {
  return [binName, ...passthrough].map(a => {
    if (a.includes(' ') || a.includes('"') || a.includes("'")) {
      return `"${a.replace(/"/g, '\\"')}"`;
    }
    return a;
  }).join(' ');
}
