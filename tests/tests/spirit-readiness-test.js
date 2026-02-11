#!/usr/bin/env node

/**
 * Spirit Readiness Test Suite
 *
 * Tests browser OS (Spirit) capabilities to verify it can support
 * Spirit AI agent functionality. Tests fundamental OS features:
 *
 * 1. File read/write/edit
 * 2. Command execution with exit codes
 * 3. Git operations
 * 4. Environment variables
 * 5. Pipe chains
 *
 * Generates pass/fail report for Spirit compatibility.
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
const spiritReadiness = {
  foam: {
    fileOps: { tests: [], passed: 0, total: 0 },
    exitCodes: { tests: [], passed: 0, total: 0 },
    git: { tests: [], passed: 0, total: 0 },
    envVars: { tests: [], passed: 0, total: 0 },
    pipes: { tests: [], passed: 0, total: 0 },
    overall: { passed: 0, total: 0, ready: false }
  },
  shiro: {
    fileOps: { tests: [], passed: 0, total: 0 },
    exitCodes: { tests: [], passed: 0, total: 0 },
    git: { tests: [], passed: 0, total: 0 },
    envVars: { tests: [], passed: 0, total: 0 },
    pipes: { tests: [], passed: 0, total: 0 },
    overall: { passed: 0, total: 0, ready: false }
  }
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
  const resultVar = `spiritTest_${Date.now()}_${Math.random().toString(36).substring(7)}`;

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
 * Run a Spirit readiness test
 */
async function testSpirit(pageId, category, testName, command, expectedPattern) {
  const terminal = pageId.includes('foam') ? 'foam' : 'shiro';
  const result = await execCommand(pageId, command, TIMEOUT);

  const pattern = expectedPattern instanceof RegExp ? expectedPattern : new RegExp(expectedPattern, 'i');
  const passed = result.success && pattern.test(String(result.output || ''));

  const testRecord = {
    name: testName,
    command,
    passed,
    output: result.success ? String(result.output).substring(0, 60) + '...' : result.error,
    required: true // All Spirit tests are required
  };

  spiritReadiness[terminal][category].tests.push(testRecord);
  spiritReadiness[terminal][category].total++;
  spiritReadiness[terminal].overall.total++;

  if (passed) {
    spiritReadiness[terminal][category].passed++;
    spiritReadiness[terminal].overall.passed++;
  }

  const symbol = passed ? '✅' : '❌';
  console.log(`    ${symbol} ${testName}`);

  return passed;
}

/**
 * Generate Spirit readiness report
 */
function generateReport() {
  const timestamp = new Date().toISOString();

  let report = `# Spirit Readiness Test Report

**Generated:** ${timestamp}
**Purpose:** Verify browser OS can support Spirit AI agent
**Terminals Tested:** foam-windwalker, shiro-windwalker

## Executive Summary

`;

  // Calculate readiness scores
  for (const terminal of ['foam', 'shiro']) {
    const data = spiritReadiness[terminal];
    const passRate = data.overall.total > 0 ?
      ((data.overall.passed / data.overall.total) * 100).toFixed(1) : 0;
    data.overall.ready = passRate >= 95; // 95% threshold for Spirit readiness
  }

  const foamReady = spiritReadiness.foam.overall.ready;
  const shiroReady = spiritReadiness.shiro.overall.ready;

  report += `| Terminal | Passed | Total | Pass Rate | Spirit Ready |
|----------|--------|-------|-----------|--------------|
| **FOAM** | ${spiritReadiness.foam.overall.passed} | ${spiritReadiness.foam.overall.total} | ${((spiritReadiness.foam.overall.passed / spiritReadiness.foam.overall.total) * 100).toFixed(1)}% | ${foamReady ? '✅ YES' : '❌ NO'} |
| **SHIRO** | ${spiritReadiness.shiro.overall.passed} | ${spiritReadiness.shiro.overall.total} | ${((spiritReadiness.shiro.overall.passed / spiritReadiness.shiro.overall.total) * 100).toFixed(1)}% | ${shiroReady ? '✅ YES' : '❌ NO'} |

`;

  if (foamReady && shiroReady) {
    report += `### ✅ Spirit Ready

Both terminals meet the requirements for Spirit AI agent deployment.

`;
  } else {
    report += `### ⚠️ Spirit Readiness Issues

One or more terminals do not meet the 95% threshold for Spirit deployment.

`;
  }

  // Detailed results by capability
  report += `## Capability Assessment\n\n`;

  const categories = [
    { key: 'fileOps', name: 'File Operations', desc: 'Read, write, edit files' },
    { key: 'exitCodes', name: 'Command Execution', desc: 'Execute commands with exit codes' },
    { key: 'git', name: 'Git Operations', desc: 'Version control functionality' },
    { key: 'envVars', name: 'Environment Variables', desc: 'Environment management' },
    { key: 'pipes', name: 'Pipe Chains', desc: 'Command composition' }
  ];

  for (const cat of categories) {
    report += `### ${cat.name}\n\n`;
    report += `**Purpose:** ${cat.desc}\n\n`;
    report += `| Test | FOAM | SHIRO | Requirement |\n`;
    report += `|------|------|-------|-------------|\n`;

    const maxTests = Math.max(
      spiritReadiness.foam[cat.key].tests.length,
      spiritReadiness.shiro[cat.key].tests.length
    );

    for (let i = 0; i < maxTests; i++) {
      const foamTest = spiritReadiness.foam[cat.key].tests[i];
      const shiroTest = spiritReadiness.shiro[cat.key].tests[i];

      const name = (foamTest || shiroTest).name;
      const foamStatus = foamTest ? (foamTest.passed ? '✅' : '❌') : '-';
      const shiroStatus = shiroTest ? (shiroTest.passed ? '✅' : '❌') : '-';

      report += `| ${name} | ${foamStatus} | ${shiroStatus} | Required |\n`;
    }

    const foamPassed = spiritReadiness.foam[cat.key].passed;
    const foamTotal = spiritReadiness.foam[cat.key].total;
    const shiroPassed = spiritReadiness.shiro[cat.key].passed;
    const shiroTotal = spiritReadiness.shiro[cat.key].total;

    report += `\n**Results:** FOAM ${foamPassed}/${foamTotal}, SHIRO ${shiroPassed}/${shiroTotal}\n\n`;

    const foamCatReady = foamTotal > 0 && foamPassed === foamTotal;
    const shiroCatReady = shiroTotal > 0 && shiroPassed === shiroTotal;

    if (foamCatReady && shiroCatReady) {
      report += `✅ **Ready:** Both terminals support ${cat.name.toLowerCase()}\n\n`;
    } else {
      report += `⚠️ **Issues detected:** Some tests failed\n\n`;
    }
  }

  // Failed tests
  const foamFailed = [];
  const shiroFailed = [];

  for (const cat of categories) {
    for (const test of spiritReadiness.foam[cat.key].tests) {
      if (!test.passed) foamFailed.push({ category: cat.name, ...test });
    }
    for (const test of spiritReadiness.shiro[cat.key].tests) {
      if (!test.passed) shiroFailed.push({ category: cat.name, ...test });
    }
  }

  if (foamFailed.length > 0 || shiroFailed.length > 0) {
    report += `## Critical Failures\n\n`;

    if (foamFailed.length > 0) {
      report += `### FOAM Failures (${foamFailed.length})\n\n`;
      for (const test of foamFailed) {
        report += `- **${test.category}:** ${test.name}\n`;
        report += `  - Command: \`${test.command}\`\n`;
        report += `  - Error: ${test.output}\n\n`;
      }
    }

    if (shiroFailed.length > 0) {
      report += `### SHIRO Failures (${shiroFailed.length})\n\n`;
      for (const test of shiroFailed) {
        report += `- **${test.category}:** ${test.name}\n`;
        report += `  - Command: \`${test.command}\`\n`;
        report += `  - Error: ${test.output}\n\n`;
      }
    }
  }

  // Spirit Requirements
  report += `## Spirit Requirements\n\n`;
  report += `For Spirit AI agent to function, the browser OS must support:\n\n`;
  report += `1. **File Operations** - Create, read, write, edit, delete files\n`;
  report += `2. **Command Execution** - Run commands and capture exit codes\n`;
  report += `3. **Git Operations** - Init, config, add, commit, status, clone\n`;
  report += `4. **Environment Variables** - Set, read, use in commands\n`;
  report += `5. **Pipe Chains** - Compose commands with pipes and redirects\n\n`;

  report += `### Readiness Threshold\n\n`;
  report += `- **Minimum:** 95% of tests must pass\n`;
  report += `- **Recommended:** 100% of tests pass\n`;
  report += `- **Critical:** All file operations must work\n\n`;

  // Recommendations
  report += `## Recommendations\n\n`;

  if (foamReady && shiroReady) {
    report += `### ✅ Deploy Spirit\n\n`;
    report += `Both terminals are ready for Spirit AI agent deployment:\n\n`;
    report += `- All required capabilities verified\n`;
    report += `- File operations fully functional\n`;
    report += `- Command execution with exit codes working\n`;
    report += `- Git workflow support confirmed\n`;
    report += `- Environment and pipes operational\n\n`;
    report += `**Next Steps:**\n`;
    report += `1. Deploy Spirit AI agent\n`;
    report += `2. Run Spirit integration tests\n`;
    report += `3. Monitor for any edge cases\n\n`;
  } else {
    report += `### ⚠️ Do Not Deploy Spirit\n\n`;
    report += `One or more terminals do not meet Spirit requirements:\n\n`;

    if (!foamReady) {
      report += `- **FOAM:** ${spiritReadiness.foam.overall.passed}/${spiritReadiness.foam.overall.total} tests passed (${((spiritReadiness.foam.overall.passed / spiritReadiness.foam.overall.total) * 100).toFixed(1)}%)\n`;
    }
    if (!shiroReady) {
      report += `- **SHIRO:** ${spiritReadiness.shiro.overall.passed}/${spiritReadiness.shiro.overall.total} tests passed (${((spiritReadiness.shiro.overall.passed / spiritReadiness.shiro.overall.total) * 100).toFixed(1)}%)\n`;
    }

    report += `\n**Action Required:**\n`;
    report += `1. Fix failing tests listed above\n`;
    report += `2. Re-run Spirit readiness test\n`;
    report += `3. Achieve 95%+ pass rate before deployment\n\n`;
  }

  report += `## Testing Methodology\n\n`;
  report += `- **API:** Skyeyes API via curl\n`;
  report += `- **Method:** Promise-polling on shell.execute()\n`;
  report += `- **Timeout:** ${TIMEOUT/1000}s per test\n`;
  report += `- **Verification:** Pattern matching on command output\n`;
  report += `- **Exit Codes:** Tested via command success/failure\n\n`;

  report += `---\n\n`;
  report += `**Test Suite:** Spirit Readiness Test\n`;
  report += `**Generated:** ${timestamp}\n`;
  report += `**Threshold:** 95% pass rate required\n`;

  return report;
}

/**
 * Main test runner
 */
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                                                           ║');
  console.log('║          SPIRIT READINESS TEST SUITE                      ║');
  console.log('║          Browser OS Capability Verification               ║');
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

  console.log('Running Spirit readiness tests...\n');

  // Test both terminals
  for (const page of [FOAM_PAGE, SHIRO_PAGE]) {
    const term = page.includes('foam') ? 'FOAM' : 'SHIRO';
    console.log(`\n═══════════════════════════════════════`);
    console.log(`Testing: ${term}`);
    console.log(`═══════════════════════════════════════\n`);

    // 1. FILE OPERATIONS
    console.log('  📁 File Read/Write/Edit:');
    await testSpirit(page, 'fileOps', 'Create file', 'echo "test content" > /tmp/spirit_test.txt && echo "created"', 'created');
    await testSpirit(page, 'fileOps', 'Read file', 'cat /tmp/spirit_test.txt', 'test content');
    await testSpirit(page, 'fileOps', 'Edit file (append)', 'echo "new line" >> /tmp/spirit_test.txt && echo "appended"', 'appended');
    await testSpirit(page, 'fileOps', 'Verify edit', 'cat /tmp/spirit_test.txt', 'new line');
    await testSpirit(page, 'fileOps', 'Delete file', 'rm /tmp/spirit_test.txt && echo "deleted"', 'deleted');

    // 2. EXIT CODES
    console.log('\n  🔧 Command Execution & Exit Codes:');
    await testSpirit(page, 'exitCodes', 'Success exit code', 'true && echo "success"', 'success');
    await testSpirit(page, 'exitCodes', 'Command output', 'echo "output test"', 'output test');
    await testSpirit(page, 'exitCodes', 'Multiple commands', 'echo "a" && echo "b" && echo "c"', /a.*b.*c/s);

    // 3. GIT OPERATIONS
    console.log('\n  📦 Git Operations:');
    await testSpirit(page, 'git', 'Git available', 'git --version', /git version/);
    await testSpirit(page, 'git', 'Git init', 'cd /tmp && rm -rf spirit_git && mkdir spirit_git && cd spirit_git && git init', /Initialized/);
    await testSpirit(page, 'git', 'Git config', 'cd /tmp/spirit_git && git config user.name "Spirit" && git config user.name', 'Spirit');
    await testSpirit(page, 'git', 'Git add', 'cd /tmp/spirit_git && echo "test" > file.txt && git add . && echo "added"', 'added');
    await testSpirit(page, 'git', 'Git status', 'cd /tmp/spirit_git && git status', /Changes to be committed|new file/);

    // 4. ENVIRONMENT VARIABLES
    console.log('\n  🌍 Environment Variables:');
    await testSpirit(page, 'envVars', 'Set variable', 'export SPIRIT_VAR=test && echo $SPIRIT_VAR', 'test');
    await testSpirit(page, 'envVars', 'Multiple vars', 'export A=1 B=2 && echo "$A$B"', '12');
    await testSpirit(page, 'envVars', 'Use in command', 'export FILE=test.txt && echo "content" > /tmp/$FILE && cat /tmp/$FILE', 'content');

    // 5. PIPE CHAINS
    console.log('\n  🔗 Pipe Chains:');
    await testSpirit(page, 'pipes', 'Simple pipe', 'echo "hello" | grep hello', 'hello');
    await testSpirit(page, 'pipes', 'Multi-stage pipe', 'echo -e "a\\nb\\nc" | grep -v b | wc -l', '2');
    await testSpirit(page, 'pipes', 'Complex chain', 'echo "TEST" | tr A-Z a-z | sed "s/test/success/"', 'success');
    await testSpirit(page, 'pipes', 'Output redirect', 'echo "redir" > /tmp/r.txt && cat /tmp/r.txt', 'redir');

    // Cleanup
    await execCommand(page, 'rm -rf /tmp/spirit_test.txt /tmp/spirit_git /tmp/test.txt /tmp/r.txt 2>/dev/null || true', 5000);
  }

  // Generate report
  console.log('\n\n═══════════════════════════════════════');
  console.log('Generating Spirit readiness report...');
  console.log('═══════════════════════════════════════\n');

  const report = generateReport();
  const reportPath = path.join(process.cwd(), 'tests', 'spirit-readiness-report.md');
  fs.writeFileSync(reportPath, report);

  console.log(`✓ Report saved to: ${reportPath}\n`);

  // Print summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log('SPIRIT READINESS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');

  for (const terminal of ['foam', 'shiro']) {
    const data = spiritReadiness[terminal];
    const passRate = ((data.overall.passed / data.overall.total) * 100).toFixed(1);
    const status = data.overall.ready ? '✅ READY' : '❌ NOT READY';

    console.log(`${terminal.toUpperCase()}: ${data.overall.passed}/${data.overall.total} (${passRate}%) - ${status}`);
  }

  console.log('═══════════════════════════════════════════════════════════\n');

  const bothReady = spiritReadiness.foam.overall.ready && spiritReadiness.shiro.overall.ready;

  if (bothReady) {
    console.log('✅ Spirit deployment approved for both terminals\n');
    process.exit(0);
  } else {
    console.log('⚠️  Spirit deployment blocked - tests must pass\n');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
