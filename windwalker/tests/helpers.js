// helpers.js -- OS abstraction layer for windwalker tests
// Provides a unified API to interact with Foam or Shiro through Puppeteer

/**
 * Returns an object with helper functions bound to the given Puppeteer page
 * and OS target ('foam' or 'shiro').
 */
export function createOSHelpers(page, osTarget) {
  const helpers = {
    osTarget,

    // -- Filesystem operations --

    async writeFile(path, content) {
      return page.evaluate(async ({ path, content, os }) => {
        if (os === 'foam') {
          await window.__foam.vfs.writeFile(path, content);
        } else {
          await window.__shiro.fs.writeFile(path, content);
        }
      }, { path, content, os: osTarget });
    },

    async readFile(path) {
      return page.evaluate(async ({ path, os }) => {
        if (os === 'foam') {
          return window.__foam.vfs.readFile(path);
        } else {
          const data = await window.__shiro.fs.readFile(path);
          // Shiro may return Uint8Array
          if (data instanceof Uint8Array) {
            return new TextDecoder().decode(data);
          }
          return data;
        }
      }, { path, os: osTarget });
    },

    async mkdir(path) {
      return page.evaluate(async ({ path, os }) => {
        if (os === 'foam') {
          await window.__foam.vfs.mkdir(path);
        } else {
          await window.__shiro.fs.mkdir(path);
        }
      }, { path, os: osTarget });
    },

    async readdir(path) {
      return page.evaluate(async ({ path, os }) => {
        if (os === 'foam') {
          return window.__foam.vfs.readdir(path);
        } else {
          return window.__shiro.fs.readdir(path);
        }
      }, { path, os: osTarget });
    },

    async stat(path) {
      return page.evaluate(async ({ path, os }) => {
        if (os === 'foam') {
          return window.__foam.vfs.stat(path);
        } else {
          return window.__shiro.fs.stat(path);
        }
      }, { path, os: osTarget });
    },

    async exists(path) {
      return page.evaluate(async ({ path, os }) => {
        try {
          if (os === 'foam') {
            await window.__foam.vfs.stat(path);
          } else {
            await window.__shiro.fs.stat(path);
          }
          return true;
        } catch {
          return false;
        }
      }, { path, os: osTarget });
    },

    async unlink(path) {
      return page.evaluate(async ({ path, os }) => {
        if (os === 'foam') {
          await window.__foam.vfs.unlink(path);
        } else {
          await window.__shiro.fs.unlink(path);
        }
      }, { path, os: osTarget });
    },

    async rename(oldPath, newPath) {
      return page.evaluate(async ({ oldPath, newPath, os }) => {
        if (os === 'foam') {
          await window.__foam.vfs.rename(oldPath, newPath);
        } else {
          await window.__shiro.fs.rename(oldPath, newPath);
        }
      }, { oldPath, newPath, os: osTarget });
    },

    // -- Shell operations --

    async exec(command) {
      return page.evaluate(async ({ command, os }) => {
        if (os === 'foam') {
          const result = { stdout: '', stderr: '', exitCode: 0 };
          try {
            const output = await window.__foam.shell.exec(command);
            if (typeof output === 'object') {
              result.stdout = output.stdout || '';
              result.stderr = output.stderr || '';
              result.exitCode = output.exitCode ?? 0;
            } else {
              result.stdout = String(output || '');
            }
          } catch (e) {
            result.stderr = e.message;
            result.exitCode = 1;
          }
          return result;
        } else {
          const result = { stdout: '', stderr: '', exitCode: 0 };
          try {
            const output = await window.__shiro.shell.exec(command);
            if (typeof output === 'object') {
              result.stdout = output.stdout || '';
              result.stderr = output.stderr || '';
              result.exitCode = output.exitCode ?? 0;
            } else {
              result.stdout = String(output || '');
            }
          } catch (e) {
            result.stderr = e.message;
            result.exitCode = 1;
          }
          return result;
        }
      }, { command, os: osTarget });
    },

    // -- Environment --

    async getCwd() {
      return page.evaluate(async ({ os }) => {
        if (os === 'foam') {
          return window.__foam.shell.cwd || window.__foam.vfs.cwd || '/home/user';
        } else {
          return window.__shiro.shell?.cwd || '/home/user';
        }
      }, { os: osTarget });
    },

    async getEnv(key) {
      return page.evaluate(async ({ key, os }) => {
        if (os === 'foam') {
          return window.__foam.shell.env?.[key];
        } else {
          return window.__shiro.shell?.env?.[key];
        }
      }, { key, os: osTarget });
    },

    // -- Provider (Spirit OSProvider interface) --

    async hasProvider() {
      return page.evaluate(async ({ os }) => {
        if (os === 'foam') {
          return !!window.__foam?.provider;
        } else {
          return !!window.__shiro?.provider;
        }
      }, { os: osTarget });
    },

    async providerReadFile(path) {
      return page.evaluate(async ({ path, os }) => {
        if (os === 'foam') {
          return window.__foam.provider.readFile(path);
        } else {
          return window.__shiro.provider.readFile(path);
        }
      }, { path, os: osTarget });
    },

    async providerExec(command) {
      return page.evaluate(async ({ command, os }) => {
        if (os === 'foam') {
          return window.__foam.provider.exec(command);
        } else {
          return window.__shiro.provider.exec(command);
        }
      }, { command, os: osTarget });
    },
  };

  return helpers;
}

/**
 * Collects console errors from the page during a test run.
 */
export function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    errors.push(err.message);
  });
  return errors;
}

/**
 * Test result tracking with timing and JSON export.
 */
export class TestResults {
  constructor(suiteName) {
    this.suite = suiteName;
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.failures = [];
    this.details = []; // { name, status, duration?, error? }
    this._startTime = Date.now();
    this._testStart = null;
  }

  /** Call before running a test to track timing. */
  startTest() {
    this._testStart = Date.now();
  }

  pass(name) {
    const duration = this._testStart ? Date.now() - this._testStart : 0;
    this.passed++;
    this.details.push({ name, status: 'pass', duration });
    const ms = duration > 0 ? ` (${duration}ms)` : '';
    console.log(`  ✓ ${name}${ms}`);
    this._testStart = null;
  }

  fail(name, error) {
    const duration = this._testStart ? Date.now() - this._testStart : 0;
    this.failed++;
    const errorStr = String(error);
    this.failures.push({ name, error: errorStr });
    this.details.push({ name, status: 'fail', duration, error: errorStr });
    console.log(`  ✗ ${name}`);
    console.log(`    ${error}`);
    this._testStart = null;
  }

  skip(name, reason) {
    this.skipped++;
    this.details.push({ name, status: 'skip', reason });
    console.log(`  - ${name} (skipped: ${reason})`);
  }

  summary() {
    const total = this.passed + this.failed + this.skipped;
    const elapsed = Date.now() - this._startTime;
    console.log(`\n  ${this.suite}: ${this.passed}/${total} passed` +
      (this.failed ? `, ${this.failed} failed` : '') +
      (this.skipped ? `, ${this.skipped} skipped` : '') +
      ` [${elapsed}ms]`);
    return this.failed === 0;
  }

  /** Export results as a JSON-serializable object. */
  toJSON() {
    return {
      suite: this.suite,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      elapsed: Date.now() - this._startTime,
      tests: this.details,
      failures: this.failures,
    };
  }
}

/**
 * Assert helper.
 */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      (message ? message + ': ' : '') +
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

export function assertIncludes(haystack, needle, message) {
  if (!haystack?.includes(needle)) {
    throw new Error(
      (message ? message + ': ' : '') +
      `expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`
    );
  }
}

export function assertMatch(str, pattern, message) {
  if (!pattern.test(str)) {
    throw new Error(
      (message ? message + ': ' : '') +
      `expected ${JSON.stringify(str)} to match ${pattern}`
    );
  }
}

export function assertNotIncludes(haystack, needle, message) {
  if (haystack?.includes(needle)) {
    throw new Error(
      (message ? message + ': ' : '') +
      `expected ${JSON.stringify(haystack)} to NOT include ${JSON.stringify(needle)}`
    );
  }
}

export async function assertThrows(fn, message) {
  try {
    await fn();
    throw new Error(
      (message ? message + ': ' : '') + 'expected function to throw'
    );
  } catch (e) {
    if (e.message?.includes('expected function to throw')) throw e;
    // Threw as expected
  }
}

export function assertGreater(actual, expected, message) {
  if (!(actual > expected)) {
    throw new Error(
      (message ? message + ': ' : '') +
      `expected ${actual} > ${expected}`
    );
  }
}
