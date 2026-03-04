/**
 * Phase 18: Package Compatibility tests
 * - util.parseArgs
 * - process.versions
 * - conditional exports (browser field)
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

describe('util.parseArgs', () => {
  it('with boolean options', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "const util = require('util'); const r = util.parseArgs({ args: ['--verbose'], options: { verbose: { type: 'boolean' } } }); console.log(JSON.stringify(r.values))"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('"verbose":true');
  });

  it('with string options', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "const util = require('util'); const r = util.parseArgs({ args: ['--name', 'alice'], options: { name: { type: 'string' } } }); console.log(JSON.stringify(r.values))"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('"name":"alice"');
  });

  it('with short aliases', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "const util = require('util'); const r = util.parseArgs({ args: ['-v'], options: { verbose: { type: 'boolean', short: 'v' } } }); console.log(JSON.stringify(r.values))"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('"verbose":true');
  });

  it('with --key=value syntax', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "const util = require('util'); const r = util.parseArgs({ args: ['--name=bob'], options: { name: { type: 'string' } } }); console.log(JSON.stringify(r.values))"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('"name":"bob"');
  });

  it('strict rejects unknown options', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "const util = require('util'); try { util.parseArgs({ args: ['--unknown'], options: {}, strict: true }); } catch(e) { console.log(e.code); }"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('ERR_PARSE_ARGS_UNKNOWN_OPTION');
  });

  it('allowPositionals', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "const util = require('util'); const r = util.parseArgs({ args: ['foo', 'bar'], options: {}, allowPositionals: true }); console.log(JSON.stringify(r.positionals))"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('["foo","bar"]');
  });

  it('with defaults', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "const util = require('util'); const r = util.parseArgs({ args: [], options: { color: { type: 'string', default: 'red' } } }); console.log(JSON.stringify(r.values))"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('"color":"red"');
  });

  it('with multiple', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "const util = require('util'); const r = util.parseArgs({ args: ['--tag', 'a', '--tag', 'b'], options: { tag: { type: 'string', multiple: true } } }); console.log(JSON.stringify(r.values))"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('"tag":["a","b"]');
  });
});

describe('process.versions', () => {
  it('has openssl and uv', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "console.log(process.versions.openssl, process.versions.uv)"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('3.0.13');
    expect(output).toContain('1.46.0');
  });
});

describe('conditional exports', () => {
  it('prefers browser field', async () => {
    const { fs, shell } = await createTestShell();
    // Create a fake package with browser condition
    await fs.mkdir('/home/user/node_modules/test-pkg', { recursive: true });
    await fs.writeFile('/home/user/node_modules/test-pkg/package.json', new TextEncoder().encode(JSON.stringify({
      name: 'test-pkg',
      exports: {
        '.': {
          browser: './browser.js',
          import: './esm.js',
          require: './cjs.js',
          default: './default.js'
        }
      }
    })));
    await fs.writeFile('/home/user/node_modules/test-pkg/browser.js', new TextEncoder().encode('module.exports = { source: "browser" };'));
    await fs.writeFile('/home/user/node_modules/test-pkg/esm.js', new TextEncoder().encode('module.exports = { source: "esm" };'));

    const { output, exitCode } = await run(shell,
      `node -e "const pkg = require('test-pkg'); console.log(pkg.source)"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('browser');
  });
});
