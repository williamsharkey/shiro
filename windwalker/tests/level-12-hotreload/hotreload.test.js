/**
 * Level 12: Hot-Reload Tests
 *
 * Tests the self-modifying OS capability:
 * 1. Clone Shiro's repo inside itself
 * 2. Edit source files
 * 3. Hot-reload individual commands without page refresh
 * 4. State preserved via migration protocol
 * 5. Truly self-modifying browser OS
 *
 * These tests require skyeyes (real browser) - they won't work in linkedom
 * because they test actual module hot-swapping.
 */

import { TestResults, createOSHelpers, assert, assertEqual, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 12: Hot-Reload (${osTarget})`);

  // Hot-reload only works in Shiro (has the registry and reload command)
  if (osTarget !== 'shiro') {
    results.skip('hot-reload tests', 'Only Shiro supports hot-reload currently');
    results.summary();
    return results;
  }

  const os = createOSHelpers(page, osTarget);

  // =========================================================================
  // Test 1: Verify registry exists and reload command is available
  // =========================================================================
  results.startTest();
  try {
    const hasRegistry = await page.evaluate(() => {
      return typeof window.__shiro?.registry === 'object' &&
             typeof window.__shiro?.registry?.list === 'function';
    });
    assert(hasRegistry, 'ModuleRegistry should exist on window.__shiro');

    // Check reload command exists
    const r = await os.exec('reload --help');
    assertIncludes(r.stdout, 'Hot-reload', 'reload command should be available');
    results.pass('registry and reload command exist');
  } catch (e) {
    results.fail('registry and reload command exist', e);
  }

  // =========================================================================
  // Test 2: List registered modules
  // =========================================================================
  results.startTest();
  try {
    const r = await os.exec('reload --list');
    assertEqual(r.exitCode, 0, 'reload --list should succeed');
    assertIncludes(r.stdout, 'commands/', 'should list commands');

    // Verify some specific commands are registered
    assertIncludes(r.stdout, 'commands/ls', 'ls should be registered');
    assertIncludes(r.stdout, 'commands/cat', 'cat should be registered');
    assertIncludes(r.stdout, 'commands/reload', 'reload should be registered');
    results.pass('reload --list shows registered modules');
  } catch (e) {
    results.fail('reload --list shows registered modules', e);
  }

  // =========================================================================
  // Test 3: Check module status and versions
  // =========================================================================
  results.startTest();
  try {
    const r = await os.exec('reload --status');
    assertEqual(r.exitCode, 0, 'reload --status should succeed');
    assertIncludes(r.stdout, 'version:', 'should show version numbers');
    assertIncludes(r.stdout, 'updated:', 'should show update times');
    results.pass('reload --status shows module metadata');
  } catch (e) {
    results.fail('reload --status shows module metadata', e);
  }

  // =========================================================================
  // Test 4: Create a simple command and hot-load it
  // =========================================================================
  results.startTest();
  try {
    // Create a simple test command in VFS
    const testCmdSource = `
export const testHotReloadCmd = {
  name: 'test-hotreload',
  description: 'Test command for hot-reload',
  _counter: 0,

  migrateFrom(old) {
    this._counter = old._counter;
    console.log('[test-hotreload] Migrated counter:', this._counter);
  },

  async exec(ctx) {
    this._counter++;
    ctx.stdout = 'Hot-reload test v1, counter: ' + this._counter + '\\n';
    return 0;
  }
};

export default testHotReloadCmd;
`;

    await os.mkdir('/tmp/hotreload-test');
    await os.writeFile('/tmp/hotreload-test/test-cmd.ts', testCmdSource);

    // Verify file was written
    const content = await os.readFile('/tmp/hotreload-test/test-cmd.ts');
    assertIncludes(content, 'test-hotreload', 'source file should be written');
    results.pass('create test command source file');
  } catch (e) {
    results.fail('create test command source file', e);
  }

  // =========================================================================
  // Test 5: Hot-load the new command
  // =========================================================================
  results.startTest();
  try {
    const r = await os.exec('reload commands/test-hotreload /tmp/hotreload-test/test-cmd.ts');
    assertEqual(r.exitCode, 0, 'reload should succeed');
    assertIncludes(r.stdout, 'Registered new module', 'should register new module');
    results.pass('hot-load new command from VFS');
  } catch (e) {
    results.fail('hot-load new command from VFS', e);
  }

  // =========================================================================
  // Test 6: Execute the hot-loaded command
  // =========================================================================
  results.startTest();
  try {
    const r = await os.exec('test-hotreload');
    assertEqual(r.exitCode, 0, 'command should succeed');
    assertIncludes(r.stdout, 'Hot-reload test v1', 'should show v1 output');
    assertIncludes(r.stdout, 'counter: 1', 'counter should be 1');
    results.pass('execute hot-loaded command');
  } catch (e) {
    results.fail('execute hot-loaded command', e);
  }

  // =========================================================================
  // Test 7: Execute again to increment counter
  // =========================================================================
  results.startTest();
  try {
    const r = await os.exec('test-hotreload');
    assertEqual(r.exitCode, 0, 'command should succeed');
    assertIncludes(r.stdout, 'counter: 2', 'counter should be 2');
    results.pass('command maintains state across executions');
  } catch (e) {
    results.fail('command maintains state across executions', e);
  }

  // =========================================================================
  // Test 8: Update source and hot-reload with state migration
  // =========================================================================
  results.startTest();
  try {
    // Create v2 of the command
    const testCmdV2 = `
export const testHotReloadCmd = {
  name: 'test-hotreload',
  description: 'Test command for hot-reload v2',
  _counter: 0,

  migrateFrom(old) {
    this._counter = old._counter;
    console.log('[test-hotreload] Migrated counter:', this._counter);
  },

  async exec(ctx) {
    this._counter++;
    ctx.stdout = 'Hot-reload test v2 (upgraded!), counter: ' + this._counter + '\\n';
    return 0;
  }
};

export default testHotReloadCmd;
`;

    await os.writeFile('/tmp/hotreload-test/test-cmd.ts', testCmdV2);

    // Hot-reload the updated command
    const r = await os.exec('reload commands/test-hotreload /tmp/hotreload-test/test-cmd.ts');
    assertEqual(r.exitCode, 0, 'reload should succeed');
    assertIncludes(r.stdout, 'Hot-reloaded', 'should hot-reload existing module');
    assertIncludes(r.stdout, 'state migration', 'should perform state migration');
    results.pass('hot-reload updated command with migration');
  } catch (e) {
    results.fail('hot-reload updated command with migration', e);
  }

  // =========================================================================
  // Test 9: Verify state was preserved through hot-reload
  // =========================================================================
  results.startTest();
  try {
    const r = await os.exec('test-hotreload');
    assertEqual(r.exitCode, 0, 'command should succeed');
    assertIncludes(r.stdout, 'v2 (upgraded!)', 'should show v2 output');
    assertIncludes(r.stdout, 'counter: 3', 'counter should be 3 (preserved + incremented)');
    results.pass('state preserved through hot-reload');
  } catch (e) {
    results.fail('state preserved through hot-reload', e);
  }

  // =========================================================================
  // Test 10: Verify module version incremented
  // =========================================================================
  results.startTest();
  try {
    const r = await os.exec('reload --status');
    assertIncludes(r.stdout, 'commands/test-hotreload', 'test command should appear in status');

    // Check version is 2 (registered once, then replaced once)
    const versionMatch = await page.evaluate(() => {
      const meta = window.__shiro?.registry?.getMetadata('commands/test-hotreload');
      return meta?.version;
    });
    assertEqual(versionMatch, 2, 'module version should be 2');
    results.pass('module version incremented after reload');
  } catch (e) {
    results.fail('module version incremented after reload', e);
  }

  // =========================================================================
  // Test 11: Clone Shiro repo (if not too slow)
  // =========================================================================
  results.startTest();
  try {
    // Check if we already have a clone
    const exists = await os.exists('/tmp/shiro-selfmod');

    if (!exists) {
      // This is slow, so we do a shallow clone
      const r = await os.exec('git clone --depth 1 https://github.com/williamsharkey/shiro /tmp/shiro-selfmod');
      // Git clone might take a while, check for success or timeout
      if (r.exitCode !== 0 && !r.stderr.includes('already exists')) {
        throw new Error(`Clone failed: ${r.stderr}`);
      }
    }

    // Verify clone succeeded
    const hasPackageJson = await os.exists('/tmp/shiro-selfmod/package.json');
    assert(hasPackageJson, 'package.json should exist after clone');

    const hasSrc = await os.exists('/tmp/shiro-selfmod/src');
    assert(hasSrc, 'src directory should exist after clone');

    results.pass('clone Shiro repo inside itself');
  } catch (e) {
    // Clone might timeout or fail in test environment - skip gracefully
    results.skip('clone Shiro repo inside itself', `Clone failed or timed out: ${e.message}`);
  }

  // =========================================================================
  // Test 12: Edit source file from cloned repo
  // =========================================================================
  results.startTest();
  try {
    const cloneExists = await os.exists('/tmp/shiro-selfmod/src');
    if (!cloneExists) {
      results.skip('edit cloned source file', 'Clone not available');
    } else {
      // Read an existing command source
      const exists = await os.exists('/tmp/shiro-selfmod/src/commands/glob.ts');
      if (exists) {
        const content = await os.readFile('/tmp/shiro-selfmod/src/commands/glob.ts');
        assertIncludes(content, 'glob', 'should contain glob command');

        // Modify it slightly (add a comment)
        const modified = '// Modified by hot-reload test\n' + content;
        await os.writeFile('/tmp/shiro-selfmod/src/commands/glob.ts', modified);

        // Verify modification
        const newContent = await os.readFile('/tmp/shiro-selfmod/src/commands/glob.ts');
        assertIncludes(newContent, 'Modified by hot-reload test', 'file should be modified');

        results.pass('edit cloned source file');
      } else {
        results.skip('edit cloned source file', 'glob.ts not found in clone');
      }
    }
  } catch (e) {
    results.fail('edit cloned source file', e);
  }

  // =========================================================================
  // Test 13: Verify reload --all works
  // =========================================================================
  results.startTest();
  try {
    // First register a module with a source
    await os.writeFile('/tmp/hotreload-test/all-test.ts', `
export default {
  name: 'all-test',
  description: 'Test for reload --all',
  async exec(ctx) {
    ctx.stdout = 'all-test works\\n';
    return 0;
  }
};
`);

    await os.exec('reload commands/all-test /tmp/hotreload-test/all-test.ts');

    // Now reload all
    const r = await os.exec('reload --all');
    assertEqual(r.exitCode, 0, 'reload --all should succeed');
    assertIncludes(r.stdout, 'Reloaded', 'should show reloaded count');
    results.pass('reload --all reloads modules with sources');
  } catch (e) {
    results.fail('reload --all reloads modules with sources', e);
  }

  // =========================================================================
  // Cleanup
  // =========================================================================
  try {
    await os.exec('rm -rf /tmp/hotreload-test');
  } catch {
    // Ignore cleanup errors
  }

  results.summary();
  return results;
}
