// Level 0: Boot tests
// Verify the OS loads without errors and exposes expected globals

import { createOSHelpers, collectConsoleErrors, TestResults } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 0: Boot (${osTarget})`);
  console.log(`\n● ${results.suite}`);

  // Test: Page loaded without crash
  try {
    const title = await page.title();
    results.pass('page loaded');
  } catch (e) {
    results.fail('page loaded', e);
  }

  // Test: No uncaught errors during boot
  try {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    // Give a moment for any late errors
    await new Promise(r => setTimeout(r, 500));
    if (errors.length > 0) {
      results.fail('no boot errors', `Console errors: ${errors.join('; ')}`);
    } else {
      results.pass('no boot errors');
    }
  } catch (e) {
    results.fail('no boot errors', e);
  }

  // Test: OS global object exists
  try {
    const hasGlobal = await page.evaluate((os) => {
      if (os === 'foam') return typeof window.__foam === 'object' && window.__foam !== null;
      if (os === 'shiro') return typeof window.__shiro === 'object' && window.__shiro !== null;
      return false;
    }, osTarget);
    if (hasGlobal) {
      results.pass('OS global object exists');
    } else {
      results.fail('OS global object exists', `window.__${osTarget} is not set`);
    }
  } catch (e) {
    results.fail('OS global object exists', e);
  }

  // Test: Filesystem object exists
  try {
    const hasFS = await page.evaluate((os) => {
      if (os === 'foam') return typeof window.__foam?.vfs === 'object';
      if (os === 'shiro') return typeof window.__shiro?.fs === 'object';
      return false;
    }, osTarget);
    if (hasFS) {
      results.pass('filesystem object exists');
    } else {
      results.fail('filesystem object exists', 'VFS/FS not found on global');
    }
  } catch (e) {
    results.fail('filesystem object exists', e);
  }

  // Test: Shell object exists
  try {
    const hasShell = await page.evaluate((os) => {
      if (os === 'foam') return typeof window.__foam?.shell === 'object';
      if (os === 'shiro') return typeof window.__shiro?.shell === 'object';
      return false;
    }, osTarget);
    if (hasShell) {
      results.pass('shell object exists');
    } else {
      results.fail('shell object exists', 'Shell not found on global');
    }
  } catch (e) {
    results.fail('shell object exists', e);
  }

  // Test: Terminal object exists
  try {
    const hasTerminal = await page.evaluate((os) => {
      if (os === 'foam') return typeof window.__foam?.terminal === 'object';
      if (os === 'shiro') return typeof window.__shiro?.terminal === 'object';
      return false;
    }, osTarget);
    if (hasTerminal) {
      results.pass('terminal object exists');
    } else {
      results.fail('terminal object exists', 'Terminal not found on global');
    }
  } catch (e) {
    results.fail('terminal object exists', e);
  }

  // Test: Default directories exist
  try {
    const os = createOSHelpers(page, osTarget);
    const homeExists = await os.exists('/home/user');
    const tmpExists = await os.exists('/tmp');
    if (homeExists && tmpExists) {
      results.pass('default directories exist (/home/user, /tmp)');
    } else {
      results.fail('default directories exist', `home=${homeExists}, tmp=${tmpExists}`);
    }
  } catch (e) {
    results.fail('default directories exist', e);
  }

  // Test: Environment variables are set
  try {
    const os = createOSHelpers(page, osTarget);
    const r = await os.exec('echo $HOME');
    if (r.stdout.includes('/home')) {
      results.pass('HOME environment variable set');
    } else {
      results.fail('HOME environment variable set', `HOME=${r.stdout}`);
    }
  } catch (e) {
    results.fail('HOME environment variable set', e);
  }

  // Test: PWD is set
  try {
    const os = createOSHelpers(page, osTarget);
    const r = await os.exec('echo $PWD');
    if (r.stdout.trim().length > 0) {
      results.pass('PWD environment variable set');
    } else {
      results.fail('PWD environment variable set', 'PWD is empty');
    }
  } catch (e) {
    results.fail('PWD environment variable set', e);
  }

  // Test: PATH is set
  try {
    const os = createOSHelpers(page, osTarget);
    const r = await os.exec('echo $PATH');
    if (r.stdout.trim().length > 0) {
      results.pass('PATH environment variable set');
    } else {
      results.fail('PATH environment variable set', 'PATH is empty');
    }
  } catch (e) {
    results.fail('PATH environment variable set', e);
  }

  // Test: Can execute basic command
  try {
    const os = createOSHelpers(page, osTarget);
    const r = await os.exec('echo test');
    if (r.stdout.includes('test')) {
      results.pass('basic command execution');
    } else {
      results.fail('basic command execution', 'echo did not work');
    }
  } catch (e) {
    results.fail('basic command execution', e);
  }

  results.summary();
  return results;
}
