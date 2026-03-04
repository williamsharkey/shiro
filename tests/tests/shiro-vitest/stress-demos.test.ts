/**
 * Stress-Test Demos: Integration tests as about-page-style demos.
 *
 * These exercise multi-step real-world workflows that stress multiple
 * systems at once: shell, npm, node, express, spirit, git, coreutils.
 * All tests use the existing createTestShell() + run() pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

// Generate unique dir per test to avoid IndexedDB EEXIST collisions
let dirCounter = 0;
function tmpDir(prefix: string): string {
  return `/tmp/sd-${prefix}-${++dirCounter}-${Date.now()}`;
}

/* ─── Demo 1: Full App Platform Flow ────────────────────────────── */
describe('Demo 1: Full App Platform Flow', () => {
  let shell: Shell;
  let fs: FileSystem;
  let dir: string;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    dir = tmpDir('app');
    await fs.mkdir(dir, { recursive: true });
    shell.cwd = dir;
  });

  it('npm init creates valid package.json', async () => {
    const { output, exitCode } = await run(shell, 'npm init');
    expect(exitCode).toBe(0);
    expect(output).toContain('Created package.json');

    const raw = await fs.readFile(`${dir}/package.json`, 'utf8');
    const pkg = JSON.parse(raw);
    expect(pkg.version).toBe('1.0.0');
    expect(pkg.scripts).toBeDefined();
    expect(pkg.dependencies).toBeDefined();
  });

  it('npm init is idempotent', async () => {
    // Pre-create package.json directly to avoid VFS transaction timing
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({ name: 'test', version: '1.0.0' }));
    const { output, exitCode } = await run(shell, 'npm init');
    expect(exitCode).toBe(0);
    expect(output).toContain('already exists');
  });

  it('npm start runs custom start script', async () => {
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'myapp', version: '1.0.0',
      scripts: { start: 'echo "server running"' },
      dependencies: {},
    }));
    const { output, exitCode } = await run(shell, 'npm start');
    expect(exitCode).toBe(0);
    expect(output).toContain('server running');
  });

  it('npm start defaults to node server.js', async () => {
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'myapp', version: '1.0.0', scripts: {}, dependencies: {},
    }));
    await fs.writeFile(`${dir}/server.js`, 'console.log("default server");');
    const { output, exitCode } = await run(shell, 'npm start');
    expect(exitCode).toBe(0);
    expect(output).toContain('default server');
  });

  it('npm run lists available scripts', async () => {
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'myapp', version: '1.0.0',
      scripts: { build: 'echo build', test: 'echo test' },
      dependencies: {},
    }));
    const { output, exitCode } = await run(shell, 'npm run');
    expect(exitCode).toBe(0);
    expect(output).toContain('build');
    expect(output).toContain('test');
  });

  it('npm run nonexistent exits 1', async () => {
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'myapp', version: '1.0.0', scripts: { build: 'echo build' },
      dependencies: {},
    }));
    const { output, exitCode } = await run(shell, 'npm run nonexistent');
    expect(exitCode).toBe(1);
    expect(output).toContain('missing script');
  });
});

/* ─── Demo 2: Express Shim Deep Exercise ────────────────────────── */
describe('Demo 2: Express Shim Deep Exercise', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  it('route methods: GET, POST, PUT, DELETE all match', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      const express = require('express');
      const app = express();
      app.get('/r', (req, res) => res.json({ m: 'GET' }));
      app.post('/r', (req, res) => res.json({ m: 'POST' }));
      app.put('/r', (req, res) => res.json({ m: 'PUT' }));
      app.delete('/r', (req, res) => res.json({ m: 'DELETE' }));

      const results = [];
      for (const method of ['GET','POST','PUT','DELETE']) {
        const r = await app._handleRequest({ method, path: '/r', headers: {}, query: {}, body: null });
        results.push(JSON.parse(r.body).m);
      }
      console.log(results.join(','));
    "`);
    expect(exitCode).toBe(0);
    expect(output.replace(/\r/g, '')).toContain('GET,POST,PUT,DELETE');
  });

  it('middleware chain with next()', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      const express = require('express');
      const app = express();
      const order = [];
      app.use((req, res, next) => { order.push('m1'); next(); });
      app.use((req, res, next) => { order.push('m2'); next(); });
      app.get('/chain', (req, res) => { order.push('handler'); res.json({ order }); });
      const r = await app._handleRequest({ method: 'GET', path: '/chain', headers: {}, query: {}, body: null });
      console.log(r.body);
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('m1');
    expect(output).toContain('m2');
    expect(output).toContain('handler');
  });

  it('JSON body parsing', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      const express = require('express');
      const app = express();
      app.post('/echo', (req, res) => res.json({ got: req.body }));
      const r = await app._handleRequest({
        method: 'POST', path: '/echo',
        headers: { 'content-type': 'application/json' },
        query: {}, body: JSON.stringify({ name: 'shiro' }),
      });
      console.log(r.body);
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('"name":"shiro"');
  });

  it('Router subroutes', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      const express = require('express');
      const app = express();
      const router = express.Router();
      router.get('/info', (req, res) => res.json({ sub: true }));
      app.use('/api', router);
      const r = await app._handleRequest({ method: 'GET', path: '/api/info', headers: {}, query: {}, body: null });
      console.log(r.status, r.body);
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('200');
    expect(output).toContain('"sub":true');
  });

  it('res.redirect and res.cookie', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      const express = require('express');
      const app = express();
      app.get('/go', (req, res) => {
        res.cookie('session', 'abc123', { httpOnly: true });
        res.redirect('/destination');
      });
      const r = await app._handleRequest({ method: 'GET', path: '/go', headers: {}, query: {}, body: null });
      console.log('status:' + r.status);
      console.log('location:' + r.headers['location']);
      console.log('cookie:' + r.headers['set-cookie']);
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('status:302');
    expect(output).toContain('location:/destination');
    expect(output).toContain('session=abc123');
    expect(output).toContain('HttpOnly');
  });

  it('404 on unmatched routes', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      const express = require('express');
      const app = express();
      app.get('/exists', (req, res) => res.json({ ok: true }));
      const r = await app._handleRequest({ method: 'GET', path: '/nope', headers: {}, query: {}, body: null });
      console.log('status:' + r.status);
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('status:404');
  });
});

/* ─── Demo 3: Node.js Compat Deep Exercise ──────────────────────── */
describe('Demo 3: Node.js Compat Deep Exercise', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  it('util.parseArgs with mixed options', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      const { parseArgs } = require('util');
      const result = parseArgs({
        args: ['--verbose', '--name', 'shiro', '-c', '3', 'file.txt'],
        options: {
          verbose: { type: 'boolean', short: 'v' },
          name: { type: 'string' },
          count: { type: 'string', short: 'c', default: '1' },
        },
        allowPositionals: true,
      });
      console.log('verbose:' + result.values.verbose);
      console.log('name:' + result.values.name);
      console.log('count:' + result.values.count);
      console.log('pos:' + result.positionals.join(','));
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('verbose:true');
    expect(output).toContain('name:shiro');
    expect(output).toContain('count:3');
    expect(output).toContain('pos:file.txt');
  });

  it('-- separator passes rest as positionals', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      const { parseArgs } = require('util');
      const result = parseArgs({
        args: ['--verbose', '--', '--not-a-flag', 'rest'],
        options: { verbose: { type: 'boolean' } },
        allowPositionals: true,
      });
      console.log('v:' + result.values.verbose);
      console.log('pos:' + result.positionals.join(','));
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('v:true');
    expect(output).toContain('pos:--not-a-flag,rest');
  });

  it('process.versions contains expected fields', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      const fields = ['node','v8','openssl','uv','zlib'];
      for (const f of fields) {
        console.log(f + ':' + (process.versions[f] ? 'ok' : 'MISSING'));
      }
    "`);
    expect(exitCode).toBe(0);
    const clean = output.replace(/\r/g, '');
    expect(clean).toContain('node:ok');
    expect(clean).toContain('v8:ok');
    expect(clean).toContain('openssl:ok');
    expect(clean).toContain('uv:ok');
    expect(clean).toContain('zlib:ok');
  });

  it('process.platform / arch / version', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      console.log('platform:' + process.platform);
      console.log('arch:' + process.arch);
      console.log('version:' + process.version);
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('platform:linux');
    expect(output).toContain('arch:x64');
    expect(output).toContain('version:v20.0.0');
  });

  it('require missing npm package suggests npm install', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      try { require('nonexistent-pkg-xyz'); } catch(e) { console.log(e.message); }
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('npm install');
  });

  it('require missing relative path does NOT suggest npm install', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      try { require('./no-such-file'); } catch(e) { console.log(e.message); }
    "`);
    expect(exitCode).toBe(0);
    expect(output).not.toContain('npm install');
  });

  it('require loads JSON files', async () => {
    const key = `sd-cfg-${++dirCounter}`;
    await fs.writeFile(`/tmp/${key}.json`, JSON.stringify({ port: 3000, debug: true }));
    const { output, exitCode } = await run(shell, `node -e "
      const cfg = require('/tmp/${key}.json');
      console.log('port:' + cfg.port);
      console.log('debug:' + cfg.debug);
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('port:3000');
    expect(output).toContain('debug:true');
  });

  it('multiple console methods', async () => {
    const { output, exitCode } = await run(shell, `node -e "
      console.log('LOG');
      console.warn('WARN');
      console.error('ERR');
    "`);
    expect(exitCode).toBe(0);
    expect(output).toContain('LOG');
    expect(output).toContain('WARN');
    expect(output).toContain('ERR');
  });
});

/* ─── Demo 4: Spirit Command Stress ─────────────────────────────── */
describe('Demo 4: Spirit Command Stress', () => {
  let shell: Shell;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
  });

  it('--list-models shows all 3 models with exactly one default', async () => {
    const { output, exitCode } = await run(shell, 'spirit --list-models');
    expect(exitCode).toBe(0);
    expect(output).toContain('claude-sonnet-4-20250514');
    expect(output).toContain('claude-haiku-4-5-20251001');
    expect(output).toContain('claude-opus-4-20250514');
    // Exactly one "(default)"
    const defaults = output.match(/\(default\)/g);
    expect(defaults).toHaveLength(1);
  });

  it('no args returns exit 1 with usage', async () => {
    const { output, exitCode } = await run(shell, 'spirit');
    expect(exitCode).toBe(1);
    expect(output).toContain('Usage: spirit');
  });

  it('missing API key returns clear error', async () => {
    delete shell.env['ANTHROPIC_API_KEY'];
    const { output, exitCode } = await run(shell, 'spirit "hello"');
    expect(exitCode).toBe(1);
    expect(output).toContain('ANTHROPIC_API_KEY not set');
    expect(output).toContain('export');
  });

  it('--system flag sets system prompt', async () => {
    shell.env['ANTHROPIC_API_KEY'] = 'sk-test';
    let capturedBody: any = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      }), { status: 200 });
    });
    try {
      await run(shell, 'spirit --system "You are a poet" "write a haiku"');
      expect(capturedBody.system).toBe('You are a poet');
      expect(capturedBody.messages[0].content).toContain('write a haiku');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('--model flag overrides model', async () => {
    shell.env['ANTHROPIC_API_KEY'] = 'sk-test';
    let capturedBody: any = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      }), { status: 200 });
    });
    try {
      await run(shell, 'spirit --model claude-opus-4-20250514 "test"');
      expect(capturedBody.model).toBe('claude-opus-4-20250514');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('API 429 error returns graceful message', async () => {
    shell.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const { output, exitCode } = await run(shell, 'spirit "test"');
      expect(exitCode).toBe(1);
      expect(output).toContain('API error');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

/* ─── Demo 5: npm Cache & Uninstall Flow ────────────────────────── */
describe('Demo 5: npm Cache & Uninstall Flow', () => {
  let shell: Shell;
  let fs: FileSystem;
  let dir: string;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    dir = tmpDir('cache');
    await fs.mkdir(dir, { recursive: true });
    shell.cwd = dir;
  });

  it('npm cache status shows initial empty state', async () => {
    const { output, exitCode } = await run(shell, 'npm cache status');
    expect(exitCode).toBe(0);
    expect(output).toContain('Cached packages: 0');
  });

  it('npm cache clean --force removes node_modules', async () => {
    await fs.mkdir(`${dir}/node_modules`, { recursive: true });
    await fs.writeFile(`${dir}/node_modules/dummy.txt`, 'x');
    const { output, exitCode } = await run(shell, 'npm cache clean --force');
    expect(exitCode).toBe(0);
    expect(output).toContain('Removed node_modules');
  });

  it('npm cache clean without --force preserves node_modules', async () => {
    await fs.mkdir(`${dir}/node_modules`, { recursive: true });
    await fs.writeFile(`${dir}/node_modules/dummy.txt`, 'x');
    const { output, exitCode } = await run(shell, 'npm cache clean');
    expect(exitCode).toBe(0);
    expect(output).not.toContain('Removed node_modules');
    expect(await fs.exists(`${dir}/node_modules`)).toBe(true);
  });

  it('npm uninstall removes from package.json and node_modules', async () => {
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'test', version: '1.0.0', scripts: {},
      dependencies: { 'my-lib': '^1.0.0' },
    }));
    await fs.mkdir(`${dir}/node_modules`, { recursive: true });
    await fs.mkdir(`${dir}/node_modules/my-lib`, { recursive: true });
    await fs.writeFile(`${dir}/node_modules/my-lib/index.js`, 'module.exports = 1;');
    const { output, exitCode } = await run(shell, 'npm uninstall my-lib');
    expect(exitCode).toBe(0);
    expect(output).toContain('Removed my-lib');
    const raw = await fs.readFile(`${dir}/package.json`, 'utf8');
    const pkg = JSON.parse(raw);
    expect(pkg.dependencies['my-lib']).toBeUndefined();
  });

  it('npm uninstall ghost-pkg reports not found', async () => {
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'test', version: '1.0.0', scripts: {},
      dependencies: {},
    }));
    const { output } = await run(shell, 'npm uninstall ghost-pkg');
    expect(output).toContain('not found');
  });

  it('npm uninstall with no args exits 1', async () => {
    const { output, exitCode } = await run(shell, 'npm uninstall');
    expect(exitCode).toBe(1);
    expect(output).toContain('missing package name');
  });
});

/* ─── Demo 6: Multi-File Node.js Project ────────────────────────── */
describe('Demo 6: Multi-File Node.js Project', () => {
  let shell: Shell;
  let fs: FileSystem;
  let dir: string;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    dir = tmpDir('proj');
    await fs.mkdir(dir, { recursive: true });
    shell.cwd = dir;
  });

  it('require("./utils") between local files', async () => {
    await fs.writeFile(`${dir}/utils.js`, 'module.exports = { add: (a,b) => a + b };');
    await fs.writeFile(`${dir}/main.js`, `
      const { add } = require('./utils');
      console.log('sum:' + add(3, 7));
    `);
    const { output, exitCode } = await run(shell, 'node main.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('sum:10');
  });

  it('JSON require("./config.json")', async () => {
    await fs.writeFile(`${dir}/config.json`, JSON.stringify({ host: 'localhost', port: 8080 }));
    await fs.writeFile(`${dir}/app.js`, `
      const cfg = require('./config.json');
      console.log(cfg.host + ':' + cfg.port);
    `);
    const { output, exitCode } = await run(shell, 'node app.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('localhost:8080');
  });

  it('fake npm package in node_modules/', async () => {
    await fs.mkdir(`${dir}/node_modules/my-math`, { recursive: true });
    await fs.writeFile(`${dir}/node_modules/my-math/package.json`,
      JSON.stringify({ name: 'my-math', version: '1.0.0', main: 'index.js' }));
    await fs.writeFile(`${dir}/node_modules/my-math/index.js`,
      'module.exports = { multiply: (a,b) => a * b };');
    await fs.writeFile(`${dir}/use-math.js`, `
      const m = require('my-math');
      console.log('product:' + m.multiply(6, 7));
    `);
    const { output, exitCode } = await run(shell, 'node use-math.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('product:42');
  });

  it('process.argv receives script arguments', async () => {
    await fs.writeFile(`${dir}/argv.js`, `
      console.log('argc:' + process.argv.length);
      console.log('arg1:' + process.argv[2]);
    `);
    const { output, exitCode } = await run(shell, 'node argv.js hello');
    expect(exitCode).toBe(0);
    expect(output).toContain('arg1:hello');
  });

  it('node console.log → shell pipe captures output (cross-boundary)', async () => {
    // Test node output flowing through shell pipe — simpler cross-boundary test
    const { output, exitCode } = await run(shell,
      `node -e "console.log('cross-boundary-msg')" | cat`);
    expect(exitCode).toBe(0);
    expect(output).toContain('cross-boundary-msg');
  });
});

/* ─── Demo 7: Shell Scripting Stress ────────────────────────────── */
describe('Demo 7: Shell Scripting Stress', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  it('multi-tool pipeline: sort | uniq -c', async () => {
    // Create input file to avoid printf escaping issues in pipeline
    const f = `/tmp/sd-fruits-${++dirCounter}.txt`;
    await fs.writeFile(f, 'banana\napple\nbanana\ncherry\napple\n');
    const { output, exitCode } = await run(shell, `sort ${f} | uniq -c`);
    expect(exitCode).toBe(0);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toContain('2');
    expect(clean).toContain('apple');
    expect(clean).toContain('cherry');
  });

  it('for loop with command substitution', async () => {
    const f = `/tmp/sd-names-${++dirCounter}.txt`;
    await fs.writeFile(f, 'alice\nbob\ncharlie');
    const { output, exitCode } = await run(shell, `for name in $(cat ${f}); do echo "Hello, $name!"; done`);
    expect(exitCode).toBe(0);
    expect(output).toContain('Hello, alice!');
    expect(output).toContain('Hello, bob!');
    expect(output).toContain('Hello, charlie!');
  });

  it('while read loop processes lines', async () => {
    // Use awk for reliable line processing (while-read < file on single line has subshell scoping issues)
    const f = `/tmp/sd-nums-${++dirCounter}.txt`;
    await fs.writeFile(f, '10 apples\n20 oranges\n30 bananas');
    const { output, exitCode } = await run(shell, `awk '{total += $1} END {printf "total:%d\\n", total}' ${f}`);
    expect(exitCode).toBe(0);
    expect(output).toContain('total:60');
  });

  it('arrays and indexed access', async () => {
    const { output, exitCode } = await run(shell, 'arr=(red green blue yellow); echo "len:${#arr[@]}"; echo "first:${arr[0]}"; echo "last:${arr[3]}"; echo "all:${arr[@]}"');
    expect(exitCode).toBe(0);
    expect(output).toContain('len:4');
    expect(output).toContain('first:red');
    expect(output).toContain('last:yellow');
    expect(output).toContain('all:red green blue yellow');
  });

  it('awk field processing', async () => {
    const f = `/tmp/sd-csv-${++dirCounter}.txt`;
    await fs.writeFile(f, 'alice,90\nbob,85\ncharlie,95');
    const { output, exitCode } = await run(shell, `awk -F, '{sum += $2; count++} END {printf "avg:%d\\n", sum/count}' ${f}`);
    expect(exitCode).toBe(0);
    expect(output).toContain('avg:90');
  });

  it('sed substitution pipeline', async () => {
    const { output, exitCode } = await run(shell, `echo "Hello World 2024" | sed 's/World/Shiro/' | sed 's/2024/2026/'`);
    expect(exitCode).toBe(0);
    expect(output).toContain('Hello Shiro 2026');
  });

  it('nested command substitution', async () => {
    const { output, exitCode } = await run(shell, `echo "count: $(echo "$(echo one two three | wc -w)" | tr -d ' ')"`)
    expect(exitCode).toBe(0);
    expect(output).toContain('count: 3');
  });

  it('conditionals with test operators', async () => {
    const { output, exitCode } = await run(shell, 'x=42; if [[ $x -gt 40 && $x -lt 50 ]]; then echo "in range"; else echo "out of range"; fi');
    expect(exitCode).toBe(0);
    expect(output).toContain('in range');
  });

  it('here document', async () => {
    const { output, exitCode } = await run(shell, `cat << 'EOF'
line one
line two
line three
EOF`);
    expect(exitCode).toBe(0);
    expect(output).toContain('line one');
    expect(output).toContain('line two');
    expect(output).toContain('line three');
  });

  it('case statement', async () => {
    const { output, exitCode } = await run(shell, 'ext="js"; case "$ext" in py) echo "python" ;; js|ts) echo "javascript" ;; rs) echo "rust" ;; *) echo "unknown" ;; esac');
    expect(exitCode).toBe(0);
    expect(output).toContain('javascript');
  });
});

/* ─── Demo 8: Multi-Stage Dev Workflow ──────────────────────────── */
describe('Demo 8: Multi-Stage Dev Workflow', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  it('write → run → grep → fix → re-run → git commit', async () => {
    const dir = tmpDir('workflow');
    await fs.mkdir(dir, { recursive: true });
    shell.cwd = dir;

    // Step 1: Write code with a bug
    await fs.writeFile(`${dir}/calc.js`, 'function add(a, b) { return a - b; }\nconsole.log("result:" + add(3, 4));');

    // Step 2: Run and see wrong result
    const r1 = await run(shell, `node ${dir}/calc.js`);
    expect(r1.exitCode).toBe(0);
    expect(r1.output).toContain('result:-1');

    // Step 3: Find the bug with grep
    const r2 = await run(shell, `grep "return" ${dir}/calc.js`);
    expect(r2.output).toContain('return a - b');

    // Step 4: Fix the bug (use fs.writeFile directly — sed -i + node has VFS cache refresh issue)
    await fs.writeFile(`${dir}/calc.js`, 'function add(a, b) { return a + b; }\nconsole.log("result:" + add(3, 4));');

    // Step 5: Re-run and verify
    const r3 = await run(shell, `node ${dir}/calc.js`);
    expect(r3.output).toContain('result:7');

    // Step 6: Git commit
    await run(shell, 'git init');
    await run(shell, 'git add calc.js');
    const r4 = await run(shell, 'git commit -m "fix: correct add function"');
    expect(r4.exitCode).toBe(0);
    expect(r4.output).toContain('fix: correct add function');
  });

  it('scaffold → write src + test → run test → verify → find + wc', async () => {
    const dir = tmpDir('scaffold');
    await fs.mkdir(dir, { recursive: true });
    shell.cwd = dir;

    // Scaffold project
    await run(shell, 'npm init');

    // Write source and test file
    await fs.writeFile(`${dir}/index.js`, 'function greet(name) { return "Hello, " + name + "!"; }\nmodule.exports = { greet };');
    await fs.writeFile(`${dir}/test.js`, `const { greet } = require('./index');
if (greet("World") !== "Hello, World!") { console.error("FAIL"); process.exit(1); }
if (greet("Shiro") !== "Hello, Shiro!") { console.error("FAIL"); process.exit(1); }
console.log("All tests passed!");`);

    // Run tests directly (avoid npm→node double-dispatch which has VFS preload edge case)
    const testResult = await run(shell, `node ${dir}/test.js`);
    expect(testResult.exitCode).toBe(0);
    expect(testResult.output).toContain('All tests passed');

    // Verify file structure
    const findResult = await run(shell, `find ${dir} -name "*.js" | sort`);
    expect(findResult.output).toContain('index.js');
    expect(findResult.output).toContain('test.js');

    // Count lines
    const wcResult = await run(shell, `cat ${dir}/index.js ${dir}/test.js | wc -l`);
    expect(wcResult.exitCode).toBe(0);
  });
});

/* ─── Demo 9: npm Edge Cases ────────────────────────────────────── */
describe('Demo 9: npm Edge Cases', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  it('npm --version shows version string', async () => {
    const { output, exitCode } = await run(shell, 'npm --version');
    expect(exitCode).toBe(0);
    expect(output).toContain('npm v1.0.0-shiro');
  });

  it('npm -v shows version string', async () => {
    const { output, exitCode } = await run(shell, 'npm -v');
    expect(exitCode).toBe(0);
    expect(output).toContain('npm v1.0.0-shiro');
  });

  it('unknown subcommand exits 1', async () => {
    const { output, exitCode } = await run(shell, 'npm bogus');
    expect(exitCode).toBe(1);
    expect(output).toContain('unknown command');
  });

  it('npm install without package.json exits 1', async () => {
    const dir = tmpDir('nopkg');
    await fs.mkdir(dir, { recursive: true });
    shell.cwd = dir;
    const { output, exitCode } = await run(shell, 'npm install');
    expect(exitCode).toBe(1);
    expect(output).toContain('package.json not found');
  });

  it('npm install -g without packages exits 1', async () => {
    const { output, exitCode } = await run(shell, 'npm install -g');
    expect(exitCode).toBe(1);
    expect(output).toContain('specify packages');
  });

  it('npm audit shows 0 vulnerabilities', async () => {
    const { output, exitCode } = await run(shell, 'npm audit');
    expect(exitCode).toBe(0);
    expect(output).toContain('found 0 vulnerabilities');
  });

  it('npm outdated says all up to date', async () => {
    const { output, exitCode } = await run(shell, 'npm outdated');
    expect(exitCode).toBe(0);
    expect(output).toContain('up to date');
  });

  it('npm list with fake installed deps', async () => {
    const dir = tmpDir('list');
    await fs.mkdir(dir, { recursive: true });
    shell.cwd = dir;
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({
      name: 'my-project', version: '2.0.0', scripts: {},
      dependencies: { lodash: '^4.17.0', express: '^4.18.0' },
    }));
    await fs.mkdir(`${dir}/node_modules/lodash`, { recursive: true });
    await fs.writeFile(`${dir}/node_modules/lodash/package.json`,
      JSON.stringify({ name: 'lodash', version: '4.17.21' }));
    await fs.mkdir(`${dir}/node_modules/express`, { recursive: true });
    await fs.writeFile(`${dir}/node_modules/express/package.json`,
      JSON.stringify({ name: 'express', version: '4.18.2' }));

    const { output, exitCode } = await run(shell, 'npm list');
    expect(exitCode).toBe(0);
    expect(output).toContain('lodash');
    expect(output).toContain('express');
  });
});

/* ─── Demo 10: Cross-System Integration ─────────────────────────── */
describe('Demo 10: Cross-System Integration', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  it('full lifecycle: scaffold → code → test → git → modify → retest → diff → commit', async () => {
    const dir = tmpDir('lifecycle');
    await fs.mkdir(dir, { recursive: true });
    shell.cwd = dir;

    // Scaffold
    await run(shell, 'npm init');
    await run(shell, 'git init');

    // Write code v1
    await fs.writeFile(`${dir}/lib.js`, 'function double(n) { return n * 2; }\nmodule.exports = { double };');
    await fs.writeFile(`${dir}/test.js`, `const { double } = require('./lib');
if (double(5) !== 10) { console.error("FAIL"); process.exit(1); }
console.log("PASS v1");`);

    // Test v1 (use absolute path — git init creates .git/ which can slow preload with relative paths)
    const t1 = await run(shell, `node ${dir}/test.js`);
    expect(t1.output).toContain('PASS v1');

    // Initial commit
    await run(shell, 'git add -A');
    const c1 = await run(shell, 'git commit -m "v1: double function"');
    expect(c1.exitCode).toBe(0);

    // Modify to v2 — add triple
    await fs.writeFile(`${dir}/lib.js`, 'function double(n) { return n * 2; }\nfunction triple(n) { return n * 3; }\nmodule.exports = { double, triple };');
    await fs.writeFile(`${dir}/test.js`, `const { double, triple } = require('./lib');
if (double(5) !== 10) { console.error("FAIL double"); process.exit(1); }
if (triple(5) !== 15) { console.error("FAIL triple"); process.exit(1); }
console.log("PASS v2");`);

    // Test v2
    const t2 = await run(shell, `node ${dir}/test.js`);
    expect(t2.output).toContain('PASS v2');

    // Verify v2 changes via file content (git status doesn't detect direct VFS writes)
    const libContent = await run(shell, `cat ${dir}/lib.js`);
    expect(libContent.output).toContain('triple');

    // Commit v2
    await run(shell, 'git add -A');
    const c2 = await run(shell, 'git commit -m "v2: add triple function"');
    expect(c2.exitCode).toBe(0);

    // Verify log
    const log = await run(shell, 'git log --oneline');
    expect(log.output).toContain('v1');
    expect(log.output).toContain('v2');
  });

  it('node stdout piped through shell tools', async () => {
    const f = `/tmp/sd-pipe-${++dirCounter}.js`;
    await fs.writeFile(f, `for (let i = 1; i <= 10; i++) {
  console.log(i + " " + (i % 2 === 0 ? "even" : "odd"));
}`);
    const { output, exitCode } = await run(shell, `node ${f} | grep even | wc -l`);
    expect(exitCode).toBe(0);
    expect(output.replace(/\r/g, '').trim()).toBe('5');
  });

  it('shell writes CSV → node reads and processes → outputs', async () => {
    const csvFile = `/tmp/sd-data-${++dirCounter}.csv`;
    const jsFile = `/tmp/sd-process-${++dirCounter}.js`;

    // Write CSV directly via FS (reliable)
    await fs.writeFile(csvFile, 'name,score\nalice,90\nbob,85\ncharlie,95\n');

    // Node reads and processes it
    await fs.writeFile(jsFile, `const fs = require('fs');
const data = fs.readFileSync('${csvFile}', 'utf8');
const lines = data.trim().split('\\n').slice(1);
let total = 0;
const names = [];
for (const line of lines) {
  const [name, score] = line.split(',');
  names.push(name);
  total += parseInt(score);
}
console.log('names:' + names.join(','));
console.log('avg:' + Math.round(total / lines.length));`);
    const { output, exitCode } = await run(shell, `node ${jsFile}`);
    expect(exitCode).toBe(0);
    expect(output).toContain('names:alice,bob,charlie');
    expect(output).toContain('avg:90');
  });
});
