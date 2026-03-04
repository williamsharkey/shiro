/**
 * CommonJS module resolver and loader.
 * Handles require() calls, node_modules resolution, package.json exports.
 * Extracted from node-cmd.ts requireModule()/_requireModule().
 */

import type { CommandContext } from '../commands/index';
import { transformESModules, transformTS, transformJSX } from '../commands/jseval/module-transform';
import { ProcessExitError } from '../commands/jseval/utils';

export interface RequireDeps {
  ctx: CommandContext;
  fileCache: Map<string, string>;
  fileMtimes: Map<string, number>;
  moduleCache: Map<string, { exports: any }>;
  pendingPromises: Promise<any>[];
  processEvents: Record<string, Function[]>;
  getBuiltinModule: (name: string) => any;
  fakeConsole: any;
  fakeProcess: any;
  FakeBuffer: any;
  createExpressShim: () => any;
  createSqliteShim: () => any;
  createAutoStub: (modPath: string, target: any) => any;
}

export function createRequireFunction(deps: RequireDeps): (modPath: string, fromDir: string) => any {
  const { ctx, fileCache, fileMtimes, moduleCache, pendingPromises, processEvents,
    getBuiltinModule, fakeConsole, fakeProcess, FakeBuffer,
    createExpressShim, createSqliteShim, createAutoStub } = deps;

  function requireModule(modPath: string, fromDir: string): any {
    const result = _requireModule(modPath, fromDir);
    // For Node.js builtins, wrap in auto-stub Proxy
    if (result && typeof result === 'object' && (modPath.startsWith('node:') || getBuiltinModule(modPath) !== null)) {
      return createAutoStub(modPath, result);
    }
    return result;
  }

  function tryResolveExtensions(base: string): string | undefined {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      if (fileCache.has(base + ext)) return base + ext;
    }
    for (const idx of ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
      if (fileCache.has(base + idx)) return base + idx;
    }
    return undefined;
  }

  function _requireModule(modPath: string, fromDir: string): any {
    // Check for Express shim — return the factory function itself
    // (users do: const express = require('express'); const app = express();)
    if (modPath === 'express') {
      return createExpressShim;
    }

    // Check for better-sqlite3 shim
    if (modPath === 'better-sqlite3') {
      return createSqliteShim();
    }

    // Check built-in modules first
    const builtin = getBuiltinModule(modPath);
    if (builtin !== null) {
      return builtin;
    }

    let resolved = modPath;

    // Handle Node.js package #imports (subpath imports)
    // e.g., chalk uses `import x from '#ansi-styles'` which maps via package.json "imports"
    if (modPath.startsWith('#')) {
      let lookupDir = fromDir;
      while (lookupDir) {
        const pkgJsonPath = `${lookupDir}/package.json`;
        if (fileCache.has(pkgJsonPath)) {
          try {
            const pkg = JSON.parse(fileCache.get(pkgJsonPath)!);
            if (pkg.imports && pkg.imports[modPath]) {
              const mapping = pkg.imports[modPath];
              let target: string | undefined;
              if (typeof mapping === 'string') {
                target = mapping;
              } else if (typeof mapping === 'object') {
                target = mapping.default || mapping.node || mapping.import || mapping.require;
              }
              if (target) {
                resolved = ctx.fs.resolvePath(target, lookupDir);
                if (!resolved.endsWith('.js') && !resolved.endsWith('.json') && !resolved.endsWith('.ts') && !resolved.endsWith('.tsx') && !resolved.endsWith('.jsx')) {
                  const found = tryResolveExtensions(resolved);
                  if (found) resolved = found;
                }
                if (moduleCache.has(resolved)) return moduleCache.get(resolved)!.exports;
                break;
              }
            }
          } catch { /* ignore parse errors */ }
        }
        const parent = lookupDir.substring(0, lookupDir.lastIndexOf('/')) || '';
        if (parent === lookupDir || !parent) break;
        lookupDir = parent;
      }
    } else if (modPath.startsWith('./') || modPath.startsWith('../') || modPath.startsWith('/')) {
      resolved = ctx.fs.resolvePath(modPath, fromDir);
      if (!resolved.endsWith('.js') && !resolved.endsWith('.json') && !resolved.endsWith('.ts') && !resolved.endsWith('.tsx') && !resolved.endsWith('.jsx')) {
        const found = tryResolveExtensions(resolved);
        if (found) resolved = found;
      }
    } else {
      // Handle subpath imports like 'semver/functions/coerce'
      // Split into package name and subpath
      const parts = modPath.split('/');
      const isScoped = modPath.startsWith('@');
      const pkgName = isScoped ? parts.slice(0, 2).join('/') : parts[0];
      const subpath = isScoped ? parts.slice(2).join('/') : parts.slice(1).join('/');

      // Walk up directories to find node_modules (npm resolution)
      let searchDir = fromDir.startsWith('/') ? fromDir : ctx.cwd;
      let found = false;
      while (searchDir) {
        let pkgDir = `${searchDir}/node_modules/${pkgName}`;
        let pkgPath = `${pkgDir}/package.json`;

        // Handle npm GitHub tarball extraction which creates nested structure
        // e.g., node_modules/busboy/mscdex-busboy-9aadb7a/package.json
        if (!fileCache.has(pkgPath)) {
          const nestedPkg = [...fileCache.keys()].find(
            k => k.startsWith(pkgDir + '/') && k.endsWith('/package.json') && k.split('/').length === pkgDir.split('/').length + 2
          );
          if (nestedPkg) {
            pkgDir = nestedPkg.replace('/package.json', '');
            pkgPath = nestedPkg;
          }
        }

        if (fileCache.has(pkgPath)) {
          if (subpath) {
            // Subpath import - check exports field first, then look for file directly
            let subpathResolved: string | undefined;
            try {
              const pkg = JSON.parse(fileCache.get(pkgPath)!);
              if (pkg.exports) {
                // Check for subpath in exports: { "./*": "./dist/*.js" } or { "./foo": "./dist/foo.js" }
                const subpathKey = `./${subpath}`;
                const exp = pkg.exports[subpathKey];
                if (exp) {
                  const target = typeof exp === 'string' ? exp
                    : (exp.browser || exp.import || exp.require || exp.default);
                  if (target) {
                    subpathResolved = `${pkgDir}/${target.replace(/^\.\//, '')}`;
                  }
                } else {
                  // Try wildcard exports: "./*" -> "./dist/*"
                  for (const [key, value] of Object.entries(pkg.exports)) {
                    if (key.includes('*')) {
                      const pattern = key.replace('./', '').replace('*', '(.*)');
                      const regex = new RegExp(`^${pattern}$`);
                      const match = subpath.match(regex);
                      if (match) {
                        const target = typeof value === 'string' ? value
                          : ((value as any).browser || (value as any).import || (value as any).require || (value as any).default);
                        if (target) {
                          subpathResolved = `${pkgDir}/${target.replace(/^\.\//, '').replace('*', match[1])}`;
                          break;
                        }
                      }
                    }
                  }
                }
              }
            } catch { /* ignore parse errors */ }

            if (subpathResolved && fileCache.has(subpathResolved)) {
              resolved = subpathResolved;
            } else {
              // Fall back to direct file lookup
              const subpathFull = `${pkgDir}/${subpath}`;
              if (fileCache.has(subpathFull)) {
                resolved = subpathFull;
              } else {
                const found = tryResolveExtensions(subpathFull);
                resolved = found || subpathResolved || subpathFull + '.js'; // Will fail with helpful error
              }
            }
          } else {
            // Main package import - use package.json exports or main field
            try {
              const pkg = JSON.parse(fileCache.get(pkgPath)!);
              let main: string | undefined;

              // Modern packages use "exports" field
              if (pkg.exports) {
                const exp = pkg.exports;
                // exports can be string, object with "." entry, or conditional exports
                if (typeof exp === 'string') {
                  main = exp;
                } else if (exp['.']) {
                  const dotExport = exp['.'];
                  if (typeof dotExport === 'string') {
                    main = dotExport;
                  } else {
                    // Conditional exports: prefer browser > import > require > default > node
                    main = dotExport.browser || dotExport.import || dotExport.require || dotExport.default || dotExport.node;
                    // Handle nested conditional (e.g., { default: { import: "..." } })
                    if (typeof main === 'object') {
                      main = (main as any).browser || (main as any).import || (main as any).require || (main as any).default;
                    }
                  }
                } else if (exp.browser || exp.import || exp.require || exp.default) {
                  main = exp.browser || exp.import || exp.require || exp.default;
                }
              }

              // Fall back to main field or index.js
              if (!main) {
                main = pkg.main || pkg.module || 'index.js';
              }

              // Ensure main is a string
              if (typeof main !== 'string') {
                main = 'index.js';
              }

              main = main.replace(/^\.\//, '');
              // Don't add .js if already has valid extension
              if (!/\.(js|cjs|mjs|json|ts|tsx|jsx)$/.test(main)) {
                // Check if main points to a directory or file, trying TS extensions first
                const fullBase = `${pkgDir}/${main}`;
                const found = tryResolveExtensions(fullBase);
                if (found) {
                  main = found.substring(pkgDir.length + 1);
                } else {
                  main += '.js';
                }
              }
              resolved = `${pkgDir}/${main}`;
            } catch {
              resolved = `${pkgDir}/index.js`;
            }
          }
          found = true;
          break;
        }
        // Also check if package exists without package.json
        if (fileCache.has(`${pkgDir}/index.js`)) {
          if (subpath) {
            const subpathFull = `${pkgDir}/${subpath}`;
            if (fileCache.has(subpathFull + '.js')) resolved = subpathFull + '.js';
            else if (fileCache.has(subpathFull)) resolved = subpathFull;
            else resolved = subpathFull + '/index.js';
          } else {
            resolved = `${pkgDir}/index.js`;
          }
          found = true;
          break;
        }
        // Move up one directory
        const parent = searchDir.substring(0, searchDir.lastIndexOf('/')) || '';
        if (parent === searchDir || !parent) break;
        searchDir = parent;
      }
      // Also check global node_modules (/usr/local/lib/node_modules)
      if (!found) {
        const globalPkgDir = `/usr/local/lib/node_modules/${pkgName}`;
        const globalPkgPath = `${globalPkgDir}/package.json`;
        if (fileCache.has(globalPkgPath)) {
          if (subpath) {
            const subpathFull = `${globalPkgDir}/${subpath}`;
            if (fileCache.has(subpathFull + '.js')) resolved = subpathFull + '.js';
            else if (fileCache.has(subpathFull)) resolved = subpathFull;
            else resolved = subpathFull + '/index.js';
          } else {
            try {
              const pkg = JSON.parse(fileCache.get(globalPkgPath)!);
              let main: string | undefined;
              if (pkg.exports) {
                const exp = pkg.exports;
                if (typeof exp === 'string') main = exp;
                else if (exp['.']) {
                  const dotExport = exp['.'];
                  main = typeof dotExport === 'string' ? dotExport
                    : (dotExport.browser || dotExport.import || dotExport.require || dotExport.default);
                } else if (exp.browser || exp.import || exp.require || exp.default) {
                  main = exp.browser || exp.import || exp.require || exp.default;
                }
              }
              if (!main) main = pkg.main || pkg.module || 'index.js';
              if (typeof main !== 'string') main = 'index.js';
              main = main.replace(/^\.\//, '');
              if (!/\.(js|cjs|mjs|json)$/.test(main)) {
                const asDir = `${globalPkgDir}/${main}/index.js`;
                const asFile = `${globalPkgDir}/${main}.js`;
                if (fileCache.has(asDir) && !fileCache.has(asFile)) main += '/index.js';
                else main += '.js';
              }
              resolved = `${globalPkgDir}/${main}`;
            } catch {
              resolved = `${globalPkgDir}/index.js`;
            }
          }
          found = true;
        }
      }
      // Also check from ctx.cwd — scripts in /tmp need to find packages in /home/user/node_modules
      if (!found && ctx.cwd !== fromDir) {
        const cwdPkgDir = `${ctx.cwd}/node_modules/${pkgName}`;
        const cwdPkgPath = `${cwdPkgDir}/package.json`;
        if (fileCache.has(cwdPkgPath)) {
          if (subpath) {
            const subpathFull = `${cwdPkgDir}/${subpath}`;
            if (fileCache.has(subpathFull + '.js')) resolved = subpathFull + '.js';
            else if (fileCache.has(subpathFull)) resolved = subpathFull;
            else if (fileCache.has(subpathFull + '/index.js')) resolved = subpathFull + '/index.js';
            else resolved = subpathFull + '.js';
          } else {
            try {
              const pkg = JSON.parse(fileCache.get(cwdPkgPath)!);
              let main: string | undefined;
              if (pkg.exports) {
                const exp = pkg.exports;
                if (typeof exp === 'string') main = exp;
                else if (exp['.']) {
                  const dotExport = exp['.'];
                  main = typeof dotExport === 'string' ? dotExport
                    : (dotExport.browser || dotExport.import || dotExport.require || dotExport.default);
                } else if (exp.browser || exp.import || exp.require || exp.default) {
                  main = exp.browser || exp.import || exp.require || exp.default;
                }
                if (typeof main === 'object') main = (main as any).browser || (main as any).import || (main as any).require || (main as any).default;
              }
              if (!main) main = pkg.main || pkg.module || 'index.js';
              if (typeof main !== 'string') main = 'index.js';
              main = main.replace(/^\.\//, '');
              if (!/\.(js|cjs|mjs|json)$/.test(main)) {
                const asDir = `${cwdPkgDir}/${main}/index.js`;
                const asFile = `${cwdPkgDir}/${main}.js`;
                if (fileCache.has(asDir) && !fileCache.has(asFile)) main += '/index.js';
                else main += '.js';
              }
              resolved = `${cwdPkgDir}/${main}`;
            } catch {
              resolved = `${cwdPkgDir}/index.js`;
            }
          }
          found = true;
        }
      }
      if (!found) {
        resolved = `${ctx.cwd}/node_modules/${modPath}/index.js`;
      }
    }

    if (moduleCache.has(resolved)) return moduleCache.get(resolved)!.exports;

    const content = fileCache.get(resolved);
    if (content === undefined) {
      // Show helpful debug info
      const nearby = [...fileCache.keys()]
        .filter(k => k.includes(modPath.replace(/^\.\.?\//g, '').replace(/\.js$/, '')))
        .slice(0, 5);
      const hint = nearby.length ? `\nSimilar files in cache: ${nearby.join(', ')}` : '';
      const isNpmPkg = !modPath.startsWith('.') && !modPath.startsWith('/');
      const npmHint = isNpmPkg ? `\nTry: npm install ${modPath.split('/')[0]}` : '';
      throw new Error(`Cannot find module '${modPath}' (resolved: ${resolved})${hint}${npmHint}`);
    }

    if (resolved.endsWith('.json')) {
      const exp = JSON.parse(content);
      moduleCache.set(resolved, { exports: exp });
      return exp;
    }

    const mod = { exports: {} as any };
    moduleCache.set(resolved, mod);
    const modDir = resolved.substring(0, resolved.lastIndexOf('/')) || ctx.cwd;
    const nestedRequire = (p: string) => requireModule(p, modDir);

    try {
      // Transform TypeScript/JSX/ESM syntax to CommonJS
      let transformedContent = content;
      if (resolved.endsWith('.ts') || resolved.endsWith('.tsx')) {
        transformedContent = transformTS(transformedContent);
      }
      if (resolved.endsWith('.tsx') || resolved.endsWith('.jsx')) {
        transformedContent = transformJSX(transformedContent);
      }
      transformedContent = transformESModules(transformedContent);

      const modImportMeta = {
        url: `file://${resolved}`,
        dirname: modDir,
        filename: resolved,
      };
      const fnParams = [
        'module', 'exports', 'require', '__filename', '__dirname',
        'console', 'process', 'global', 'Buffer', '__import_meta',
      ];
      const fnArgs = [mod, mod.exports, nestedRequire, resolved, modDir,
        fakeConsole, fakeProcess, globalThis, FakeBuffer, modImportMeta];

      // Try synchronous execution first — most npm packages don't use top-level await.
      // This ensures module.exports is populated before require() returns,
      // fixing ESM-only packages like chalk v5 that export via `export default`.
      try {
        const syncFn = new Function(...fnParams, transformedContent);
        syncFn(...fnArgs);
      } catch (syncErr: any) {
        // SyntaxError from top-level `await` -> fall back to AsyncFunction
        if (syncErr instanceof SyntaxError && /\bawait\b/.test(transformedContent)) {
          const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
          const wrapped = new AsyncFn(...fnParams, transformedContent);
          const execPromise = wrapped(...fnArgs);
          pendingPromises.push(execPromise.catch((e: any) => {
            if (!(e instanceof ProcessExitError)) {
              console.error(`Error in module ${resolved}:`, e.message, e.stack?.slice(0, 300));
              if (processEvents['uncaughtException']?.length) {
                fakeProcess.emit('uncaughtException', e);
              }
            }
          }));
        } else {
          throw syncErr;
        }
      }

    } catch (err) {
      moduleCache.delete(resolved);
      const errMsg = err instanceof Error ? err.message : String(err);
      const enhancedErr = new Error(`Error loading module '${resolved}': ${errMsg}`);
      if (err instanceof Error && err.stack) {
        enhancedErr.stack = `Error loading module '${resolved}':\n${err.stack}`;
      }
      throw enhancedErr;
    }

    return mod.exports;
  }

  return requireModule;
}
