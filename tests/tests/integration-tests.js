#!/usr/bin/env node

/**
 * Windwalker Integration Test Suite
 * Full dev workflow testing for foam and shiro browser terminals
 *
 * Tests: git clone, file operations, pipes, npm install, node execution
 */

import http from 'http';
import { URL } from 'url';

// Configuration
const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const FOAM_PAGE = 'foam-windwalker';
const SHIRO_PAGE = 'shiro-windwalker';

// Colors
const c = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

// Test counters
let passed = 0;
let failed = 0;
const results = [];

/**
 * Execute JS code via eval API
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
async function execCommand(pageId, command, timeoutMs = 30000) {
  const shell = pageId.includes('shiro') ? '__shiro' : '__foam';
  const resultVar = `testResult_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  // Escape command for JavaScript
  const escapedCmd = command
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  // Initiate command execution
  const initCode = `
(function() {
  window.${shell}.shell.execute(\`${escapedCmd}\`)
    .then(function(result) {
      window.${resultVar} = { success: true, output: result, done: true };
    })
    .catch(function(error) {
      window.${resultVar} = { success: false, error: String(error.message || error), done: true };
    });
  return 'initiated';
})()
`;

  try {
    await evalCode(pageId, initCode);
  } catch (error) {
    return { success: false, error: `Failed to initiate: ${error.message}` };
  }

  // Poll for result
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    try {
      const checkCode = `return window.${resultVar} ? JSON.stringify(window.${resultVar}) : null`;
      const resultStr = await evalCode(pageId, checkCode);

      if (resultStr && resultStr !== 'null') {
        // Clean up
        await evalCode(pageId, `delete window.${resultVar}; return "cleaned"`).catch(() => {});

        try {
          return JSON.parse(resultStr);
        } catch (e) {
          return { success: false, error: `Invalid JSON: ${resultStr}` };
        }
      }
    } catch (error) {
      // Continue polling
    }
  }

  return { success: false, error: 'Timeout waiting for result' };
}

/**
 * Run a single test
 */
async function runTest(pageId, name, command, expectedPattern, timeout = 30000) {
  const pageName = pageId.includes('foam') ? 'FOAM' : 'SHIRO';
  const fullName = `${pageName}: ${name}`;

  process.stdout.write(`  ${c.cyan}→${c.reset} ${name.padEnd(50)} `);

  try {
    const result = await execCommand(pageId, command, timeout);

    if (!result.success) {
      console.log(`${c.red}✗ FAIL${c.reset} (${result.error})`);
      failed++;
      results.push({ name: fullName, status: 'FAIL', error: result.error });
      return false;
    }

    const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    const pattern = expectedPattern instanceof RegExp ? expectedPattern : new RegExp(expectedPattern, 'i');

    if (pattern.test(output)) {
      console.log(`${c.green}✓ PASS${c.reset}`);
      passed++;
      results.push({ name: fullName, status: 'PASS' });
      return true;
    } else {
      console.log(`${c.red}✗ FAIL${c.reset} (pattern not matched)`);
      console.log(`    Expected: ${expectedPattern}`);
      console.log(`    Got: ${output.substring(0, 100)}...`);
      failed++;
      results.push({ name: fullName, status: 'FAIL', expected: expectedPattern, got: output.substring(0, 100) });
      return false;
    }
  } catch (error) {
    console.log(`${c.red}✗ FAIL${c.reset} (${error.message})`);
    failed++;
    results.push({ name: fullName, status: 'FAIL', error: error.message });
    return false;
  }
}

/**
 * Print section header
 */
function printHeader(title) {
  console.log();
  console.log(`${c.blue}${'='.repeat(70)}${c.reset}`);
  console.log(`${c.blue}${title}${c.reset}`);
  console.log(`${c.blue}${'='.repeat(70)}${c.reset}`);
}

/**
 * Run integration tests for a page
 */
async function runIntegrationTests(pageId) {
  const pageName = pageId.includes('foam') ? 'FOAM' : 'SHIRO';
  const testId = pageName.toLowerCase();

  printHeader(`Integration Tests - ${pageName} (${pageId})`);

  // Basic Commands
  console.log(`\n${c.yellow}Basic Commands:${c.reset}`);
  await runTest(pageId, 'Echo command', 'echo "Hello World"', 'Hello World', 5000);
  await runTest(pageId, 'PWD command', 'pwd', '/', 5000);
  await runTest(pageId, 'Node version', 'node --version', /v\d+/, 5000);

  // File Operations
  console.log(`\n${c.yellow}File Operations:${c.reset}`);
  await runTest(pageId, 'Create file', `echo "test content" > /tmp/test_${testId}.txt && echo "created"`, 'created', 10000);
  await runTest(pageId, 'Read file', `cat /tmp/test_${testId}.txt`, 'test content', 5000);
  await runTest(pageId, 'Append to file', `echo "line 2" >> /tmp/test_${testId}.txt && echo "appended"`, 'appended', 5000);
  await runTest(pageId, 'Verify multiline', `cat /tmp/test_${testId}.txt`, 'line 2', 5000);
  await runTest(pageId, 'File redirection', `echo "redirect test" > /tmp/redir_${testId}.txt && cat /tmp/redir_${testId}.txt`, 'redirect test', 10000);

  // Pipe Operations
  console.log(`\n${c.yellow}Pipe Operations:${c.reset}`);
  await runTest(pageId, 'Simple pipe', 'echo hello | grep hello', 'hello', 5000);
  await runTest(pageId, 'Pipe with grep', 'echo -e "line1\\nline2\\nline3" | grep line2', 'line2', 5000);
  await runTest(pageId, 'Pipe with wc', 'echo -e "a\\nb\\nc" | wc -l', '3', 5000);
  await runTest(pageId, 'Multi-stage pipe', 'echo -e "apple\\nbanana\\napricot" | grep "^a" | wc -l', '2', 10000);
  await runTest(pageId, 'Complex pipe', 'echo "HELLO WORLD" | tr A-Z a-z', 'hello world', 5000);

  // Git Workflows
  console.log(`\n${c.yellow}Git Workflows:${c.reset}`);
  await runTest(pageId, 'Git version', 'git --version', /git version/, 5000);
  await runTest(pageId, 'Git init', `cd /tmp && rm -rf git_${testId} && mkdir git_${testId} && cd git_${testId} && git init 2>&1`, /Initialized/, 15000);
  await runTest(pageId, 'Git config', `cd /tmp/git_${testId} && git config user.name "Test" && git config user.email "test@example.com" && git config user.name`, 'Test', 10000);
  await runTest(pageId, 'Create file in repo', `cd /tmp/git_${testId} && echo "# Test Repo" > README.md && echo "created"`, 'created', 5000);
  await runTest(pageId, 'Git add', `cd /tmp/git_${testId} && git add . && echo "added"`, 'added', 10000);
  await runTest(pageId, 'Git commit', `cd /tmp/git_${testId} && git commit -m "Initial commit" 2>&1`, /Initial commit/, 15000);
  await runTest(pageId, 'Git log', `cd /tmp/git_${testId} && git log --oneline -n 1`, /Initial commit/, 5000);
  await runTest(pageId, 'Git status', `cd /tmp/git_${testId} && git status`, /working tree clean/, 5000);

  // Git Clone
  console.log(`\n${c.yellow}Git Clone:${c.reset}`);
  await runTest(
    pageId,
    'Clone small repo (octocat/Hello-World)',
    `cd /tmp && rm -rf hello_${testId} && git clone --depth 1 https://github.com/octocat/Hello-World.git hello_${testId} 2>&1`,
    /Cloning into/,
    60000
  );
  await runTest(pageId, 'Verify cloned repo', `ls /tmp/hello_${testId}/README`, 'README', 5000);

  // npm Workflows
  console.log(`\n${c.yellow}npm Workflows:${c.reset}`);
  await runTest(pageId, 'npm version', 'npm --version', /\d+\.\d+/, 5000);
  await runTest(pageId, 'npm init', `cd /tmp && rm -rf npm_${testId} && mkdir npm_${testId} && cd npm_${testId} && npm init -y 2>&1`, /package\.json/, 15000);
  await runTest(
    pageId,
    'npm install (is-odd package)',
    `cd /tmp/npm_${testId} && npm install is-odd --silent 2>&1 && echo "installed"`,
    'installed',
    60000
  );
  await runTest(pageId, 'Verify node_modules', `ls /tmp/npm_${testId}/node_modules`, 'is-odd', 5000);

  // Node.js Execution
  console.log(`\n${c.yellow}Node.js Execution:${c.reset}`);
  await runTest(pageId, 'Node eval (math)', 'node -e "console.log(2 + 2)"', '4', 5000);
  await runTest(pageId, 'Node eval (JSON)', 'node -e "console.log(JSON.stringify({test: true}))"', /\{"test":true\}/, 5000);
  await runTest(pageId, 'Node script file', `echo "console.log('Hello Node')" > /tmp/test_${testId}.js && node /tmp/test_${testId}.js`, 'Hello Node', 10000);
  await runTest(
    pageId,
    'Node require (use installed package)',
    `cd /tmp/npm_${testId} && node -e "const isOdd = require('is-odd'); console.log(isOdd(5))"`,
    'true',
    10000
  );

  // Cleanup
  console.log(`\n${c.yellow}Cleanup:${c.reset}`);
  await runTest(
    pageId,
    'Remove test files',
    `rm -rf /tmp/test_${testId}.txt /tmp/redir_${testId}.txt /tmp/test_${testId}.js /tmp/git_${testId} /tmp/npm_${testId} /tmp/hello_${testId} && echo "cleaned"`,
    'cleaned',
    15000
  );
}

/**
 * Main
 */
async function main() {
  const target = process.argv[2] || 'all';

  console.log(`${c.cyan}
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║      WINDWALKER INTEGRATION TEST SUITE                        ║
║      Full Dev Workflow Testing via Skyeyes API                ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
${c.reset}`);

  // Check API
  console.log(`${c.yellow}Checking Skyeyes API...${c.reset}`);
  try {
    const statusData = await new Promise((resolve, reject) => {
      const url = `${SKYEYES_API}/status`;
      const urlObj = new URL(url);
      http.request({
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'GET',
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

    console.log(`${c.green}✓ Skyeyes API available${c.reset}`);
    console.log(`  - ${FOAM_PAGE}: ${c.green}Active${c.reset}`);
    console.log(`  - ${SHIRO_PAGE}: ${c.green}Active${c.reset}`);
  } catch (error) {
    console.error(`${c.red}✗ Skyeyes API not available: ${error.message}${c.reset}`);
    process.exit(1);
  }

  // Run tests
  try {
    switch (target) {
      case 'foam':
        await runIntegrationTests(FOAM_PAGE);
        break;
      case 'shiro':
        await runIntegrationTests(SHIRO_PAGE);
        break;
      case 'all':
        await runIntegrationTests(FOAM_PAGE);
        await runIntegrationTests(SHIRO_PAGE);
        break;
      default:
        console.error(`${c.red}Invalid target: ${target}${c.reset}`);
        console.log('Usage: node integration-tests.js [foam|shiro|all]');
        process.exit(1);
    }
  } catch (error) {
    console.error(`${c.red}Fatal error: ${error.message}${c.reset}`);
    console.error(error.stack);
    process.exit(1);
  }

  // Summary
  printHeader('Test Summary');

  const total = passed + failed;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : 0;

  console.log();
  console.log(`  ${c.green}✓ PASSED:${c.reset}  ${passed}/${total} (${passRate}%)`);
  console.log(`  ${c.red}✗ FAILED:${c.reset}  ${failed}/${total}`);
  console.log();

  if (failed > 0) {
    console.log(`${c.yellow}Failed Tests:${c.reset}`);
    results
      .filter(r => r.status === 'FAIL')
      .forEach(r => {
        console.log(`  ${c.red}✗${c.reset} ${r.name}`);
        if (r.error) console.log(`    Error: ${r.error}`);
      });
    console.log();
  }

  console.log(`${c.blue}${'='.repeat(70)}${c.reset}\n`);

  if (failed === 0) {
    console.log(`${c.green}✓✓✓ ALL INTEGRATION TESTS PASSED! ✓✓✓${c.reset}\n`);
    process.exit(0);
  } else {
    console.log(`${c.yellow}⚠ Some tests failed (${passRate}% pass rate)${c.reset}\n`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`${c.red}Fatal error: ${error.message}${c.reset}`);
  console.error(error.stack);
  process.exit(1);
});
