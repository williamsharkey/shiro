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
import { parseHTML, DOMParser } from 'linkedom';

// Set up global.window with DOMParser BEFORE importing Foam modules
// This is needed for hypercompact (hc command) which checks window at module load
global.window = global.window || {};
global.window.DOMParser = DOMParser;
global.DOMParser = DOMParser;
// Note: Let commands.js initialize window.__hc with HCSession class

// Pre-load isomorphic-git for Node.js (Foam's devtools.js checks for this)
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
globalThis.__isomorphicGit = git;
globalThis.__isomorphicGitHttp = http;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
// FOAM_PATH can be overridden via env var (useful for CI)
const FOAM_PATH = process.env.FOAM_PATH || join(ROOT, '..', 'foam', 'src');

// Test suite modules for linkedom
// All these work without a real browser - isomorphic-git, VFS, and shell all run in Node.js
const LINKEDOM_SUITES = [
  { name: 'level-0-boot',         path: './level-0-boot/boot.test.js' },
  { name: 'level-1-filesystem',   path: './level-1-filesystem/filesystem.test.js' },
  { name: 'level-2-shell',        path: './level-2-shell/shell.test.js' },
  { name: 'level-3-coreutils',    path: './level-3-coreutils/coreutils.test.js' },
  { name: 'level-4-pipes',        path: './level-4-pipes/pipes.test.js' },
  { name: 'level-5-git',          path: './level-5-git/git.test.js' },
  { name: 'level-6-spirit',       path: './level-6-spirit/spirit.test.js' },
  { name: 'level-7-workflows',    path: './level-7-workflows/workflows.test.js' },
  { name: 'level-8-fluffycoreutils', path: './level-8-fluffycoreutils/fluffycoreutils.test.js' },
  // Level 9 requires network AND authentication (foam repo is private)
  // Run with ENABLE_NETWORK_TESTS=1 and GITHUB_TOKEN set
  { name: 'level-9-selfbuild',    path: './level-9-selfbuild/selfbuild.test.js', needsNetwork: true, needsAuth: true },
  { name: 'level-10-hypercompact', path: './level-10-hypercompact/hypercompact.test.js' },
  { name: 'level-11-advanced',    path: './level-11-advanced/advanced.test.js' },
];

// Suites that need network access (git clone over HTTPS)
// These are skipped in CI unless ENABLE_NETWORK_TESTS=1
const NETWORK_SUITES = ['level-9-selfbuild'];

/**
 * Create a mock page object that provides the same interface as Puppeteer/Skyeyes
 * but executes code directly against Foam modules
 */
async function createMockPage(vfs, shell, provider) {
  // Add __foam to global.window (preserving __hc, DOMParser, etc.)
  global.window.__foam = {
    vfs,
    shell,
    terminal: null,
    provider,
  };

  return {
    // Mock page.evaluate() to execute functions directly
    async evaluate(fn, ...args) {
      if (typeof fn === 'function') {
        // Use the global.window which has __foam, __hc, DOMParser, etc.
        return await fn(...args);
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
      // Use the global.window which has all our globals
      return await fn();
    },
  };
}

/**
 * Initialize Foam VFS, Shell, and Provider for testing
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

  // Initialize FoamProvider for Spirit tests (level-6)
  let provider = null;
  try {
    const FoamProvider = (await import(join(FOAM_PATH, 'foam-provider.js'))).default;
    provider = new FoamProvider(vfs, shell, null);
  } catch (e) {
    console.log('  Note: FoamProvider not available, level-6 tests may fail');
  }

  // Load devtools.js to register git, npm, node commands
  try {
    await import(join(FOAM_PATH, 'devtools.js'));
  } catch (e) {
    console.log('  Note: devtools not available, git tests may fail');
  }

  return { vfs, shell, provider };
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
  let vfs, shell, provider;
  try {
    ({ vfs, shell, provider } = await initFoam());
    console.log('✓ Foam initialized\n');
  } catch (err) {
    console.error('✗ Failed to initialize Foam:', err.message);
    console.error('  Make sure ../foam/src exists and has vfs.js and shell.js');
    process.exit(1);
  }

  // Create mock page
  const page = await createMockPage(vfs, shell, provider);

  // Check if network tests should run
  const enableNetworkTests = process.env.ENABLE_NETWORK_TESTS === '1';

  const skippedNetworkSuites = [];

  for (const suite of LINKEDOM_SUITES) {
    const suitePath = join(__dirname, suite.path);
    if (!existsSync(suitePath)) {
      console.log(`\n⊘ ${suite.name} (no test file yet)`);
      continue;
    }

    // Skip network tests unless explicitly enabled
    if (suite.needsNetwork && !enableNetworkTests) {
      console.log(`\n⊘ ${suite.name} (needs network, set ENABLE_NETWORK_TESTS=1)`);
      skippedNetworkSuites.push(suite.name);
      totalSkipped++;
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

  // Note skipped network suites
  if (skippedNetworkSuites.length > 0) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log('Network suites (skipped, set ENABLE_NETWORK_TESTS=1 to run):');
    for (const name of skippedNetworkSuites) {
      console.log(`  ⊘ ${name}`);
    }
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
