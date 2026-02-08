import { Command, CommandContext } from './index';

/**
 * test: Simple test runner for browser-native JavaScript tests
 *
 * Provides Jest-like globals (describe, it, expect) and runs test files.
 *
 * Usage:
 *   test                     Run all *.test.js files in current directory
 *   test path/to/test.js     Run specific test file
 *   test --help              Show help
 *
 * Test files should use:
 *   describe('suite', () => { ... })
 *   it('test name', () => { ... })
 *   expect(value).toBe(expected)
 */

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

interface SuiteResult {
  name: string;
  tests: TestResult[];
}

export const testCmd: Command = {
  name: 'jest',
  description: 'Run JavaScript test files with Jest-like syntax',

  async exec(ctx: CommandContext): Promise<number> {
    if (ctx.args[0] === '--help' || ctx.args[0] === '-h') {
      ctx.stdout += 'Usage: test [files...]\n\n';
      ctx.stdout += 'Run JavaScript tests with Jest-like syntax.\n\n';
      ctx.stdout += 'Options:\n';
      ctx.stdout += '  --help, -h    Show this help\n';
      ctx.stdout += '  --verbose     Show all test names\n';
      ctx.stdout += '\nIf no files specified, runs all *.test.js in current directory.\n';
      ctx.stdout += '\nTest syntax:\n';
      ctx.stdout += "  describe('suite', () => {\n";
      ctx.stdout += "    it('test name', () => {\n";
      ctx.stdout += '      expect(1 + 1).toBe(2);\n';
      ctx.stdout += '    });\n';
      ctx.stdout += '  });\n';
      return 0;
    }

    const verbose = ctx.args.includes('--verbose') || ctx.args.includes('-v');
    const fileArgs = ctx.args.filter(a => !a.startsWith('-'));

    // Find test files
    let testFiles: string[] = [];
    if (fileArgs.length > 0) {
      testFiles = fileArgs.map(f => ctx.fs.resolvePath(f, ctx.cwd));
    } else {
      // Find all *.test.js files in current directory
      try {
        const files = await ctx.fs.readdir(ctx.cwd);
        for (const file of files) {
          if (file.endsWith('.test.js')) {
            testFiles.push(ctx.fs.resolvePath(file, ctx.cwd));
          }
        }
      } catch (e: any) {
        ctx.stderr += `test: cannot read directory: ${e.message}\n`;
        return 1;
      }
    }

    if (testFiles.length === 0) {
      ctx.stderr += 'test: no test files found\n';
      ctx.stderr += 'Run "test --help" for usage.\n';
      return 1;
    }

    // Run tests
    const allResults: SuiteResult[] = [];
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;

    for (const testFile of testFiles) {
      ctx.stdout += `\n${getFileName(testFile)}\n`;

      try {
        const results = await runTestFile(ctx, testFile);
        allResults.push(...results);

        for (const suite of results) {
          for (const test of suite.tests) {
            totalTests++;
            if (test.passed) {
              passedTests++;
              if (verbose) {
                ctx.stdout += `  ✓ ${test.name}\n`;
              }
            } else {
              failedTests++;
              ctx.stdout += `  ✗ ${test.name}\n`;
              if (test.error) {
                ctx.stdout += `    ${test.error}\n`;
              }
            }
          }
        }
      } catch (e: any) {
        ctx.stderr += `  Error running ${testFile}: ${e.message}\n`;
        failedTests++;
        totalTests++;
      }
    }

    // Summary
    ctx.stdout += '\n';
    if (failedTests === 0) {
      ctx.stdout += `✓ ${passedTests} test${passedTests !== 1 ? 's' : ''} passed\n`;
      return 0;
    } else {
      ctx.stdout += `✗ ${failedTests} failed, ${passedTests} passed (${totalTests} total)\n`;
      return 1;
    }
  },
};

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

async function runTestFile(ctx: CommandContext, filePath: string): Promise<SuiteResult[]> {
  // Read test file
  const code = await ctx.fs.readFile(filePath, 'utf8') as string;

  // Create test harness
  const suites: SuiteResult[] = [];
  let currentSuite: SuiteResult = { name: 'default', tests: [] };
  suites.push(currentSuite);

  // Jest-like globals
  function describe(name: string, fn: () => void) {
    const prevSuite = currentSuite;
    currentSuite = { name, tests: [] };
    suites.push(currentSuite);
    try {
      fn();
    } finally {
      currentSuite = prevSuite;
    }
  }

  function it(name: string, fn: () => void | Promise<void>) {
    const fullName = currentSuite.name !== 'default'
      ? `${currentSuite.name} > ${name}`
      : name;

    try {
      const result = fn();
      if (result instanceof Promise) {
        // Mark as async - will be resolved later
        currentSuite.tests.push({
          name: fullName,
          passed: true,
          error: undefined,
        });
        result.catch(e => {
          // Find and update the test result
          const testResult = currentSuite.tests.find(t => t.name === fullName);
          if (testResult) {
            testResult.passed = false;
            testResult.error = e.message || String(e);
          }
        });
      } else {
        currentSuite.tests.push({ name: fullName, passed: true });
      }
    } catch (e: any) {
      currentSuite.tests.push({
        name: fullName,
        passed: false,
        error: e.message || String(e),
      });
    }
  }

  // Alias
  const test = it;

  // expect() with matchers
  function expect(actual: any) {
    return {
      toBe(expected: any) {
        if (actual !== expected) {
          throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
      },
      toEqual(expected: any) {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
      },
      toBeTruthy() {
        if (!actual) {
          throw new Error(`Expected truthy value, got ${JSON.stringify(actual)}`);
        }
      },
      toBeFalsy() {
        if (actual) {
          throw new Error(`Expected falsy value, got ${JSON.stringify(actual)}`);
        }
      },
      toBeNull() {
        if (actual !== null) {
          throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
        }
      },
      toBeUndefined() {
        if (actual !== undefined) {
          throw new Error(`Expected undefined, got ${JSON.stringify(actual)}`);
        }
      },
      toBeDefined() {
        if (actual === undefined) {
          throw new Error('Expected defined value, got undefined');
        }
      },
      toBeGreaterThan(expected: number) {
        if (!(actual > expected)) {
          throw new Error(`Expected ${actual} > ${expected}`);
        }
      },
      toBeLessThan(expected: number) {
        if (!(actual < expected)) {
          throw new Error(`Expected ${actual} < ${expected}`);
        }
      },
      toContain(expected: any) {
        if (typeof actual === 'string') {
          if (!actual.includes(expected)) {
            throw new Error(`Expected "${actual}" to contain "${expected}"`);
          }
        } else if (Array.isArray(actual)) {
          if (!actual.includes(expected)) {
            throw new Error(`Expected array to contain ${JSON.stringify(expected)}`);
          }
        } else {
          throw new Error('toContain only works with strings and arrays');
        }
      },
      toHaveLength(expected: number) {
        if (actual.length !== expected) {
          throw new Error(`Expected length ${expected}, got ${actual.length}`);
        }
      },
      toMatch(pattern: RegExp | string) {
        const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
        if (!regex.test(actual)) {
          throw new Error(`Expected "${actual}" to match ${pattern}`);
        }
      },
      toThrow(expectedMessage?: string | RegExp) {
        if (typeof actual !== 'function') {
          throw new Error('toThrow requires a function');
        }
        let threw = false;
        let thrownError: any;
        try {
          actual();
        } catch (e) {
          threw = true;
          thrownError = e;
        }
        if (!threw) {
          throw new Error('Expected function to throw');
        }
        if (expectedMessage !== undefined) {
          const msg = thrownError?.message || String(thrownError);
          if (expectedMessage instanceof RegExp) {
            if (!expectedMessage.test(msg)) {
              throw new Error(`Expected error matching ${expectedMessage}, got "${msg}"`);
            }
          } else if (!msg.includes(expectedMessage)) {
            throw new Error(`Expected error containing "${expectedMessage}", got "${msg}"`);
          }
        }
      },
      not: {
        toBe(expected: any) {
          if (actual === expected) {
            throw new Error(`Expected not ${JSON.stringify(expected)}`);
          }
        },
        toEqual(expected: any) {
          if (JSON.stringify(actual) === JSON.stringify(expected)) {
            throw new Error(`Expected not ${JSON.stringify(expected)}`);
          }
        },
        toBeTruthy() {
          if (actual) {
            throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`);
          }
        },
        toBeFalsy() {
          if (!actual) {
            throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
          }
        },
        toBeNull() {
          if (actual === null) {
            throw new Error('Expected not null');
          }
        },
        toBeUndefined() {
          if (actual === undefined) {
            throw new Error('Expected not undefined');
          }
        },
        toContain(expected: any) {
          if (typeof actual === 'string' && actual.includes(expected)) {
            throw new Error(`Expected "${actual}" not to contain "${expected}"`);
          }
          if (Array.isArray(actual) && actual.includes(expected)) {
            throw new Error(`Expected array not to contain ${JSON.stringify(expected)}`);
          }
        },
        toThrow() {
          if (typeof actual !== 'function') {
            throw new Error('toThrow requires a function');
          }
          try {
            actual();
          } catch (e) {
            throw new Error('Expected function not to throw');
          }
        },
      },
    };
  }

  // Build-in modules available in tests
  const fakeConsole = {
    log: (...args: any[]) => { ctx.stdout += args.map(String).join(' ') + '\n'; },
    warn: (...args: any[]) => { ctx.stderr += args.map(String).join(' ') + '\n'; },
    error: (...args: any[]) => { ctx.stderr += args.map(String).join(' ') + '\n'; },
  };

  // Execute test file
  try {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFunction(
      'describe', 'it', 'test', 'expect', 'console',
      code
    );
    await fn(describe, it, test, expect, fakeConsole);
  } catch (e: any) {
    suites.push({
      name: 'execution error',
      tests: [{
        name: 'test file execution',
        passed: false,
        error: e.message,
      }],
    });
  }

  // Filter out empty default suite
  return suites.filter(s => s.tests.length > 0);
}
