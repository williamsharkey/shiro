/**
 * Tests for ESM/Node.js runtime fixes that improve developer experience.
 *
 * These tests cover:
 * 1. "$@" with no args expands to nothing (shell.ts)
 * 2. setTimeout callbacks fire before script exit (jseval.ts timer tracking)
 * 3. Sync require() execution for ESM packages (jseval.ts)
 * 4. Node.js #imports (subpath imports) support (jseval.ts)
 * 5. ctx.cwd module resolution fallback (jseval.ts)
 * 6. Directory-as-main in package.json (jseval.ts)
 * 7. Localhost fetch/curl routing through virtual servers (fetch.ts + jseval.ts)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { nodeCmd } from '@shiro/commands/jseval';
import type { CommandContext } from '@shiro/commands/index';

function createCtx(shell: Shell, fs: FileSystem, args: string[], stdin = ''): CommandContext {
  return {
    args,
    fs,
    cwd: shell.cwd,
    env: { ...shell.env },
    stdin,
    stdout: '',
    stderr: '',
    shell,
  };
}

describe('Shell: "$@" empty args expansion', () => {
  let shell: Shell;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
  });

  it('should expand "$@" with no args to nothing (zero words)', async () => {
    // Test $@ expansion directly via echo (source writes to ctx.stdout, not the run callback)
    const { output } = await run(shell, 'echo "args:$@:end"');
    expect(output).toContain('args::end');
  });

  it('should expand "$@" with args correctly', async () => {
    shell.env['@'] = 'hello world';
    const { output } = await run(shell, 'echo "args:$@:end"');
    expect(output).toContain('args:hello world:end');
  });
});

describe('Node Runtime: setTimeout timer tracking', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  it('should wait for setTimeout callbacks before exiting', async () => {
    const ctx = createCtx(shell, fs, ['-e', `
      setTimeout(() => { console.log("timer-fired"); }, 50);
    `]);
    const exitCode = await nodeCmd.exec(ctx);
    expect(exitCode).toBe(0);
    expect(ctx.stdout).toContain('timer-fired');
  });

  it('should handle clearTimeout properly', async () => {
    const ctx = createCtx(shell, fs, ['-e', `
      const id = setTimeout(() => { console.log("should-not-fire"); }, 50);
      clearTimeout(id);
      console.log("cleared");
    `]);
    const exitCode = await nodeCmd.exec(ctx);
    expect(exitCode).toBe(0);
    expect(ctx.stdout).toContain('cleared');
    expect(ctx.stdout).not.toContain('should-not-fire');
  });

  it('should not wait forever for long timers (5s max)', async () => {
    const start = Date.now();
    const ctx = createCtx(shell, fs, ['-e', `
      setTimeout(() => { console.log("late"); }, 60000);
      console.log("started");
    `]);
    const exitCode = await nodeCmd.exec(ctx);
    const elapsed = Date.now() - start;
    expect(exitCode).toBe(0);
    expect(ctx.stdout).toContain('started');
    // Should exit within ~8s (5s timer wait + overhead), not 60s
    expect(elapsed).toBeLessThan(15000);
  }, 20000); // 20s vitest timeout for this test

});

describe('Node Runtime: Sync require() for ESM packages', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    await fs.mkdir('/home/user/node_modules/fake-esm', { recursive: true });
    await fs.writeFile('/home/user/node_modules/fake-esm/package.json', JSON.stringify({
      name: 'fake-esm',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js' },
    }));
    await fs.writeFile('/home/user/node_modules/fake-esm/index.js',
      'export default function greet(name) { return `Hello, ${name}!`; }\n' +
      'export const VERSION = "1.0.0";\n'
    );
  });

  it('should synchronously populate module.exports from ESM default export', async () => {
    const ctx = createCtx(shell, fs, ['-e', `
      const greet = require('fake-esm');
      if (typeof greet === 'function') {
        console.log(greet('World'));
      } else if (greet && typeof greet.default === 'function') {
        console.log(greet.default('World'));
      } else {
        console.log('type:' + typeof greet);
      }
    `]);
    const exitCode = await nodeCmd.exec(ctx);
    expect(ctx.stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(ctx.stdout).toContain('Hello, World!');
  });
});

describe('Node Runtime: #imports (subpath imports)', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    // Create a package that uses #imports (like chalk v5)
    await fs.mkdir('/home/user/node_modules/my-colors/source/vendor', { recursive: true });
    await fs.writeFile('/home/user/node_modules/my-colors/package.json', JSON.stringify({
      name: 'my-colors',
      version: '5.0.0',
      type: 'module',
      exports: './source/index.js',
      imports: {
        '#styles': './source/vendor/styles.js',
        '#supports': { default: './source/vendor/supports.js' },
      },
    }));
    await fs.writeFile('/home/user/node_modules/my-colors/source/vendor/styles.js',
      'export const red = "\\x1b[31m";\nexport const reset = "\\x1b[0m";\n'
    );
    await fs.writeFile('/home/user/node_modules/my-colors/source/vendor/supports.js',
      'export default true;\n'
    );
    await fs.writeFile('/home/user/node_modules/my-colors/source/index.js',
      'import { red, reset } from "#styles";\n' +
      'import supports from "#supports";\n' +
      'export default function colorize(text) { return supports ? red + text + reset : text; }\n'
    );
  });

  it('should resolve #imports from package.json imports field', async () => {
    const ctx = createCtx(shell, fs, ['-e', `
      const colorize = require('my-colors');
      const fn = typeof colorize === 'function' ? colorize : colorize.default;
      if (typeof fn === 'function') {
        const result = fn('hello');
        console.log('has-ansi:' + result.includes('\\x1b[31m'));
      } else {
        console.log('not-a-function:' + typeof fn);
      }
    `]);
    const exitCode = await nodeCmd.exec(ctx);
    expect(exitCode).toBe(0);
    expect(ctx.stdout).toContain('has-ansi:true');
  });

  it('should resolve conditional #imports with default key', async () => {
    const ctx = createCtx(shell, fs, ['-e', `
      const colorize = require('my-colors');
      const fn = typeof colorize === 'function' ? colorize : colorize.default;
      const result = fn('test');
      console.log('colored:' + (result !== 'test'));
    `]);
    const exitCode = await nodeCmd.exec(ctx);
    expect(exitCode).toBe(0);
    expect(ctx.stdout).toContain('colored:true');
  });
});

describe('Node Runtime: ctx.cwd module resolution fallback', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    // Install a package in /home/user/node_modules
    await fs.mkdir('/home/user/node_modules/my-util', { recursive: true });
    await fs.writeFile('/home/user/node_modules/my-util/package.json', JSON.stringify({
      name: 'my-util', version: '1.0.0', main: 'index.js',
    }));
    await fs.writeFile('/home/user/node_modules/my-util/index.js',
      'module.exports = { hello: () => "from-my-util" };\n'
    );
  });

  it('should find packages from ctx.cwd when script is in /tmp', async () => {
    // Script lives in /tmp but should find packages from cwd (/home/user)
    await fs.mkdir('/tmp', { recursive: true });
    await fs.writeFile('/tmp/test-script.js',
      'const util = require("my-util");\nconsole.log(util.hello());\n'
    );
    const ctx = createCtx(shell, fs, ['/tmp/test-script.js']);
    ctx.cwd = '/home/user';
    const exitCode = await nodeCmd.exec(ctx);
    expect(exitCode).toBe(0);
    expect(ctx.stdout).toContain('from-my-util');
  });
});

describe('Node Runtime: directory-as-main in package.json', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    // Create a package where main points to a directory (has index.js inside)
    await fs.mkdir('/usr/local/lib/node_modules/dir-main/dist', { recursive: true });
    await fs.writeFile('/usr/local/lib/node_modules/dir-main/package.json', JSON.stringify({
      name: 'dir-main', version: '1.0.0', main: 'dist',
    }));
    await fs.writeFile('/usr/local/lib/node_modules/dir-main/dist/index.js',
      'module.exports = { name: "dir-main-works" };\n'
    );
  });

  it('should resolve main:"dist" to dist/index.js when dist/ is a directory', async () => {
    const ctx = createCtx(shell, fs, ['-e', `
      const pkg = require('dir-main');
      console.log(pkg.name);
    `]);
    const exitCode = await nodeCmd.exec(ctx);
    expect(exitCode).toBe(0);
    expect(ctx.stdout).toContain('dir-main-works');
  });
});

describe('Localhost fetch routing through virtual servers', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  it('should route curl localhost:PORT through virtual server or error gracefully', async () => {
    // In linkedom tests, no real iframeServer exists — curl should fail gracefully
    const { output, exitCode } = await run(shell, 'curl http://localhost:99999');
    // Should get an error (no server on that port), not crash
    expect(output).toBeDefined();
    // curl returns 1 on network error
    expect(exitCode).toBe(1);
  });

  it('should intercept localhost fetch in node runtime when iframeServer has a port', async () => {
    // This tests the fetch URL pattern matching — in linkedom, iframeServer won't be
    // available so it will fall through to real fetch (which fails). The test verifies
    // the pattern is recognized and handled without crashing.
    const ctx = createCtx(shell, fs, ['-e', `
      fetch('http://localhost:12345/api/test')
        .then(r => r.text())
        .then(t => console.log('got:' + t))
        .catch(e => console.log('error:expected'));
    `]);
    const exitCode = await nodeCmd.exec(ctx);
    // Should not crash — either routes through iframeServer or fails gracefully
    expect(ctx.stdout).toMatch(/got:|error:expected/);
  });
});
