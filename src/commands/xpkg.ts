import { Command, CommandContext } from './index';
import {
  searchX86Packages,
  listX86Available,
  listX86Installed,
  downloadX86Package,
  removeX86Package,
  findX86Package,
  clearX86Cache,
} from '../x86-packages';

/**
 * xpkg — Binary (x86-64 ELF) package manager for Shiro
 *
 * Usage:
 *   xpkg install <name>    Download and cache an x86-64 ELF binary
 *   xpkg search <query>    Search available packages
 *   xpkg list              Show installed packages
 *   xpkg available         Show all available packages
 *   xpkg remove <name>     Remove a cached package
 *   xpkg info <name>       Show package details
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

/** Write #!x86-pkg stubs to /usr/local/bin for a package + its aliases/applets */
async function writePathStubs(ctx: CommandContext, pkgName: string): Promise<void> {
  const pkg = findX86Package(pkgName);
  if (!pkg) return;
  await ensureBinDir(ctx.fs);

  // Main binary stub
  const stubContent = `#!x86-pkg ${pkg.name}\n`;
  await ctx.fs.writeFile(`${PKG_BIN_DIR}/${pkg.name}`, stubContent);

  // Alias stubs
  const aliases = pkg.aliases || [];
  for (const alias of aliases) {
    await ctx.fs.writeFile(`${PKG_BIN_DIR}/${alias}`, stubContent);
  }

  // For multi-call binaries (busybox): write stubs for all applets
  if (pkg.applets) {
    for (const applet of pkg.applets) {
      // Applet stub uses the applet name as argv[0] so busybox knows which command
      const appletStub = `#!x86-pkg ${pkg.name} ${applet}\n`;
      await ctx.fs.writeFile(`${PKG_BIN_DIR}/${applet}`, appletStub);
    }
  }
}

/** Remove #!x86-pkg stubs from /usr/local/bin for a package + aliases/applets */
async function removePathStubs(ctx: CommandContext, pkgName: string): Promise<void> {
  const pkg = findX86Package(pkgName);
  if (!pkg) return;
  const names = [pkg.name, ...(pkg.aliases || []), ...(pkg.applets || [])];
  for (const cmdName of names) {
    try {
      await ctx.fs.unlink(`${PKG_BIN_DIR}/${cmdName}`);
    } catch { /* ignore if not found */ }
  }
}

async function xpkgInstall(ctx: CommandContext): Promise<number> {
  const name = ctx.args[1];
  if (!name) {
    ctx.stderr += 'xpkg install: missing package name\n';
    return 1;
  }

  try {
    await downloadX86Package(name, (msg) => {
      ctx.stdout += msg + '\n';
    });
    await writePathStubs(ctx, name);
    const pkg = findX86Package(name);
    if (pkg?.applets) {
      ctx.stdout += `Installed ${pkg.applets.length} applet stubs in ${PKG_BIN_DIR}\n`;
    }

    // Special handling: python3 stdlib setup
    if (name === 'python3') {
      await setupPythonStdlib(ctx);
    }

    return 0;
  } catch (e: any) {
    ctx.stderr += `xpkg install: ${e.message}\n`;
    return 1;
  }
}

/** Create minimal Python stdlib directories for CPython */
async function setupPythonStdlib(ctx: CommandContext): Promise<void> {
  const fs = ctx.fs;
  const libDirs = [
    '/usr', '/usr/lib', '/usr/lib/python3.12',
    '/usr/lib/python3.12/lib-dynload',
    '/usr/lib/python3.12/encodings',
  ];
  for (const dir of libDirs) {
    try { await fs.mkdir(dir); } catch {}
  }

  // Write minimal site.py and encodings/__init__.py so CPython can bootstrap
  await fs.writeFile('/usr/lib/python3.12/site.py', '# Minimal site.py for Shiro\n');
  await fs.writeFile('/usr/lib/python3.12/encodings/__init__.py',
    '# encodings package stub\nimport codecs\ndef search_function(name):\n    return None\ncodecs.register(search_function)\n');
  await fs.writeFile('/usr/lib/python3.12/encodings/utf_8.py',
    'import codecs\ncodec_info = codecs.lookup("utf-8")\n');
  await fs.writeFile('/usr/lib/python3.12/encodings/aliases.py', 'aliases = {}\n');

  ctx.stdout += 'Python 3.12 stdlib initialized in /usr/lib/python3.12/\n';
}

async function xpkgSearch(ctx: CommandContext): Promise<number> {
  const query = ctx.args.slice(1).join(' ');
  if (!query) {
    ctx.stderr += 'xpkg search: missing query\n';
    return 1;
  }

  const results = searchX86Packages(query);
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

async function xpkgList(ctx: CommandContext): Promise<number> {
  const installed = await listX86Installed();
  if (installed.length === 0) {
    ctx.stdout += 'No x86 packages installed.\n';
    ctx.stdout += 'Run \'xpkg available\' to see available packages.\n';
    return 0;
  }

  ctx.stdout += 'Installed x86-64 packages:\n';
  for (const pkg of installed) {
    const sizeStr = pkg.size > 1_000_000
      ? `${(pkg.size / 1_000_000).toFixed(1)}MB`
      : `${(pkg.size / 1_000).toFixed(0)}KB`;
    const date = new Date(pkg.installedAt).toLocaleDateString();
    ctx.stdout += `  ${pkg.name.padEnd(16)} ${pkg.version.padEnd(8)} ${sizeStr.padEnd(8)} installed ${date}\n`;
  }
  return 0;
}

async function xpkgAvailable(ctx: CommandContext): Promise<number> {
  const all = listX86Available();
  const installed = await listX86Installed();
  const installedNames = new Set(installed.map(p => p.name));

  ctx.stdout += 'Available x86-64 ELF packages:\n\n';
  for (const pkg of all) {
    const sizeStr = pkg.size > 1_000_000
      ? `${(pkg.size / 1_000_000).toFixed(1)}MB`
      : `${(pkg.size / 1_000).toFixed(0)}KB`;
    const status = installedNames.has(pkg.name) ? ' [installed]' : '';
    ctx.stdout += `  ${pkg.name.padEnd(16)} ${pkg.version.padEnd(8)} ${sizeStr.padEnd(8)} ${pkg.description}${status}\n`;
  }
  ctx.stdout += `\n${all.length} packages available. Use 'xpkg install <name>' to install.\n`;
  return 0;
}

async function xpkgRemove(ctx: CommandContext): Promise<number> {
  const name = ctx.args[1];
  if (!name) {
    ctx.stderr += 'xpkg remove: missing package name\n';
    return 1;
  }

  try {
    await removePathStubs(ctx, name);
    await removeX86Package(name);
    clearX86Cache(name);
    ctx.stdout += `Removed ${name}\n`;
    return 0;
  } catch (e: any) {
    ctx.stderr += `xpkg remove: ${e.message}\n`;
    return 1;
  }
}

async function xpkgInfo(ctx: CommandContext): Promise<number> {
  const name = ctx.args[1];
  if (!name) {
    ctx.stderr += 'xpkg info: missing package name\n';
    return 1;
  }

  const pkg = findX86Package(name);
  if (!pkg) {
    ctx.stderr += `xpkg info: package '${name}' not found\n`;
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
  ctx.stdout += `Arch:        x86-64 (musl-static)\n`;
  if (pkg.aliases?.length) {
    ctx.stdout += `Aliases:     ${pkg.aliases.join(', ')}\n`;
  }
  if (pkg.applets?.length) {
    ctx.stdout += `Applets:     ${pkg.applets.length} (${pkg.applets.slice(0, 10).join(', ')}${pkg.applets.length > 10 ? '...' : ''})\n`;
  }
  return 0;
}

export const xpkgCmd: Command = {
  name: 'xpkg',
  description: 'Binary (x86-64) package manager',

  async exec(ctx: CommandContext): Promise<number> {
    const subcmd = ctx.args[0];

    if (!subcmd || subcmd === '--help' || subcmd === '-h') {
      ctx.stdout += 'Usage: xpkg <command> [args]\n\n';
      ctx.stdout += 'Commands:\n';
      ctx.stdout += '  install <name>    Download and cache an x86-64 ELF binary\n';
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
        return xpkgInstall(ctx);
      case 'search':
      case 's':
        return xpkgSearch(ctx);
      case 'list':
      case 'ls':
        return xpkgList(ctx);
      case 'available':
      case 'avail':
        return xpkgAvailable(ctx);
      case 'remove':
      case 'rm':
      case 'uninstall':
        return xpkgRemove(ctx);
      case 'info':
        return xpkgInfo(ctx);
      default:
        ctx.stderr += `xpkg: unknown command '${subcmd}'\n`;
        ctx.stderr += 'Run \'xpkg --help\' for usage.\n';
        return 1;
    }
  },
};
