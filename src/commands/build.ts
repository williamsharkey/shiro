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
 */

let esbuildInitialized = false;
let initPromise: Promise<void> | null = null;

async function ensureEsbuildInitialized(): Promise<void> {
  if (esbuildInitialized) return;

  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    try {
      // Initialize esbuild-wasm — use worker:false to avoid web worker
      // issues in browser OS context, and a modern version with fixed
      // WASM initialization (0.20.0 had Go WASM runtime bugs)
      await esbuild.initialize({
        wasmURL: 'https://unpkg.com/esbuild-wasm@0.27.2/esbuild.wasm',
        worker: false,
      });
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
function createVirtualFSPlugin(ctx: CommandContext): esbuild.Plugin {
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
      ctx.stdout += '\nExample:\n';
      ctx.stdout += '  build src/index.ts --outfile=dist/bundle.js --bundle --minify\n';
      return 0;
    }

    try {
      // Initialize esbuild
      ctx.stdout += 'Initializing esbuild...\n';
      await ensureEsbuildInitialized();

      // Parse arguments
      const entryPoint = ctx.args[0];
      const options: any = {
        bundle: false,
        minify: false,
        sourcemap: false,
        format: 'esm',
        target: 'es2020',
      };

      let outfile = 'out.js';

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
        }
      }

      // Resolve entry point
      const entryPath = ctx.fs.resolvePath(entryPoint, ctx.cwd);

      ctx.stdout += `Building ${entryPath}...\n`;

      // Build with esbuild
      const result = await esbuild.build({
        entryPoints: [entryPath],
        bundle: options.bundle,
        minify: options.minify,
        sourcemap: options.sourcemap,
        format: options.format,
        target: options.target,
        write: false, // Don't write to real filesystem
        plugins: [createVirtualFSPlugin(ctx)],
        logLevel: 'silent',
      });

      // Handle build errors
      if (result.errors.length > 0) {
        for (const error of result.errors) {
          ctx.stderr += `Error: ${error.text}\n`;
          if (error.location) {
            ctx.stderr += `  at ${error.location.file}:${error.location.line}:${error.location.column}\n`;
          }
        }
        return 1;
      }

      // Handle warnings
      if (result.warnings.length > 0) {
        for (const warning of result.warnings) {
          ctx.stdout += `Warning: ${warning.text}\n`;
        }
      }

      // Write output to virtual filesystem
      if (result.outputFiles && result.outputFiles.length > 0) {
        const output = result.outputFiles[0];
        const outputPath = ctx.fs.resolvePath(outfile, ctx.cwd);

        // Ensure output directory exists
        const outputDir = outputPath.split('/').slice(0, -1).join('/');
        if (outputDir) {
          try {
            await ctx.fs.mkdir(outputDir);
          } catch {
            // Directory might already exist
          }
        }

        await ctx.fs.writeFile(outputPath, output.contents);

        const sizeKB = (output.contents.length / 1024).toFixed(2);
        ctx.stdout += `✓ Built successfully: ${outputPath} (${sizeKB} KB)\n`;

        // Write sourcemap if generated
        if (options.sourcemap && result.outputFiles.length > 1) {
          const sourcemapOutput = result.outputFiles[1];
          const sourcemapPath = outputPath + '.map';
          await ctx.fs.writeFile(sourcemapPath, sourcemapOutput.contents);
          ctx.stdout += `✓ Generated sourcemap: ${sourcemapPath}\n`;
        }
      }

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
