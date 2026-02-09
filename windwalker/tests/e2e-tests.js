#!/usr/bin/env node

/**
 * Windwalker End-to-End Tests
 *
 * Focused E2E tests for core dev workflows:
 * - npm install works in both terminals
 * - git clone works in both terminals
 * - file editing works (echo > file && cat file)
 * - pipe chains work (ls | grep | wc)
 *
 * Uses curl to skyeyes API for browser terminal interaction
 */

import http from 'http';
import { URL } from 'url';

// Configuration
const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const FOAM_PAGE = 'foam-windwalker';
const SHIRO_PAGE = 'shiro-windwalker';
const TIMEOUT_SHORT = 15000;   // 15s for quick commands
const TIMEOUT_MEDIUM = 30000;  // 30s for git clone
const TIMEOUT_LONG = 60000;    // 60s for npm install

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

let passed = 0;
let failed = 0;
let skipped = 0;

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
 * Execute shell command with async promise polling
 */
async function execCommand(pageId, command, timeoutMs = 30000) {
  const shell = pageId.includes('shiro') ? '__shiro' : '__foam';
  const resultVar = `e2eTest_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  // Escape command
  const escapedCmd = command
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  // Initiate execution
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
        // Cleanup
        await evalCode(pageId, `delete window.${resultVar}; return "ok"`).catch(() => {});

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

  // Cleanup on timeout
  await evalCode(pageId, `delete window.${resultVar}; return "ok"`).catch(() => {});
  return { success: false, error: 'Timeout waiting for command result' };
}

/**
 * Run E2E test
 */
async function runE2ETest(testName, testFn) {
  console.log(`\n${c.cyan}${c.bold}Test: ${testName}${c.reset}`);
  console.log(`${c.blue}${'─'.repeat(70)}${c.reset}`);

  try {
    await testFn();
    console.log(`${c.green}✓ ${testName} PASSED${c.reset}`);
    passed++;
  } catch (error) {
    console.log(`${c.red}✗ ${testName} FAILED: ${error.message}${c.reset}`);
    if (error.details) {
      console.log(`  ${c.yellow}Details: ${error.details}${c.reset}`);
    }
    failed++;
  }
}

/**
 * Verify command output
 */
function verify(result, expectedPattern, testDescription) {
  if (!result.success) {
    throw new Error(`Command failed: ${result.error}`);
  }

  const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  const pattern = expectedPattern instanceof RegExp ? expectedPattern : new RegExp(expectedPattern, 'i');

  if (!pattern.test(output)) {
    const error = new Error(testDescription);
    error.details = `Expected pattern: ${expectedPattern}\nGot: ${output.substring(0, 200)}`;
    throw error;
  }

  console.log(`  ${c.green}✓${c.reset} ${testDescription}`);
  return output;
}

/**
 * E2E Test 1: File Editing Works (echo > file && cat file)
 */
async function testFileEditing() {
  console.log(`${c.yellow}Testing in FOAM...${c.reset}`);

  // Create file
  let result = await execCommand(FOAM_PAGE, 'echo "Hello from FOAM" > /tmp/e2e_foam.txt', TIMEOUT_SHORT);
  verify(result, '', 'Created file in FOAM');

  // Read file
  result = await execCommand(FOAM_PAGE, 'cat /tmp/e2e_foam.txt', TIMEOUT_SHORT);
  verify(result, 'Hello from FOAM', 'Read file content in FOAM');

  // Append to file
  result = await execCommand(FOAM_PAGE, 'echo "Line 2" >> /tmp/e2e_foam.txt', TIMEOUT_SHORT);
  verify(result, '', 'Appended to file in FOAM');

  // Verify multiline
  result = await execCommand(FOAM_PAGE, 'cat /tmp/e2e_foam.txt', TIMEOUT_SHORT);
  verify(result, /Hello from FOAM.*Line 2/s, 'Verified multiline content in FOAM');

  console.log(`${c.yellow}Testing in SHIRO...${c.reset}`);

  // Create file
  result = await execCommand(SHIRO_PAGE, 'echo "Hello from SHIRO" > /tmp/e2e_shiro.txt', TIMEOUT_SHORT);
  verify(result, '', 'Created file in SHIRO');

  // Read file
  result = await execCommand(SHIRO_PAGE, 'cat /tmp/e2e_shiro.txt', TIMEOUT_SHORT);
  verify(result, 'Hello from SHIRO', 'Read file content in SHIRO');

  // Cleanup
  await execCommand(FOAM_PAGE, 'rm /tmp/e2e_foam.txt', TIMEOUT_SHORT);
  await execCommand(SHIRO_PAGE, 'rm /tmp/e2e_shiro.txt', TIMEOUT_SHORT);
}

/**
 * E2E Test 2: Pipe Chains Work (ls | grep | wc)
 */
async function testPipeChains() {
  console.log(`${c.yellow}Testing in FOAM...${c.reset}`);

  // Simple pipe
  let result = await execCommand(FOAM_PAGE, 'echo "hello world" | grep hello', TIMEOUT_SHORT);
  verify(result, 'hello', 'Simple pipe (echo | grep) in FOAM');

  // Multi-stage pipe
  result = await execCommand(FOAM_PAGE, 'echo -e "apple\\nbanana\\napricot\\navocado" | grep "^a" | wc -l', TIMEOUT_SHORT);
  verify(result, '3', 'Multi-stage pipe (echo | grep | wc) in FOAM');

  // Complex pipe with transform
  result = await execCommand(FOAM_PAGE, 'echo "HELLO WORLD" | tr A-Z a-z | sed "s/world/universe/"', TIMEOUT_SHORT);
  verify(result, 'hello universe', 'Complex pipe chain in FOAM');

  console.log(`${c.yellow}Testing in SHIRO...${c.reset}`);

  // Simple pipe
  result = await execCommand(SHIRO_PAGE, 'echo "test data" | grep data', TIMEOUT_SHORT);
  verify(result, 'data', 'Simple pipe (echo | grep) in SHIRO');

  // Multi-stage pipe
  result = await execCommand(SHIRO_PAGE, 'echo -e "1\\n2\\n3\\n4\\n5" | grep -v 3 | wc -l', TIMEOUT_SHORT);
  verify(result, '4', 'Multi-stage pipe (echo | grep | wc) in SHIRO');

  // Pipe with sort
  result = await execCommand(SHIRO_PAGE, 'echo -e "zebra\\napple\\nbanana" | sort | head -n 1', TIMEOUT_SHORT);
  verify(result, 'apple', 'Pipe with sort in SHIRO');
}

/**
 * E2E Test 3: Git Clone Works
 */
async function testGitClone() {
  console.log(`${c.yellow}Testing in FOAM...${c.reset}`);

  // Clone small repo
  let result = await execCommand(
    FOAM_PAGE,
    'cd /tmp && rm -rf e2e_hello_foam && git clone --depth 1 https://github.com/octocat/Hello-World.git e2e_hello_foam 2>&1',
    TIMEOUT_MEDIUM
  );
  verify(result, /Cloning into/, 'Cloned repository in FOAM');

  // Verify clone
  result = await execCommand(FOAM_PAGE, 'ls /tmp/e2e_hello_foam/README', TIMEOUT_SHORT);
  verify(result, 'README', 'Verified cloned files in FOAM');

  // Check git log
  result = await execCommand(FOAM_PAGE, 'cd /tmp/e2e_hello_foam && git log --oneline -n 1', TIMEOUT_SHORT);
  verify(result, /.+/, 'Verified git log in FOAM');

  console.log(`${c.yellow}Testing in SHIRO...${c.reset}`);

  // Clone small repo
  result = await execCommand(
    SHIRO_PAGE,
    'cd /tmp && rm -rf e2e_hello_shiro && git clone --depth 1 https://github.com/octocat/Hello-World.git e2e_hello_shiro 2>&1',
    TIMEOUT_MEDIUM
  );
  verify(result, /Cloning into/, 'Cloned repository in SHIRO');

  // Verify clone
  result = await execCommand(SHIRO_PAGE, 'ls /tmp/e2e_hello_shiro/README', TIMEOUT_SHORT);
  verify(result, 'README', 'Verified cloned files in SHIRO');

  // Cleanup
  await execCommand(FOAM_PAGE, 'rm -rf /tmp/e2e_hello_foam', TIMEOUT_SHORT);
  await execCommand(SHIRO_PAGE, 'rm -rf /tmp/e2e_hello_shiro', TIMEOUT_SHORT);
}

/**
 * E2E Test 4: npm install Works
 */
async function testNpmInstall() {
  console.log(`${c.yellow}Testing in FOAM...${c.reset}`);

  // Create package.json
  let result = await execCommand(FOAM_PAGE, 'cd /tmp && rm -rf e2e_npm_foam && mkdir e2e_npm_foam && cd e2e_npm_foam && npm init -y 2>&1', TIMEOUT_SHORT);
  verify(result, /package\.json/, 'Created package.json in FOAM');

  // Install package
  result = await execCommand(
    FOAM_PAGE,
    'cd /tmp/e2e_npm_foam && npm install is-odd --silent 2>&1 && echo "installed"',
    TIMEOUT_LONG
  );
  verify(result, 'installed', 'Installed npm package in FOAM');

  // Verify node_modules
  result = await execCommand(FOAM_PAGE, 'ls /tmp/e2e_npm_foam/node_modules', TIMEOUT_SHORT);
  verify(result, 'is-odd', 'Verified node_modules in FOAM');

  // Test require
  result = await execCommand(FOAM_PAGE, 'cd /tmp/e2e_npm_foam && node -e "const isOdd = require(\\"is-odd\\"); console.log(isOdd(5))"', TIMEOUT_SHORT);
  verify(result, 'true', 'Tested require() with installed package in FOAM');

  console.log(`${c.yellow}Testing in SHIRO...${c.reset}`);

  // Create package.json
  result = await execCommand(SHIRO_PAGE, 'cd /tmp && rm -rf e2e_npm_shiro && mkdir e2e_npm_shiro && cd e2e_npm_shiro && npm init -y 2>&1', TIMEOUT_SHORT);
  verify(result, /package\.json/, 'Created package.json in SHIRO');

  // Install package
  result = await execCommand(
    SHIRO_PAGE,
    'cd /tmp/e2e_npm_shiro && npm install is-odd --silent 2>&1 && echo "installed"',
    TIMEOUT_LONG
  );
  verify(result, 'installed', 'Installed npm package in SHIRO');

  // Verify node_modules
  result = await execCommand(SHIRO_PAGE, 'ls /tmp/e2e_npm_shiro/node_modules', TIMEOUT_SHORT);
  verify(result, 'is-odd', 'Verified node_modules in SHIRO');

  // Test require
  result = await execCommand(SHIRO_PAGE, 'cd /tmp/e2e_npm_shiro && node -e "const isOdd = require(\\"is-odd\\"); console.log(isOdd(5))"', TIMEOUT_SHORT);
  verify(result, 'true', 'Tested require() with installed package in SHIRO');

  // Cleanup
  await execCommand(FOAM_PAGE, 'rm -rf /tmp/e2e_npm_foam', TIMEOUT_SHORT);
  await execCommand(SHIRO_PAGE, 'rm -rf /tmp/e2e_npm_shiro', TIMEOUT_SHORT);
}

/**
 * Main
 */
async function main() {
  console.log(`${c.cyan}${c.bold}
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║           WINDWALKER END-TO-END TEST SUITE                    ║
║           Core Dev Workflow Verification                      ║
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
    console.log(`  - ${FOAM_PAGE}: ${c.green}✓ Active${c.reset}`);
    console.log(`  - ${SHIRO_PAGE}: ${c.green}✓ Active${c.reset}\n`);
  } catch (error) {
    console.error(`${c.red}✗ Skyeyes API not available: ${error.message}${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.cyan}${c.bold}Running E2E Tests...${c.reset}\n`);

  // Run tests
  await runE2ETest('File Editing (echo > file && cat file)', testFileEditing);
  await runE2ETest('Pipe Chains (ls | grep | wc)', testPipeChains);
  await runE2ETest('Git Clone', testGitClone);
  await runE2ETest('npm install', testNpmInstall);

  // Summary
  console.log(`\n${c.blue}${'═'.repeat(70)}${c.reset}`);
  console.log(`${c.cyan}${c.bold}E2E Test Summary${c.reset}`);
  console.log(`${c.blue}${'═'.repeat(70)}${c.reset}\n`);

  const total = passed + failed + skipped;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : 0;

  console.log(`  ${c.green}✓ PASSED:  ${passed}/${total}${c.reset} (${passRate}%)`);
  console.log(`  ${c.red}✗ FAILED:  ${failed}/${total}${c.reset}`);
  if (skipped > 0) {
    console.log(`  ${c.yellow}⊘ SKIPPED: ${skipped}/${total}${c.reset}`);
  }
  console.log();

  console.log(`${c.blue}${'═'.repeat(70)}${c.reset}\n`);

  if (failed === 0) {
    console.log(`${c.green}${c.bold}✓✓✓ ALL E2E TESTS PASSED! ✓✓✓${c.reset}\n`);
    process.exit(0);
  } else {
    console.log(`${c.red}${c.bold}✗ ${failed} E2E test(s) failed${c.reset}\n`);
    process.exit(1);
  }
}

// Run
main().catch(error => {
  console.error(`${c.red}${c.bold}Fatal error: ${error.message}${c.reset}`);
  console.error(error.stack);
  process.exit(1);
});
