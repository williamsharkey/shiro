import type { RunContext, RunnerResult } from '../types';
import type { DetectResult } from '../types';

/** Safe stat check — returns null on ENOENT instead of throwing */
async function safeStat(ctx: RunContext, path: string) {
  try { return await ctx.fs.stat(path); } catch { return null; }
}

/**
 * Node runner: npm install → optional build → esbuild fallback → serve or run.
 */
export async function runNode(ctx: RunContext, detect: DetectResult): Promise<RunnerResult> {
  const { shell, dir, repoName, log, fs } = ctx;

  // Ensure we're in the project directory
  shell.cwd = dir;

  // Step 1: npm install
  log(`\x1b[36mInstalling dependencies...\x1b[0m`);
  const installCode = await exec(ctx, `cd "${dir}" && npm install`);
  if (installCode !== 0) {
    // npm install failed — try to serve as static if index.html exists
    if ((await safeStat(ctx, `${dir}/index.html`))?.type === 'file') {
      log(`\x1b[33mnpm install failed, falling back to static serve...\x1b[0m`);
      const { runStatic } = await import('./static');
      return runStatic(ctx, dir);
    }
    return { success: false, action: 'npm install', error: `npm install failed (exit ${installCode})` };
  }
  log(`\x1b[32mDependencies installed\x1b[0m`);

  // Step 2: Build if needed
  let buildFailed = false;
  if (detect.meta?.build) {
    log(`\x1b[36mBuilding project...\x1b[0m`);
    const buildCode = await exec(ctx, `cd "${dir}" && npm run build`);
    if (buildCode !== 0) {
      log(`\x1b[33mBuild failed (exit ${buildCode}), trying to continue...\x1b[0m`);
      buildFailed = true;
    } else {
      log(`\x1b[32mBuild complete\x1b[0m`);
    }
  }

  // Step 3: Determine how to run

  // Check for built output directories (dist/, build/, out/, public/)
  const builtDirs = ['dist', 'build', 'out', 'public'];
  for (const d of builtDirs) {
    const builtDir = `${dir}/${d}`;
    if ((await safeStat(ctx, builtDir))?.type === 'dir') {
      if ((await safeStat(ctx, `${builtDir}/index.html`))?.type === 'file') {
        log(`\x1b[36mServing built output from ${d}/\x1b[0m`);
        const { runStatic } = await import('./static');
        return runStatic(ctx, builtDir);
      }
    }
  }

  // Check for index.html at root (some projects don't need a build)
  if ((await safeStat(ctx, `${dir}/index.html`))?.type === 'file') {
    log(`\x1b[36mServing project root\x1b[0m`);
    const { runStatic } = await import('./static');
    return runStatic(ctx, dir);
  }

  // Step 3b: esbuild fallback for node-web projects when build failed or no built output
  if (detect.kind === 'node-web' && (buildFailed || !detect.meta?.build)) {
    const esbuildResult = await tryEsbuildFallback(ctx, dir);
    if (esbuildResult) return esbuildResult;
  }

  // For node-web with start/dev scripts, spawn in a window
  if (detect.kind === 'node-web') {
    if (detect.meta?.start) {
      log(`\x1b[36mStarting server: npm start\x1b[0m`);
      await exec(ctx, `cd "${dir}" && spawn npm start`);
      return { success: true, action: 'spawn:npm start' };
    }
    if (detect.meta?.dev) {
      log(`\x1b[36mStarting dev server: npm run dev\x1b[0m`);
      await exec(ctx, `cd "${dir}" && spawn npm run dev`);
      return { success: true, action: 'spawn:npm run dev' };
    }
  }

  // For CLI projects, run the entry point
  if (detect.kind === 'node-cli' && detect.entry) {
    if ((await safeStat(ctx, `${dir}/${detect.entry}`))?.type === 'file') {
      log(`\x1b[36mRunning: node ${detect.entry}\x1b[0m`);
      const runCode = await exec(ctx, `cd "${dir}" && node "${detect.entry}"`);
      return { success: runCode === 0, action: `node ${detect.entry}` };
    }
  }

  // Fallback: check for main field in package.json
  try {
    const pkgRaw = await fs.readFile(`${dir}/package.json`);
    const pkgText = typeof pkgRaw === 'string' ? pkgRaw : new TextDecoder().decode(pkgRaw);
    const pkg = JSON.parse(pkgText);
    const main = pkg.main || 'index.js';
    if ((await safeStat(ctx, `${dir}/${main}`))?.type === 'file') {
      log(`\x1b[36mRunning: node ${main}\x1b[0m`);
      const runCode = await exec(ctx, `cd "${dir}" && node "${main}"`);
      return { success: runCode === 0, action: `node ${main}` };
    }

    // Try bin entry
    if (pkg.bin) {
      const binEntry = typeof pkg.bin === 'string' ? pkg.bin
        : typeof pkg.bin === 'object' ? Object.values(pkg.bin)[0] as string
        : null;
      if (binEntry && (await safeStat(ctx, `${dir}/${binEntry}`))?.type === 'file') {
        log(`\x1b[36mRunning bin: node ${binEntry}\x1b[0m`);
        const runCode = await exec(ctx, `cd "${dir}" && node "${binEntry}" "Hello World"`);
        return { success: runCode === 0, action: `node ${binEntry}` };
      }
    }
  } catch {}

  // Try examples/ heuristic for library repos
  const exResult = await tryExamples(ctx, dir);
  if (exResult) return exResult;

  return { success: false, action: 'node', error: 'Could not determine how to run this project' };
}

/**
 * esbuild fallback: find an entry point and bundle with esbuild-wasm.
 * Used when npm run build fails (missing vite/rollup/webpack).
 */
async function tryEsbuildFallback(ctx: RunContext, dir: string): Promise<RunnerResult | null> {
  const { log, fs } = ctx;

  // Look for common entry points
  const entryPaths = [
    'src/index.tsx', 'src/index.ts', 'src/main.tsx', 'src/main.ts',
    'src/App.tsx', 'src/index.jsx', 'src/index.js',
    'index.tsx', 'index.ts',
  ];

  let entryPath: string | null = null;
  for (const ep of entryPaths) {
    if ((await safeStat(ctx, `${dir}/${ep}`))?.type === 'file') {
      entryPath = `${dir}/${ep}`;
      break;
    }
  }

  if (!entryPath) return null;

  log(`\x1b[36mesbuild fallback: bundling ${entryPath.replace(dir + '/', '')}...\x1b[0m`);

  try {
    const { ensureEsbuildInitialized, createVirtualFSPlugin } = await import('../../commands/build');

    await ensureEsbuildInitialized();

    // Adapt RunContext to CommandContext shape for the plugin
    const adaptedCtx = { fs, cwd: dir } as any;

    const esbuild = await import('esbuild-wasm');
    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      minify: false,
      format: 'esm' as const,
      target: 'es2020',
      write: false,
      plugins: [createVirtualFSPlugin(adaptedCtx)],
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
    });

    if (result.errors.length > 0) {
      log(`\x1b[33mesbuild fallback failed: ${result.errors[0].text}\x1b[0m`);
      return null;
    }

    if (!result.outputFiles || result.outputFiles.length === 0) {
      return null;
    }

    // Write bundled output
    const distDir = `${dir}/dist`;
    try { await fs.mkdir(distDir); } catch {}

    await fs.writeFile(`${distDir}/bundle.js`, result.outputFiles[0].contents);

    // Generate minimal HTML
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>App</title></head><body><div id="root"></div><div id="app"></div>
<script type="module" src="bundle.js"></script></body></html>`;
    await fs.writeFile(`${distDir}/index.html`, html);

    const sizeKB = (result.outputFiles[0].contents.length / 1024).toFixed(1);
    log(`\x1b[32mesbuild fallback: bundled ${sizeKB}KB → dist/\x1b[0m`);

    const { runStatic } = await import('./static');
    return runStatic(ctx, distDir);
  } catch (e: any) {
    log(`\x1b[33mesbuild fallback error: ${e.message}\x1b[0m`);
    return null;
  }
}

/**
 * Try running example files for library repos that lack a clear entry point.
 */
async function tryExamples(ctx: RunContext, dir: string): Promise<RunnerResult | null> {
  const { log, fs } = ctx;

  const exDirs = ['examples', 'example'];
  for (const exDir of exDirs) {
    const exPath = `${dir}/${exDir}`;
    if ((await safeStat(ctx, exPath))?.type !== 'dir') continue;

    try {
      const entries = await fs.readdir(exPath);
      const jsFiles = entries.filter((e: string) => e.endsWith('.js'));
      if (jsFiles.length > 0) {
        // Prefer demo.js, app.js, index.js, then first alphabetical
        const preferred = ['demo.js', 'app.js', 'index.js', 'basic.js'];
        const pick = preferred.find(p => jsFiles.includes(p)) || jsFiles.sort()[0];
        const exFile = `${exDir}/${pick}`;
        log(`\x1b[36mRunning example: node ${exFile}\x1b[0m`);
        const code = await exec(ctx, `cd "${dir}" && node "${exFile}"`);
        return { success: code === 0, action: `node ${exFile}` };
      }
    } catch {}
  }

  return null;
}

async function exec(ctx: RunContext, cmd: string): Promise<number> {
  return ctx.shell.execute(
    cmd,
    (out: string) => ctx.terminal.term.write(out.replace(/\n/g, '\r\n')),
    (err: string) => ctx.terminal.term.write(`\x1b[31m${err.replace(/\n/g, '\r\n')}\x1b[0m`),
  );
}
