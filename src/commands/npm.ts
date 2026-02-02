import { Command, CommandContext } from './index';
import { extractTarGzToFS, type FileSystemWriter } from '../utils/tar-utils';
import { maxSatisfying, satisfiesRange } from '../utils/semver-utils';

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
 *   - Package metadata cached in memory with 1-hour TTL
 *   - In-flight request deduplication prevents duplicate fetches
 */

// Metadata cache: maps package name -> { data, timestamp }
const metadataCache = new Map<string, { data: NpmPackageMetadata; timestamp: number }>();
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

interface ResolvedPackage {
  name: string;
  version: string;
  tarballUrl: string;
  dependencies: Record<string, string>;
}

export const npmCmd: Command = {
  name: 'npm',
  description: 'Browser-native package manager for Node.js packages',

  async exec(ctx: CommandContext): Promise<number> {
    const subcommand = ctx.args[0];

    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      ctx.stdout += 'Usage: npm <command>\n\n';
      ctx.stdout += 'Commands:\n';
      ctx.stdout += '  init              Create a package.json file\n';
      ctx.stdout += '  install [pkg]     Install package(s) from registry.npmjs.org\n';
      ctx.stdout += '  i [pkg]           Alias for install\n';
      ctx.stdout += '  list              List installed packages\n';
      ctx.stdout += '  ls                Alias for list\n';
      ctx.stdout += '  run <script>      Run a script from package.json\n';
      ctx.stdout += '  uninstall [pkg]   Remove a package\n';
      ctx.stdout += '  cache clean       Clear the metadata cache\n';
      ctx.stdout += '  cache status      Show cache statistics\n';
      ctx.stdout += '  --version         Show npm version\n';
      ctx.stdout += '\nNote: Downloads real tarballs from registry.npmjs.org\n';
      ctx.stdout += 'Package metadata is cached for 1 hour to speed up installs.\n';
      return 0;
    }

    if (subcommand === '--version' || subcommand === '-v') {
      ctx.stdout += 'npm v1.0.0-shiro (browser-native)\n';
      return 0;
    }

    switch (subcommand) {
      case 'init':
        return await npmInit(ctx);
      case 'install':
      case 'i':
        return await npmInstall(ctx);
      case 'list':
      case 'ls':
        return await npmList(ctx);
      case 'run':
        return await npmRun(ctx);
      case 'uninstall':
      case 'remove':
      case 'rm':
        return await npmUninstall(ctx);
      case 'cache':
        return await npmCache(ctx);
      default:
        ctx.stderr += `npm: unknown command '${subcommand}'\n`;
        ctx.stderr += "Run 'npm --help' for usage.\n";
        return 1;
    }
  },
};

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
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Package '${packageName}' not found in npm registry`);
      }
      throw new Error(`Failed to fetch package metadata: ${response.statusText}`);
    }

    const data: NpmPackageMetadata = await response.json();

    // Cache the result
    metadataCache.set(packageName, { data, timestamp: Date.now() });

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
 * Resolve a version range to a specific version
 */
function resolveVersion(metadata: NpmPackageMetadata, versionRange: string): string | null {
  // Handle 'latest' or '*'
  if (versionRange === 'latest' || versionRange === '*' || versionRange === '') {
    return metadata['dist-tags'].latest;
  }

  // Get all available versions
  const versions = Object.keys(metadata.versions);

  // Find maximum satisfying version
  return maxSatisfying(versions, versionRange);
}

/**
 * Resolve dependency tree with parallel metadata fetching
 */
async function resolveDependencyTree(
  packageName: string,
  versionRange: string,
  ctx: CommandContext
): Promise<Map<string, ResolvedPackage>> {
  const resolved = new Map<string, ResolvedPackage>();
  let queue: Array<{ name: string; range: string }> = [{ name: packageName, range: versionRange }];
  const seen = new Set<string>();

  while (queue.length > 0) {
    // Filter out already-seen packages
    const toProcess = queue.filter(({ name, range }) => {
      const key = `${name}@${range}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (toProcess.length === 0) break;
    queue = []; // Clear queue, will be refilled from results

    // Fire all metadata requests at once - browser handles connection pooling
    const promises = toProcess.map(async ({ name, range }) => {
      try {
        const metadata = await fetchPackageMetadata(name);
        return { name, range, metadata };
      } catch (error: any) {
        ctx.stderr += `Error resolving ${name}@${range}: ${error.message}\n`;
        return { name, range, metadata: null };
      }
    });

    const results = await Promise.all(promises);

    // Process results and queue new dependencies
    for (const { name, range, metadata } of results) {
      if (!metadata) continue;

      const version = resolveVersion(metadata, range);
      if (!version) {
        ctx.stderr += `Warning: No version found for ${name}@${range}\n`;
        continue;
      }

      const versionData = metadata.versions[version];
      if (!versionData) {
        ctx.stderr += `Warning: Version ${version} not found for ${name}\n`;
        continue;
      }

      // Store resolved package
      resolved.set(`${name}@${version}`, {
        name,
        version,
        tarballUrl: versionData.dist.tarball,
        dependencies: versionData.dependencies || {},
      });

      // Queue dependencies
      for (const [depName, depRange] of Object.entries(versionData.dependencies || {})) {
        queue.push({ name: depName, range: depRange });
      }
    }
  }

  return resolved;
}

/**
 * Download and extract a package tarball
 */
async function installPackage(
  pkg: ResolvedPackage,
  ctx: CommandContext
): Promise<void> {
  ctx.stdout += `  + ${pkg.name}@${pkg.version}\n`;

  // Download tarball
  const response = await fetch(pkg.tarballUrl);
  if (!response.ok) {
    throw new Error(`Failed to download ${pkg.name}: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const tarballData = new Uint8Array(arrayBuffer);

  // Create node_modules directory if needed
  const nodeModulesPath = ctx.fs.resolvePath('node_modules', ctx.cwd);
  try {
    await ctx.fs.mkdir(nodeModulesPath);
  } catch {
    // Already exists
  }

  // Create package directory
  const packageDir = ctx.fs.resolvePath(`node_modules/${pkg.name}`, ctx.cwd);
  await ctx.fs.mkdir(packageDir, { recursive: true });

  // Extract tarball to package directory
  let filesWritten = 0;
  const fsWriter: FileSystemWriter = {
    writeFile: async (path: string, data: Uint8Array) => {
      await ctx.fs.writeFile(path, data);
      filesWritten++;
    },
    mkdir: async (path: string) => {
      try {
        await ctx.fs.mkdir(path, { recursive: true });
      } catch {
        // Directory might exist
      }
    },
  };

  await extractTarGzToFS(tarballData, packageDir, fsWriter);
  ctx.stdout += `  ${filesWritten} files extracted\n`;
}

/**
 * Create symlinks in node_modules/.bin for packages with bin entries
 */
async function createBinSymlinks(
  ctx: CommandContext,
  packages: Map<string, ResolvedPackage>
): Promise<void> {
  const binDir = ctx.fs.resolvePath('node_modules/.bin', ctx.cwd);

  // Ensure .bin directory exists
  try {
    await ctx.fs.mkdir(binDir, { recursive: true });
  } catch {
    // Already exists
  }

  let binCount = 0;

  for (const pkg of packages.values()) {
    try {
      // Read package.json from installed package
      const pkgJsonPath = ctx.fs.resolvePath(
        `node_modules/${pkg.name}/package.json`,
        ctx.cwd
      );

      const content = await ctx.fs.readFile(pkgJsonPath, 'utf8') as string;
      const pkgData = JSON.parse(content) as PackageJson;

      if (!pkgData.bin) continue;

      // Handle bin as string or object
      const bins: Record<string, string> = typeof pkgData.bin === 'string'
        ? { [pkg.name]: pkgData.bin }
        : pkgData.bin;

      // Create symlink for each bin entry
      for (const [binName, binPath] of Object.entries(bins)) {
        const symlinkPath = ctx.fs.resolvePath(`node_modules/.bin/${binName}`, ctx.cwd);
        // Target is relative from .bin to the actual script
        const cleanBinPath = binPath.replace(/^\.\//, '');
        const targetPath = `../${pkg.name}/${cleanBinPath}`;

        try {
          // Remove existing symlink if any
          await ctx.fs.unlink(symlinkPath);
        } catch {
          // Doesn't exist, that's fine
        }

        await ctx.fs.symlink(targetPath, symlinkPath);
        binCount++;
      }
    } catch {
      // Package doesn't have valid package.json or bin entries, skip
    }
  }

  if (binCount > 0) {
    ctx.stdout += `Created ${binCount} bin symlink(s) in node_modules/.bin\n`;
  }
}

async function npmInstall(ctx: CommandContext): Promise<number> {
  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  // Read package.json
  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch (e: any) {
    if (e.message.includes('ENOENT')) {
      ctx.stderr += 'npm: package.json not found. Run "npm init" first.\n';
      return 1;
    }
    ctx.stderr += `npm: failed to parse package.json: ${e.message}\n`;
    return 1;
  }

  // Get packages to install from args, filtering out flags
  // Supported flags: --ignore-scripts (ignored, scripts not supported anyway)
  const packagesToInstall = ctx.args.slice(1).filter(arg => !arg.startsWith('--'));

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
    if (!pkg.dependencies) pkg.dependencies = {};

    for (const spec of packagesToInstall) {
      const [name, version] = spec.includes('@') && !spec.startsWith('@')
        ? spec.split('@')
        : [spec, 'latest'];

      depsToResolve[name] = version;
      pkg.dependencies[name] = version === 'latest' ? '*' : version;
    }

    // Save updated package.json
    await ctx.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    ctx.stdout += 'Installing packages...\n';
  }

  // Resolve dependency tree for each package
  const allResolved = new Map<string, ResolvedPackage>();

  for (const [name, range] of Object.entries(depsToResolve)) {
    try {
      const resolved = await resolveDependencyTree(name, range, ctx);
      for (const [key, value] of resolved) {
        allResolved.set(key, value);
      }
    } catch (error: any) {
      ctx.stderr += `Error installing ${name}: ${error.message}\n`;
      return 1;
    }
  }

  // Install all resolved packages in parallel - browser handles connection pooling
  ctx.stdout += `\nResolved ${allResolved.size} package(s):\n`;

  const packages = Array.from(allResolved.values());

  // Fire all install requests at once
  const installPromises = packages.map(pkg => installPackage(pkg, ctx).catch(err => {
    ctx.stderr += `Error installing ${pkg.name}: ${err.message}\n`;
  }));

  await Promise.all(installPromises);

  // Create .bin symlinks for packages with bin entries
  await createBinSymlinks(ctx, allResolved);

  ctx.stdout += '\nPackages installed successfully.\n';
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
    (s) => ctx.stderr += s
  );

  return exitCode;
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
    case 'clear':
      const size = metadataCache.size;
      metadataCache.clear();
      ctx.stdout += `Cleared ${size} cached package metadata entries.\n`;
      return 0;

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
