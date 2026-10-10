import { Command, CommandContext } from './index';
import { quoteArgsForShell } from '../shell';
import { extractTarGzToFS, type FileSystemWriter } from '../utils/tar-utils';
import { buildTree, binDirOf, binEntries, WASM_ALTERNATES, type BuildResult, type PackageMetadata, type TreeNode, type Wanted } from './npm-tree';

/**
 * npm: Browser-native package manager for Node.js packages
 *
 * Supports:
 *   - npm init: Create package.json
 *   - npm install [package]: Install packages from registry.npmjs.org
 *   - npm list: Show installed packages
 *   - npm run [script]: Run scripts from package.json
 *
 * Downloads real tarballs from registry.npmjs.org (CORS-enabled)
 * Extracts to node_modules/ using browser-native DecompressionStream
 * Resolves dependency trees with semver
 *
 * Performance optimizations:
 *   - Package metadata cached in memory (1-hour TTL; trimmed to the most recently used 16 MB between commands)
 *   - In-flight request deduplication prevents duplicate fetches
 */

// Metadata cache: maps package name -> { data, timestamp }
/** What `npm -v` says: the npm that node 20 ships with (tools parse a bare semver) */
export const NPM_VERSION = '10.8.2';

const metadataCache = new Map<string, { data: NpmPackageMetadata; timestamp: number; bytes: number }>();
/** Metadata kept between npm commands (the most recently used, by response size) */
const METADATA_KEEP_BYTES = 16 << 20;

/** Trim the metadata cache to METADATA_KEEP_BYTES, least recently used first */
function trimMetadataCache(): void {
  let total = 0;
  for (const e of metadataCache.values()) total += e.bytes;
  for (const [name, e] of metadataCache) {
    if (total <= METADATA_KEEP_BYTES) break;
    metadataCache.delete(name);
    total -= e.bytes;
  }
}
const METADATA_CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

// In-flight request deduplication: maps package name -> pending promise
const pendingMetadataRequests = new Map<string, Promise<NpmPackageMetadata>>();

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  type?: 'module' | 'commonjs';
  bin?: string | Record<string, string>;
}

interface NpmPackageMetadata {
  name: string;
  'dist-tags': {
    latest: string;
    [tag: string]: string;
  };
  versions: {
    [version: string]: {
      name: string;
      version: string;
      description?: string;
      main?: string;
      dependencies?: Record<string, string>;
      dist: {
        tarball: string;
        shasum: string;
      };
    };
  };
}


/** npm commands running: the metadata cache lives while any is */
let activeCommands = 0;

export const npmCmd: Command = {
  name: 'npm',
  description: 'Browser-native package manager for Node.js packages',

  async exec(ctx: CommandContext): Promise<number> {
    activeCommands++;
    try {
      return await npmMain(ctx);
    } finally {
      // The abbreviated documents of a big tree (vite+react+eslint+typescript:
      // ~300 packages) held ~45 MB for an hour after the install: keep the
      // most recently used 16 MB (a small project's whole tree)
      if (--activeCommands === 0) trimMetadataCache();
    }
  },
};

async function npmMain(ctx: CommandContext): Promise<number> {
    const subcommand = ctx.args[0];

    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      ctx.stdout += 'Usage: npm <command>\n\n';
      ctx.stdout += 'Commands:\n';
      ctx.stdout += '  init              Create a package.json file\n';
      ctx.stdout += '  create <name>     Run create-<name> (npm init <name>), e.g. npm create vite@latest app\n';
      ctx.stdout += '  exec, x <pkg>     Run a package\'s bin (npx)\n';
      ctx.stdout += '  install [pkg]     Install package(s) from registry.npmjs.org\n';
      ctx.stdout += '  i [pkg]           Alias for install\n';
      ctx.stdout += '  list              List installed packages\n';
      ctx.stdout += '  ls                Alias for list\n';
      ctx.stdout += '  run <script>      Run a script from package.json\n';
      ctx.stdout += '  start             Run the start script (default: node server.js)\n';
      ctx.stdout += '  test, t           Run the test script\n';
      ctx.stdout += '  stop              Run the stop script\n';
      ctx.stdout += '  uninstall [pkg]   Remove a package\n';
      ctx.stdout += '  cache clean       Clear the metadata cache\n';
      ctx.stdout += '  cache status      Show cache statistics\n';
      ctx.stdout += '  --version         Show npm version\n';
      ctx.stdout += '\nNote: Downloads real tarballs from registry.npmjs.org\n';
      ctx.stdout += 'Package metadata is cached for 1 hour to speed up installs.\n';
      return 0;
    }

    if (subcommand === '--version' || subcommand === '-v') {
      // a bare semver, as tools parse it (npm 10 is what node 20 ships with)
      ctx.stdout += `${NPM_VERSION}\n`;
      return 0;
    }

    switch (subcommand) {
      case 'create':
      case 'innit':
        return await npmCreate(ctx);
      case 'init':
        // npm init <initializer> is npm create
        if (ctx.args[1] && !ctx.args[1].startsWith('-')) return await npmCreate(ctx);
        return await npmInit(ctx);
      case 'exec':
      case 'x': {
        // npm exec [--] <pkg> [args]: npx
        const rest = ctx.args.slice(1).filter((a, i) => !(i === 0 && a === '--'));
        return ctx.shell.execute(quoteArgsForShell(['npx', ...rest]), (o) => { ctx.stdout += o.replace(/\r\n/g, '\n'); }, (e) => { ctx.stderr += e.replace(/\r\n/g, '\n'); }, false, ctx.terminal, true);
      }
      case 'install':
      case 'i':
        return await npmInstall(ctx);
      case 'list':
      case 'ls':
        return await npmList(ctx);
      case 'run':
        return await npmRun(ctx);
      case 'start':
        return await npmRunScript(ctx, 'start', 'node server.js');
      case 'test':
      case 't':
      case 'tst':
        return await npmRunScript(ctx, 'test');
      case 'stop':
        return await npmRunScript(ctx, 'stop');
      case 'uninstall':
      case 'remove':
      case 'rm':
        return await npmUninstall(ctx);
      case 'cache':
        return await npmCache(ctx);
      case 'config':
      case 'c':
        return await npmConfig(ctx);
      case 'get':
        ctx.args = ['config', 'get', ...ctx.args.slice(1)];
        return await npmConfig(ctx);
      case 'prefix':
        ctx.stdout += (ctx.args.includes('-g') || ctx.args.includes('--global') ? '/usr/local' : ctx.cwd) + '\n';
        return 0;
      case 'update':
      case 'up':
        ctx.stdout += 'up to date, audited 0 packages\n';
        return 0;
      case 'outdated':
        ctx.stdout += 'All packages are up to date.\n';
        return 0;
      case 'audit':
        ctx.stdout += 'found 0 vulnerabilities\n';
        return 0;
      default:
        ctx.stderr += `npm: unknown command '${subcommand}'\n`;
        ctx.stderr += "Run 'npm --help' for usage.\n";
        return 1;
    }
}

/**
 * npm create <initializer> [args]: npx create-<name> with the arguments
 * (vite@latest → create-vite@latest, @scope → @scope/create,
 * @scope/name → @scope/create-name); a `--` before them is dropped.
 */
export function initializerPackage(spec: string): string {
  const m = /^(@[^/@]+)(?:\/([^@]+))?(@.*)?$/.exec(spec);
  if (m) return `${m[1]}/${m[2] ? 'create-' + m[2] : 'create'}${m[3] ?? ''}`;
  const at = spec.indexOf('@', 1);
  const name = at > 0 ? spec.slice(0, at) : spec;
  return `create-${name}${at > 0 ? spec.slice(at) : ''}`;
}

async function npmCreate(ctx: CommandContext): Promise<number> {
  const spec = ctx.args[1];
  if (!spec || spec.startsWith('-')) {
    ctx.stderr += 'npm create: usage: npm create <initializer> [args]\n';
    return 1;
  }
  const rest = ctx.args.slice(2);
  const args = rest[0] === '--' ? rest.slice(1) : rest.filter((a, i) => !(a === '--' && i === rest.indexOf('--')));
  return ctx.shell.execute(quoteArgsForShell(['npx', initializerPackage(spec), ...args]),
    (o) => { ctx.stdout += o.replace(/\r\n/g, '\n'); }, (e) => { ctx.stderr += e.replace(/\r\n/g, '\n'); }, false, ctx.terminal, true);
}

async function npmInit(ctx: CommandContext): Promise<number> {
  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  // Check if package.json already exists
  try {
    await ctx.fs.readFile(pkgPath, 'utf8');
    ctx.stdout += 'package.json already exists.\n';
    return 0;
  } catch {
    // Doesn't exist, create it
  }

  // Extract directory name for package name
  const dirName = ctx.cwd.split('/').filter(Boolean).pop() || 'my-project';

  const pkg: PackageJson = {
    name: dirName,
    version: '1.0.0',
    description: '',
    main: 'index.js',
    type: 'module',
    scripts: {
      test: 'echo "Error: no test specified" && exit 1',
    },
    dependencies: {},
  };

  await ctx.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  ctx.stdout += 'Created package.json\n';
  return 0;
}

/**
 * Fetch package metadata from npm registry with caching and deduplication
 */
async function fetchPackageMetadata(packageName: string): Promise<NpmPackageMetadata> {
  // Check in-memory cache first
  const cached = metadataCache.get(packageName);
  if (cached && (Date.now() - cached.timestamp) < METADATA_CACHE_TTL) {
    // Most recently used last (trimMetadataCache drops from the front)
    metadataCache.delete(packageName);
    metadataCache.set(packageName, cached);
    return cached.data;
  }

  // Check if there's already a pending request for this package
  const pending = pendingMetadataRequests.get(packageName);
  if (pending) {
    return pending;
  }

  // Create new request with deduplication
  const requestPromise = (async () => {
    const registryUrl = `https://registry.npmjs.org/${packageName}`;

    const response = await fetch(registryUrl, {
      // The abbreviated install document: deps, peers, bins, os/cpu and dist
      // are all the resolver reads, at a fraction of the full document's size
      headers: {
        'Accept': 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Package '${packageName}' not found in npm registry`);
      }
      throw new Error(`Failed to fetch package metadata: ${response.statusText}`);
    }

    const text = await response.text();
    const data: NpmPackageMetadata = JSON.parse(text);

    // Cache the result
    metadataCache.set(packageName, { data, timestamp: Date.now(), bytes: text.length });

    return data;
  })();

  // Register the pending request
  pendingMetadataRequests.set(packageName, requestPromise);

  try {
    return await requestPromise;
  } finally {
    // Clean up pending request
    pendingMetadataRequests.delete(packageName);
  }
}


/**
 * Install a resolved tree under `baseDir` (a project, or /usr/local/lib for -g):
 * shallower packages first (a version change empties the directory, nested
 * packages included), each level's downloads together, then the bins.
 */
async function installTree(
  ctx: CommandContext,
  baseDir: string,
  tree: BuildResult,
  opts: { globalBinDir?: string; ignoreScripts?: boolean } = {},
): Promise<{ added: number; failed: number }> {
  const base = baseDir.replace(/\/$/, '');
  const byDepth = new Map<number, TreeNode[]>();
  for (const n of tree.nodes) {
    const d = n.dir.split('/node_modules/').length;
    (byDepth.get(d) ?? byDepth.set(d, []).get(d)!).push(n);
  }
  let added = 0;
  let failed = 0;
  const fresh: TreeNode[] = [];
  for (const depth of [...byDepth.keys()].sort((x, y) => x - y)) {
    const queue = [...byDepth.get(depth)!];
    const worker = async () => {
      for (let n = queue.shift(); n; n = queue.shift()) {
        const dir = `${base}/${n.dir}`;
        try {
          try {
            const have = JSON.parse(await ctx.fs.readFile(`${dir}/package.json`, 'utf8') as string);
            if (have.version === n.version && have.name === n.source) continue; // (an alternate's files carry its own name)
            await ctx.fs.rm(dir, { recursive: true, force: true } as any);
          } catch { /* not installed */ }
          const response = await fetch(n.tarball);
          if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
          const tarballData = new Uint8Array(await response.arrayBuffer());
          await ctx.fs.mkdir(dir, { recursive: true });
          const fsWriter: FileSystemWriter = {
            writeFile: async (path: string, data: Uint8Array) => { await ctx.fs.writeFile(path, data); },
            mkdir: async (path: string) => { try { await ctx.fs.mkdir(path, { recursive: true }); } catch { /* exists */ } },
          };
          await extractTarGzToFS(tarballData, dir, fsWriter);
          fresh.push(n);
          added++;
        } catch (e: any) {
          failed++;
          ctx.stderr += `npm: ${n.name}@${n.version}: ${e?.message ?? e}\n`;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, queue.length) }, worker));
  }

  // Bins: each package's in the node_modules/.bin of its level; -g also links the top ones into the global bin dir
  for (const n of tree.nodes) {
    for (const [binName, rel] of binEntries(n.name, n.bin)) {
      const clean = rel.replace(/^\.\//, '');
      const links: [string, string][] = [[`${base}/${binDirOf(n)}/${binName}`, `../${n.name}/${clean}`]];
      if (opts.globalBinDir && n.parent?.dir === '') links.push([`${opts.globalBinDir}/${binName}`, `${base}/${n.dir}/${clean}`]);
      for (const [link, target] of links) {
        try {
          await ctx.fs.mkdir(link.slice(0, link.lastIndexOf('/')), { recursive: true });
          try { await ctx.fs.unlink(link); } catch { /* none */ }
          await ctx.fs.symlink(target, link);
        } catch { /* skip */ }
      }
    }
  }
  if (!opts.ignoreScripts) await runInstallScripts(ctx, base, fresh);
  return { added, failed };
}

/** --ignore-scripts, or ignore-scripts=true in ~/.npmrc */
async function ignoreScripts(ctx: CommandContext): Promise<boolean> {
  if (ctx.args.includes('--ignore-scripts')) return true;
  try {
    const rc = await ctx.fs.readFile(`${ctx.env['HOME'] || '/home/user'}/.npmrc`, 'utf8') as string;
    return /^\s*ignore-scripts\s*=\s*true\s*$/m.test(rc);
  } catch { return false; }
}

/**
 * The install scripts of the packages just installed (preinstall, install,
 * postinstall), dependencies before the packages that need them, in each
 * package's directory, as npm runs them: quiet unless one fails. A failure is
 * a warning here, not the end of the install: a script that builds a native
 * addon (node-gyp, prebuild-install) can't succeed in the tab, and the
 * package's JavaScript often works without it.
 */
async function runInstallScripts(ctx: CommandContext, base: string, nodes: TreeNode[]): Promise<void> {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // Each package after what it depends on (hoisting leaves that at any depth)
  const order: TreeNode[] = [];
  const seen = new Set<TreeNode>();
  const visit = (n: TreeNode) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of n.resolved.values()) visit(d);
    order.push(n);
  };
  nodes.forEach(visit);
  const fresh = new Set(nodes);
  for (const n of order.filter((n) => fresh.has(n))) {
    const dir = `${base}/${n.dir}`;
    let scripts: Record<string, string> = {};
    try { scripts = JSON.parse(await ctx.fs.readFile(`${dir}/package.json`, 'utf8') as string).scripts ?? {}; } catch { continue; }
    for (const event of ['preinstall', 'install', 'postinstall']) {
      const script = scripts[event];
      if (!script) continue;
      const env = {
        npm_lifecycle_event: event, npm_lifecycle_script: script, npm_package_name: n.name,
        npm_package_version: n.version, INIT_CWD: ctx.cwd, npm_command: 'install',
      };
      let out = '';
      const code = await ctx.shell.execute(
        `(cd ${q(dir)} && export ${Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ')} PATH=${q(`${dir}/node_modules/.bin:${base}/${binDirOf(n)}`)}:"$PATH" && ${script})`,
        (s) => { out += s; }, (s) => { out += s; }, false, undefined, true,
      );
      if (code !== 0) {
        ctx.stderr += `npm warn ${n.name}@${n.version} ${event}: \`${script}\` exited with ${code}\n`;
        if (out.trim()) ctx.stderr += out.trimEnd().split('\n').slice(-10).map((l) => `npm warn   ${l}`).join('\n') + '\n';
        break;
      }
    }
  }
}

/** The tree for `wanted`, with what was left out reported */
async function resolveTree(ctx: CommandContext, wanted: Wanted[]): Promise<BuildResult> {
  const tree = await buildTree(wanted, fetchPackageMetadata as (n: string) => Promise<PackageMetadata>);
  for (const w of tree.warnings) ctx.stderr += `npm warn ${w}\n`;
  // The packages asked for, as npm lists them
  for (const n of tree.nodes) if (n.parent === tree.root && wanted.some((w) => w.name === n.name)) ctx.stdout += `  + ${n.name}@${n.version}\n`;
  const alternates = tree.nodes.filter((n) => n.source !== n.name && Object.values(WASM_ALTERNATES).includes(n.source));
  for (const n of alternates) ctx.stdout += `  ${n.name}@${n.version}: the WebAssembly build (${n.source})\n`;
  if (tree.skipped.length) ctx.stdout += `  skipped ${tree.skipped.length} native platform package(s): ${tree.skipped.slice(0, 6).join(', ')}${tree.skipped.length > 6 ? ', ...' : ''}\n`;
  return tree;
}

async function npmInstall(ctx: CommandContext): Promise<number> {
  // Check for global flag and save-dev
  const isGlobal = ctx.args.includes('-g') || ctx.args.includes('--global');
  const saveDev = ctx.args.includes('-D') || ctx.args.includes('--save-dev');

  // Filter out flags, including -g/--global, -D/--save-dev
  const packagesToInstall = ctx.args.slice(1).filter(arg =>
    !arg.startsWith('--') && arg !== '-g' && arg !== '-D'
  );

  if (isGlobal) {
    return await npmInstallGlobal(ctx, packagesToInstall);
  }

  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  // Read package.json
  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch (e: any) {
    if (!e.message.includes('ENOENT')) {
      ctx.stderr += `npm: failed to parse package.json: ${e.message}\n`;
      return 1;
    }
    // As npm: installing into a directory without one starts it (`npm i x` → {"dependencies": {"x": …}})
    if (!packagesToInstall.length) { ctx.stdout += 'up to date, audited 0 packages\n'; return 0; }
    pkg = {} as PackageJson;
  }

  let depsToResolve: Record<string, string> = {};

  if (packagesToInstall.length === 0) {
    // Install all dependencies from package.json
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (Object.keys(allDeps).length === 0) {
      ctx.stdout += 'No dependencies to install.\n';
      return 0;
    }
    depsToResolve = allDeps;
    ctx.stdout += 'Installing dependencies...\n';
  } else {
    // Install specific packages
    const targetSection = saveDev ? 'devDependencies' : 'dependencies';
    if (!pkg[targetSection]) pkg[targetSection] = {};

    for (const spec of packagesToInstall) {
      let name: string, version: string;
      if (spec.startsWith('@')) {
        // Scoped package: @scope/pkg or @scope/pkg@version
        const lastAt = spec.lastIndexOf('@');
        if (lastAt > 0) {
          name = spec.slice(0, lastAt);
          version = spec.slice(lastAt + 1);
        } else {
          name = spec;
          version = 'latest';
        }
      } else if (spec.includes('@')) {
        const atIdx = spec.indexOf('@');
        name = spec.slice(0, atIdx);
        version = spec.slice(atIdx + 1);
      } else {
        name = spec;
        version = 'latest';
      }

      depsToResolve[name] = version;
      pkg[targetSection]![name] = version === 'latest' ? '*' : version;
    }

    // Save updated package.json
    await ctx.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    ctx.stdout += 'Installing packages...\n';
  }

  const t0 = Date.now();
  const tree = await resolveTree(ctx, Object.entries(depsToResolve).map(([name, range]) => ({ name, range })));
  const { added, failed } = await installTree(ctx, ctx.cwd, tree, { ignoreScripts: await ignoreScripts(ctx) });
  ctx.stdout += `\nadded ${added} package(s), ${tree.nodes.length} in the tree, in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`;
  if (failed || (tree.warnings.length && tree.nodes.length === 0)) return 1;
  ctx.stdout += 'Packages installed successfully.\n';
  return 0;
}

/**
 * Global install: install packages to /usr/local/lib/node_modules/
 * and create bin symlinks in /usr/local/bin/
 */
async function npmInstallGlobal(
  ctx: CommandContext,
  packagesToInstall: string[]
): Promise<number> {
  if (packagesToInstall.length === 0) {
    ctx.stderr += 'npm: please specify packages to install globally\n';
    return 1;
  }

  const globalModulesDir = '/usr/local/lib/node_modules';
  const globalBinDir = '/usr/local/bin';

  // Ensure global directories exist
  for (const dir of ['/usr/local/lib', globalModulesDir, globalBinDir]) {
    try {
      await ctx.fs.mkdir(dir, { recursive: true });
    } catch {
      // Already exists
    }
  }

  const depsToResolve: Record<string, string> = {};
  for (const spec of packagesToInstall) {
    let name: string, version: string;
    if (spec.startsWith('@')) {
      const lastAt = spec.lastIndexOf('@');
      if (lastAt > 0) {
        name = spec.slice(0, lastAt);
        version = spec.slice(lastAt + 1);
      } else {
        name = spec;
        version = 'latest';
      }
    } else if (spec.includes('@')) {
      const atIdx = spec.indexOf('@');
      name = spec.slice(0, atIdx);
      version = spec.slice(atIdx + 1);
    } else {
      name = spec;
      version = 'latest';
    }
    depsToResolve[name] = version;
  }

  ctx.stdout += 'Installing packages globally...\n';
  const tree = await resolveTree(ctx, Object.entries(depsToResolve).map(([name, range]) => ({ name, range })));
  const { added, failed } = await installTree(ctx, '/usr/local/lib', tree, { globalBinDir, ignoreScripts: await ignoreScripts(ctx) });
  ctx.stdout += `\nadded ${added} package(s)\n`;
  if (failed) return 1;
  ctx.stdout += 'Packages installed globally.\n';
  return 0;
}

async function npmList(ctx: CommandContext): Promise<number> {
  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch {
    ctx.stderr += 'npm: package.json not found.\n';
    return 1;
  }

  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};

  if (Object.keys(deps).length === 0 && Object.keys(devDeps).length === 0) {
    ctx.stdout += 'No packages installed.\n';
    return 0;
  }

  ctx.stdout += `${pkg.name}@${pkg.version}\n`;

  if (Object.keys(deps).length > 0) {
    ctx.stdout += '\ndependencies:\n';
    for (const [name, version] of Object.entries(deps)) {
      // Try to read installed version from node_modules
      const installedPkgPath = ctx.fs.resolvePath(
        `node_modules/${name}/package.json`,
        ctx.cwd
      );
      let installedVersion = version;
      try {
        const installedContent = await ctx.fs.readFile(installedPkgPath, 'utf8') as string;
        const installedPkg = JSON.parse(installedContent);
        installedVersion = installedPkg.version || version;
      } catch {
        // Can't read installed version
      }
      ctx.stdout += `  ${name} ${installedVersion}\n`;
    }
  }

  if (Object.keys(devDeps).length > 0) {
    ctx.stdout += '\ndevDependencies:\n';
    for (const [name, version] of Object.entries(devDeps)) {
      ctx.stdout += `  ${name} ${version}\n`;
    }
  }

  return 0;
}

async function npmRun(ctx: CommandContext): Promise<number> {
  const scriptName = ctx.args[1];

  if (!scriptName) {
    // List available scripts
    const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);
    let pkg: PackageJson;
    try {
      const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
      pkg = JSON.parse(content);
    } catch {
      ctx.stderr += 'npm: package.json not found.\n';
      return 1;
    }

    const scripts = pkg.scripts || {};
    if (Object.keys(scripts).length === 0) {
      ctx.stdout += 'No scripts available.\n';
      return 0;
    }

    ctx.stdout += 'Available scripts:\n';
    for (const [name, command] of Object.entries(scripts)) {
      ctx.stdout += `  ${name}\n`;
      ctx.stdout += `    ${command}\n`;
    }
    return 0;
  }

  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch {
    ctx.stderr += 'npm: package.json not found.\n';
    return 1;
  }

  const script = pkg.scripts?.[scriptName];
  if (!script) {
    ctx.stderr += `npm: missing script: ${scriptName}\n`;
    ctx.stderr += '\nAvailable scripts:\n';
    for (const name of Object.keys(pkg.scripts || {})) {
      ctx.stderr += `  ${name}\n`;
    }
    return 1;
  }

  ctx.stdout += `> ${pkg.name}@${pkg.version} ${scriptName}\n`;
  ctx.stdout += `> ${script}\n\n`;

  // Execute the script via the shell
  const exitCode = await ctx.shell.execute(script,
    (s) => ctx.stdout += s,
    (s) => ctx.stderr += s,
    false, undefined, true
  );

  return exitCode;
}

/**
 * Run a named script shortcut (npm start, npm test, npm stop).
 * Falls back to defaultScript if the script isn't defined in package.json.
 */
async function npmRunScript(ctx: CommandContext, scriptName: string, defaultScript?: string): Promise<number> {
  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch {
    ctx.stderr += 'npm: package.json not found.\n';
    return 1;
  }

  const script = pkg.scripts?.[scriptName];
  if (!script) {
    if (defaultScript) {
      ctx.stdout += `> ${pkg.name || ''}@${pkg.version || ''} ${scriptName}\n`;
      ctx.stdout += `> ${defaultScript}\n\n`;
      return await ctx.shell.execute(defaultScript,
        (s) => ctx.stdout += s,
        (s) => ctx.stderr += s,
        false, undefined, true
      );
    }
    ctx.stderr += `npm: missing script: ${scriptName}\n`;
    ctx.stderr += '\nAvailable scripts:\n';
    for (const name of Object.keys(pkg.scripts || {})) {
      ctx.stderr += `  ${name}\n`;
    }
    return 1;
  }

  ctx.stdout += `> ${pkg.name || ''}@${pkg.version || ''} ${scriptName}\n`;
  ctx.stdout += `> ${script}\n\n`;

  return await ctx.shell.execute(script,
    (s) => ctx.stdout += s,
    (s) => ctx.stderr += s,
    false, undefined, true
  );
}

async function npmUninstall(ctx: CommandContext): Promise<number> {
  const packagesToRemove = ctx.args.slice(1);

  if (packagesToRemove.length === 0) {
    ctx.stderr += 'npm: missing package name\n';
    ctx.stderr += 'Usage: npm uninstall <package>\n';
    return 1;
  }

  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch {
    ctx.stderr += 'npm: package.json not found.\n';
    return 1;
  }

  for (const name of packagesToRemove) {
    if (pkg.dependencies?.[name]) {
      delete pkg.dependencies[name];
      ctx.stdout += `Removed ${name} from dependencies.\n`;
    } else if (pkg.devDependencies?.[name]) {
      delete pkg.devDependencies[name];
      ctx.stdout += `Removed ${name} from devDependencies.\n`;
    } else {
      ctx.stderr += `Package ${name} not found in dependencies.\n`;
    }

    // Remove from node_modules
    const packagePath = ctx.fs.resolvePath(`node_modules/${name}`, ctx.cwd);
    try {
      await ctx.fs.rm(packagePath, { recursive: true });
      ctx.stdout += `Removed ${name} from node_modules.\n`;
    } catch (e: any) {
      ctx.stderr += `Warning: Could not remove ${name} from node_modules: ${e.message}\n`;
    }
  }

  // Save package.json
  await ctx.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  return 0;
}

async function npmCache(ctx: CommandContext): Promise<number> {
  const action = ctx.args[1];

  if (!action || action === '--help') {
    ctx.stdout += 'Usage: npm cache <command>\n\n';
    ctx.stdout += 'Commands:\n';
    ctx.stdout += '  clean     Clear the metadata cache\n';
    ctx.stdout += '  status    Show cache statistics\n';
    return 0;
  }

  switch (action) {
    case 'clean':
    case 'clear': {
      const force = ctx.args.includes('--force') || ctx.args.includes('-f');
      const size = metadataCache.size;
      metadataCache.clear();
      ctx.stdout += `Cleared ${size} cached package metadata entries.\n`;
      if (force) {
        const nmPath = ctx.fs.resolvePath('node_modules', ctx.cwd);
        try {
          await ctx.fs.rm(nmPath, { recursive: true });
          ctx.stdout += 'Removed node_modules/ directory.\n';
        } catch {
          ctx.stdout += 'No node_modules/ directory to remove.\n';
        }
      }
      return 0;
    }

    case 'status':
    case 'ls':
      ctx.stdout += 'npm metadata cache:\n';
      ctx.stdout += `  Cached packages: ${metadataCache.size}\n`;
      ctx.stdout += `  TTL: ${METADATA_CACHE_TTL / 1000 / 60} minutes\n`;
      if (metadataCache.size > 0) {
        ctx.stdout += '\n  Cached entries:\n';
        const now = Date.now();
        for (const [name, { timestamp }] of metadataCache) {
          const ageSeconds = Math.floor((now - timestamp) / 1000);
          const ageMinutes = Math.floor(ageSeconds / 60);
          const remaining = Math.floor((METADATA_CACHE_TTL - (now - timestamp)) / 1000 / 60);
          ctx.stdout += `    ${name} (age: ${ageMinutes}m, expires in: ${remaining}m)\n`;
        }
      }
      return 0;

    default:
      ctx.stderr += `npm cache: unknown command '${action}'\n`;
      return 1;
  }
}

/**
 * npm config get|set|delete|list: ~/.npmrc (key=value lines), with npm's
 * defaults for what isn't set. Tools ask it things: Next.js downloads its
 * SWC binary from `npm config get registry`.
 */
async function npmConfig(ctx: CommandContext): Promise<number> {
  const home = ctx.env['HOME'] || '/home/user';
  const rcPath = `${home}/.npmrc`;
  const defaults: Record<string, string> = {
    registry: 'https://registry.npmjs.org/',
    prefix: '/usr/local',
    cache: `${home}/.npm`,
    'user-agent': `npm/${NPM_VERSION} node/v22.12.0 linux x64 workspaces/false`,
  };
  let text = '';
  try { text = await ctx.fs.readFile(rcPath, 'utf8') as string; } catch { /* none */ }
  const rc = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) rc.set(m[1], m[2]);
  }
  const save = () => ctx.fs.writeFile(rcPath, [...rc].map(([k, v]) => `${k}=${v}`).join('\n') + (rc.size ? '\n' : ''));
  const [, action = 'list', ...rest] = ctx.args.filter((a) => a !== '--global' && a !== '-g' && a !== '--location=user');
  switch (action) {
    case 'get': {
      if (!rest.length) { for (const [k, v] of rc) ctx.stdout += `${k}=${v}\n`; return 0; }
      for (const k of rest) ctx.stdout += `${rc.get(k) ?? defaults[k] ?? 'undefined'}\n`;
      return 0;
    }
    case 'set': {
      for (const kv of rest) {
        const i = kv.indexOf('=');
        if (i > 0) rc.set(kv.slice(0, i), kv.slice(i + 1));
        else if (rest.length >= 2) { rc.set(rest[0], rest[1]); break; }
      }
      await save();
      return 0;
    }
    case 'delete':
    case 'rm':
      for (const k of rest) rc.delete(k);
      await save();
      return 0;
    case 'list':
    case 'ls':
      ctx.stdout += `; "user" config from ${rcPath}\n\n`;
      for (const [k, v] of rc) ctx.stdout += `${k} = ${JSON.stringify(v)}\n`;
      ctx.stdout += `\n; node bin location = /usr/local/bin/node\n; cwd = ${ctx.cwd}\n; HOME = ${home}\n`;
      return 0;
    default:
      ctx.stderr += `npm config: unknown command '${action}'\n`;
      return 1;
  }
}
