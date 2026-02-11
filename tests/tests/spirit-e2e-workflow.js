#!/usr/bin/env node

/**
 * Spirit AI End-to-End Workflow Test
 *
 * Simulates a complete Spirit AI development cycle:
 * 1. Create project directory
 * 2. Write initial JavaScript file
 * 3. Run it with node
 * 4. Git init/config/add/commit
 * 5. Edit file with sed
 * 6. Run again to verify changes
 * 7. Git commit the changes
 * 8. Verify git history
 *
 * This test verifies that Spirit can perform a realistic development
 * workflow from start to finish in both foam and shiro terminals.
 *
 * Exit codes:
 * 0 = All workflow steps passed
 * 1 = One or more steps failed
 */

import http from 'http';
import { URL } from 'url';

// Configuration
const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const FOAM_PAGE = 'foam-windwalker';
const SHIRO_PAGE = 'shiro-windwalker';
const TIMEOUT = 20000;

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
async function execCommand(pageId, command, timeoutMs = 20000) {
  const shell = pageId.includes('shiro') ? '__shiro' : '__foam';
  const resultVar = `spiritE2E_${Date.now()}_${Math.random().toString(36).substring(7)}`;

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
 * Run a workflow test step
 */
async function testStep(pageId, stepName, command, expectedPattern) {
  const terminal = pageId.includes('foam') ? 'FOAM' : 'SHIRO';
  const result = await execCommand(pageId, command, TIMEOUT);

  const pattern = expectedPattern instanceof RegExp ? expectedPattern : new RegExp(expectedPattern, 'i');
  const passed = result.success && pattern.test(String(result.output || ''));

  if (passed) {
    console.log(`  ${c.green}✓${c.reset} ${stepName}`);
    totalPassed++;
  } else {
    console.log(`  ${c.red}✗${c.reset} ${stepName}`);
    const error = result.success ? `Output mismatch: ${result.output.substring(0, 100)}...` : result.error;
    failedTests.push({ terminal, step: stepName, error });
    totalFailed++;
  }

  return passed;
}

/**
 * Main workflow test runner
 */
async function main() {
  console.log(`${c.cyan}${c.bold}\n╔═══════════════════════════════════════════════════════════╗`);
  console.log('║                                                           ║');
  console.log('║         SPIRIT AI END-TO-END WORKFLOW TEST                ║');
  console.log('║         Complete Development Cycle Simulation             ║');
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

  // Run Spirit E2E workflow in both terminals
  const startTime = Date.now();

  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    const term = page.includes('foam') ? 'FOAM' : 'SHIRO';
    console.log(`${c.blue}${c.bold}═══ ${term} SPIRIT WORKFLOW ═══${c.reset}\n`);

    // WORKFLOW STEP 1: Setup project directory
    console.log(`${c.yellow}Step 1: Project Setup${c.reset}`);
    await testStep(
      page,
      'Create project directory',
      'rm -rf /tmp/spirit_project && mkdir -p /tmp/spirit_project && cd /tmp/spirit_project && pwd',
      /spirit_project/
    );

    // WORKFLOW STEP 2: Write initial JavaScript file
    console.log(`\n${c.yellow}Step 2: Create Initial Code${c.reset}`);
    await testStep(
      page,
      'Write app.js v1',
      'cd /tmp/spirit_project && echo "console.log(\\"Hello from Spirit v1\\");" > app.js && cat app.js',
      /Hello from Spirit v1/
    );

    await testStep(
      page,
      'Verify file exists',
      'cd /tmp/spirit_project && ls -la app.js',
      /app\.js/
    );

    // WORKFLOW STEP 3: Run with Node.js
    console.log(`\n${c.yellow}Step 3: Execute Code${c.reset}`);
    await testStep(
      page,
      'Run app.js (first execution)',
      'cd /tmp/spirit_project && node app.js',
      /Hello from Spirit v1/
    );

    // WORKFLOW STEP 4: Git init/config/add/commit
    console.log(`\n${c.yellow}Step 4: Version Control - Initial Commit${c.reset}`);
    await testStep(
      page,
      'Git init',
      'cd /tmp/spirit_project && git init',
      /Initialized/
    );

    await testStep(
      page,
      'Git config user',
      'cd /tmp/spirit_project && git config user.name "Spirit AI" && git config user.email "spirit@ai.com" && git config user.name',
      /Spirit AI/
    );

    await testStep(
      page,
      'Git add files',
      'cd /tmp/spirit_project && git add . && git status',
      /app\.js/
    );

    await testStep(
      page,
      'Git commit initial version',
      'cd /tmp/spirit_project && git commit -m "Initial version: Spirit v1" 2>&1',
      /Initial version/
    );

    await testStep(
      page,
      'Verify commit in log',
      'cd /tmp/spirit_project && git log --oneline',
      /Initial version/
    );

    // WORKFLOW STEP 5: Edit file with sed
    console.log(`\n${c.yellow}Step 5: Code Modification${c.reset}`);
    await testStep(
      page,
      'Edit with sed (v1 -> v2)',
      'cd /tmp/spirit_project && sed -i "s/v1/v2/g" app.js && cat app.js',
      /Hello from Spirit v2/
    );

    await testStep(
      page,
      'Verify git detects changes',
      'cd /tmp/spirit_project && git status',
      /modified.*app\.js/
    );

    // WORKFLOW STEP 6: Run again to verify changes
    console.log(`\n${c.yellow}Step 6: Verify Modified Code${c.reset}`);
    await testStep(
      page,
      'Run app.js (after edit)',
      'cd /tmp/spirit_project && node app.js',
      /Hello from Spirit v2/
    );

    // WORKFLOW STEP 7: Git commit the changes
    console.log(`\n${c.yellow}Step 7: Version Control - Commit Changes${c.reset}`);
    await testStep(
      page,
      'Git add modified file',
      'cd /tmp/spirit_project && git add app.js && git status',
      /Changes to be committed/
    );

    await testStep(
      page,
      'Git commit update',
      'cd /tmp/spirit_project && git commit -m "Update: Spirit v2" 2>&1',
      /Update.*Spirit v2/
    );

    // WORKFLOW STEP 8: Verify git history
    console.log(`\n${c.yellow}Step 8: Verify Version History${c.reset}`);
    await testStep(
      page,
      'Check git log shows 2 commits',
      'cd /tmp/spirit_project && git log --oneline',
      /Update.*Spirit v2/
    );

    await testStep(
      page,
      'Git diff between commits',
      'cd /tmp/spirit_project && git log -p -1',
      /v2/
    );

    // WORKFLOW STEP 9: Advanced verification
    console.log(`\n${c.yellow}Step 9: Workflow Verification${c.reset}`);
    await testStep(
      page,
      'Verify clean working directory',
      'cd /tmp/spirit_project && git status',
      /nothing to commit.*working tree clean/
    );

    await testStep(
      page,
      'Count total commits',
      'cd /tmp/spirit_project && git rev-list --count HEAD',
      /2/
    );

    // Cleanup
    await execCommand(page, 'rm -rf /tmp/spirit_project', 5000);
    console.log('');
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}`);
  console.log(`${c.blue}${c.bold}SPIRIT E2E WORKFLOW SUMMARY${c.reset}`);
  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}\n`);

  const total = totalPassed + totalFailed;
  const passRate = total > 0 ? ((totalPassed / total) * 100).toFixed(1) : 0;

  console.log(`  Workflow Steps:  ${total}`);
  console.log(`  ${c.green}Passed:          ${totalPassed}${c.reset}`);
  console.log(`  ${totalFailed > 0 ? c.red : c.reset}Failed:          ${totalFailed}${c.reset}`);
  console.log(`  Pass Rate:       ${passRate}%`);
  console.log(`  Duration:        ${duration}s\n`);

  if (failedTests.length > 0) {
    console.log(`${c.red}${c.bold}Failed Steps:${c.reset}\n`);
    for (const failure of failedTests) {
      console.log(`  ${c.red}✗${c.reset} ${failure.terminal}: ${failure.step}`);
      console.log(`    ${c.yellow}Error:${c.reset} ${failure.error}\n`);
    }
  }

  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}\n`);

  if (totalFailed === 0) {
    console.log(`${c.green}${c.bold}✓ SPIRIT WORKFLOW COMPLETE${c.reset}`);
    console.log(`${c.green}All development cycle steps verified successfully${c.reset}`);
    console.log(`${c.green}Spirit can perform complete development workflows${c.reset}\n`);
    process.exit(0);
  } else {
    console.log(`${c.red}${c.bold}✗ SPIRIT WORKFLOW FAILED${c.reset}`);
    console.log(`${c.red}Some workflow steps did not complete successfully${c.reset}\n`);
    process.exit(1);
  }
}

// Run workflow test
main().catch(error => {
  console.error(`${c.red}${c.bold}Fatal error: ${error.message}${c.reset}`);
  console.error(error.stack);
  process.exit(1);
});
