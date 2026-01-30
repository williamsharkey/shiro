#!/usr/bin/env node
// runner-skyeyes.js -- Skyeyes-based test runner for windwalker
// Runs test suites against Foam and/or Shiro using skyeyes instead of Puppeteer

import { launch } from './skyeyes-adapter.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

// Determine which OS targets to test
const targetEnv = process.env.OS_TARGET;
const targets = targetEnv ? [targetEnv] : ['foam', 'shiro'];

// Test suite modules (ordered by level)
const SUITES = [
  { name: 'level-0-boot',       path: './level-0-boot/boot.test.js' },
  { name: 'level-1-filesystem', path: './level-1-filesystem/filesystem.test.js' },
  { name: 'level-2-shell',      path: './level-2-shell/shell.test.js' },
  { name: 'level-3-coreutils',  path: './level-3-coreutils/coreutils.test.js' },
  { name: 'level-4-pipes',      path: './level-4-pipes/pipes.test.js' },
  { name: 'level-5-git',        path: './level-5-git/git.test.js' },
  { name: 'level-6-spirit',     path: './level-6-spirit/spirit.test.js' },
  { name: 'level-7-workflows',  path: './level-7-workflows/workflows.test.js' },
  { name: 'level-8-fluffycoreutils', path: './level-8-fluffycoreutils/fluffycoreutils.test.js' },
  { name: 'level-9-selfbuild', path: './level-9-selfbuild/selfbuild.test.js' },
];

// Skyeyes page names for each OS (must match what's configured in skyeyes)
// Windwalker uses dedicated page IDs to avoid conflicts with other workers
const SKYEYES_PAGES = {
  foam: 'foam-windwalker',
  shiro: 'shiro-windwalker',
};

// URLs for each OS (assumes dev servers are running)
const URLS = {
  foam: 'http://localhost:5174',      // foam dev server
  shiro: 'http://localhost:5173/shiro/', // shiro dev server
};

async function runTarget(osTarget) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${osTarget.toUpperCase()} (via skyeyes)`);
  console.log(`Page: ${SKYEYES_PAGES[osTarget]}`);
  console.log(`${'='.repeat(60)}`);

  const pageName = SKYEYES_PAGES[osTarget];
  if (!pageName) {
    console.log(`⚠ No skyeyes page configured for ${osTarget}`);
    return { target: osTarget, ok: false, reason: 'no skyeyes page' };
  }

  const url = URLS[osTarget];
  const browser = await launch({ headless: true });

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const allFailures = [];
  const suiteResults = [];

  for (const suite of SUITES) {
    const suitePath = join(__dirname, suite.path);
    if (!existsSync(suitePath)) {
      console.log(`\n⊘ ${suite.name} (no test file yet)`);
      continue;
    }

    // Get or create the skyeyes page
    const page = await browser.getPage(pageName);

    // Navigate to the OS URL (first time only, or if needed)
    try {
      const currentUrl = await page.evaluate('window.location.href').catch(() => null);
      if (!currentUrl || !currentUrl.startsWith(url)) {
        console.log(`  Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      }
    } catch (e) {
      console.log(`  ⚠ Navigation warning: ${e.message}`);
    }

    // Wait for OS to boot
    try {
      await page.waitForFunction(() => {
        return !!(window.__foam || window.__shiro);
      }, { timeout: 15000 });
    } catch (e) {
      console.log(`  ⚠ Boot timeout: ${e.message}`);
      // Continue anyway, tests will handle this
    }

    try {
      const mod = await import(suitePath);
      const results = await mod.default(page, osTarget);
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
      totalFailed++;
      allFailures.push({
        name: `${suite.name} (suite-level error)`,
        error: err.message,
        suite: suite.name,
      });
    }

    // Don't close the page - keep it open for next suite (faster)
  }

  await browser.close();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${osTarget.toUpperCase()} TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);
  if (allFailures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of allFailures) {
      console.log(`  [${f.suite}] ${f.name}: ${f.error}`);
    }
  }

  return {
    target: osTarget,
    ok: totalFailed === 0,
    totalPassed,
    totalFailed,
    totalSkipped,
    allFailures,
    suiteResults
  };
}

async function main() {
  console.log('Windwalker Test Suite (Skyeyes Mode)');
  console.log(`Targets: ${targets.join(', ')}`);
  console.log('\n⚡ Using skyeyes - no browser launch overhead!');

  const results = [];
  for (const target of targets) {
    results.push(await runTarget(target));
  }

  // Cross-platform comparison
  if (results.length > 1) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('CROSS-PLATFORM SUMMARY');
    console.log(`${'='.repeat(60)}`);
    for (const r of results) {
      const status = r.ok ? '✓' : '✗';
      console.log(`  ${status} ${r.target}: ${r.totalPassed || 0} passed, ${r.totalFailed || 0} failed`);
    }
  }

  // Write JSON results for CI artifacts
  const resultsDir = join(ROOT, 'test-results');
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const jsonReport = {
    timestamp: new Date().toISOString(),
    mode: 'skyeyes',
    targets: results.map(r => ({
      target: r.target,
      ok: r.ok,
      passed: r.totalPassed || 0,
      failed: r.totalFailed || 0,
      skipped: r.totalSkipped || 0,
      suites: r.suiteResults || [],
      failures: r.allFailures || [],
    })),
  };
  writeFileSync(
    join(resultsDir, 'results-skyeyes.json'),
    JSON.stringify(jsonReport, null, 2)
  );
  console.log(`\nResults written to test-results/results-skyeyes.json`);

  const anyFailed = results.some(r => !r.ok);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(err => {
  console.error('Runner error:', err);
  process.exit(1);
});
