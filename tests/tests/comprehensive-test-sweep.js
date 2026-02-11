#!/usr/bin/env node

/**
 * Windwalker Comprehensive Test Sweep
 *
 * Tests every command category in both foam and shiro terminals:
 * - Coreutils (ls, cat, echo, mkdir, rm, cp, mv, etc.)
 * - Git operations
 * - Pipes and redirects
 * - Environment variables
 * - Quoting and escaping
 * - Text processing
 *
 * Generates detailed test results report
 */

import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';

// Configuration
const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const FOAM_PAGE = 'foam-windwalker';
const SHIRO_PAGE = 'shiro-windwalker';
const TIMEOUT = 15000;

// Test results
const testResults = {
  foam: { passed: 0, failed: 0, tests: [] },
  shiro: { passed: 0, failed: 0, tests: [] },
  categories: {}
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
  const resultVar = `sweepTest_${Date.now()}_${Math.random().toString(36).substring(7)}`;

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
          return { success: false, error: `Invalid JSON: ${resultStr}` };
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
 * Test a command in a specific terminal
 */
async function testCommand(pageId, category, testName, command, expectedPattern) {
  const terminal = pageId.includes('foam') ? 'foam' : 'shiro';

  const result = await execCommand(pageId, command, TIMEOUT);
  const pattern = expectedPattern instanceof RegExp ? expectedPattern : new RegExp(expectedPattern, 'i');

  const passed = result.success && pattern.test(String(result.output || ''));

  const testRecord = {
    name: testName,
    command,
    passed,
    output: result.success ? String(result.output).substring(0, 100) : result.error,
    expected: String(expectedPattern)
  };

  if (!testResults.categories[category]) {
    testResults.categories[category] = { foam: [], shiro: [] };
  }

  testResults.categories[category][terminal].push(testRecord);
  testResults[terminal].tests.push({ category, ...testRecord });

  if (passed) {
    testResults[terminal].passed++;
  } else {
    testResults[terminal].failed++;
  }

  return passed;
}

/**
 * Generate markdown report
 */
function generateReport() {
  const timestamp = new Date().toISOString();

  let report = `# Windwalker Comprehensive Test Sweep Results

**Generated:** ${timestamp}
**Terminals Tested:** foam-windwalker, shiro-windwalker

## Executive Summary

`;

  const foamTotal = testResults.foam.passed + testResults.foam.failed;
  const shiroTotal = testResults.shiro.passed + testResults.shiro.failed;
  const foamRate = foamTotal > 0 ? ((testResults.foam.passed / foamTotal) * 100).toFixed(1) : 0;
  const shiroRate = shiroTotal > 0 ? ((testResults.shiro.passed / shiroTotal) * 100).toFixed(1) : 0;

  report += `| Terminal | Passed | Failed | Total | Pass Rate |
|----------|--------|--------|-------|-----------|
| **FOAM** | ${testResults.foam.passed} | ${testResults.foam.failed} | ${foamTotal} | ${foamRate}% |
| **SHIRO** | ${testResults.shiro.passed} | ${testResults.shiro.failed} | ${shiroTotal} | ${shiroRate}% |

`;

  // Category breakdown
  report += `## Results by Category\n\n`;

  for (const category in testResults.categories) {
    const catData = testResults.categories[category];
    const foamPassed = catData.foam.filter(t => t.passed).length;
    const shiroPassed = catData.shiro.filter(t => t.passed).length;
    const foamTotal = catData.foam.length;
    const shiroTotal = catData.shiro.length;

    report += `### ${category}\n\n`;
    report += `| Test | FOAM | SHIRO | Command |\n`;
    report += `|------|------|-------|----------|\n`;

    // Combine tests from both terminals
    const allTests = new Set([...catData.foam.map(t => t.name), ...catData.shiro.map(t => t.name)]);

    for (const testName of allTests) {
      const foamTest = catData.foam.find(t => t.name === testName);
      const shiroTest = catData.shiro.find(t => t.name === testName);

      const foamStatus = foamTest ? (foamTest.passed ? '✅' : '❌') : '-';
      const shiroStatus = shiroTest ? (shiroTest.passed ? '✅' : '❌') : '-';
      const cmd = (foamTest || shiroTest).command.substring(0, 40) + '...';

      report += `| ${testName} | ${foamStatus} | ${shiroStatus} | \`${cmd}\` |\n`;
    }

    report += `\n**Summary:** FOAM ${foamPassed}/${foamTotal}, SHIRO ${shiroPassed}/${shiroTotal}\n\n`;
  }

  // Failed tests details
  const foamFailed = testResults.foam.tests.filter(t => !t.passed);
  const shiroFailed = testResults.shiro.tests.filter(t => !t.passed);

  if (foamFailed.length > 0 || shiroFailed.length > 0) {
    report += `## Failed Tests Details\n\n`;

    if (foamFailed.length > 0) {
      report += `### FOAM Failures (${foamFailed.length})\n\n`;
      for (const test of foamFailed) {
        report += `#### ${test.category}: ${test.name}\n\n`;
        report += `- **Command:** \`${test.command}\`\n`;
        report += `- **Expected:** ${test.expected}\n`;
        report += `- **Got:** ${test.output}\n\n`;
      }
    }

    if (shiroFailed.length > 0) {
      report += `### SHIRO Failures (${shiroFailed.length})\n\n`;
      for (const test of shiroFailed) {
        report += `#### ${test.category}: ${test.name}\n\n`;
        report += `- **Command:** \`${test.command}\`\n`;
        report += `- **Expected:** ${test.expected}\n`;
        report += `- **Got:** ${test.output}\n\n`;
      }
    }
  }

  // Recommendations
  report += `## Analysis & Recommendations\n\n`;

  if (foamRate >= 95 && shiroRate >= 95) {
    report += `✅ **Excellent Results!** Both terminals show ${Math.min(foamRate, shiroRate)}%+ pass rates.\n\n`;
  } else if (foamRate >= 80 && shiroRate >= 80) {
    report += `⚠️ **Good Results** with some failures. Review failed tests above.\n\n`;
  } else {
    report += `❌ **Action Required.** Significant test failures need investigation.\n\n`;
  }

  report += `### Command Coverage\n\n`;
  for (const category in testResults.categories) {
    const catData = testResults.categories[category];
    const foamPassed = catData.foam.filter(t => t.passed).length;
    const shiroPassed = catData.shiro.filter(t => t.passed).length;
    const total = catData.foam.length;

    const status = (foamPassed === total && shiroPassed === total) ? '✅' :
                   (foamPassed >= total * 0.8 && shiroPassed >= total * 0.8) ? '⚠️' : '❌';

    report += `- ${status} **${category}:** FOAM ${foamPassed}/${total}, SHIRO ${shiroPassed}/${total}\n`;
  }

  report += `\n## Testing Details\n\n`;
  report += `- **API Endpoint:** ${SKYEYES_API}\n`;
  report += `- **Timeout per test:** ${TIMEOUT/1000}s\n`;
  report += `- **Method:** Promise-polling via shell.execute()\n`;
  report += `- **Total tests per terminal:** ${foamTotal}\n`;

  report += `\n---\n\n`;
  report += `**Test Suite:** Comprehensive Test Sweep  \n`;
  report += `**Generated:** ${timestamp}\n`;

  return report;
}

/**
 * Main test runner
 */
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                                                           ║');
  console.log('║     WINDWALKER COMPREHENSIVE TEST SWEEP                   ║');
  console.log('║     Testing All Command Categories                        ║');
  console.log('║                                                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

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
      console.error('✗ Required pages not active');
      process.exit(1);
    }

    console.log('✓ Skyeyes API available');
    console.log(`✓ ${FOAM_PAGE} active`);
    console.log(`✓ ${SHIRO_PAGE} active\n`);
  } catch (error) {
    console.error(`✗ Skyeyes API error: ${error.message}`);
    process.exit(1);
  }

  console.log('Running comprehensive test sweep...\n');

  // COREUTILS TESTS
  console.log('═══ Testing: Coreutils ═══');

  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    const term = page.includes('foam') ? 'FOAM' : 'SHIRO';
    console.log(`\n  ${term}:`);

    await testCommand(page, 'Coreutils', 'echo', 'echo "hello world"', 'hello world');
    await testCommand(page, 'Coreutils', 'cat', 'echo "test" > /tmp/t1.txt && cat /tmp/t1.txt', 'test');
    await testCommand(page, 'Coreutils', 'ls', 'touch /tmp/testfile && ls /tmp/testfile', 'testfile');
    await testCommand(page, 'Coreutils', 'mkdir', 'mkdir -p /tmp/testdir && ls -d /tmp/testdir', 'testdir');
    await testCommand(page, 'Coreutils', 'rm', 'touch /tmp/rmtest && rm /tmp/rmtest && echo "deleted"', 'deleted');
    await testCommand(page, 'Coreutils', 'cp', 'echo "src" > /tmp/src.txt && cp /tmp/src.txt /tmp/dst.txt && cat /tmp/dst.txt', 'src');
    await testCommand(page, 'Coreutils', 'mv', 'echo "mv" > /tmp/a.txt && mv /tmp/a.txt /tmp/b.txt && cat /tmp/b.txt', 'mv');
    await testCommand(page, 'Coreutils', 'pwd', 'pwd', '/');
    await testCommand(page, 'Coreutils', 'touch', 'touch /tmp/touchtest && ls /tmp/touchtest', 'touchtest');
    await testCommand(page, 'Coreutils', 'wc', 'echo -e "a\\nb\\nc" | wc -l', '3');
  }

  // GIT TESTS
  console.log('\n═══ Testing: Git ═══');

  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    const term = page.includes('foam') ? 'FOAM' : 'SHIRO';
    console.log(`\n  ${term}:`);

    await testCommand(page, 'Git', 'git --version', 'git --version', /git version/);
    await testCommand(page, 'Git', 'git init', 'cd /tmp && rm -rf gitrepo && mkdir gitrepo && cd gitrepo && git init', /Initialized/);
    await testCommand(page, 'Git', 'git config', 'cd /tmp/gitrepo && git config user.name "Test" && git config user.name', 'Test');
    await testCommand(page, 'Git', 'git add', 'cd /tmp/gitrepo && echo "test" > file.txt && git add . && echo "added"', 'added');
    await testCommand(page, 'Git', 'git status', 'cd /tmp/gitrepo && git status', /Changes to be committed|new file/);
  }

  // PIPES TESTS
  console.log('\n═══ Testing: Pipes ═══');

  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    const term = page.includes('foam') ? 'FOAM' : 'SHIRO';
    console.log(`\n  ${term}:`);

    await testCommand(page, 'Pipes', 'simple pipe', 'echo "test" | cat', 'test');
    await testCommand(page, 'Pipes', 'grep pipe', 'echo -e "a\\nb\\nc" | grep b', 'b');
    await testCommand(page, 'Pipes', 'wc pipe', 'echo -e "1\\n2\\n3" | wc -l', '3');
    await testCommand(page, 'Pipes', 'multi-stage', 'echo -e "apple\\napricot\\nbanana" | grep "^a" | wc -l', '2');
    await testCommand(page, 'Pipes', 'sort pipe', 'echo -e "c\\na\\nb" | sort | head -1', 'a');
  }

  // REDIRECTS TESTS
  console.log('\n═══ Testing: Redirects ═══');

  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    const term = page.includes('foam') ? 'FOAM' : 'SHIRO';
    console.log(`\n  ${term}:`);

    await testCommand(page, 'Redirects', 'output >', 'echo "redirect" > /tmp/out.txt && cat /tmp/out.txt', 'redirect');
    await testCommand(page, 'Redirects', 'append >>', 'echo "line1" > /tmp/app.txt && echo "line2" >> /tmp/app.txt && cat /tmp/app.txt', 'line2');
    await testCommand(page, 'Redirects', 'combined', 'echo "test" > /tmp/c.txt && cat /tmp/c.txt && rm /tmp/c.txt', 'test');
  }

  // ENVIRONMENT VARIABLES
  console.log('\n═══ Testing: Environment Variables ═══');

  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    const term = page.includes('foam') ? 'FOAM' : 'SHIRO';
    console.log(`\n  ${term}:`);

    await testCommand(page, 'Environment', 'export', 'export MYVAR=hello && echo $MYVAR', 'hello');
    await testCommand(page, 'Environment', 'multiple vars', 'export A=1 B=2 && echo "$A$B"', '12');
    await testCommand(page, 'Environment', 'PATH', 'echo $PATH', /.+/);
  }

  // QUOTING TESTS
  console.log('\n═══ Testing: Quoting & Escaping ═══');

  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    const term = page.includes('foam') ? 'FOAM' : 'SHIRO';
    console.log(`\n  ${term}:`);

    await testCommand(page, 'Quoting', 'double quotes', 'echo "hello world"', 'hello world');
    await testCommand(page, 'Quoting', 'single quotes', "echo 'hello world'", 'hello world');
    await testCommand(page, 'Quoting', 'spaces', 'echo "a b c"', 'a b c');
    await testCommand(page, 'Quoting', 'special chars', 'echo "test@#$"', 'test@#$');
  }

  // TEXT PROCESSING
  console.log('\n═══ Testing: Text Processing ═══');

  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    const term = page.includes('foam') ? 'FOAM' : 'SHIRO';
    console.log(`\n  ${term}:`);

    await testCommand(page, 'Text Processing', 'grep', 'echo "hello" | grep hello', 'hello');
    await testCommand(page, 'Text Processing', 'sed', 'echo "hello" | sed "s/hello/world/"', 'world');
    await testCommand(page, 'Text Processing', 'tr', 'echo "HELLO" | tr A-Z a-z', 'hello');
    await testCommand(page, 'Text Processing', 'head', 'echo -e "1\\n2\\n3" | head -1', '1');
    await testCommand(page, 'Text Processing', 'tail', 'echo -e "1\\n2\\n3" | tail -1', '3');
  }

  // Cleanup
  console.log('\n═══ Cleanup ═══\n');
  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    await execCommand(page, 'rm -rf /tmp/t1.txt /tmp/testfile /tmp/testdir /tmp/rmtest /tmp/src.txt /tmp/dst.txt /tmp/b.txt /tmp/touchtest /tmp/gitrepo /tmp/out.txt /tmp/app.txt /tmp/c.txt 2>/dev/null || true', 5000);
  }

  // Generate report
  console.log('Generating test report...');
  const report = generateReport();

  const reportPath = path.join(process.cwd(), 'tests', 'test-sweep-results.md');
  fs.writeFileSync(reportPath, report);

  console.log(`✓ Report saved to: ${reportPath}\n`);

  // Print summary
  const foamTotal = testResults.foam.passed + testResults.foam.failed;
  const shiroTotal = testResults.shiro.passed + testResults.shiro.failed;
  const foamRate = foamTotal > 0 ? ((testResults.foam.passed / foamTotal) * 100).toFixed(1) : 0;
  const shiroRate = shiroTotal > 0 ? ((testResults.shiro.passed / shiroTotal) * 100).toFixed(1) : 0;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('TEST SWEEP SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`FOAM:  ${testResults.foam.passed}/${foamTotal} passed (${foamRate}%)`);
  console.log(`SHIRO: ${testResults.shiro.passed}/${shiroTotal} passed (${shiroRate}%)`);
  console.log('═══════════════════════════════════════════════════════════\n');

  process.exit(0);
}

main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
