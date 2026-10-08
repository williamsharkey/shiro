import { Command, CommandContext } from './index';
import {
  loadIndex, findEntry, searchIndex, installPackages, removePackage, readStatus, reverseDeps,
  packageStatus, missingFeatures, downloadSize, formatSize, parseIndex, resolveDeps,
  PKG_LISTS_DIR, PKG_SOURCES, PKG_ROOT, type PkgEntry,
} from '../pkg-manager';

/**
 * pkg — Shiro's package manager for prebuilt WebAssembly programs.
 * `apt` and `apt-get` are the same tool with apt's verbs.
 *
 *   pkg install [--force] [--reinstall] <name>...
 *   pkg remove <name>...
 *   pkg list [--all]          installed packages (--all: everything in the index)
 *   pkg search <query>
 *   pkg info <name>
 *   pkg files <name>          files an installed package owns
 *   pkg update                fetch the index lists named in /etc/pkg/sources.list
 *   pkg upgrade               reinstall packages whose index version changed
 */

const USAGE = `Usage: pkg <command> [args]

Commands:
  install <name>...   Download, verify (sha256) and install packages
  remove <name>...    Remove installed packages
  list [--all]        Installed packages; --all lists the whole index
  available           Every package with its status
  search <query>      Search names, descriptions and commands
  info <name>         Package details (version, license, source, files)
  files <name>        Files an installed package owns
  update              Fetch extra index lists from ${PKG_SOURCES}
  upgrade             Upgrade installed packages to the index versions

Options: --force (install despite missing kernel features), --reinstall, -y (ignored)
Packages install to ${PKG_ROOT}/<name>/ with commands linked into /usr/bin.
`;

const STATUS_LABEL = { ok: 'ok', partial: 'partial', blocked: 'needs kernel' } as const;

function splitArgs(args: string[]) {
  const flags = new Set(args.filter(a => a.startsWith('-')));
  const names = args.filter(a => !a.startsWith('-'));
  return { flags, names };
}

async function cmdInstall(ctx: CommandContext, args: string[]): Promise<number> {
  const { flags, names } = splitArgs(args);
  if (names.length === 0) {
    ctx.stderr += 'pkg install: missing package name\n';
    return 1;
  }
  const index = await loadIndex(ctx.fs);
  try {
    const plan = resolveDeps(index, names);
    const status = await readStatus(ctx.fs);
    const fresh = plan.filter(p => !status[p.name]);
    if (fresh.length) {
      ctx.stdout += `The following NEW packages will be installed:\n  ${fresh.map(p => p.name).join(' ')}\n`;
      ctx.stdout += `Need to get ${formatSize(fresh.reduce((n, p) => n + downloadSize(p), 0))} of archives.\n`;
    }
    await installPackages(ctx.fs, index, names, {
      force: flags.has('--force') || flags.has('-f'),
      reinstall: flags.has('--reinstall'),
      env: ctx.env,
      log: line => { ctx.stdout += line + '\n'; },
    });
    for (const p of plan) {
      const missing = missingFeatures(p, p.wants || []);
      if (missing.length && p.notes) ctx.stdout += `Note: ${p.name}: ${p.notes}\n`;
    }
    return 0;
  } catch (e: any) {
    ctx.stderr += `E: ${e.message}\n`;
    return 100;
  }
}

async function cmdRemove(ctx: CommandContext, args: string[]): Promise<number> {
  const { names } = splitArgs(args);
  if (names.length === 0) {
    ctx.stderr += 'pkg remove: missing package name\n';
    return 1;
  }
  let rc = 0;
  for (const name of names) {
    const users = await reverseDeps(ctx.fs, name);
    if (users.length) {
      ctx.stderr += `E: ${name} is needed by ${users.join(', ')}; remove those first\n`;
      rc = 100;
      continue;
    }
    if (await removePackage(ctx.fs, name)) {
      ctx.stdout += `Removing ${name} ...\n`;
    } else {
      ctx.stderr += `Package '${name}' is not installed, so not removed\n`;
    }
  }
  return rc;
}

function line(p: PkgEntry, extra = ''): string {
  return `  ${p.name.padEnd(13)} ${p.version.padEnd(9)} ${formatSize(downloadSize(p)).padEnd(8)} ${p.description}${extra}\n`;
}

async function cmdList(ctx: CommandContext, args: string[]): Promise<number> {
  if (args.includes('--all') || args.includes('-a')) return cmdAvailable(ctx);
  const status = Object.values(await readStatus(ctx.fs)).sort((a, b) => a.name.localeCompare(b.name));
  if (status.length === 0) {
    ctx.stdout += "No packages installed. Run 'pkg available' to see what can be.\n";
    return 0;
  }
  for (const p of status) {
    ctx.stdout += `  ${p.name.padEnd(13)} ${p.version.padEnd(9)} ${formatSize(p.size).padEnd(8)} ${p.bins.slice(0, 6).join(' ')}${p.bins.length > 6 ? ' …' : ''}\n`;
  }
  return 0;
}

async function cmdAvailable(ctx: CommandContext): Promise<number> {
  const index = await loadIndex(ctx.fs);
  const status = await readStatus(ctx.fs);
  for (const p of [...index.packages].sort((a, b) => a.name.localeCompare(b.name))) {
    const st = STATUS_LABEL[packageStatus(p)];
    ctx.stdout += line(p, `  [${st}${status[p.name] ? ', installed' : ''}]`);
  }
  ctx.stdout += `\n${index.packages.length} packages. 'pkg info <name>' for details, 'pkg install <name>' to install.\n`;
  return 0;
}

async function cmdSearch(ctx: CommandContext, args: string[]): Promise<number> {
  const query = args.filter(a => !a.startsWith('-')).join(' ');
  if (!query) {
    ctx.stderr += 'pkg search: missing query\n';
    return 1;
  }
  const results = searchIndex(await loadIndex(ctx.fs), query);
  if (results.length === 0) {
    ctx.stdout += `No packages found matching '${query}'\n`;
    return 0;
  }
  for (const p of results) ctx.stdout += line(p, packageStatus(p) === 'blocked' ? '  [needs kernel]' : '');
  return 0;
}

async function cmdInfo(ctx: CommandContext, args: string[]): Promise<number> {
  const name = args.find(a => !a.startsWith('-'));
  if (!name) {
    ctx.stderr += 'pkg info: missing package name\n';
    return 1;
  }
  const p = findEntry(await loadIndex(ctx.fs), name);
  if (!p) {
    ctx.stderr += `pkg info: package '${name}' not found\n`;
    return 1;
  }
  const installed = (await readStatus(ctx.fs))[p.name];
  const st = packageStatus(p);
  const out = [
    `Package:     ${p.name}`,
    `Version:     ${p.version}${installed ? `  (installed${installed.version !== p.version ? ` ${installed.version}` : ''})` : ''}`,
    `Description: ${p.description}`,
    `Section:     ${p.section}`,
    `License:     ${p.license}`,
    `Source:      ${p.source}`,
    ...(p.homepage ? [`Homepage:    ${p.homepage}`] : []),
    `Origin:      ${p.origin === 'shiro' ? `built by Shiro (${p.recipe})` : 'Wasmer registry'}`,
    `ABI:         ${p.abi}`,
    `Download:    ${formatSize(downloadSize(p))}`,
    `Commands:    ${Object.keys(p.bin).join(', ')}`,
    ...(p.deps?.length ? [`Depends:     ${p.deps.join(', ')}`] : []),
    `Status:      ${STATUS_LABEL[st]}` +
      (st === 'blocked' ? ` (missing: ${missingFeatures(p).join(', ')})` :
        st === 'partial' ? ` (without: ${missingFeatures(p, p.wants).join(', ')})` : ''),
    ...(p.notes ? [`Notes:       ${p.notes}`] : []),
    'Files:',
    ...p.files.map(f => `  ${f.path}  sha256:${f.sha256.slice(0, 16)}…  ${f.url}${f.webc ? ` (${f.webc.atom ? `atom ${f.webc.atom}` : `volume ${f.webc.volume}:${f.webc.dir}`})` : ''}`),
  ];
  ctx.stdout += out.join('\n') + '\n';
  return 0;
}

async function cmdFiles(ctx: CommandContext, args: string[]): Promise<number> {
  const name = args.find(a => !a.startsWith('-'));
  const pkg = name ? (await readStatus(ctx.fs))[name] : undefined;
  if (!pkg) {
    ctx.stderr += `pkg files: package '${name ?? ''}' is not installed\n`;
    return 1;
  }
  const walk = async (dir: string): Promise<void> => {
    for (const e of (await ctx.fs.readdir(dir)).sort()) {
      const p = `${dir}/${e}`;
      const st = await ctx.fs.lstat(p);
      if (st.type === 'dir') await walk(p);
      else ctx.stdout += p + '\n';
    }
  };
  await walk(`${PKG_ROOT}/${pkg.name}`);
  for (const b of pkg.bins) ctx.stdout += `/usr/bin/${b}\n`;
  return 0;
}

async function cmdUpdate(ctx: CommandContext): Promise<number> {
  let sources: string[] = [];
  try {
    sources = (await ctx.fs.readFile(PKG_SOURCES, 'utf8') as string)
      .split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  } catch { /* no extra sources */ }
  const builtin = (await loadIndex(ctx.fs)).packages.length;
  ctx.stdout += `Built-in index: ${builtin} packages\n`;
  if (sources.length === 0) {
    ctx.stdout += `No extra sources (add index URLs to ${PKG_SOURCES}).\n`;
    return 0;
  }
  await ctx.fs.mkdir(PKG_LISTS_DIR, { recursive: true });
  let rc = 0;
  for (const [i, url] of sources.entries()) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText || ''}`.trim());
      const idx = parseIndex(await resp.json());
      const file = `${PKG_LISTS_DIR}/${String(i).padStart(2, '0')}-${url.replace(/[^a-zA-Z0-9.]+/g, '_').slice(-60)}.json`;
      await ctx.fs.writeFile(file, JSON.stringify(idx));
      ctx.stdout += `Get:${i + 1} ${url} [${idx.packages.length} packages]\n`;
    } catch (e: any) {
      ctx.stderr += `Err:${i + 1} ${url}: ${e.message}\n`;
      rc = 100;
    }
  }
  return rc;
}

async function cmdUpgrade(ctx: CommandContext, args: string[]): Promise<number> {
  const index = await loadIndex(ctx.fs);
  const status = await readStatus(ctx.fs);
  const stale = Object.values(status).filter(p => {
    const e = findEntry(index, p.name);
    return e && e.name === p.name && e.version !== p.version;
  }).map(p => p.name);
  if (stale.length === 0) {
    ctx.stdout += 'All packages are up to date.\n';
    return 0;
  }
  return cmdInstall(ctx, [...args.filter(a => a.startsWith('-')), ...stale]);
}

async function dispatch(ctx: CommandContext, tool: string, sub: string | undefined, rest: string[]): Promise<number> {
  switch (sub) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      ctx.stdout += tool === 'pkg' ? USAGE : USAGE.replace(/^Usage: pkg/, `Usage: ${tool}`);
      return 0;
    case 'install':
    case 'i':
    case 'add':
      return cmdInstall(ctx, rest);
    case 'reinstall':
      return cmdInstall(ctx, ['--reinstall', ...rest]);
    case 'remove':
    case 'rm':
    case 'uninstall':
    case 'purge':
    case 'del':
      return cmdRemove(ctx, rest);
    case 'list':
    case 'ls':
      return cmdList(ctx, tool === 'pkg' ? rest : (rest.includes('--installed') ? [] : ['--all']));
    case 'available':
    case 'avail':
      return cmdAvailable(ctx);
    case 'search':
    case 's':
      return cmdSearch(ctx, rest);
    case 'info':
    case 'show':
      return cmdInfo(ctx, rest);
    case 'files':
      return cmdFiles(ctx, rest);
    case 'update':
      return cmdUpdate(ctx);
    case 'upgrade':
    case 'dist-upgrade':
    case 'full-upgrade':
      return cmdUpgrade(ctx, rest);
    case 'autoremove':
    case 'clean':
    case 'autoclean':
      return 0;
    default:
      ctx.stderr += `${tool}: unknown command '${sub}'\nRun '${tool} --help' for usage.\n`;
      return 1;
  }
}

export const pkgCmd: Command = {
  name: 'pkg',
  description: 'Package manager for WebAssembly programs (also apt, apt-get)',
  exec(ctx) {
    return dispatch(ctx, 'pkg', ctx.args[0], ctx.args.slice(1));
  },
};

export const aptCmd: Command = {
  name: 'apt',
  description: 'Package manager (same as pkg)',
  exec(ctx) {
    const args = ctx.args.filter(a => a !== '-y' && a !== '--yes' && a !== '-q');
    return dispatch(ctx, 'apt', args[0], args.slice(1));
  },
};

export const aptGetCmd: Command = { ...aptCmd, name: 'apt-get', description: 'Package manager (same as pkg)' };
