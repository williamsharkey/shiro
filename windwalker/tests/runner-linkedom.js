#!/usr/bin/env node
// runner-linkedom.js -- Fast linkedom-based test runner for windwalker
// Runs tests directly in Node.js without browser overhead
// Uses fake-indexeddb for VFS storage

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Set up fake-indexeddb BEFORE importing anything that uses IndexedDB
import 'fake-indexeddb/auto';

// Set up linkedom for DOM APIs
import { parseHTML } from 'linkedom';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
// FOAM_PATH can be overridden via env var (useful for CI)
const FOAM_PATH = process.env.FOAM_PATH || join(ROOT, '..', 'foam', 'src');

// Test suite modules (only levels 0-4 for linkedom -- higher levels need real browser)
const LINKEDOM_SUITES = [
  { name: 'level-0-boot',       path: './level-0-boot/boot.test.js' },
  { name: 'level-1-filesystem', path: './level-1-filesystem/filesystem.test.js' },
  { name: 'level-2-shell',      path: './level-2-shell/shell.test.js' },
  { name: 'level-3-coreutils',  path: './level-3-coreutils/coreutils.test.js' },
  { name: 'level-4-pipes',      path: './level-4-pipes/pipes.test.js' },
];

// Higher-level suites that need real browser (skip in linkedom mode)
const BROWSER_ONLY_SUITES = [
  'level-5-git',
  'level-6-spirit',
  'level-7-workflows',
  'level-8-fluffycoreutils',
  'level-9-selfbuild',
];

/**
 * Create a mock page object that provides the same interface as Puppeteer/Skyeyes
 * but executes code directly against Foam modules
 */
async function createMockPage(vfs, shell) {
  // Set up globals that Foam expects
  const mockGlobals = {
    __foam: {
      vfs,
      shell,
      terminal: null,
      provider: null,
    },
  };

  return {
    // Mock page.evaluate() to execute functions directly
    async evaluate(fn, ...args) {
      if (typeof fn === 'function') {
        // Create a mock window object with our globals
        const window = { ...mockGlobals };

        // Execute the function with the mock window
        const originalWindow = global.window;
        global.window = window;
        try {
          return await fn(...args);
        } finally {
          global.window = originalWindow;
        }
      }
      // For string expressions
      return eval(fn);
    },

    // Mock page.title()
    async title() {
      return 'Foam (linkedom)';
    },

    // Mock page.on() - no-op for console/pageerror in linkedom
    on(event, handler) {
      // No-op - linkedom doesn't have real browser events
    },

    // Mock page.waitForFunction() - just run immediately
    async waitForFunction(fn, options = {}) {
      const window = { ...mockGlobals };
      global.window = window;
      try {
        return await fn();
      } finally {
        global.window = undefined;
      }
    },
  };
}

/**
 * Initialize Foam VFS and Shell for testing
 */
async function initFoam() {
  // Import Foam modules
  const VFS = (await import(join(FOAM_PATH, 'vfs.js'))).default;
  const Shell = (await import(join(FOAM_PATH, 'shell.js'))).default;

  // Initialize VFS
  const vfs = new VFS();
  await vfs.init();

  // Initialize Shell
  const shell = new Shell(vfs);

  // Try to load fluffycoreutils commands
  try {
    const { registerFluffyCommands } = await import(join(FOAM_PATH, 'fluffy-bridge.js'));
    await registerFluffyCommands();
  } catch (e) {
    console.log('  Note: fluffycoreutils not available, using built-in commands only');
  }

  return { vfs, shell };
}

async function runLinkedomTests() {
  console.log('Windwalker Test Suite (Linkedom Mode)');
  console.log('Target: foam (direct module access)');
  console.log('\n⚡ Using linkedom - ~10ms startup, no browser!\n');

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const allFailures = [];
  const suiteResults = [];

  // Initialize Foam once for all tests
  console.log('Initializing Foam modules...');
  let vfs, shell;
  try {
    ({ vfs, shell } = await initFoam());
    console.log('✓ Foam initialized\n');
  } catch (err) {
    console.error('✗ Failed to initialize Foam:', err.message);
    console.error('  Make sure ../foam/src exists and has vfs.js and shell.js');
    process.exit(1);
  }

  // Create mock page
  const page = await createMockPage(vfs, shell);

  for (const suite of LINKEDOM_SUITES) {
    const suitePath = join(__dirname, suite.path);
    if (!existsSync(suitePath)) {
      console.log(`\n⊘ ${suite.name} (no test file yet)`);
      continue;
    }

    try {
      const mod = await import(suitePath);
      const results = await mod.default(page, 'foam');
      totalPassed += results.passed;
      totalFailed += results.failed;
      totalSkipped += results.skipped;
      if (results.toJSON) suiteResults.push(results.toJSON());
      allFailures.push(...results.failures.map(f => ({
        ...f,
        suite: suite.name,
      })));
    } catch (err) {
      console.log(`\n✗ ${suite.name} -- suite error: ${err.message}`);
      if (err.stack) console.log(`    ${err.stack.split('\n').slice(1, 3).join('\n    ')}`);
      totalFailed++;
      allFailures.push({
        name: `${suite.name} (suite-level error)`,
        error: err.message,
        suite: suite.name,
      });
    }
  }

  // Note skipped browser-only suites
  console.log(`\n${'─'.repeat(60)}`);
  console.log('Browser-only suites (use runner-skyeyes.js):');
  for (const name of BROWSER_ONLY_SUITES) {
    console.log(`  ⊘ ${name}`);
    totalSkipped++;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`LINKEDOM TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);
  if (allFailures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of allFailures) {
      console.log(`  [${f.suite}] ${f.name}: ${f.error}`);
    }
  }

  // Write JSON results
  const resultsDir = join(ROOT, 'test-results');
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const jsonReport = {
    timestamp: new Date().toISOString(),
    mode: 'linkedom',
    targets: [{
      target: 'foam',
      mode: 'linkedom',
      ok: totalFailed === 0,
      passed: totalPassed,
      failed: totalFailed,
      skipped: totalSkipped,
      suites: suiteResults,
      failures: allFailures,
    }],
  };
  writeFileSync(
    join(resultsDir, 'results-linkedom.json'),
    JSON.stringify(jsonReport, null, 2)
  );
  console.log(`\nResults written to test-results/results-linkedom.json`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

runLinkedomTests().catch(err => {
  console.error('Runner error:', err);
  process.exit(1);
});
