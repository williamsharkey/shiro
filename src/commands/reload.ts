import { Command, CommandContext } from './index';
import { registry } from '../registry';
import * as esbuild from 'esbuild-wasm';

/**
 * reload: Hot-reload modules from the virtual filesystem
 *
 * Recompiles TypeScript/JavaScript from VFS and hot-swaps modules
 * in the running system without losing state.
 *
 * Usage:
 *   reload commands/ls       # Reload a specific command
 *   reload --list            # List all registered modules
 *   reload --status          # Show module versions and sources
 *   reload --all             # Reload all modules with VFS sources
 *
 * The reloaded module can implement migrateFrom(old) to preserve state.
 */

// Track esbuild initialization state (shared with build.ts)
let esbuildInitialized = false;
let initPromise: Promise<void> | null = null;

const ESBUILD_WASM_URL = 'https://unpkg.com/esbuild-wasm@0.27.2/esbuild.wasm';
const WASM_CACHE_DB = 'shiro-wasm-cache';
const WASM_CACHE_STORE = 'wasm-binaries';
const WASM_CACHE_KEY = 'esbuild-0.27.2';

async function openWasmCacheDB(): Promise<IDBDatabase> {
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
    // Caching failure is non-fatal
  }
}

async function ensureEsbuildInitialized(): Promise<void> {
  if (esbuildInitialized) return;

  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    try {
      let wasmBinary = await getCachedWasm();

      if (wasmBinary) {
        await esbuild.initialize({
          wasmModule: await WebAssembly.compile(wasmBinary),
          worker: false,
        });
      } else {
        const response = await fetch(ESBUILD_WASM_URL);
        wasmBinary = await response.arrayBuffer();
        await esbuild.initialize({
          wasmModule: await WebAssembly.compile(wasmBinary),
          worker: false,
        });
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
 * Compile a TypeScript/JavaScript file from VFS to executable code
 */
async function compileFromVFS(
  ctx: CommandContext,
  sourcePath: string
): Promise<string> {
  await ensureEsbuildInitialized();

  // Read source from VFS
  const source = await ctx.fs.readFile(sourcePath, 'utf8') as string;

  // Determine loader from extension
  let loader: 'ts' | 'tsx' | 'js' | 'jsx' = 'ts';
  if (sourcePath.endsWith('.tsx')) loader = 'tsx';
  else if (sourcePath.endsWith('.js')) loader = 'js';
  else if (sourcePath.endsWith('.jsx')) loader = 'jsx';

  // Transform to executable JavaScript
  const result = await esbuild.transform(source, {
    loader,
    format: 'esm',
    target: 'es2020',
  });

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`[reload] Warning in ${sourcePath}: ${warning.text}`);
    }
  }

  return result.code;
}

/**
 * Execute compiled code and extract the module export
 */
async function loadCompiledModule(code: string, moduleName: string): Promise<unknown> {
  // Create a blob URL for the compiled code
  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);

  try {
    // Dynamic import from blob URL
    const module = await import(/* @vite-ignore */ url);
    return module.default || module;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const reloadCmd: Command = {
  name: 'reload',
  description: 'Hot-reload modules from virtual filesystem',

  async exec(ctx: CommandContext): Promise<number> {
    const arg = ctx.args[0];

    // List registered modules
    if (arg === '--list' || arg === '-l') {
      const modules = registry.list();
      if (modules.length === 0) {
        ctx.stdout += 'No modules registered.\n';
      } else {
        ctx.stdout += 'Registered modules:\n';
        for (const name of modules.sort()) {
          ctx.stdout += `  ${name}\n`;
        }
      }
      return 0;
    }

    // Show detailed status
    if (arg === '--status' || arg === '-s') {
      const modules = registry.list();
      if (modules.length === 0) {
        ctx.stdout += 'No modules registered.\n';
      } else {
        ctx.stdout += 'Module registry status:\n\n';
        for (const name of modules.sort()) {
          const meta = registry.getMetadata(name);
          if (meta) {
            const age = Math.floor((Date.now() - meta.lastUpdatedAt) / 1000);
            ctx.stdout += `  ${name}\n`;
            ctx.stdout += `    version: ${meta.version}\n`;
            ctx.stdout += `    updated: ${age}s ago\n`;
            if (meta.source) {
              ctx.stdout += `    source: ${meta.source}\n`;
            }
            ctx.stdout += '\n';
          }
        }
      }
      return 0;
    }

    // Reload all modules with sources
    if (arg === '--all' || arg === '-a') {
      const modules = registry.list();
      let reloaded = 0;
      let failed = 0;

      for (const name of modules) {
        const meta = registry.getMetadata(name);
        if (meta?.source) {
          try {
            ctx.stdout += `Reloading ${name} from ${meta.source}...\n`;
            const code = await compileFromVFS(ctx, meta.source);
            const newModule = await loadCompiledModule(code, name);
            const result = registry.replace(name, newModule as any, meta.source);
            if (result.migrated) {
              ctx.stdout += `  ✓ Reloaded with state migration\n`;
            } else if (result.error) {
              ctx.stdout += `  ⚠ Reloaded but migration failed: ${result.error.message}\n`;
            } else {
              ctx.stdout += `  ✓ Reloaded (no migration needed)\n`;
            }
            reloaded++;
          } catch (e: any) {
            ctx.stderr += `  ✗ Failed: ${e.message}\n`;
            failed++;
          }
        }
      }

      ctx.stdout += `\nReloaded ${reloaded} module(s)`;
      if (failed > 0) {
        ctx.stdout += `, ${failed} failed`;
      }
      ctx.stdout += '.\n';
      return failed > 0 ? 1 : 0;
    }

    // Show help
    if (!arg || arg === '--help' || arg === '-h') {
      ctx.stdout += 'Usage: reload <module-name> [source-path]\n';
      ctx.stdout += '       reload --list          List registered modules\n';
      ctx.stdout += '       reload --status        Show module versions and sources\n';
      ctx.stdout += '       reload --all           Reload all modules with sources\n';
      ctx.stdout += '\n';
      ctx.stdout += 'Examples:\n';
      ctx.stdout += '  reload commands/ls                    # Reload from registered source\n';
      ctx.stdout += '  reload commands/ls /src/commands/ls.ts  # Reload from specific path\n';
      ctx.stdout += '\n';
      ctx.stdout += 'Modules can implement migrateFrom(old) to preserve state during reload.\n';
      return 0;
    }

    // Reload specific module
    const moduleName = arg;
    const sourcePath = ctx.args[1] || registry.getMetadata(moduleName)?.source;

    if (!sourcePath) {
      ctx.stderr += `reload: no source path for '${moduleName}'\n`;
      ctx.stderr += `Specify a source path: reload ${moduleName} /path/to/source.ts\n`;
      return 1;
    }

    // Check if source exists
    try {
      await ctx.fs.stat(sourcePath);
    } catch {
      ctx.stderr += `reload: source not found: ${sourcePath}\n`;
      return 1;
    }

    ctx.stdout += `Compiling ${sourcePath}...\n`;

    try {
      const code = await compileFromVFS(ctx, sourcePath);
      ctx.stdout += `Loading module...\n`;

      const newModule = await loadCompiledModule(code, moduleName);

      if (registry.has(moduleName)) {
        const result = registry.replace(moduleName, newModule as any, sourcePath);
        if (result.migrated) {
          ctx.stdout += `✓ Hot-reloaded '${moduleName}' with state migration\n`;
        } else if (result.error) {
          ctx.stdout += `⚠ Hot-reloaded '${moduleName}' but migration failed: ${result.error.message}\n`;
        } else {
          ctx.stdout += `✓ Hot-reloaded '${moduleName}'\n`;
        }
      } else {
        registry.register(moduleName, newModule, sourcePath);
        ctx.stdout += `✓ Registered new module '${moduleName}'\n`;
      }

      return 0;
    } catch (e: any) {
      ctx.stderr += `reload: ${e.message}\n`;
      return 1;
    }
  },
};
