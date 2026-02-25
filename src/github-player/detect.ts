import type { FileSystem } from '../filesystem';
import type { DetectResult, ProjectKind } from './types';

/**
 * Detect project type by inspecting files in the given directory.
 * Checks in priority order: package.json → index.html → requirements.txt →
 * Makefile → *.c → *.lua → fallback index.html → unknown
 */
export async function detectProject(fs: FileSystem, dir: string): Promise<DetectResult> {
  // 1. package.json (only if it has meaningful Node.js info)
  const pkgResult = await tryPackageJson(fs, dir);
  if (pkgResult) return pkgResult;

  // 2. index.html at root (no package.json or package.json was uninformative)
  if (await fileExists(fs, `${dir}/index.html`)) {
    return { kind: 'static', entry: dir };
  }

  // 3. Python project
  const pyResult = await tryPython(fs, dir);
  if (pyResult) return pyResult;

  // 4. Makefile with C references
  const makeResult = await tryMakefile(fs, dir);
  if (makeResult) return makeResult;

  // 5. C source files (root + one level deep)
  const cResult = await tryCFiles(fs, dir);
  if (cResult) return cResult;

  // 6. Lua files (root + one level deep)
  const luaResult = await tryLua(fs, dir);
  if (luaResult) return luaResult;

  // 7. index.html in subdirectory (fallback)
  const htmlDir = await findIndexHtml(fs, dir);
  if (htmlDir) return { kind: 'static', entry: htmlDir };

  return { kind: 'unknown' };
}

async function fileExists(fs: FileSystem, path: string): Promise<boolean> {
  try {
    const s = await fs.stat(path);
    return s !== null && s.type === 'file';
  } catch { return false; }
}

async function dirExists(fs: FileSystem, path: string): Promise<boolean> {
  try {
    const s = await fs.stat(path);
    return s !== null && s.type === 'dir';
  } catch { return false; }
}

async function readText(fs: FileSystem, path: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path);
    if (typeof raw === 'string') return raw;
    return new TextDecoder().decode(raw);
  } catch { return null; }
}

async function listDir(fs: FileSystem, path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch { return []; }
}

// --- package.json detection ---

const WEB_FRAMEWORK_DEPS = [
  'react', 'react-dom', 'vue', 'svelte', '@sveltejs/kit', 'next', 'nuxt',
  'astro', 'solid-js', 'preact', 'angular', '@angular/core', 'lit',
  'express', 'koa', 'fastify', 'hapi', '@hapi/hapi', 'hono',
];

/** Check if a script is Electron-specific (not a web build command) */
function isElectronScript(script: string | undefined): boolean {
  if (!script) return true; // absence is fine — doesn't indicate a web project
  return /\belectron\b/.test(script) || /\belectron-forge\b/.test(script);
}

async function tryPackageJson(fs: FileSystem, dir: string): Promise<DetectResult | null> {
  const text = await readText(fs, `${dir}/package.json`);
  if (!text) return null;

  let pkg: any;
  try { pkg = JSON.parse(text); } catch { return null; }

  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};
  const allDeps = { ...deps, ...devDeps };
  const scripts = pkg.scripts || {};

  const hasWebDep = WEB_FRAMEWORK_DEPS.some(d => d in allDeps);
  const hasStart = scripts.start;
  const hasDev = scripts.dev;
  const hasBuild = scripts.build;
  const hasDependencies = Object.keys(deps).length > 0 || Object.keys(devDeps).length > 0;

  if (hasWebDep || hasStart || hasDev) {
    // Check if this is an Electron-only project with a root index.html
    // (e.g., jspaint has package.json for Electron but is actually static)
    const isElectronOnly = ('electron' in allDeps || 'electron' in (pkg.devDependencies || {}))
      && !hasWebDep
      && isElectronScript(scripts.start)
      && isElectronScript(scripts.dev);
    if (isElectronOnly && await fileExists(fs, `${dir}/index.html`)) {
      return { kind: 'static', entry: dir };
    }

    const meta: Record<string, string> = {};
    if (hasBuild) meta.build = 'npm run build';
    if (hasStart) meta.start = 'npm start';
    if (hasDev) meta.dev = 'npm run dev';

    // Detect specific framework for logging
    for (const fw of WEB_FRAMEWORK_DEPS) {
      if (fw in allDeps) { meta.framework = fw; break; }
    }

    return { kind: 'node-web', meta };
  }

  // CLI: has main or bin, no web deps
  if (pkg.main || pkg.bin) {
    const entry = typeof pkg.main === 'string' ? pkg.main :
      typeof pkg.bin === 'string' ? pkg.bin :
      typeof pkg.bin === 'object' ? Object.values(pkg.bin)[0] as string :
      undefined;
    return { kind: 'node-cli', entry };
  }

  // package.json with no deps and no meaningful Node.js scripts = metadata-only.
  // Fall through to let other detectors run (might be a C/Lua/Python project
  // that happens to have a package.json for clib/npm metadata).
  // Only start/dev/build/serve indicate a real Node project; install/version/test don't.
  const NODE_SCRIPTS = ['start', 'dev', 'build', 'serve', 'compile', 'watch', 'lint'];
  const hasNodeScript = NODE_SCRIPTS.some(s => s in scripts);
  if (!hasDependencies && !hasNodeScript) {
    return null;
  }

  // Has package.json but nothing obvious — check for index.html (hybrid)
  if (await fileExists(fs, `${dir}/index.html`)) {
    return { kind: 'static', entry: dir };
  }

  // Default to node-cli for any package.json project with actual deps/scripts
  return { kind: 'node-cli', entry: pkg.main || 'index.js' };
}

// --- Python detection ---

const PYTHON_WEB_FRAMEWORKS = ['flask', 'django', 'fastapi', 'starlette', 'tornado', 'bottle', 'sanic'];

async function tryPython(fs: FileSystem, dir: string): Promise<DetectResult | null> {
  const hasRequirements = await fileExists(fs, `${dir}/requirements.txt`);
  const hasSetupPy = await fileExists(fs, `${dir}/setup.py`);
  const hasPyproject = await fileExists(fs, `${dir}/pyproject.toml`);

  if (!hasRequirements && !hasSetupPy && !hasPyproject) {
    // Check for loose .py files at root
    const entries = await listDir(fs, dir);
    const pyFiles = entries.filter(e => e.endsWith('.py'));
    if (pyFiles.length === 0) return null;
    const entry = pyFiles.includes('main.py') ? 'main.py' :
      pyFiles.includes('app.py') ? 'app.py' : pyFiles[0];
    return { kind: 'python-cli', entry };
  }

  // Check requirements for web frameworks
  let isWeb = false;
  if (hasRequirements) {
    const reqs = await readText(fs, `${dir}/requirements.txt`);
    if (reqs) {
      const lower = reqs.toLowerCase();
      isWeb = PYTHON_WEB_FRAMEWORKS.some(fw => lower.includes(fw));
    }
  }

  // Find entry point — check root .py files first (excluding build files)
  const entries = await listDir(fs, dir);
  const BUILD_PY_FILES = ['setup.py', 'conftest.py', 'noxfile.py', 'fabfile.py'];
  const pyFiles = entries.filter(e => e.endsWith('.py') && !BUILD_PY_FILES.includes(e));

  let entry: string | undefined;
  if (pyFiles.includes('main.py')) entry = 'main.py';
  else if (pyFiles.includes('app.py')) entry = 'app.py';
  else if (pyFiles.includes('run.py')) entry = 'run.py';
  else if (pyFiles.length > 0) entry = pyFiles[0];

  // If no root .py files, look for a package with __main__.py
  // (e.g., tqdm/tqdm/__main__.py → run with python3 -m tqdm)
  if (!entry) {
    const repoName = dir.split('/').filter(Boolean).pop() || '';
    // Check common package dirs: repo name, lowercase repo name
    const pkgCandidates = [repoName, repoName.toLowerCase(), 'src'];
    for (const pkgDir of pkgCandidates) {
      if (await fileExists(fs, `${dir}/${pkgDir}/__main__.py`)) {
        entry = pkgDir; // Will be used as module name with -m flag
        break;
      }
    }
    // Also check all subdirectories for __main__.py
    if (!entry) {
      for (const e of entries) {
        if (await fileExists(fs, `${dir}/${e}/__main__.py`)) {
          entry = e;
          break;
        }
      }
    }
  }

  const meta: Record<string, string> = {};
  if (isWeb) meta.webFramework = 'true';
  // If entry is a directory (has __main__.py), flag it for -m invocation
  if (entry && await dirExists(fs, `${dir}/${entry}`)) {
    meta.moduleRun = 'true';
  }

  return {
    kind: isWeb ? 'python-web' : 'python-cli',
    entry,
    meta,
  };
}

// --- Makefile detection ---

async function tryMakefile(fs: FileSystem, dir: string): Promise<DetectResult | null> {
  const text = await readText(fs, `${dir}/Makefile`);
  if (!text) return null;

  // Check if it references C compilation (match .c as word boundary, not .css/.csv)
  if (/\.c\b/.test(text) || text.includes('gcc') || /\bcc\b/.test(text)) {
    return { kind: 'c', meta: { hasMakefile: 'true' } };
  }

  return null;
}

// --- C file detection ---

async function tryCFiles(fs: FileSystem, dir: string): Promise<DetectResult | null> {
  const entries = await listDir(fs, dir);
  const cFiles = entries.filter(e => e.endsWith('.c'));

  if (cFiles.length > 0) {
    const entry = cFiles.includes('main.c') ? 'main.c' : cFiles[0];
    return { kind: 'c', entry };
  }

  // Scan one level deep for .c files (e.g., src/*.c, algorithms/*.c)
  for (const e of entries) {
    const subPath = `${dir}/${e}`;
    if (await dirExists(fs, subPath)) {
      const subEntries = await listDir(fs, subPath);
      const subC = subEntries.filter(f => f.endsWith('.c'));
      if (subC.length > 0) {
        const entry = subC.includes('main.c') ? `${e}/main.c` : `${e}/${subC[0]}`;
        return { kind: 'c', entry, meta: { subdir: e } };
      }
    }
  }

  return null;
}

// --- Lua detection ---

async function tryLua(fs: FileSystem, dir: string): Promise<DetectResult | null> {
  const entries = await listDir(fs, dir);
  const luaFiles = entries.filter(e => e.endsWith('.lua'));

  if (luaFiles.length > 0) {
    const entry = luaFiles.includes('main.lua') ? 'main.lua' :
      luaFiles.includes('init.lua') ? 'init.lua' : luaFiles[0];
    return { kind: 'lua', entry };
  }

  // Scan one level deep for .lua files (e.g., pacpac/*.lua, src/*.lua)
  for (const e of entries) {
    const subPath = `${dir}/${e}`;
    if (await dirExists(fs, subPath)) {
      const subEntries = await listDir(fs, subPath);
      const subLua = subEntries.filter(f => f.endsWith('.lua'));
      if (subLua.length > 0) {
        const entry = subLua.includes('main.lua') ? `${e}/main.lua` :
          subLua.includes('init.lua') ? `${e}/init.lua` : `${e}/${subLua[0]}`;
        return { kind: 'lua', entry, meta: { subdir: e } };
      }
    }
  }

  return null;
}

// --- Find index.html in subdirectories ---

async function findIndexHtml(fs: FileSystem, dir: string): Promise<string | null> {
  const subdirs = ['dist', 'public', 'build', 'docs', 'www', 'site', 'src'];
  for (const sub of subdirs) {
    const subPath = `${dir}/${sub}`;
    if (await dirExists(fs, subPath) && await fileExists(fs, `${subPath}/index.html`)) {
      return subPath;
    }
  }

  // Recursive scan one level deep
  const entries = await listDir(fs, dir);
  for (const e of entries) {
    const p = `${dir}/${e}`;
    if (await dirExists(fs, p) && await fileExists(fs, `${p}/index.html`)) {
      return p;
    }
  }

  return null;
}
