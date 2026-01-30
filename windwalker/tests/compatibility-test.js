#!/usr/bin/env node

/**
 * Windwalker Compatibility Test Suite
 *
 * Tests commands in both foam and shiro to identify compatibility differences.
 * Generates a markdown report showing which commands work in both terminals.
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

// Test results storage
const results = {
  foam: {},
  shiro: {},
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
 * Execute shell command with async promise polling
 */
async function execCommand(pageId, command, timeoutMs = 15000) {
  const shell = pageId.includes('shiro') ? '__shiro' : '__foam';
  const resultVar = `compatTest_${Date.now()}_${Math.random().toString(36).substring(7)}`;

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
  return { success: false, error: 'Timeout' };
}

/**
 * Test a command in both terminals
 */
async function testCommand(category, testName, command, expectedPattern) {
  console.log(`  Testing: ${testName}...`);

  const foamResult = await execCommand(FOAM_PAGE, command, TIMEOUT);
  const shiroResult = await execCommand(SHIRO_PAGE, command, TIMEOUT);

  // Check if output matches expected pattern
  const pattern = expectedPattern instanceof RegExp ? expectedPattern : new RegExp(expectedPattern, 'i');

  const foamWorks = foamResult.success && pattern.test(String(foamResult.output || ''));
  const shiroWorks = shiroResult.success && pattern.test(String(shiroResult.output || ''));

  // Store results
  if (!results.categories[category]) {
    results.categories[category] = [];
  }

  results.categories[category].push({
    name: testName,
    command,
    foam: {
      works: foamWorks,
      output: foamResult.success ? String(foamResult.output).substring(0, 100) : foamResult.error
    },
    shiro: {
      works: shiroWorks,
      output: shiroResult.success ? String(shiroResult.output).substring(0, 100) : shiroResult.error
    }
  });

  const symbol = foamWorks && shiroWorks ? '✓' :
                 foamWorks || shiroWorks ? '⚠' : '✗';
  console.log(`    ${symbol} FOAM: ${foamWorks ? 'OK' : 'FAIL'} | SHIRO: ${shiroWorks ? 'OK' : 'FAIL'}`);
}

/**
 * Generate markdown report
 */
function generateReport() {
  let report = `# Windwalker Terminal Compatibility Report

**Generated:** ${new Date().toISOString()}
**Terminals Tested:** foam-windwalker, shiro-windwalker

## Summary

`;

  // Calculate statistics
  let totalTests = 0;
  let bothWork = 0;
  let onlyFoam = 0;
  let onlyShiro = 0;
  let neitherWork = 0;

  for (const category in results.categories) {
    for (const test of results.categories[category]) {
      totalTests++;
      if (test.foam.works && test.shiro.works) bothWork++;
      else if (test.foam.works && !test.shiro.works) onlyFoam++;
      else if (!test.foam.works && test.shiro.works) onlyShiro++;
      else neitherWork++;
    }
  }

  const compatibility = ((bothWork / totalTests) * 100).toFixed(1);

  report += `| Metric | Count | Percentage |
|--------|-------|------------|
| **Total Commands Tested** | ${totalTests} | 100% |
| **Work in Both** | ${bothWork} | ${((bothWork/totalTests)*100).toFixed(1)}% |
| **Only FOAM** | ${onlyFoam} | ${((onlyFoam/totalTests)*100).toFixed(1)}% |
| **Only SHIRO** | ${onlyShiro} | ${((onlyShiro/totalTests)*100).toFixed(1)}% |
| **Neither Works** | ${neitherWork} | ${((neitherWork/totalTests)*100).toFixed(1)}% |

**Compatibility Score:** ${compatibility}% of commands work in both terminals.

`;

  // Detailed results by category
  report += `## Detailed Results

Legend:
- ✅ Works in both FOAM and SHIRO
- ⚠️ Works in one terminal only
- ❌ Doesn't work in either terminal

`;

  for (const category in results.categories) {
    report += `\n### ${category}\n\n`;
    report += `| Command | FOAM | SHIRO | Status |\n`;
    report += `|---------|------|-------|--------|\n`;

    for (const test of results.categories[category]) {
      const foamStatus = test.foam.works ? '✓' : '✗';
      const shiroStatus = test.shiro.works ? '✓' : '✗';

      let status;
      if (test.foam.works && test.shiro.works) {
        status = '✅ Both';
      } else if (test.foam.works) {
        status = '⚠️ FOAM only';
      } else if (test.shiro.works) {
        status = '⚠️ SHIRO only';
      } else {
        status = '❌ Neither';
      }

      report += `| \`${test.name}\` | ${foamStatus} | ${shiroStatus} | ${status} |\n`;
    }
  }

  // Compatibility issues
  report += `\n## Compatibility Issues\n\n`;

  const issues = [];
  for (const category in results.categories) {
    for (const test of results.categories[category]) {
      if (test.foam.works !== test.shiro.works) {
        issues.push({
          category,
          test: test.name,
          command: test.command,
          worksIn: test.foam.works ? 'FOAM' : 'SHIRO',
          failsIn: test.foam.works ? 'SHIRO' : 'FOAM',
          error: test.foam.works ? test.shiro.output : test.foam.output
        });
      }
    }
  }

  if (issues.length === 0) {
    report += `**No compatibility issues found!** All tested commands work identically in both terminals.\n\n`;
  } else {
    report += `Found ${issues.length} compatibility difference(s):\n\n`;

    for (const issue of issues) {
      report += `### ${issue.category}: ${issue.test}\n\n`;
      report += `**Command:** \`${issue.command}\`\n\n`;
      report += `- ✓ Works in: **${issue.worksIn}**\n`;
      report += `- ✗ Fails in: **${issue.failsIn}**\n`;
      report += `- Error: \`${issue.error}\`\n\n`;
    }
  }

  // Recommendations
  report += `## Recommendations\n\n`;

  if (compatibility >= 95) {
    report += `✅ **Excellent compatibility** (${compatibility}%)! Both terminals support the core command set.\n\n`;
  } else if (compatibility >= 80) {
    report += `⚠️ **Good compatibility** (${compatibility}%), but some differences exist. Review the compatibility issues above.\n\n`;
  } else {
    report += `❌ **Compatibility concerns** (${compatibility}%). Significant differences between terminals. Consider implementing missing features.\n\n`;
  }

  if (onlyFoam > 0) {
    report += `- **FOAM-specific features:** ${onlyFoam} command(s) work only in FOAM\n`;
  }
  if (onlyShiro > 0) {
    report += `- **SHIRO-specific features:** ${onlyShiro} command(s) work only in SHIRO\n`;
  }

  report += `\n## Testing Methodology\n\n`;
  report += `Tests executed via Skyeyes API using promise-polling approach:\n\n`;
  report += `1. Execute command via \`window.__foam.shell.execute()\` or \`window.__shiro.shell.execute()\`\n`;
  report += `2. Poll for result every 500ms (max ${TIMEOUT/1000}s timeout)\n`;
  report += `3. Verify output matches expected pattern\n`;
  report += `4. Record success/failure for each terminal\n\n`;

  report += `## Next Steps\n\n`;
  report += `1. Review compatibility issues and determine if fixes are needed\n`;
  report += `2. Add tests for any missing commands\n`;
  report += `3. Re-run compatibility test after making changes\n`;
  report += `4. Update documentation to note any terminal-specific behaviors\n\n`;

  report += `---\n\n`;
  report += `**Test Suite:** Windwalker Compatibility Test  \n`;
  report += `**API Endpoint:** ${SKYEYES_API}  \n`;
  report += `**Timeout per command:** ${TIMEOUT/1000}s\n`;

  return report;
}

/**
 * Main test runner
 */
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                                                           ║');
  console.log('║       WINDWALKER COMPATIBILITY TEST SUITE                 ║');
  console.log('║       Testing FOAM vs SHIRO Command Compatibility         ║');
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

  // Run compatibility tests
  console.log('Running compatibility tests...\n');

  // Basic Commands
  console.log('Category: Basic Commands');
  await testCommand('Basic Commands', 'echo', 'echo "hello"', 'hello');
  await testCommand('Basic Commands', 'pwd', 'pwd', '/');
  await testCommand('Basic Commands', 'whoami', 'whoami', /.+/);
  await testCommand('Basic Commands', 'date', 'date', /.+/);

  // File Operations
  console.log('\nCategory: File Operations');
  await testCommand('File Operations', 'create file', 'echo "test" > /tmp/compat_test.txt && echo "created"', 'created');
  await testCommand('File Operations', 'read file', 'cat /tmp/compat_test.txt', 'test');
  await testCommand('File Operations', 'append file', 'echo "line2" >> /tmp/compat_test.txt && cat /tmp/compat_test.txt', 'line2');
  await testCommand('File Operations', 'ls', 'ls /tmp', 'compat_test');
  await testCommand('File Operations', 'rm file', 'rm /tmp/compat_test.txt && echo "deleted"', 'deleted');
  await testCommand('File Operations', 'mkdir', 'mkdir -p /tmp/test_dir && ls -d /tmp/test_dir', 'test_dir');
  await testCommand('File Operations', 'rmdir', 'rmdir /tmp/test_dir && echo "removed"', 'removed');

  // Pipes and Redirects
  console.log('\nCategory: Pipes and Redirects');
  await testCommand('Pipes and Redirects', 'simple pipe', 'echo "hello" | grep hello', 'hello');
  await testCommand('Pipes and Redirects', 'grep pipe', 'echo -e "a\\nb\\nc" | grep b', 'b');
  await testCommand('Pipes and Redirects', 'wc pipe', 'echo -e "1\\n2\\n3" | wc -l', '3');
  await testCommand('Pipes and Redirects', 'multi-pipe', 'echo -e "apple\\nbanana\\napricot" | grep "^a" | wc -l', '2');
  await testCommand('Pipes and Redirects', 'redirect output', 'echo "redir" > /tmp/r.txt && cat /tmp/r.txt && rm /tmp/r.txt', 'redir');

  // Text Processing
  console.log('\nCategory: Text Processing');
  await testCommand('Text Processing', 'grep', 'echo "test" | grep test', 'test');
  await testCommand('Text Processing', 'sed', 'echo "hello" | sed "s/hello/world/"', 'world');
  await testCommand('Text Processing', 'tr', 'echo "HELLO" | tr A-Z a-z', 'hello');
  await testCommand('Text Processing', 'sort', 'echo -e "c\\na\\nb" | sort | head -1', 'a');
  await testCommand('Text Processing', 'head', 'echo -e "1\\n2\\n3" | head -1', '1');
  await testCommand('Text Processing', 'tail', 'echo -e "1\\n2\\n3" | tail -1', '3');

  // Node.js
  console.log('\nCategory: Node.js');
  await testCommand('Node.js', 'node version', 'node --version', /v\d+/);
  await testCommand('Node.js', 'node eval', 'node -e "console.log(2+2)"', '4');
  await testCommand('Node.js', 'node script', 'echo "console.log(\\"test\\")" > /tmp/t.js && node /tmp/t.js && rm /tmp/t.js', 'test');

  // npm
  console.log('\nCategory: npm');
  await testCommand('npm', 'npm version', 'npm --version', /\d+/);
  await testCommand('npm', 'npm help', 'npm help 2>&1 | head -1', /npm/);

  // Git
  console.log('\nCategory: Git');
  await testCommand('Git', 'git version', 'git --version', /git version/);
  await testCommand('Git', 'git init', 'cd /tmp && rm -rf gt && mkdir gt && cd gt && git init 2>&1', /Initialized/);
  await testCommand('Git', 'git config', 'cd /tmp/gt && git config user.name "Test" && git config user.name', 'Test');

  // Environment
  console.log('\nCategory: Environment');
  await testCommand('Environment', 'export var', 'export TESTVAR=123 && echo $TESTVAR', '123');
  await testCommand('Environment', 'env', 'env | head -1', /.+/);

  // Cleanup
  await execCommand(FOAM_PAGE, 'rm -rf /tmp/gt /tmp/compat_test.txt /tmp/r.txt /tmp/t.js /tmp/test_dir 2>/dev/null', 5000);
  await execCommand(SHIRO_PAGE, 'rm -rf /tmp/gt /tmp/compat_test.txt /tmp/r.txt /tmp/t.js /tmp/test_dir 2>/dev/null', 5000);

  // Generate report
  console.log('\n\nGenerating compatibility report...');
  const report = generateReport();

  const reportPath = path.join(process.cwd(), 'tests', 'compatibility-report.md');
  fs.writeFileSync(reportPath, report);

  console.log(`✓ Report saved to: ${reportPath}\n`);

  // Print summary
  let totalTests = 0;
  let bothWork = 0;
  for (const category in results.categories) {
    for (const test of results.categories[category]) {
      totalTests++;
      if (test.foam.works && test.shiro.works) bothWork++;
    }
  }

  const compatibility = ((bothWork / totalTests) * 100).toFixed(1);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('COMPATIBILITY TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Total Commands Tested: ${totalTests}`);
  console.log(`Work in Both: ${bothWork} (${compatibility}%)`);
  console.log(`Compatibility Score: ${compatibility >= 95 ? '✅' : compatibility >= 80 ? '⚠️' : '❌'} ${compatibility}%`);
  console.log('═══════════════════════════════════════════════════════════\n');

  process.exit(0);
}

main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
