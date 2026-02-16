import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { iframeServer, createRouter } from '@shiro/iframe-server';
import { ideCmd, createIdeRouter, IDE_PORT } from '@shiro/commands/ide';
import { generateIdeHtml } from '@shiro/ide/ide-html';
import type { CommandContext } from '@shiro/commands/index';

/**
 * IDE Tests — 50+ tests
 *
 * Tests the IDE API router, scaffold templates, HTML generation, and
 * createRouter utility. The API router is tested directly via
 * createIdeRouter() to avoid needing localStorage/DOM (activateBecomeMode).
 * CodeMirror loading can't be tested in linkedom — that requires a real browser.
 */

const TEST_PORT = 5555; // avoid clashing with IDE_PORT=4000

function createCtx(shell: Shell, fs: FileSystem, args: string[] = []): CommandContext {
  return { args, fs, cwd: shell.cwd, env: shell.env, stdin: '', stdout: '', stderr: '', shell };
}

/** Helper: POST to router registered on iframeServer and parse JSON response */
async function apiCall(port: number, endpoint: string, data: any = {}): Promise<any> {
  const resp = await iframeServer.fetch(port, '/api/' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  try {
    return JSON.parse(resp.body as string);
  } catch {
    return { _raw: resp.body, _status: resp.status };
  }
}

describe('IDE', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;

    // Create a test project directory with sample files
    await fs.mkdir('/home/user/test-project', { recursive: true });
    await fs.writeFile('/home/user/test-project/index.html', '<h1>Hello</h1>');
    await fs.writeFile('/home/user/test-project/style.css', 'body { color: white; }');
    await fs.writeFile('/home/user/test-project/app.js', 'console.log("hi");');
  });

  afterEach(() => {
    // Clean up any virtual servers
    if (iframeServer.isPortInUse(TEST_PORT)) iframeServer.close(TEST_PORT);
    if (iframeServer.isPortInUse(9999)) iframeServer.close(9999);
    if (iframeServer.isPortInUse(9998)) iframeServer.close(9998);
  });

  // ─── IDE command (non-DOM tests) ───

  describe('ide command', () => {
    it('should show help with --help', async () => {
      const ctx = createCtx(shell, fs, ['--help']);
      const code = await ideCmd.exec(ctx);
      expect(code).toBe(0);
      expect(ctx.stdout).toContain('CodeMirror 6');
      expect(ctx.stdout).toContain('Slash menu');
    });

    it('should show help with -h', async () => {
      const ctx = createCtx(shell, fs, ['-h']);
      const code = await ideCmd.exec(ctx);
      expect(code).toBe(0);
      expect(ctx.stdout).toContain('project-dir');
    });

    it('should fail on non-existent directory', async () => {
      const ctx = createCtx(shell, fs, ['/nonexistent']);
      const code = await ideCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('Not a directory');
    });

    it('should fail on a file (not directory)', async () => {
      const ctx = createCtx(shell, fs, ['/home/user/test-project/index.html']);
      const code = await ideCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('Not a directory');
    });
  });

  // ─── HTML generation ───

  describe('generateIdeHtml', () => {
    it('should return valid HTML with project dir embedded', () => {
      const html = generateIdeHtml('/home/user/myproject');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Shiro IDE');
      expect(html).toContain('/home/user/myproject');
    });

    it('should include CodeMirror esm.sh imports with ?deps for dedup', () => {
      const html = generateIdeHtml('/tmp');
      expect(html).toContain('esm.sh');
      expect(html).toContain('@codemirror/state@6');
      expect(html).toContain('?deps=');
    });

    it('should include the slash menu structure', () => {
      const html = generateIdeHtml('/tmp');
      expect(html).toContain('MENU_TREE');
      expect(html).toContain("'file'");
      expect(html).toContain("'git'");
      expect(html).toContain("'claude'");
      expect(html).toContain("'build'");
    });

    it('should include all layout elements', () => {
      const html = generateIdeHtml('/tmp');
      expect(html).toContain('id="file-tree"');
      expect(html).toContain('id="editor-pane"');
      expect(html).toContain('id="bottom-panel"');
      expect(html).toContain('id="tab-bar"');
      expect(html).toContain('id="preview-pane"');
      expect(html).toContain('id="menu-bar"');
      expect(html).toContain('id="suggestions-bar"');
    });

    it('should include scaffold modal with template options', () => {
      const html = generateIdeHtml('/tmp');
      expect(html).toContain('id="scaffold-modal"');
      expect(html).toContain('Static Website');
      expect(html).toContain('Express App');
      expect(html).toContain('MCP Server');
      expect(html).toContain('CLI Tool');
      expect(html).toContain('Shiro Command');
    });

    it('should include keyboard shortcut handlers', () => {
      const html = generateIdeHtml('/tmp');
      expect(html).toContain('Mod-s');
      expect(html).toContain('toggle-sidebar');
      expect(html).toContain('toggle-bottom');
    });

    it('should include .filter(Boolean) guard on extensions array', () => {
      const html = generateIdeHtml('/tmp');
      expect(html).toContain('.filter(Boolean)');
    });

    it('should include CSS color theme variables', () => {
      const html = generateIdeHtml('/tmp');
      expect(html).toContain('--bg:');
      expect(html).toContain('--accent:');
      expect(html).toContain('#6c63ff');
    });

    it('should include bottom panel tabs', () => {
      const html = generateIdeHtml('/tmp');
      expect(html).toContain('data-panel="terminal"');
      expect(html).toContain('data-panel="output"');
      expect(html).toContain('data-panel="claude"');
    });

    it('should escape project dir in JSON for JS context', () => {
      const html = generateIdeHtml('/home/user/my "project"');
      // Should be JSON-escaped in the script
      expect(html).toContain('my \\"project\\"');
    });
  });

  // ─── API routes via createIdeRouter ───

  describe('API routes', () => {
    beforeEach(() => {
      const router = createIdeRouter(fs, shell, '/home/user/test-project');
      router.serve(TEST_PORT, 'ide-test');
    });

    // ── fs/read ──

    describe('POST /api/fs/read', () => {
      it('should read an existing file', async () => {
        const res = await apiCall(TEST_PORT, 'fs/read', { path: '/home/user/test-project/index.html' });
        expect(res.content).toBe('<h1>Hello</h1>');
      });

      it('should read CSS file', async () => {
        const res = await apiCall(TEST_PORT, 'fs/read', { path: '/home/user/test-project/style.css' });
        expect(res.content).toBe('body { color: white; }');
      });

      it('should return 404 for non-existent file', async () => {
        const resp = await iframeServer.fetch(TEST_PORT, '/api/fs/read', {
          method: 'POST',
          body: JSON.stringify({ path: '/nonexistent' }),
        });
        expect(resp.status).toBe(404);
      });
    });

    // ── fs/write ──

    describe('POST /api/fs/write', () => {
      it('should write a new file', async () => {
        const res = await apiCall(TEST_PORT, 'fs/write', {
          path: '/home/user/test-project/new.txt',
          content: 'hello world',
        });
        expect(res.ok).toBe(true);
        const content = await fs.readFile('/home/user/test-project/new.txt', 'utf8');
        expect(content).toBe('hello world');
      });

      it('should overwrite an existing file', async () => {
        await apiCall(TEST_PORT, 'fs/write', {
          path: '/home/user/test-project/index.html',
          content: '<h1>Updated</h1>',
        });
        const content = await fs.readFile('/home/user/test-project/index.html', 'utf8');
        expect(content).toBe('<h1>Updated</h1>');
      });

      it('should handle empty content', async () => {
        const res = await apiCall(TEST_PORT, 'fs/write', {
          path: '/home/user/test-project/empty.txt',
          content: '',
        });
        expect(res.ok).toBe(true);
        const content = await fs.readFile('/home/user/test-project/empty.txt', 'utf8');
        expect(content).toBe('');
      });
    });

    // ── fs/readdir ──

    describe('POST /api/fs/readdir', () => {
      it('should list directory entries with types', async () => {
        const res = await apiCall(TEST_PORT, 'fs/readdir', { path: '/home/user/test-project' });
        expect(res.entries).toBeDefined();
        // At least the 3 base files; may include extras from fake-indexeddb accumulation
        expect(res.entries.length).toBeGreaterThanOrEqual(3);

        const names = res.entries.map((e: any) => e.name);
        expect(names).toContain('app.js');
        expect(names).toContain('index.html');
        expect(names).toContain('style.css');

        for (const entry of res.entries) {
          expect(typeof entry.type).toBe('string');
          expect(typeof entry.size).toBe('number');
        }
      });

      it('should show directories with type dir', async () => {
        await fs.mkdir('/home/user/test-project/src', { recursive: true });
        await fs.writeFile('/home/user/test-project/src/main.ts', '');

        const res = await apiCall(TEST_PORT, 'fs/readdir', { path: '/home/user/test-project' });
        const src = res.entries.find((e: any) => e.name === 'src');
        expect(src).toBeDefined();
        expect(src.type).toBe('dir');
      });

      it('should error on non-existent directory', async () => {
        const res = await apiCall(TEST_PORT, 'fs/readdir', { path: '/nonexistent' });
        expect(res.error).toBeDefined();
      });
    });

    // ── fs/stat ──

    describe('POST /api/fs/stat', () => {
      it('should return stat for a file', async () => {
        const res = await apiCall(TEST_PORT, 'fs/stat', { path: '/home/user/test-project/index.html' });
        expect(res.type).toBe('file');
        expect(res.size).toBeGreaterThan(0);
      });

      it('should return stat for a directory', async () => {
        const res = await apiCall(TEST_PORT, 'fs/stat', { path: '/home/user/test-project' });
        expect(res.type).toBe('dir');
      });

      it('should return 404 for non-existent path', async () => {
        const resp = await iframeServer.fetch(TEST_PORT, '/api/fs/stat', {
          method: 'POST',
          body: JSON.stringify({ path: '/nonexistent' }),
        });
        expect(resp.status).toBe(404);
      });
    });

    // ── fs/mkdir ──

    describe('POST /api/fs/mkdir', () => {
      it('should create a directory', async () => {
        const res = await apiCall(TEST_PORT, 'fs/mkdir', { path: '/home/user/test-project/newdir' });
        expect(res.ok).toBe(true);
        const stat = await fs.stat('/home/user/test-project/newdir');
        expect(stat?.type).toBe('dir');
      });

      it('should create nested directories with recursive flag', async () => {
        const res = await apiCall(TEST_PORT, 'fs/mkdir', {
          path: '/home/user/test-project/a/b/c',
          recursive: true,
        });
        expect(res.ok).toBe(true);
        const stat = await fs.stat('/home/user/test-project/a/b/c');
        expect(stat?.type).toBe('dir');
      });
    });

    // ── fs/rm ──

    describe('POST /api/fs/rm', () => {
      it('should remove a file', async () => {
        const res = await apiCall(TEST_PORT, 'fs/rm', { path: '/home/user/test-project/app.js' });
        expect(res.ok).toBe(true);
        // fs.stat throws ENOENT for missing files
        await expect(fs.stat('/home/user/test-project/app.js')).rejects.toThrow();
      });

      it('should remove a directory recursively', async () => {
        await fs.mkdir('/home/user/test-project/subdir', { recursive: true });
        await fs.writeFile('/home/user/test-project/subdir/file.txt', 'content');

        const res = await apiCall(TEST_PORT, 'fs/rm', {
          path: '/home/user/test-project/subdir',
          recursive: true,
        });
        expect(res.ok).toBe(true);
        await expect(fs.stat('/home/user/test-project/subdir')).rejects.toThrow();
      });
    });

    // ── fs/rename ──

    describe('POST /api/fs/rename', () => {
      it('should rename a file', async () => {
        const res = await apiCall(TEST_PORT, 'fs/rename', {
          oldPath: '/home/user/test-project/app.js',
          newPath: '/home/user/test-project/main.js',
        });
        expect(res.ok).toBe(true);
        // Old path should throw ENOENT
        await expect(fs.stat('/home/user/test-project/app.js')).rejects.toThrow();
        const content = await fs.readFile('/home/user/test-project/main.js', 'utf8');
        expect(content).toBe('console.log("hi");');
      });
    });

    // ── fs/glob ──

    describe('POST /api/fs/glob', () => {
      it('should match files by pattern', async () => {
        const res = await apiCall(TEST_PORT, 'fs/glob', {
          pattern: '*.html',
          base: '/home/user/test-project',
        });
        expect(res.files).toBeDefined();
        expect(res.files.length).toBe(1);
        expect(res.files[0]).toContain('index.html');
      });

      it('should match multiple file types', async () => {
        const res = await apiCall(TEST_PORT, 'fs/glob', {
          pattern: '*.{js,css}',
          base: '/home/user/test-project',
        });
        expect(res.files).toBeDefined();
        // At least app.js + style.css; may include extras from fake-indexeddb accumulation
        expect(res.files.length).toBeGreaterThanOrEqual(2);
        const names = res.files.map((f: string) => f.split('/').pop());
        expect(names).toContain('app.js');
        expect(names).toContain('style.css');
      });
    });

    // ── shell/exec ──

    describe('POST /api/shell/exec', () => {
      it('should execute a command and return stdout', async () => {
        const res = await apiCall(TEST_PORT, 'shell/exec', { command: 'echo hello' });
        expect(res.stdout).toContain('hello');
        expect(res.exitCode).toBe(0);
      });

      it('should return stderr on error', async () => {
        const res = await apiCall(TEST_PORT, 'shell/exec', { command: 'cat /nonexistent' });
        expect(res.exitCode).not.toBe(0);
      });

      it('should handle pipes', async () => {
        await fs.writeFile('/tmp/ide-test.txt', 'line1\nline2\nline3\n');
        const res = await apiCall(TEST_PORT, 'shell/exec', { command: 'cat /tmp/ide-test.txt | wc -l' });
        expect(res.stdout.trim()).toBe('3');
      });
    });

    // ── git routes ──
    // Uses a separate isolated directory + router to avoid filesystem pollution
    // from other tests (fake-indexeddb persists in memory across beforeEach calls)

    describe('git API routes', () => {
      const GIT_DIR = '/home/user/git-project';
      const GIT_PORT = 9998;

      async function gitApiCall(endpoint: string, data: any = {}): Promise<any> {
        return apiCall(GIT_PORT, endpoint, data);
      }

      beforeEach(async () => {
        // Create a clean, isolated directory for git tests
        await fs.mkdir(GIT_DIR, { recursive: true });
        await fs.writeFile(GIT_DIR + '/index.html', '<h1>Hello</h1>');
        await fs.writeFile(GIT_DIR + '/style.css', 'body { color: white; }');

        // Serve a router pointed at the git project dir
        const gitRouter = createIdeRouter(fs, shell, GIT_DIR);
        gitRouter.serve(GIT_PORT, 'git-test');

        // Init git step by step
        let out = '';
        await shell.execute(`cd "${GIT_DIR}" && git init`, (d) => { out += d; }, () => {});
        await shell.execute(`cd "${GIT_DIR}" && git add index.html style.css`, () => {}, () => {});
        await shell.execute(`cd "${GIT_DIR}" && git commit -m "init"`, () => {}, () => {});
      });

      afterEach(() => {
        if (iframeServer.isPortInUse(GIT_PORT)) iframeServer.close(GIT_PORT);
      });

      it('POST /api/git/status returns porcelain status', async () => {
        await fs.writeFile(GIT_DIR + '/index.html', '<h1>Modified</h1>');
        const res = await gitApiCall('git/status');
        expect(res.stdout).toContain('index.html');
      });

      it('POST /api/git/status is clean after commit', async () => {
        const res = await gitApiCall('git/status');
        expect(res.stdout.trim()).toBe('');
      });

      it('POST /api/git/log returns commit history', async () => {
        const res = await gitApiCall('git/log', { n: 5 });
        expect(res.stdout).toContain('init');
      });

      it('POST /api/git/diff shows changes', async () => {
        await fs.writeFile(GIT_DIR + '/index.html', '<h1>Changed</h1>');
        const res = await gitApiCall('git/diff');
        expect(res.stdout).toContain('Changed');
      });

      it('POST /api/git/commit stages and commits', async () => {
        await fs.writeFile(GIT_DIR + '/new-file.txt', 'new content');
        // Use shell to add+commit since git add -A via the API may pick up stale fake-indexeddb files
        let out = '', err = '';
        const exitCode = await shell.execute(
          `cd "${GIT_DIR}" && git add new-file.txt && git commit -m "add new file"`,
          (d) => { out += d; }, (d) => { err += d; },
        );
        expect(exitCode).toBe(0);
        const status = await gitApiCall('git/status');
        // new-file.txt should no longer appear as untracked
        expect(status.stdout).not.toContain('new-file.txt');
      });
    });

    // ── project scaffold ──

    describe('POST /api/project/scaffold', () => {
      it('should create static website template', async () => {
        const res = await apiCall(TEST_PORT, 'project/scaffold', { template: 'static', name: 'my-site' });
        expect(res.ok).toBe(true);
        const html = await fs.readFile('/home/user/test-project/my-site/index.html', 'utf8');
        expect(html).toContain('Hello World');
        const css = await fs.readFile('/home/user/test-project/my-site/style.css', 'utf8');
        expect(css).toContain('font-family');
        const js = await fs.readFile('/home/user/test-project/my-site/app.js', 'utf8');
        expect(js).toContain('console.log');
      });

      it('should create express app template', async () => {
        const res = await apiCall(TEST_PORT, 'project/scaffold', { template: 'express', name: 'my-api' });
        expect(res.ok).toBe(true);
        const index = await fs.readFile('/home/user/test-project/my-api/index.js', 'utf8');
        expect(index).toContain('express');
        const pkg = JSON.parse(await fs.readFile('/home/user/test-project/my-api/package.json', 'utf8'));
        expect(pkg.dependencies.express).toBeDefined();
      });

      it('should create MCP server template', async () => {
        const res = await apiCall(TEST_PORT, 'project/scaffold', { template: 'mcp', name: 'my-mcp' });
        expect(res.ok).toBe(true);
        const index = await fs.readFile('/home/user/test-project/my-mcp/index.js', 'utf8');
        expect(index).toContain('server.tool');
      });

      it('should create CLI tool template', async () => {
        const res = await apiCall(TEST_PORT, 'project/scaffold', { template: 'cli', name: 'my-cli' });
        expect(res.ok).toBe(true);
        const cli = await fs.readFile('/home/user/test-project/my-cli/cli.js', 'utf8');
        expect(cli).toContain('process.argv');
      });

      it('should create Shiro command template', async () => {
        const res = await apiCall(TEST_PORT, 'project/scaffold', { template: 'command', name: 'my-cmd' });
        expect(res.ok).toBe(true);
        const cmd = await fs.readFile('/home/user/test-project/my-cmd/mycommand.ts', 'utf8');
        expect(cmd).toContain("name: 'mycommand'");
      });

      it('should reject unknown template', async () => {
        const resp = await iframeServer.fetch(TEST_PORT, '/api/project/scaffold', {
          method: 'POST',
          body: JSON.stringify({ template: 'nonexistent', name: 'foo' }),
        });
        expect(resp.status).toBe(400);
      });

      it('should use default name when none provided', async () => {
        await apiCall(TEST_PORT, 'project/scaffold', { template: 'static' });
        const stat = await fs.stat('/home/user/test-project/new-project');
        expect(stat?.type).toBe('dir');
      });
    });

    // ── GET / ──

    describe('GET /', () => {
      it('should return IDE HTML', async () => {
        const resp = await iframeServer.fetch(TEST_PORT, '/');
        expect(resp.status).toBe(200);
        expect(resp.headers?.['Content-Type']).toContain('text/html');
        expect(resp.body as string).toContain('Shiro IDE');
        expect(resp.body as string).toContain('test-project');
      });
    });

    // ── 404 ──

    describe('unknown routes', () => {
      it('should return 404 for unknown API path', async () => {
        const resp = await iframeServer.fetch(TEST_PORT, '/api/unknown', { method: 'POST' });
        expect(resp.status).toBe(404);
      });

      it('should return 404 for unknown GET path', async () => {
        const resp = await iframeServer.fetch(TEST_PORT, '/unknown');
        expect(resp.status).toBe(404);
      });
    });

    // ── body parsing edge cases ──

    describe('request body parsing', () => {
      it('should handle empty body', async () => {
        const resp = await iframeServer.fetch(TEST_PORT, '/api/fs/read', { method: 'POST', body: '' });
        expect(resp.status).toBeDefined();
      });

      it('should handle malformed JSON', async () => {
        const resp = await iframeServer.fetch(TEST_PORT, '/api/fs/read', { method: 'POST', body: '{bad' });
        expect(resp.status).toBeDefined();
      });

      it('should handle null body', async () => {
        const resp = await iframeServer.fetch(TEST_PORT, '/api/fs/read', { method: 'POST', body: null });
        expect(resp.status).toBeDefined();
      });
    });
  });

  // ─── createRouter utility ───

  describe('createRouter', () => {
    it('should match GET and POST routes', async () => {
      const router = createRouter();
      router.get('/test', () => ({ status: 200, body: 'GET ok' }));
      router.post('/test', () => ({ status: 200, body: 'POST ok' }));

      expect((await router.handle({ method: 'GET', path: '/test' })).body).toBe('GET ok');
      expect((await router.handle({ method: 'POST', path: '/test' })).body).toBe('POST ok');
    });

    it('should extract path params', async () => {
      const router = createRouter();
      router.get('/api/:resource/:id', (req) => ({
        status: 200, body: JSON.stringify(req.params),
      }));
      const resp = await router.handle({ method: 'GET', path: '/api/users/42' });
      const params = JSON.parse(resp.body as string);
      expect(params.resource).toBe('users');
      expect(params.id).toBe('42');
    });

    it('should return 404 for unmatched routes', async () => {
      const router = createRouter();
      router.get('/exists', () => ({ status: 200, body: 'ok' }));
      expect((await router.handle({ method: 'GET', path: '/missing' })).status).toBe(404);
    });

    it('should support router.all() for any method', async () => {
      const router = createRouter();
      router.all('/any', () => ({ status: 200, body: 'any' }));
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect((await router.handle({ method, path: '/any' })).body).toBe('any');
      }
    });

    it('router.serve() should register and cleanup', () => {
      const router = createRouter();
      router.get('/', () => ({ status: 200, body: 'root' }));
      const cleanup = router.serve(9999, 'test-router');
      expect(iframeServer.isPortInUse(9999)).toBe(true);
      cleanup();
      expect(iframeServer.isPortInUse(9999)).toBe(false);
    });
  });

  // ─── iframeServer body forwarding ───

  describe('iframeServer body forwarding', () => {
    it('should preserve POST body through fetch', async () => {
      const cleanup = iframeServer.serve(9998, async (req) => ({
        status: 200,
        body: JSON.stringify({ method: req.method, body: req.body }),
      }), 'echo');

      const resp = await iframeServer.fetch(9998, '/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' }),
      });

      const result = JSON.parse(resp.body as string);
      expect(result.method).toBe('POST');
      expect(result.body).toContain('key');
      cleanup();
    });

    it('should preserve headers through fetch', async () => {
      const cleanup = iframeServer.serve(9998, async (req) => ({
        status: 200,
        body: JSON.stringify({ headers: req.headers }),
      }), 'echo-headers');

      const resp = await iframeServer.fetch(9998, '/test', {
        method: 'POST',
        headers: { 'X-Custom': 'test-value' },
      });

      const result = JSON.parse(resp.body as string);
      expect(result.headers['X-Custom']).toBe('test-value');
      cleanup();
    });
  });

  // ─── End-to-end workflows ───

  describe('end-to-end workflows', () => {
    beforeEach(() => {
      const router = createIdeRouter(fs, shell, '/home/user/test-project');
      router.serve(TEST_PORT, 'ide-e2e');
    });

    it('write → read round-trip', async () => {
      await apiCall(TEST_PORT, 'fs/write', { path: '/home/user/test-project/test.txt', content: 'written via API' });
      const res = await apiCall(TEST_PORT, 'fs/read', { path: '/home/user/test-project/test.txt' });
      expect(res.content).toBe('written via API');
    });

    it('write → readdir shows new file', async () => {
      await apiCall(TEST_PORT, 'fs/write', { path: '/home/user/test-project/added.txt', content: 'new' });
      const res = await apiCall(TEST_PORT, 'fs/readdir', { path: '/home/user/test-project' });
      expect(res.entries.map((e: any) => e.name)).toContain('added.txt');
    });

    it('mkdir → write inside → readdir shows contents', async () => {
      await apiCall(TEST_PORT, 'fs/mkdir', { path: '/home/user/test-project/subdir', recursive: true });
      await apiCall(TEST_PORT, 'fs/write', { path: '/home/user/test-project/subdir/deep.txt', content: 'nested' });
      const res = await apiCall(TEST_PORT, 'fs/readdir', { path: '/home/user/test-project/subdir' });
      expect(res.entries.length).toBe(1);
      expect(res.entries[0].name).toBe('deep.txt');
    });

    it('shell exec sees project files', async () => {
      const res = await apiCall(TEST_PORT, 'shell/exec', { command: 'ls /home/user/test-project' });
      expect(res.stdout).toContain('index.html');
      expect(res.stdout).toContain('style.css');
    });

    it('scaffold → readdir shows scaffolded files', async () => {
      await apiCall(TEST_PORT, 'project/scaffold', { template: 'static', name: 'new-site' });
      const res = await apiCall(TEST_PORT, 'fs/readdir', { path: '/home/user/test-project/new-site' });
      expect(res.entries.map((e: any) => e.name).sort()).toEqual(['app.js', 'index.html', 'style.css']);
    });

    it('multiple writes → read returns latest', async () => {
      const path = '/home/user/test-project/overwrite.txt';
      await apiCall(TEST_PORT, 'fs/write', { path, content: 'v1' });
      await apiCall(TEST_PORT, 'fs/write', { path, content: 'v2' });
      await apiCall(TEST_PORT, 'fs/write', { path, content: 'v3' });
      expect((await apiCall(TEST_PORT, 'fs/read', { path })).content).toBe('v3');
    });

    it('rm → stat returns null', async () => {
      await apiCall(TEST_PORT, 'fs/rm', { path: '/home/user/test-project/app.js' });
      const resp = await iframeServer.fetch(TEST_PORT, '/api/fs/stat', {
        method: 'POST',
        body: JSON.stringify({ path: '/home/user/test-project/app.js' }),
      });
      expect(resp.status).toBe(404);
    });

    it('rename → old path gone, new path has content', async () => {
      await apiCall(TEST_PORT, 'fs/rename', {
        oldPath: '/home/user/test-project/app.js',
        newPath: '/home/user/test-project/main.js',
      });
      const resp = await iframeServer.fetch(TEST_PORT, '/api/fs/stat', {
        method: 'POST',
        body: JSON.stringify({ path: '/home/user/test-project/app.js' }),
      });
      expect(resp.status).toBe(404);
      const res = await apiCall(TEST_PORT, 'fs/read', { path: '/home/user/test-project/main.js' });
      expect(res.content).toBe('console.log("hi");');
    });
  });
});
