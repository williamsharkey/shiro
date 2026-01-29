#!/usr/bin/env node
// runner.js -- Puppeteer-based test runner for windwalker
// Runs test suites against Foam and/or Shiro served locally

import puppeteer from 'puppeteer';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

// Determine which OS targets to test
const targetEnv = process.env.OS_TARGET;
const targets = targetEnv
  ? [targetEnv]
  : ['foam', 'shiro'];

// MIME types for static file serving
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.ts':   'text/plain',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function serveStatic(root, port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let filePath = join(root, req.url === '/' ? 'index.html' : req.url);
      // Strip query strings
      filePath = filePath.split('?')[0];
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(readFileSync(filePath));
    });
    server.listen(port, () => resolve(server));
  });
}

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

// Port assignments
const PORTS = { foam: 8701, shiro: 8702 };

// OS repo paths (set via env or default to sibling dirs)
function getOSPath(os) {
  const envKey = `${os.toUpperCase()}_PATH`;
  if (process.env[envKey]) return process.env[envKey];
  // For Shiro, we need to serve from dist/ after build
  if (os === 'shiro') {
    const distPath = join(ROOT, '..', 'shiro', 'dist');
    if (existsSync(distPath)) return distPath;
    return join(ROOT, '..', 'shiro');
  }
  return join(ROOT, '..', os);
}

async function runTarget(osTarget) {
  const osPath = getOSPath(osTarget);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${osTarget.toUpperCase()}`);
  console.log(`Source:  ${osPath}`);
  console.log(`${'='.repeat(60)}`);

  if (!existsSync(osPath)) {
    console.log(`⚠ ${osTarget} not found at ${osPath}, skipping`);
    return { target: osTarget, ok: false, reason: 'not found' };
  }

  const port = PORTS[osTarget];
  const server = await serveStatic(osPath, port);
  const url = `http://localhost:${port}`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

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

    const page = await browser.newPage();

    // Give OS time to boot
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    // Additional wait for async init (IndexedDB, etc.)
    await page.waitForFunction(() => {
      return !!(window.__foam || window.__shiro);
    }, { timeout: 15000 }).catch(() => {
      // OS globals might not be exposed -- tests will handle this
    });

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

    await page.close();
  }

  await browser.close();
  server.close();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${osTarget.toUpperCase()} TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);
  if (allFailures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of allFailures) {
      console.log(`  [${f.suite}] ${f.name}: ${f.error}`);
    }
  }

  return { target: osTarget, ok: totalFailed === 0, totalPassed, totalFailed, totalSkipped, allFailures, suiteResults };
}

async function main() {
  console.log('Windwalker Test Suite');
  console.log(`Targets: ${targets.join(', ')}`);

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
    join(resultsDir, 'results.json'),
    JSON.stringify(jsonReport, null, 2)
  );
  console.log(`\nResults written to test-results/results.json`);

  const anyFailed = results.some(r => !r.ok);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(err => {
  console.error('Runner error:', err);
  process.exit(1);
});
