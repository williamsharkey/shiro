#!/usr/bin/env node

/**
 * Windwalker Regression Test Suite
 *
 * Fast, focused regression tests for critical Spirit prerequisites.
 * Run this on every deployment to ensure core functionality works.
 *
 * Tests:
 * 1. File CRUD (Create, Read, Update, Delete)
 * 2. Command execution with proper exit codes
 * 3. Pipe chains
 * 4. Git init/add/commit
 * 5. Environment variable expansion
 *
 * Exit codes:
 * 0 = All tests passed
 * 1 = One or more tests failed
 */

import http from 'http';
import { URL } from 'url';

// Configuration
const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const FOAM_PAGE = 'foam-windwalker';
const SHIRO_PAGE = 'shiro-windwalker';
const TIMEOUT = 15000;

// Test results
let totalPassed = 0;
let totalFailed = 0;
const failedTests = [];

// Colors
const c = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

/**
 * Execute JS code via Skyeyes eval API
 */
async function evalCode(pageId, code, timeout = 5000) {
  const encodedCode = encodeURIComponent(code);
  const url = `${SKYEYES_API}/${pageId}/eval?code=${encodedCode}`;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

/**
 * Execute shell command with promise polling
 */
async function execCommand(pageId, command, timeoutMs = 15000) {
  const shell = pageId.includes('shiro') ? '__shiro' : '__foam';
  const resultVar = `regTest_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const escapedCmd = command
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  const initCode = `
(function() {
  window.${shell}.shell.execute(\`${escapedCmd}\`)
    .then(function(result) {
      window.${resultVar} = { success: true, output: result };
    })
    .catch(function(error) {
      window.${resultVar} = { success: false, error: String(error.message || error) };
    });
  return 'initiated';
})()
`;

  try {
    await evalCode(pageId, initCode);
  } catch (error) {
    return { success: false, error: `Init failed: ${error.message}` };
  }

  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    try {
      const checkCode = `return window.${resultVar} ? JSON.stringify(window.${resultVar}) : null`;
      const resultStr = await evalCode(pageId, checkCode);

      if (resultStr && resultStr !== 'null') {
        await evalCode(pageId, `delete window.${resultVar}; return "ok"`).catch(() => {});
        try {
          return JSON.parse(resultStr);
        } catch (e) {
          return { success: false, error: `Invalid JSON` };
        }
      }
    } catch (error) {
      // Continue polling
    }
  }

  await evalCode(pageId, `delete window.${resultVar}; return "ok"`).catch(() => {});
  return { success: false, error: 'Timeout' };
}

/**
 * Run a regression test
 */
async function test(pageId, testName, command, expectedPattern) {
  const terminal = pageId.includes('foam') ? 'FOAM' : 'SHIRO';
  const result = await execCommand(pageId, command, TIMEOUT);

  const pattern = expectedPattern instanceof RegExp ? expectedPattern : new RegExp(expectedPattern, 'i');
  const passed = result.success && pattern.test(String(result.output || ''));

  if (passed) {
    console.log(`  ${c.green}✓${c.reset} ${testName}`);
    totalPassed++;
  } else {
    console.log(`  ${c.red}✗${c.reset} ${testName}`);
    const error = result.success ? `Output mismatch: ${result.output.substring(0, 50)}...` : result.error;
    failedTests.push({ terminal, test: testName, error });
    totalFailed++;
  }

  return passed;
}

/**
 * Main test runner
 */
async function main() {
  console.log(`${c.cyan}${c.bold}\n╔═══════════════════════════════════════════════════════════╗`);
  console.log('║                                                           ║');
  console.log('║           WINDWALKER REGRESSION TEST SUITE                ║');
  console.log('║           Critical Spirit Prerequisites                   ║');
  console.log('║                                                           ║');
  console.log(`╚═══════════════════════════════════════════════════════════╝${c.reset}\n`);

  // Check API
  console.log('Checking Skyeyes API...');
  try {
    const statusData = await new Promise((resolve, reject) => {
      const url = `${SKYEYES_API}/status`;
      const urlObj = new URL(url);
      http.request({
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject).end();
    });

    if (!statusData[FOAM_PAGE] || !statusData[SHIRO_PAGE]) {
      console.error(`${c.red}✗ Required pages not active${c.reset}`);
      process.exit(1);
    }

    console.log(`${c.green}✓ API available, pages active${c.reset}\n`);
  } catch (error) {
    console.error(`${c.red}✗ Skyeyes API error: ${error.message}${c.reset}`);
    process.exit(1);
  }

  // Run regression tests
  const startTime = Date.now();

  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    const term = page.includes('foam') ? 'FOAM' : 'SHIRO';
    console.log(`${c.blue}${c.bold}═══ ${term} ═══${c.reset}\n`);

    // 1. FILE CRUD
    console.log(`${c.yellow}File CRUD:${c.reset}`);
    await test(page, 'Create file', 'echo "test data" > /tmp/reg.txt && echo "created"', 'created');
    await test(page, 'Read file', 'cat /tmp/reg.txt', 'test data');
    await test(page, 'Update file', 'echo "updated" >> /tmp/reg.txt && cat /tmp/reg.txt', 'updated');
    await test(page, 'Delete file', 'rm /tmp/reg.txt && echo "deleted"', 'deleted');

    // 2. COMMAND EXECUTION WITH EXIT CODES
    console.log(`\n${c.yellow}Command Execution:${c.reset}`);
    await test(page, 'Success command', 'true && echo "success"', 'success');
    await test(page, 'Command output', 'echo "output test"', 'output test');
    await test(page, 'Chained commands', 'echo "a" && echo "b" && echo "c"', /c/);

    // 3. PIPE CHAINS
    console.log(`\n${c.yellow}Pipe Chains:${c.reset}`);
    await test(page, 'Simple pipe', 'echo "test" | grep test', 'test');
    await test(page, 'Multi-stage pipe', 'echo -e "1\\n2\\n3" | grep -v 2 | wc -l', '2');
    await test(page, 'Pipe with redirect', 'echo "data" | cat > /tmp/p.txt && cat /tmp/p.txt && rm /tmp/p.txt', 'data');

    // 4. GIT INIT/ADD/COMMIT
    console.log(`\n${c.yellow}Git Operations:${c.reset}`);
    await test(page, 'Git init', 'cd /tmp && rm -rf rg && mkdir rg && cd rg && git init', /Initialized/);
    await test(page, 'Git config', 'cd /tmp/rg && git config user.name "Reg" && git config user.name', 'Reg');
    await test(page, 'Git add', 'cd /tmp/rg && echo "test" > f.txt && git add . && echo "added"', 'added');
    await test(page, 'Git commit', 'cd /tmp/rg && git commit -m "Test commit" 2>&1', /Test commit/);

    // 5. ENVIRONMENT VARIABLE EXPANSION
    console.log(`\n${c.yellow}Environment Variables:${c.reset}`);
    await test(page, 'Set variable', 'export TEST_VAR=hello && echo $TEST_VAR', 'hello');
    await test(page, 'Use in command', 'export F=test.txt && echo "content" > /tmp/$F && cat /tmp/$F', 'content');
    await test(page, 'Multiple vars', 'export A=x B=y && echo "$A$B"', 'xy');

    // Cleanup
    await execCommand(page, 'rm -rf /tmp/reg.txt /tmp/rg /tmp/p.txt /tmp/test.txt 2>/dev/null || true', 5000);
    console.log('');
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}`);
  console.log(`${c.blue}${c.bold}REGRESSION TEST SUMMARY${c.reset}`);
  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}\n`);

  const total = totalPassed + totalFailed;
  const passRate = total > 0 ? ((totalPassed / total) * 100).toFixed(1) : 0;

  console.log(`  Tests Run:     ${total}`);
  console.log(`  ${c.green}Passed:        ${totalPassed}${c.reset}`);
  console.log(`  ${totalFailed > 0 ? c.red : c.reset}Failed:        ${totalFailed}${c.reset}`);
  console.log(`  Pass Rate:     ${passRate}%`);
  console.log(`  Duration:      ${duration}s\n`);

  if (failedTests.length > 0) {
    console.log(`${c.red}${c.bold}Failed Tests:${c.reset}\n`);
    for (const failure of failedTests) {
      console.log(`  ${c.red}✗${c.reset} ${failure.terminal}: ${failure.test}`);
      console.log(`    ${c.yellow}Error:${c.reset} ${failure.error}\n`);
    }
  }

  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}\n`);

  if (totalFailed === 0) {
    console.log(`${c.green}${c.bold}✓ ALL REGRESSION TESTS PASSED${c.reset}`);
    console.log(`${c.green}Spirit prerequisites verified - safe to deploy${c.reset}\n`);
    process.exit(0);
  } else {
    console.log(`${c.red}${c.bold}✗ REGRESSION TESTS FAILED${c.reset}`);
    console.log(`${c.red}Do not deploy until failures are fixed${c.reset}\n`);
    process.exit(1);
  }
}

// Run tests
main().catch(error => {
  console.error(`${c.red}${c.bold}Fatal error: ${error.message}${c.reset}`);
  console.error(error.stack);
  process.exit(1);
});
