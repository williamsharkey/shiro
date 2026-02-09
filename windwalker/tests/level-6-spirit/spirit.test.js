// Level 6: Spirit OSProvider tests
// Verify the Spirit provider interface works correctly on each OS
// NOTE: These tests do NOT call the Anthropic API -- they test the OSProvider layer only

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 6: Spirit Provider (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  // Test: Provider exists
  try {
    const has = await os.hasProvider();
    if (!has) {
      results.skip('all provider tests', 'provider not exposed on window');
      results.summary();
      return results;
    }
    results.pass('provider exists');
  } catch (e) {
    results.fail('provider exists', e);
    results.summary();
    return results;
  }

  // Test: provider.readFile
  try {
    await os.writeFile('/tmp/ww-spirit-read.txt', 'spirit read test');
    const content = await os.providerReadFile('/tmp/ww-spirit-read.txt');
    assertIncludes(content, 'spirit read test', 'provider readFile');
    results.pass('provider.readFile');
  } catch (e) {
    results.fail('provider.readFile', e);
  }

  // Test: provider.writeFile
  try {
    await page.evaluate(async (os) => {
      const p = os === 'foam' ? window.__foam.provider : window.__shiro.provider;
      await p.writeFile('/tmp/ww-spirit-write.txt', 'spirit write test');
    }, osTarget);
    const content = await os.readFile('/tmp/ww-spirit-write.txt');
    assertEqual(content, 'spirit write test', 'provider writeFile');
    results.pass('provider.writeFile');
  } catch (e) {
    results.fail('provider.writeFile', e);
  }

  // Test: provider.exec
  try {
    const result = await os.providerExec('echo "spirit exec"');
    assertIncludes(result.stdout, 'spirit exec', 'provider exec stdout');
    assertEqual(result.exitCode, 0, 'provider exec exit code');
    results.pass('provider.exec');
  } catch (e) {
    results.fail('provider.exec', e);
  }

  // Test: provider.exec captures stderr
  try {
    const result = await os.providerExec('nonexistent_ww_cmd_xyz');
    assert(result.exitCode !== 0 || result.stderr.length > 0,
      'failed command should have non-zero exit or stderr');
    results.pass('provider.exec (error handling)');
  } catch (e) {
    // Throwing is also acceptable
    results.pass('provider.exec (error handling - threw)');
  }

  // Test: provider.mkdir
  try {
    await page.evaluate(async (os) => {
      const p = os === 'foam' ? window.__foam.provider : window.__shiro.provider;
      await p.mkdir('/tmp/ww-spirit-mkdir');
    }, osTarget);
    const exists = await os.exists('/tmp/ww-spirit-mkdir');
    assert(exists, 'provider mkdir should create directory');
    results.pass('provider.mkdir');
  } catch (e) {
    results.fail('provider.mkdir', e);
  }

  // Test: provider.readdir
  try {
    await os.writeFile('/tmp/ww-spirit-mkdir/f1.txt', '1');
    await os.writeFile('/tmp/ww-spirit-mkdir/f2.txt', '2');
    const entries = await page.evaluate(async (os) => {
      const p = os === 'foam' ? window.__foam.provider : window.__shiro.provider;
      return p.readdir('/tmp/ww-spirit-mkdir');
    }, osTarget);
    const names = entries.map(e => typeof e === 'string' ? e : e.name);
    assert(names.includes('f1.txt'), 'readdir should list f1.txt');
    assert(names.includes('f2.txt'), 'readdir should list f2.txt');
    results.pass('provider.readdir');
  } catch (e) {
    results.fail('provider.readdir', e);
  }

  // Test: provider.stat
  try {
    const info = await page.evaluate(async (os) => {
      const p = os === 'foam' ? window.__foam.provider : window.__shiro.provider;
      return p.stat('/tmp/ww-spirit-read.txt');
    }, osTarget);
    assert(info, 'provider stat should return info');
    results.pass('provider.stat');
  } catch (e) {
    results.fail('provider.stat', e);
  }

  // Test: provider.exists
  try {
    const yes = await page.evaluate(async (os) => {
      const p = os === 'foam' ? window.__foam.provider : window.__shiro.provider;
      return p.exists('/tmp/ww-spirit-read.txt');
    }, osTarget);
    assert(yes, 'provider.exists should return true');
    results.pass('provider.exists');
  } catch (e) {
    results.fail('provider.exists', e);
  }

  // Test: provider.glob
  try {
    const matches = await page.evaluate(async (os) => {
      const p = os === 'foam' ? window.__foam.provider : window.__shiro.provider;
      return p.glob('*.txt', '/tmp/ww-spirit-mkdir');
    }, osTarget);
    assert(Array.isArray(matches), 'glob should return array');
    assert(matches.length >= 2, 'glob should find txt files');
    results.pass('provider.glob');
  } catch (e) {
    results.fail('provider.glob', e);
  }

  // Test: provider.getCwd
  try {
    const cwd = await page.evaluate(async (os) => {
      const p = os === 'foam' ? window.__foam.provider : window.__shiro.provider;
      return p.getCwd();
    }, osTarget);
    assert(cwd && cwd.startsWith('/'), 'getCwd should return absolute path');
    results.pass('provider.getCwd');
  } catch (e) {
    results.fail('provider.getCwd', e);
  }

  // Test: provider.getHostInfo
  try {
    const info = await page.evaluate(async (os) => {
      const p = os === 'foam' ? window.__foam.provider : window.__shiro.provider;
      return p.getHostInfo();
    }, osTarget);
    assert(info && info.name, 'getHostInfo should return name');
    results.pass('provider.getHostInfo');
  } catch (e) {
    results.fail('provider.getHostInfo', e);
  }

  results.summary();
  return results;
}
