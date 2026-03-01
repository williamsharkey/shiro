import { Command, CommandContext } from './index';
import {
  searchPackages,
  listAvailable,
  listInstalled,
  downloadPackage,
  removePackage,
  findPackage,
  clearModuleCache,
} from '../wasi-packages';

/**
 * pkg — WASM package manager for Shiro
 *
 * Usage:
 *   pkg install <name>    Download and cache a WASM package
 *   pkg search <query>    Search available packages
 *   pkg list              Show installed packages
 *   pkg available         Show all available packages
 *   pkg remove <name>     Remove a cached package
 *   pkg info <name>       Show package details
 */

const PKG_BIN_DIR = '/usr/local/bin';

/** Ensure /usr/local/bin exists in the virtual FS */
async function ensureBinDir(fs: any): Promise<void> {
  for (const dir of ['/usr', '/usr/local', PKG_BIN_DIR]) {
    try {
      await fs.stat(dir);
    } catch {
      await fs.mkdir(dir);
    }
  }
}

/** Write #!wasi-pkg stubs to /usr/local/bin for a package + its aliases */
async function writePathStubs(ctx: CommandContext, pkgName: string): Promise<void> {
  const pkg = findPackage(pkgName);
  if (!pkg) return;
  await ensureBinDir(ctx.fs);
  const stubContent = `#!wasi-pkg ${pkg.name}\n`;
  const names = [pkg.name, ...(pkg.aliases || [])];
  for (const cmdName of names) {
    await ctx.fs.writeFile(`${PKG_BIN_DIR}/${cmdName}`, stubContent);
  }
}

/** Remove #!wasi-pkg stubs from /usr/local/bin for a package + its aliases */
async function removePathStubs(ctx: CommandContext, pkgName: string): Promise<void> {
  const pkg = findPackage(pkgName);
  if (!pkg) return;
  const names = [pkg.name, ...(pkg.aliases || [])];
  for (const cmdName of names) {
    try {
      await ctx.fs.unlink(`${PKG_BIN_DIR}/${cmdName}`);
    } catch { /* ignore if not found */ }
  }
}

async function pkgInstall(ctx: CommandContext): Promise<number> {
  const name = ctx.args[1];
  if (!name) {
    ctx.stderr += 'pkg install: missing package name\n';
    return 1;
  }

  try {
    await downloadPackage(name, (msg) => {
      ctx.stdout += msg + '\n';
    });
    // Write PATH stubs so the command is found via PATH lookup
    await writePathStubs(ctx, name);
    return 0;
  } catch (e: any) {
    ctx.stderr += `pkg install: ${e.message}\n`;
    return 1;
  }
}

async function pkgSearch(ctx: CommandContext): Promise<number> {
  const query = ctx.args.slice(1).join(' ');
  if (!query) {
    ctx.stderr += 'pkg search: missing query\n';
    return 1;
  }

  const results = searchPackages(query);
  if (results.length === 0) {
    ctx.stdout += `No packages found matching '${query}'\n`;
    return 0;
  }

  for (const pkg of results) {
    const sizeStr = pkg.size > 1_000_000
      ? `${(pkg.size / 1_000_000).toFixed(1)}MB`
      : `${(pkg.size / 1_000).toFixed(0)}KB`;
    ctx.stdout += `  ${pkg.name.padEnd(16)} ${pkg.version.padEnd(8)} ${sizeStr.padEnd(8)} ${pkg.description}\n`;
  }
  return 0;
}

async function pkgList(ctx: CommandContext): Promise<number> {
  const installed = await listInstalled();
  if (installed.length === 0) {
    ctx.stdout += 'No packages installed.\n';
    ctx.stdout += 'Run \'pkg available\' to see available packages.\n';
    return 0;
  }

  ctx.stdout += 'Installed packages:\n';
  for (const pkg of installed) {
    const sizeStr = pkg.size > 1_000_000
      ? `${(pkg.size / 1_000_000).toFixed(1)}MB`
      : `${(pkg.size / 1_000).toFixed(0)}KB`;
    const date = new Date(pkg.installedAt).toLocaleDateString();
    ctx.stdout += `  ${pkg.name.padEnd(16)} ${pkg.version.padEnd(8)} ${sizeStr.padEnd(8)} installed ${date}\n`;
  }
  return 0;
}

async function pkgAvailable(ctx: CommandContext): Promise<number> {
  const all = listAvailable();
  const installed = await listInstalled();
  const installedNames = new Set(installed.map(p => p.name));

  ctx.stdout += 'Available WASM packages:\n\n';
  for (const pkg of all) {
    const sizeStr = pkg.size > 1_000_000
      ? `${(pkg.size / 1_000_000).toFixed(1)}MB`
      : `${(pkg.size / 1_000).toFixed(0)}KB`;
    const status = installedNames.has(pkg.name) ? ' [installed]' : '';
    ctx.stdout += `  ${pkg.name.padEnd(16)} ${pkg.version.padEnd(8)} ${sizeStr.padEnd(8)} ${pkg.description}${status}\n`;
  }
  ctx.stdout += `\n${all.length} packages available. Use 'pkg install <name>' to install.\n`;
  return 0;
}

async function pkgRemove(ctx: CommandContext): Promise<number> {
  const name = ctx.args[1];
  if (!name) {
    ctx.stderr += 'pkg remove: missing package name\n';
    return 1;
  }

  try {
    await removePathStubs(ctx, name);
    await removePackage(name);
    clearModuleCache(name);
    ctx.stdout += `Removed ${name}\n`;
    return 0;
  } catch (e: any) {
    ctx.stderr += `pkg remove: ${e.message}\n`;
    return 1;
  }
}

async function pkgInfo(ctx: CommandContext): Promise<number> {
  const name = ctx.args[1];
  if (!name) {
    ctx.stderr += 'pkg info: missing package name\n';
    return 1;
  }

  const pkg = findPackage(name);
  if (!pkg) {
    ctx.stderr += `pkg info: package '${name}' not found\n`;
    return 1;
  }

  const sizeStr = pkg.size > 1_000_000
    ? `${(pkg.size / 1_000_000).toFixed(1)}MB`
    : `${(pkg.size / 1_000).toFixed(0)}KB`;

  ctx.stdout += `Name:        ${pkg.name}\n`;
  ctx.stdout += `Version:     ${pkg.version}\n`;
  ctx.stdout += `Description: ${pkg.description}\n`;
  ctx.stdout += `Category:    ${pkg.category}\n`;
  ctx.stdout += `Size:        ${sizeStr}\n`;
  ctx.stdout += `URL:         ${pkg.url}\n`;
  if (pkg.aliases?.length) {
    ctx.stdout += `Aliases:     ${pkg.aliases.join(', ')}\n`;
  }
  return 0;
}

export const pkgCmd: Command = {
  name: 'pkg',
  description: 'WASM package manager',

  async exec(ctx: CommandContext): Promise<number> {
    const subcmd = ctx.args[0];

    if (!subcmd || subcmd === '--help' || subcmd === '-h') {
      ctx.stdout += 'Usage: pkg <command> [args]\n\n';
      ctx.stdout += 'Commands:\n';
      ctx.stdout += '  install <name>    Download and cache a WASM package\n';
      ctx.stdout += '  search <query>    Search available packages\n';
      ctx.stdout += '  list              Show installed packages\n';
      ctx.stdout += '  available         Show all available packages\n';
      ctx.stdout += '  remove <name>     Remove a cached package\n';
      ctx.stdout += '  info <name>       Show package details\n';
      return 0;
    }

    switch (subcmd) {
      case 'install':
      case 'i':
        return pkgInstall(ctx);
      case 'search':
      case 's':
        return pkgSearch(ctx);
      case 'list':
      case 'ls':
        return pkgList(ctx);
      case 'available':
      case 'avail':
        return pkgAvailable(ctx);
      case 'remove':
      case 'rm':
      case 'uninstall':
        return pkgRemove(ctx);
      case 'info':
        return pkgInfo(ctx);
      default:
        ctx.stderr += `pkg: unknown command '${subcmd}'\n`;
        ctx.stderr += 'Run \'pkg --help\' for usage.\n';
        return 1;
    }
  },
};
