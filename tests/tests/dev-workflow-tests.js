#!/usr/bin/env node

/**
 * Windwalker Dev Workflow Test Suite
 * Automated tests for foam-windwalker and shiro-windwalker terminals
 *
 * NOTE: This test suite documents the intended test coverage.
 * Due to limitations in the Skyeyes /eval API (no async/await support),
 * actual shell command execution cannot be tested via this method.
 *
 * Tests: git, npm, node, pipes, file operations
 */

import http from 'http';
import { URL } from 'url';

// Configuration
const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const FOAM_PAGE = 'foam-windwalker';
const SHIRO_PAGE = 'shiro-windwalker';
const TIMEOUT = 5000;

// ANSI Colors
const c = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

/**
 * Execute JavaScript code in a page via skyeyes eval API
 */
async function evalCode(pageId, code) {
  const encodedCode = encodeURIComponent(code);
  const url = `${SKYEYES_API}/${pageId}/eval?code=${encodedCode}`;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      timeout: TIMEOUT,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
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
 * Check if skyeyes is available
 */
async function checkSkyeyesStatus() {
  try {
    const statusData = await new Promise((resolve, reject) => {
      const url = `${SKYEYES_API}/status`;
      const urlObj = new URL(url);

      http.request({
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'GET',
        timeout: TIMEOUT,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject).end();
    });

    return {
      available: true,
      foamActive: statusData[FOAM_PAGE] === true,
      shiroActive: statusData[SHIRO_PAGE] === true,
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

/**
 * Test page connectivity
 */
async function testPageConnectivity(pageId) {
  try {
    const result = await evalCode(pageId, 'return "connected"');
    return result === 'connected';
  } catch (error) {
    return false;
  }
}

/**
 * Test shell object existence
 */
async function testShellObject(pageId, shellName) {
  try {
    const result = await evalCode(pageId, `return typeof window.${shellName}`);
    return result === 'object';
  } catch (error) {
    return false;
  }
}

/**
 * Main test runner
 */
async function main() {
  console.log(`${c.cyan}
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║         WINDWALKER DEV WORKFLOW TEST SUITE                ║
║         Automated Testing via Skyeyes API                 ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
${c.reset}`);

  let passed = 0;
  let failed = 0;

  // Check skyeyes status
  console.log(`${c.yellow}Step 1: Checking Skyeyes API availability...${c.reset}`);
  const status = await checkSkyeyesStatus();

  if (!status.available) {
    console.error(`${c.red}✗ Skyeyes API not available: ${status.error}${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.green}✓ Skyeyes API is running${c.reset}`);
  console.log(`  URL: ${SKYEYES_API}`);

  // Check page status
  console.log(`\n${c.yellow}Step 2: Checking page status...${c.reset}`);
  console.log(`  foam-windwalker: ${status.foamActive ? c.green + '✓ Active' : c.red + '✗ Inactive'}${c.reset}`);
  console.log(`  shiro-windwalker: ${status.shiroActive ? c.green + '✓ Active' : c.red + '✗ Inactive'}${c.reset}`);

  if (!status.foamActive) {
    console.error(`${c.red}✗ foam-windwalker not active${c.reset}`);
    failed++;
  } else {
    passed++;
  }

  if (!status.shiroActive) {
    console.error(`${c.red}✗ shiro-windwalker not active${c.reset}`);
    failed++;
  } else {
    passed++;
  }

  // Test connectivity
  console.log(`\n${c.yellow}Step 3: Testing page connectivity...${c.reset}`);

  const foamConnected = await testPageConnectivity(FOAM_PAGE);
  console.log(`  foam-windwalker eval: ${foamConnected ? c.green + '✓ Connected' : c.red + '✗ Failed'}${c.reset}`);
  foamConnected ? passed++ : failed++;

  const shiroConnected = await testPageConnectivity(SHIRO_PAGE);
  console.log(`  shiro-windwalker eval: ${shiroConnected ? c.green + '✓ Connected' : c.red + '✗ Failed'}${c.reset}`);
  shiroConnected ? passed++ : failed++;

  // Test shell objects
  console.log(`\n${c.yellow}Step 4: Testing shell object availability...${c.reset}`);

  const foamShell = await testShellObject(FOAM_PAGE, '__foam');
  console.log(`  window.__foam: ${foamShell ? c.green + '✓ Available' : c.red + '✗ Missing'}${c.reset}`);
  foamShell ? passed++ : failed++;

  const shiroShell = await testShellObject(SHIRO_PAGE, '__shiro');
  console.log(`  window.__shiro: ${shiroShell ? c.green + '✓ Available' : c.red + '✗ Missing'}${c.reset}`);
  shiroShell ? passed++ : failed++;

  // Document intended test coverage
  console.log(`\n${c.blue}${'='.repeat(60)}${c.reset}`);
  console.log(`${c.blue}Intended Test Coverage (Not Executable via /eval API)${c.reset}`);
  console.log(`${c.blue}${'='.repeat(60)}${c.reset}`);

  const testCategories = [
    {
      name: 'Git Workflows',
      tests: [
        'git init - Initialize new repository',
        'git config - Set user name and email',
        'git add - Stage files',
        'git commit - Create commits',
        'git status - Check repository status',
        'git log - View commit history',
        'git clone - Clone remote repositories',
      ]
    },
    {
      name: 'npm Workflows',
      tests: [
        'npm init - Initialize package.json',
        'npm install - Install packages',
        'npm run - Execute package scripts',
        'Verify node_modules creation',
      ]
    },
    {
      name: 'Node.js Execution',
      tests: [
        'node --version - Check Node version',
        'node -e "code" - Execute inline JavaScript',
        'node script.js - Execute script files',
        'require() - Load npm packages',
      ]
    },
    {
      name: 'File Operations',
      tests: [
        'echo > file - Create files',
        'cat file - Read file contents',
        'echo >> file - Append to files',
        'rm file - Delete files',
        'ls - List files',
        'mkdir - Create directories',
      ]
    },
    {
      name: 'Pipe Operations',
      tests: [
        'cmd | grep - Filter output',
        'cmd | wc -l - Count lines',
        'cmd | sort - Sort output',
        'Multi-stage pipes (3+ commands)',
        'Complex pipe chains with tr, sed, awk',
      ]
    },
  ];

  testCategories.forEach(category => {
    console.log(`\n${c.cyan}${category.name}:${c.reset}`);
    category.tests.forEach(test => {
      console.log(`  ${c.gray}○${c.reset} ${test}`);
    });
  });

  // Summary
  console.log(`\n${c.blue}${'='.repeat(60)}${c.reset}`);
  console.log(`${c.blue}Test Summary${c.reset}`);
  console.log(`${c.blue}${'='.repeat(60)}${c.reset}\n`);

  const total = passed + failed;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : 0;

  console.log(`  ${c.green}✓ PASSED:${c.reset}  ${passed}/${total} (${passRate}%)`);
  console.log(`  ${c.red}✗ FAILED:${c.reset}  ${failed}/${total}`);
  console.log();

  console.log(`${c.yellow}Infrastructure Tests: ${passed === total ? 'ALL PASSED ✓' : 'Some Failed'}${c.reset}`);
  console.log();

  // Explanation
  console.log(`${c.blue}${'='.repeat(60)}${c.reset}`);
  console.log(`${c.blue}Important Note${c.reset}`);
  console.log(`${c.blue}${'='.repeat(60)}${c.reset}\n`);

  console.log(`${c.yellow}Why workflow tests cannot run via this script:${c.reset}\n`);
  console.log(`The Skyeyes /eval API endpoint executes JavaScript ${c.cyan}synchronously${c.reset},`);
  console.log(`but shell commands require ${c.cyan}async/await${c.reset} support.\n`);
  console.log(`${c.gray}Example:${c.reset}`);
  console.log(`${c.red}  // This fails with "await not valid in async functions"${c.reset}`);
  console.log(`${c.gray}  return await window.__foam.shell.execute("pwd")${c.reset}\n`);
  console.log(`${c.yellow}To test workflows, you need:${c.reset}`);
  console.log(`  1. ${c.cyan}Interactive terminal testing${c.reset} (manual)`);
  console.log(`  2. ${c.cyan}Async-capable API endpoint${c.reset} (e.g., /exec-async)`);
  console.log(`  3. ${c.cyan}MCP tools${c.reset} (mcp__skyeyes__terminal_exec, etc.)`);
  console.log(`  4. ${c.cyan}WebSocket/streaming API${c.reset} for terminal I/O\n`);

  console.log(`${c.green}✓ Infrastructure verified and ready${c.reset}`);
  console.log(`${c.yellow}○ Workflow tests require alternative testing method${c.reset}\n`);

  console.log(`${c.blue}${'='.repeat(60)}${c.reset}\n`);

  if (failed === 0) {
    console.log(`${c.green}Infrastructure tests PASSED${c.reset}\n`);
    process.exit(0);
  } else {
    console.log(`${c.red}Some infrastructure tests FAILED${c.reset}\n`);
    process.exit(1);
  }
}

// Run tests
main().catch(error => {
  console.error(`${c.red}Fatal error: ${error.message}${c.reset}`);
  console.error(error.stack);
  process.exit(1);
});
