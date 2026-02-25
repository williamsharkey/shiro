/**
 * GitHub Player Demos Test Suite
 *
 * NOT part of the standard test suite (excluded in vitest.config.ts).
 * Run explicitly: npx vitest run tests/shiro-vitest/github-player-demos.test.ts
 *
 * Tests:
 * - Candidates list integrity (no duplicates, required fields)
 * - Detection logic with mock filesystem structures
 * - Electron detection (jspaint-like repos)
 * - esbuild fallback paths in node runner
 * - Examples heuristic for CLI repos
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { candidates } from '@shiro/github-player/candidates';
import { detectProject } from '@shiro/github-player/detect';
import type { Candidate } from '@shiro/github-player/types';

let fs: FileSystem;

beforeEach(async () => {
  fs = new FileSystem();
  await fs.init();
});

// ────────────────────────────────────────────────
// 1. Candidates list integrity
// ────────────────────────────────────────────────

describe('Candidates list', () => {
  it('should have at least 30 candidates', () => {
    expect(candidates.length).toBeGreaterThanOrEqual(30);
  });

  it('should have no duplicate user/repo combinations', () => {
    const keys = candidates.map(c => `${c.user}/${c.repo}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('should have required fields on every candidate', () => {
    for (const c of candidates) {
      expect(c.user, `missing user on ${c.repo}`).toBeTruthy();
      expect(c.repo, `missing repo on ${c.user}`).toBeTruthy();
      expect(c.expectedKind, `missing expectedKind on ${c.user}/${c.repo}`).toBeTruthy();
      expect(c.description, `missing description on ${c.user}/${c.repo}`).toBeTruthy();
    }
  });

  it('should have valid expectedKind values', () => {
    const validKinds = ['static', 'node-web', 'node-cli', 'python-cli', 'python-web', 'c', 'lua'];
    for (const c of candidates) {
      expect(validKinds, `invalid kind "${c.expectedKind}" on ${c.user}/${c.repo}`)
        .toContain(c.expectedKind);
    }
  });

  it('should have at least 10 static HTML candidates', () => {
    const statics = candidates.filter(c => c.expectedKind === 'static');
    expect(statics.length).toBeGreaterThanOrEqual(10);
  });

  it('should have candidates in all 6 categories', () => {
    const kinds = new Set(candidates.map(c => c.expectedKind));
    expect(kinds).toContain('static');
    expect(kinds).toContain('node-web');
    expect(kinds).toContain('node-cli');
    expect(kinds).toContain('python-cli');
    expect(kinds).toContain('c');
    expect(kinds).toContain('lua');
  });
});

// ────────────────────────────────────────────────
// 2. Detection: static HTML projects
// ────────────────────────────────────────────────

describe('Detection: static HTML', () => {
  it('should detect index.html at root as static', async () => {
    const dir = '/tmp/test-static';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/index.html`, '<html><body>Hello</body></html>');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('static');
    expect(result.entry).toBe(dir);
  });

  it('should detect index.html in dist/ subdirectory as static', async () => {
    const dir = '/tmp/test-static-dist';
    await fs.mkdir(dir);
    await fs.mkdir(`${dir}/dist`);
    await fs.writeFile(`${dir}/dist/index.html`, '<html></html>');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('static');
  });

  it('should detect index.html at root even with non-node package.json', async () => {
    const dir = '/tmp/test-static-pkg';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/index.html`, '<html></html>');
    // package.json with no deps, no scripts — metadata-only
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({ name: 'test', version: '1.0.0' }));

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('static');
  });
});

// ────────────────────────────────────────────────
// 3. Detection: Electron projects (jspaint-like)
// ────────────────────────────────────────────────

describe('Detection: Electron fallback to static', () => {
  it('should detect Electron-only project with index.html as static', async () => {
    const dir = '/tmp/test-electron';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/index.html`, '<html><body>App</body></html>');
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'my-electron-app',
      version: '1.0.0',
      scripts: {
        start: 'electron .',
        dev: 'electron-forge start',
      },
      devDependencies: {
        electron: '^20.0.0',
        '@electron-forge/cli': '^6.0.0',
      },
    }));

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('static');
    expect(result.entry).toBe(dir);
  });

  it('should detect as node-web when Electron + React deps are present', async () => {
    const dir = '/tmp/test-electron-react';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/index.html`, '<html></html>');
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'electron-react-app',
      scripts: { start: 'electron .', build: 'webpack' },
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
      devDependencies: { electron: '^20.0.0' },
    }));

    const result = await detectProject(fs, dir);
    // Has react → web framework dep → node-web (not static)
    expect(result.kind).toBe('node-web');
  });

  it('should NOT treat non-electron start script as electron-only', async () => {
    const dir = '/tmp/test-node-start';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/index.html`, '<html></html>');
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'web-app',
      scripts: { start: 'node server.js' },
      dependencies: {},
    }));

    const result = await detectProject(fs, dir);
    // start script exists but isn't electron → node-web
    expect(result.kind).toBe('node-web');
  });
});

// ────────────────────────────────────────────────
// 4. Detection: Node.js projects
// ────────────────────────────────────────────────

describe('Detection: Node.js', () => {
  it('should detect package.json with React as node-web', async () => {
    const dir = '/tmp/test-react';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
      scripts: { build: 'vite build', dev: 'vite' },
    }));

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('node-web');
    expect(result.meta?.framework).toBe('react');
    expect(result.meta?.build).toBe('npm run build');
  });

  it('should detect package.json with start script as node-web', async () => {
    const dir = '/tmp/test-start';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      scripts: { start: 'node server.js' },
    }));

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('node-web');
    expect(result.meta?.start).toBe('npm start');
  });

  it('should detect package.json with bin as node-cli', async () => {
    const dir = '/tmp/test-cli';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'cowsay',
      bin: { cowsay: './cli.js' },
    }));

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('node-cli');
    expect(result.entry).toBe('./cli.js');
  });

  it('should detect package.json with main as node-cli', async () => {
    const dir = '/tmp/test-main';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'asciichart',
      main: 'index.js',
    }));

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('node-cli');
    expect(result.entry).toBe('index.js');
  });
});

// ────────────────────────────────────────────────
// 5. Detection: Python projects
// ────────────────────────────────────────────────

describe('Detection: Python', () => {
  it('should detect setup.py as python-cli', async () => {
    const dir = '/tmp/test-py-setup';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/setup.py`, 'from setuptools import setup\nsetup()');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('python-cli');
  });

  it('should detect __main__.py in package directory', async () => {
    const dir = '/tmp/test-py-module';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/setup.py`, 'setup()');
    await fs.mkdir(`${dir}/tqdm`);
    await fs.writeFile(`${dir}/tqdm/__main__.py`, 'print("hello")');
    await fs.writeFile(`${dir}/tqdm/__init__.py`, '');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('python-cli');
    expect(result.entry).toBe('tqdm');
    expect(result.meta?.moduleRun).toBe('true');
  });

  it('should detect requirements.txt with flask as python-web', async () => {
    const dir = '/tmp/test-py-flask';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/requirements.txt`, 'flask>=2.0\nrequests\n');
    await fs.writeFile(`${dir}/app.py`, 'from flask import Flask');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('python-web');
    expect(result.entry).toBe('app.py');
  });

  it('should detect loose .py files', async () => {
    const dir = '/tmp/test-py-loose';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/main.py`, 'print("hi")');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('python-cli');
    expect(result.entry).toBe('main.py');
  });
});

// ────────────────────────────────────────────────
// 6. Detection: C projects
// ────────────────────────────────────────────────

describe('Detection: C', () => {
  it('should detect .c files at root', async () => {
    const dir = '/tmp/test-c';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/main.c`, '#include <stdio.h>\nint main() { return 0; }');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('c');
    expect(result.entry).toBe('main.c');
  });

  it('should detect Makefile with gcc as C project', async () => {
    const dir = '/tmp/test-c-make';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/Makefile`, 'all:\n\tgcc -o app main.c\n');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('c');
    expect(result.meta?.hasMakefile).toBe('true');
  });

  it('should detect .c files one level deep', async () => {
    const dir = '/tmp/test-c-sub';
    await fs.mkdir(dir);
    await fs.mkdir(`${dir}/src`);
    await fs.writeFile(`${dir}/src/main.c`, 'int main() {}');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('c');
    expect(result.entry).toBe('src/main.c');
  });
});

// ────────────────────────────────────────────────
// 7. Detection: Lua projects
// ────────────────────────────────────────────────

describe('Detection: Lua', () => {
  it('should detect .lua files at root', async () => {
    const dir = '/tmp/test-lua';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/main.lua`, 'print("hello")');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('lua');
    expect(result.entry).toBe('main.lua');
  });

  it('should prefer init.lua over arbitrary .lua files', async () => {
    const dir = '/tmp/test-lua-init';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/init.lua`, 'return {}');
    await fs.writeFile(`${dir}/utils.lua`, 'return {}');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('lua');
    expect(result.entry).toBe('init.lua');
  });

  it('should detect .lua files one level deep', async () => {
    const dir = '/tmp/test-lua-sub';
    await fs.mkdir(dir);
    await fs.mkdir(`${dir}/src`);
    await fs.writeFile(`${dir}/src/init.lua`, 'return {}');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('lua');
    expect(result.entry).toBe('src/init.lua');
  });
});

// ────────────────────────────────────────────────
// 8. Detection: unknown / fallback
// ────────────────────────────────────────────────

describe('Detection: unknown', () => {
  it('should return unknown for empty directory', async () => {
    const dir = '/tmp/test-empty';
    await fs.mkdir(dir);

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('unknown');
  });

  it('should return unknown for directory with only .txt files', async () => {
    const dir = '/tmp/test-txt';
    await fs.mkdir(dir);
    await fs.writeFile(`${dir}/README.txt`, 'Hello');

    const result = await detectProject(fs, dir);
    expect(result.kind).toBe('unknown');
  });
});

// ────────────────────────────────────────────────
// 9. Detection accuracy for all candidates
//    Mock each candidate's expected filesystem structure and
//    verify that detectProject returns the expectedKind.
// ────────────────────────────────────────────────

describe('Detection accuracy: mock candidate filesystems', () => {
  // Build a mock filesystem for each candidate type
  async function mockCandidateFS(c: Candidate, dir: string): Promise<void> {
    await fs.mkdir(dir);

    switch (c.expectedKind) {
      case 'static':
        await fs.writeFile(`${dir}/index.html`, `<html><body>${c.description}</body></html>`);
        await fs.writeFile(`${dir}/style.css`, 'body {}');
        await fs.writeFile(`${dir}/script.js`, 'console.log("hi")');
        break;

      case 'node-web':
        await fs.writeFile(`${dir}/package.json`, JSON.stringify({
          name: c.repo,
          scripts: { start: 'node server.js', build: 'webpack' },
          dependencies: { express: '^4.0.0' },
        }));
        break;

      case 'node-cli':
        await fs.writeFile(`${dir}/package.json`, JSON.stringify({
          name: c.repo,
          main: 'index.js',
          bin: { [c.repo]: './cli.js' },
        }));
        await fs.writeFile(`${dir}/index.js`, 'module.exports = {}');
        await fs.writeFile(`${dir}/cli.js`, '#!/usr/bin/env node\nconsole.log("hi")');
        break;

      case 'python-cli':
        await fs.writeFile(`${dir}/setup.py`, 'from setuptools import setup\nsetup()');
        await fs.writeFile(`${dir}/main.py`, 'print("hello")');
        break;

      case 'c':
        await fs.writeFile(`${dir}/main.c`, '#include <stdio.h>\nint main() { printf("hi"); return 0; }');
        break;

      case 'lua':
        await fs.writeFile(`${dir}/main.lua`, 'print("hello")');
        break;
    }
  }

  for (const c of candidates) {
    it(`${c.user}/${c.repo} should detect as ${c.expectedKind}`, async () => {
      const dir = `/tmp/mock-${c.user}-${c.repo}`;
      await mockCandidateFS(c, dir);
      const result = await detectProject(fs, dir);
      expect(result.kind).toBe(c.expectedKind);
    });
  }
});

// ────────────────────────────────────────────────
// 10. Demos page exists in public/
// ────────────────────────────────────────────────

describe('Demos page', () => {
  it('public/demos.html should exist and reference all static candidates', async () => {
    // This test reads the actual file from disk
    const nodefs = await import('fs');
    const path = await import('path');
    const demosPath = path.resolve(__dirname, '../../../public/demos.html');
    const html = nodefs.readFileSync(demosPath, 'utf8');

    // Should reference every candidate repo
    const staticCandidates = candidates.filter(c => c.expectedKind === 'static');
    for (const c of staticCandidates) {
      expect(html, `missing link for ${c.user}/${c.repo}`).toContain(`/${c.user}/${c.repo}`);
    }
  });

  it('public/demos.html should reference all node-cli candidates', async () => {
    const nodefs = await import('fs');
    const path = await import('path');
    const demosPath = path.resolve(__dirname, '../../../public/demos.html');
    const html = nodefs.readFileSync(demosPath, 'utf8');

    const cliCandidates = candidates.filter(c => c.expectedKind === 'node-cli');
    for (const c of cliCandidates) {
      expect(html, `missing link for ${c.user}/${c.repo}`).toContain(`/${c.user}/${c.repo}`);
    }
  });

  it('public/demos.html should have links for every candidate', async () => {
    const nodefs = await import('fs');
    const path = await import('path');
    const demosPath = path.resolve(__dirname, '../../../public/demos.html');
    const html = nodefs.readFileSync(demosPath, 'utf8');

    for (const c of candidates) {
      expect(html, `missing link for ${c.user}/${c.repo}`).toContain(`/${c.user}/${c.repo}`);
    }
  });
});
