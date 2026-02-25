import { Command, CommandContext } from './index';
import * as esbuild from 'esbuild-wasm';

/**
 * build: Browser-native TypeScript/JavaScript bundler using esbuild-wasm
 *
 * Integrates esbuild with Shiro's virtual filesystem to bundle code
 * entirely in the browser without any backend servers.
 *
 * Usage:
 *   build src/index.ts --outfile=dist/bundle.js
 *   build src/index.ts --bundle --minify
 *
 * Features:
 *   - TypeScript and JSX/TSX support
 *   - Tree shaking and minification
 *   - Source maps
 *   - Custom virtual FS plugin for browser filesystem
 *   - WASM binary cached in IndexedDB for fast subsequent loads
 */

const ESBUILD_WASM_URL = 'https://unpkg.com/esbuild-wasm@0.27.2/esbuild.wasm';
const WASM_CACHE_DB = 'shiro-wasm-cache';
const WASM_CACHE_STORE = 'wasm-binaries';
const WASM_CACHE_KEY = 'esbuild-0.27.2';

let esbuildInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Open/create the IndexedDB database for WASM binary caching
 */
function openWasmCacheDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WASM_CACHE_DB, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WASM_CACHE_STORE)) {
        db.createObjectStore(WASM_CACHE_STORE);
      }
    };
  });
}

/**
 * Get cached WASM binary from IndexedDB
 */
async function getCachedWasm(): Promise<ArrayBuffer | null> {
  try {
    const db = await openWasmCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(WASM_CACHE_STORE, 'readonly');
      const store = tx.objectStore(WASM_CACHE_STORE);
      const request = store.get(WASM_CACHE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

/**
 * Store WASM binary in IndexedDB for future sessions
 */
async function cacheWasm(wasmBinary: ArrayBuffer): Promise<void> {
  try {
    const db = await openWasmCacheDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WASM_CACHE_STORE, 'readwrite');
      const store = tx.objectStore(WASM_CACHE_STORE);
      const request = store.put(wasmBinary, WASM_CACHE_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    // Caching failure is non-fatal, just means next session will re-download
  }
}

export async function ensureEsbuildInitialized(): Promise<void> {
  if (esbuildInitialized) return;

  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    try {
      // Try to load WASM from cache first
      let wasmBinary = await getCachedWasm();

      if (wasmBinary) {
        // Use cached WASM binary
        await esbuild.initialize({
          wasmModule: await WebAssembly.compile(wasmBinary),
          worker: false,
        });
      } else {
        // Download and cache for future sessions
        const response = await fetch(ESBUILD_WASM_URL);
        wasmBinary = await response.arrayBuffer();

        // Initialize with downloaded WASM
        await esbuild.initialize({
          wasmModule: await WebAssembly.compile(wasmBinary),
          worker: false,
        });

        // Cache for next time (fire and forget)
        cacheWasm(wasmBinary);
      }

      esbuildInitialized = true;
    } catch (e: any) {
      initPromise = null;
      throw new Error(`Failed to initialize esbuild: ${e.message}`);
    }
  })();

  await initPromise;
}

/**
 * Create a virtual filesystem plugin for esbuild that reads from Shiro's filesystem
 */
export function createVirtualFSPlugin(ctx: CommandContext): esbuild.Plugin {
  return {
    name: 'shiro-virtual-fs',
    setup(build) {
      // Handle all imports - resolve paths relative to the importing file
      build.onResolve({ filter: /.*/ }, async (args) => {
        // Handle node_modules imports
        if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
          // Try to resolve as node_modules package
          const possiblePaths = [
            `/node_modules/${args.path}/package.json`,
            `/node_modules/${args.path}/index.js`,
            `/node_modules/${args.path}/index.ts`,
            `/node_modules/${args.path}.js`,
            `/node_modules/${args.path}.ts`,
            `${ctx.cwd}/node_modules/${args.path}/package.json`,
            `${ctx.cwd}/node_modules/${args.path}/index.js`,
            `${ctx.cwd}/node_modules/${args.path}/index.ts`,
            `${ctx.cwd}/node_modules/${args.path}.js`,
            `${ctx.cwd}/node_modules/${args.path}.ts`,
          ];

          for (const possiblePath of possiblePaths) {
            try {
              if (possiblePath.endsWith('package.json')) {
                const pkgContent = await ctx.fs.readFile(possiblePath, 'utf8') as string;
                const pkg = JSON.parse(pkgContent);
                const main = pkg.main || 'index.js';
                const pkgDir = possiblePath.replace('/package.json', '');
                return { path: ctx.fs.resolvePath(main, pkgDir), namespace: 'shiro-fs' };
              } else {
                await ctx.fs.readFile(possiblePath, 'utf8');
                return { path: possiblePath, namespace: 'shiro-fs' };
              }
            } catch {
              continue;
            }
          }

          // Not found in node_modules - mark as external
          return { path: args.path, external: true };
        }

        // Resolve relative/absolute paths
        let resolvedPath: string;
        if (args.path.startsWith('/')) {
          resolvedPath = args.path;
        } else {
          const baseDir = args.importer
            ? args.importer.split('/').slice(0, -1).join('/') || '/'
            : ctx.cwd;
          resolvedPath = ctx.fs.resolvePath(args.path, baseDir);
        }

        // Try with and without extensions
        const extensionsToTry = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
        for (const ext of extensionsToTry) {
          const pathToTry = resolvedPath + ext;
          try {
            await ctx.fs.readFile(pathToTry, 'utf8');
            return { path: pathToTry, namespace: 'shiro-fs' };
          } catch {
            continue;
          }
        }

        return { path: resolvedPath, namespace: 'shiro-fs' };
      });

      // Load file contents from Shiro's virtual filesystem
      build.onLoad({ filter: /.*/, namespace: 'shiro-fs' }, async (args) => {
        try {
          const contents = await ctx.fs.readFile(args.path, 'utf8') as string;

          // Determine loader based on file extension
          let loader: esbuild.Loader = 'js';
          if (args.path.endsWith('.ts')) loader = 'ts';
          else if (args.path.endsWith('.tsx')) loader = 'tsx';
          else if (args.path.endsWith('.jsx')) loader = 'jsx';
          else if (args.path.endsWith('.json')) loader = 'json';
          else if (args.path.endsWith('.css')) loader = 'css';

          return {
            contents,
            loader,
          };
        } catch (e: any) {
          return {
            errors: [{
              text: `Failed to load ${args.path}: ${e.message}`,
              location: null,
            }],
          };
        }
      });
    },
  };
}

/**
 * Run a single esbuild build and write output files.
 * Returns the list of input files from metafile (for watch mode).
 */
async function runBuild(
  ctx: CommandContext,
  entryPath: string,
  outfile: string,
  options: any,
  write: (msg: string) => void,
): Promise<{ ok: boolean; inputs: string[] }> {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: options.bundle,
    minify: options.minify,
    sourcemap: options.sourcemap,
    format: options.format,
    target: options.target,
    write: false,
    metafile: true,
    plugins: [createVirtualFSPlugin(ctx)],
    logLevel: 'silent',
  });

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      write(`Error: ${error.text}\n`);
      if (error.location) {
        write(`  at ${error.location.file}:${error.location.line}:${error.location.column}\n`);
      }
    }
    return { ok: false, inputs: [] };
  }

  for (const warning of result.warnings) {
    write(`Warning: ${warning.text}\n`);
  }

  if (result.outputFiles && result.outputFiles.length > 0) {
    const output = result.outputFiles[0];
    const outputPath = ctx.fs.resolvePath(outfile, ctx.cwd);
    const outputDir = outputPath.split('/').slice(0, -1).join('/');
    if (outputDir) {
      try { await ctx.fs.mkdir(outputDir); } catch { /* exists */ }
    }
    await ctx.fs.writeFile(outputPath, output.contents);
    const sizeKB = (output.contents.length / 1024).toFixed(2);
    write(`\u2713 Built: ${outputPath} (${sizeKB} KB)\n`);

    if (options.sourcemap && result.outputFiles.length > 1) {
      const sourcemapOutput = result.outputFiles[1];
      await ctx.fs.writeFile(outputPath + '.map', sourcemapOutput.contents);
    }
  }

  // Extract input file paths from metafile
  const inputs = result.metafile ? Object.keys(result.metafile.inputs) : [entryPath];
  return { ok: true, inputs };
}

export const buildCmd: Command = {
  name: 'build',
  description: 'Bundle TypeScript/JavaScript using esbuild-wasm',

  async exec(ctx: CommandContext): Promise<number> {
    if (ctx.args.length === 0 || ctx.args[0] === '--help' || ctx.args[0] === '-h') {
      ctx.stdout += 'Usage: build <entry-point> [options]\n\n';
      ctx.stdout += 'Options:\n';
      ctx.stdout += '  --outfile=FILE    Output file path\n';
      ctx.stdout += '  --bundle          Bundle all dependencies\n';
      ctx.stdout += '  --minify          Minify the output\n';
      ctx.stdout += '  --sourcemap       Generate source maps\n';
      ctx.stdout += '  --format=FORMAT   Output format (iife, cjs, esm)\n';
      ctx.stdout += '  --target=TARGET   Target environment (es2015, es2020, etc.)\n';
      ctx.stdout += '  --watch           Rebuild on file changes and auto-reload served iframes\n';
      ctx.stdout += '\nExample:\n';
      ctx.stdout += '  build src/index.ts --outfile=dist/bundle.js --bundle --minify\n';
      ctx.stdout += '  build app.tsx --bundle --watch --outfile=bundle.js &\n';
      return 0;
    }

    try {
      ctx.stdout += 'Initializing esbuild...\n';
      await ensureEsbuildInitialized();

      const entryPoint = ctx.args[0];
      const options: any = {
        bundle: false,
        minify: false,
        sourcemap: false,
        format: 'esm',
        target: 'es2020',
      };

      let outfile = 'out.js';
      let watch = false;

      for (let i = 1; i < ctx.args.length; i++) {
        const arg = ctx.args[i];
        if (arg.startsWith('--outfile=')) {
          outfile = arg.slice('--outfile='.length);
        } else if (arg === '--bundle') {
          options.bundle = true;
        } else if (arg === '--minify') {
          options.minify = true;
        } else if (arg === '--sourcemap') {
          options.sourcemap = true;
        } else if (arg.startsWith('--format=')) {
          options.format = arg.slice('--format='.length);
        } else if (arg.startsWith('--target=')) {
          options.target = arg.slice('--target='.length);
        } else if (arg === '--watch') {
          watch = true;
        }
      }

      const entryPath = ctx.fs.resolvePath(entryPoint, ctx.cwd);
      const write = (msg: string) => { ctx.stdout += msg; };

      write(`Building ${entryPath}...\n`);
      const first = await runBuild(ctx, entryPath, outfile, options, write);
      if (!first.ok && !watch) return 1;

      if (!watch) return first.ok ? 0 : 1;

      // -- Watch mode --
      const term = ctx.terminal;
      const liveWrite = (msg: string) => {
        if (term) term.writeOutput(msg.replace(/\n/g, '\r\n'));
        else ctx.stdout += msg;
      };

      // Collect initial mtimes
      const mtimes = new Map<string, number>();
      for (const f of first.inputs) {
        try {
          const stat = await ctx.fs.stat(f);
          if (stat) mtimes.set(f, (stat as any).mtimeMs ?? stat.mtime.getTime());
        } catch { /* skip */ }
      }

      liveWrite(`[watching ${mtimes.size} files, Ctrl+C to stop]\n`);

      // Get iframeServer for reload broadcast
      const iframeServer = typeof window !== 'undefined' && (window as any).__shiro?.iframeServer;

      // Poll loop
      let stopped = false;
      const interval = setInterval(async () => {
        if (stopped) return;
        let changed = false;

        // Check all tracked files for mtime changes
        for (const [file, oldMtime] of mtimes) {
          try {
            const stat = await ctx.fs.stat(file);
            if (!stat) continue;
            const newMtime = (stat as any).mtimeMs ?? stat.mtime.getTime();
            if (newMtime > oldMtime) {
              changed = true;
              mtimes.set(file, newMtime);
            }
          } catch { /* file deleted */ }
        }

        if (!changed) return;

        const t0 = performance.now();
        const res = await runBuild(ctx, entryPath, outfile, options, liveWrite);
        const elapsed = Math.round(performance.now() - t0);

        if (res.ok) {
          liveWrite(`[rebuilt in ${elapsed}ms]\n`);
          // Update tracked files from new metafile
          for (const f of res.inputs) {
            if (!mtimes.has(f)) {
              try {
                const stat = await ctx.fs.stat(f);
                if (stat) mtimes.set(f, (stat as any).mtimeMs ?? stat.mtime.getTime());
              } catch { /* skip */ }
            }
          }
          // Broadcast reload to all served iframes
          if (iframeServer?.broadcastReload) {
            iframeServer.broadcastReload();
          }
        } else {
          liveWrite(`[build failed after ${elapsed}ms]\n`);
        }
      }, 500);

      // Block until terminal closes or Ctrl+C
      await new Promise<void>((resolve) => {
        if (term) {
          term.enterStdinPassthrough((data) => {
            // Ctrl+C
            if (data === '\x03') {
              stopped = true;
              clearInterval(interval);
              term.exitStdinPassthrough();
              liveWrite('[watch stopped]\n');
              resolve();
            }
          });
        } else {
          // No terminal (background mode) — run until process is killed
          // Store cleanup on the global so `kill` command can stop it
          (globalThis as any).__buildWatchCleanup = () => {
            stopped = true;
            clearInterval(interval);
            resolve();
          };
        }
      });

      return 0;
    } catch (e: any) {
      ctx.stderr += `build: ${e.message}\n`;
      if (e.stack) {
        ctx.stderr += e.stack + '\n';
      }
      return 1;
    }
  },
};
