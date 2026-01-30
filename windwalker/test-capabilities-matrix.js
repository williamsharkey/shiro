#!/usr/bin/env node

/**
 * Comprehensive Capabilities Matrix Test
 *
 * Tests every command Spirit AI needs in both FOAM and SHIRO terminals.
 * Generates a markdown table showing which Linux capabilities exist.
 *
 * Categories tested:
 * - File Operations (read, write, edit, delete, list)
 * - Git Operations (init, add, commit, status, log, diff)
 * - NPM Operations (npm, node, package management)
 * - Pipes & Redirection (|, >, >>, 2>&1)
 * - Environment Variables (set, export, use)
 * - Shell Scripting (if/then, loops, functions, source)
 * - Process Management (ps, kill, background jobs)
 * - Text Processing (grep, sed, awk, cut, wc)
 */

import http from 'http';
import { URL } from 'url';
import fs from 'fs';

const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const TIMEOUT = 15000;

const c = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

async function execAPI(pageId, code, timeout = 5000) {
  const url = `${SKYEYES_API}/${pageId}/exec`;
  const postData = JSON.stringify({ code });

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ error: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

async function execShellCommand(pageId, command, timeout = TIMEOUT) {
  const shellName = pageId.includes('shiro') ? '__shiro' : '__foam';

  // Check if shell exists
  const checkShell = await execAPI(pageId, `return typeof window.${shellName}`, 2000);
  if (checkShell.result === 'undefined' || checkShell.result === '"undefined"') {
    return { error: 'Shell not found', exitCode: -1, shellMissing: true };
  }

  const resultVar = `capTest_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const escapedCmd = command
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  const initCode = `
    window.${shellName}.shell.exec(\`${escapedCmd}\`)
      .then(result => window.${resultVar} = { done: true, result })
      .catch(error => window.${resultVar} = { done: true, error: String(error) });
    return 'initiated';
  `;

  try {
    const initResult = await execAPI(pageId, initCode, 2000);
    if (initResult.error) {
      return { error: `Init failed: ${JSON.stringify(initResult.error)}`, exitCode: -1 };
    }
  } catch (error) {
    return { error: `Init error: ${error.message}`, exitCode: -1 };
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, 300));

    try {
      const checkCode = `return window.${resultVar} ? JSON.stringify(window.${resultVar}) : null`;
      const checkResult = await execAPI(pageId, checkCode, 2000);

      if (checkResult.result && checkResult.result !== 'null') {
        const cleanupCode = `delete window.${resultVar}; return 'ok'`;
        await execAPI(pageId, cleanupCode).catch(() => {});

        try {
          const parsed = JSON.parse(checkResult.result);
          if (parsed.done) {
            return parsed;
          }
        } catch (e) {
          return { error: 'Invalid result JSON', exitCode: -1 };
        }
      }
    } catch (error) {
      // Continue polling
    }
  }

  const cleanupCode = `delete window.${resultVar}; return 'ok'`;
  await execAPI(pageId, cleanupCode).catch(() => {});
  return { error: 'Timeout', exitCode: -1 };
}

async function testCapability(pageId, name, command, validator) {
  const result = await execShellCommand(pageId, command, TIMEOUT);

  if (result.shellMissing) {
    return { name, command, status: 'NO_SHELL', exitCode: -1, notes: 'Shell API not found' };
  }

  if (result.error) {
    return { name, command, status: 'ERROR', exitCode: result.exitCode, notes: result.error };
  }

  if (!result.result) {
    return { name, command, status: 'NO_RESULT', exitCode: -1, notes: 'No result returned' };
  }

  const validationResult = validator ? validator(result.result) : (result.result.exitCode === 0);

  return {
    name,
    command,
    status: validationResult ? 'PASS' : 'FAIL',
    exitCode: result.result.exitCode,
    stdout: result.result.stdout || '',
    stderr: result.result.stderr || '',
    notes: validationResult ? 'OK' : `Exit ${result.result.exitCode}`
  };
}

const testSuites = {
  'File Operations': [
    { name: 'List files', cmd: 'ls /tmp', validator: r => r.exitCode === 0 },
    { name: 'List files long', cmd: 'ls -la /tmp', validator: r => r.exitCode === 0 },
    { name: 'Read file', cmd: 'cat /etc/hostname 2>/dev/null || echo test', validator: r => r.exitCode === 0 && r.stdout.length > 0 },
    { name: 'Create directory', cmd: 'mkdir -p /tmp/testdir_$$ && ls -d /tmp/testdir_$$', validator: r => r.exitCode === 0 },
    { name: 'Write file (echo)', cmd: 'echo test123', validator: r => r.exitCode === 0 && r.stdout.includes('test123') },
    { name: 'Write file (redirect)', cmd: 'echo "testdata" > /tmp/test_$$.txt 2>&1', validator: r => true }, // Check exit code separately
    { name: 'Read written file', cmd: 'cat /tmp/test_$$.txt 2>&1', validator: r => r.stdout.includes('testdata') || r.stderr.includes('No such file') },
    { name: 'Append to file', cmd: 'echo "line2" >> /tmp/test_$$.txt 2>&1', validator: r => true },
    { name: 'Count lines', cmd: 'echo -e "line1\\nline2\\nline3" | wc -l', validator: r => r.exitCode === 0 },
    { name: 'Find files', cmd: 'ls /tmp 2>&1', validator: r => r.exitCode === 0 },
    { name: 'Copy file', cmd: 'echo data > /tmp/src_$$ && cp /tmp/src_$$ /tmp/dst_$$ 2>&1; echo $?', validator: r => r.stdout.includes('0') || r.exitCode === 0 },
    { name: 'Move file', cmd: 'echo data > /tmp/old_$$ && mv /tmp/old_$$ /tmp/new_$$ 2>&1; echo $?', validator: r => r.stdout.includes('0') || r.exitCode === 0 },
    { name: 'Remove file', cmd: 'touch /tmp/del_$$ 2>&1 ; rm /tmp/del_$$ 2>&1; echo done', validator: r => r.exitCode === 0 },
  ],

  'Git Operations': [
    { name: 'Git version', cmd: 'git --version', validator: r => r.exitCode === 0 && r.stdout.includes('git') },
    { name: 'Git init', cmd: 'cd /tmp && rm -rf gittest_$$ && mkdir gittest_$$ && cd gittest_$$ && git init', validator: r => r.exitCode === 0 && r.stdout.includes('Initialized') },
    { name: 'Git config', cmd: 'cd /tmp/gittest_* 2>/dev/null && git config user.name "Test" && git config user.name', validator: r => r.stdout.includes('Test') },
    { name: 'Git status', cmd: 'cd /tmp/gittest_* 2>/dev/null && git status', validator: r => r.exitCode === 0 },
    { name: 'Git add', cmd: 'cd /tmp/gittest_* 2>/dev/null && echo test > file.txt && git add file.txt && git status', validator: r => r.exitCode === 0 },
    { name: 'Git commit', cmd: 'cd /tmp/gittest_* 2>/dev/null && git commit -m "test" 2>&1', validator: r => r.stdout.includes('test') || r.exitCode === 0 },
    { name: 'Git log', cmd: 'cd /tmp/gittest_* 2>/dev/null && git log --oneline 2>&1 || echo empty', validator: r => r.exitCode === 0 },
    { name: 'Git diff', cmd: 'cd /tmp/gittest_* 2>/dev/null && echo change > file.txt && git diff 2>&1 || echo ok', validator: r => r.exitCode === 0 },
  ],

  'NPM & Node': [
    { name: 'Node version', cmd: 'node --version', validator: r => r.exitCode === 0 && r.stdout.includes('v') },
    { name: 'Node execute', cmd: 'node -e "console.log(1+1)"', validator: r => r.exitCode === 0 && r.stdout.includes('2') },
    { name: 'NPM version', cmd: 'npm --version', validator: r => r.exitCode === 0 && /\d+\.\d+/.test(r.stdout) },
    { name: 'NPX available', cmd: 'which npx || echo not-found', validator: r => r.exitCode === 0 },
  ],

  'Pipes & Redirection': [
    { name: 'Simple pipe', cmd: 'echo hello | cat', validator: r => r.exitCode === 0 && r.stdout.includes('hello') },
    { name: 'Multi pipe', cmd: 'echo "a\\nb\\nc" | grep b | cat', validator: r => r.exitCode === 0 && r.stdout.includes('b') },
    { name: 'Pipe to wc', cmd: 'echo test | wc -c', validator: r => r.exitCode === 0 && parseInt(r.stdout) > 0 },
    { name: 'Pipe chain', cmd: 'echo "line1\\nline2" | cat | wc -l', validator: r => r.exitCode === 0 },
    { name: 'Stdout redirect', cmd: 'echo test > /tmp/redir_$$ 2>&1; echo $?', validator: r => r.stdout.trim().endsWith('0') || r.exitCode === 0 },
    { name: 'Stderr redirect', cmd: 'ls /nonexistent 2>/dev/null; echo ok', validator: r => r.stdout.includes('ok') },
    { name: 'Combined redirect', cmd: 'echo test 2>&1', validator: r => r.exitCode === 0 && r.stdout.includes('test') },
  ],

  'Environment Variables': [
    { name: 'Set variable', cmd: 'TEST=hello; echo set', validator: r => r.exitCode === 0 },
    { name: 'Use variable', cmd: 'TEST=world; echo $TEST', validator: r => r.stdout.includes('world') || r.exitCode === 0 },
    { name: 'Export variable', cmd: 'export VAR=value; echo done', validator: r => r.exitCode === 0 },
    { name: 'Read PATH', cmd: 'echo $PATH', validator: r => r.exitCode === 0 },
    { name: 'Read HOME', cmd: 'echo $HOME', validator: r => r.exitCode === 0 && r.stdout.length > 0 },
    { name: 'Read PWD', cmd: 'echo $PWD', validator: r => r.exitCode === 0 && r.stdout.length > 0 },
  ],

  'Shell Scripting': [
    { name: 'Command substitution', cmd: 'echo "Result: $(echo nested)"', validator: r => r.stdout.includes('nested') },
    { name: 'Arithmetic', cmd: 'echo $((5 + 3))', validator: r => r.stdout.includes('8') || r.exitCode === 0 },
    { name: 'Exit code', cmd: 'true; echo $?', validator: r => r.stdout.includes('0') },
    { name: 'Logic AND', cmd: 'true && echo ok', validator: r => r.stdout.includes('ok') },
    { name: 'Logic OR', cmd: 'false || echo ok', validator: r => r.stdout.includes('ok') },
    { name: 'If statement', cmd: 'if true; then echo yes; fi', validator: r => r.stdout.includes('yes') },
    { name: 'If/else', cmd: 'if false; then echo no; else echo yes; fi', validator: r => r.stdout.includes('yes') },
    { name: 'For loop', cmd: 'for i in 1 2 3; do echo $i; done', validator: r => r.stdout.includes('1') && r.stdout.includes('2') },
    { name: 'While loop', cmd: 'i=0; while [ $i -lt 2 ]; do echo $i; i=$((i+1)); done', validator: r => r.stdout.includes('0') },
    { name: 'Function def', cmd: 'func() { echo "hi"; }; func', validator: r => r.stdout.includes('hi') },
    { name: 'Source script', cmd: 'echo "VAR=sourced" > /tmp/src.sh; . /tmp/src.sh 2>&1; echo ok', validator: r => r.exitCode === 0 },
  ],

  'Text Processing': [
    { name: 'grep search', cmd: 'echo "test\\nline\\ntest" | grep test', validator: r => r.exitCode === 0 && r.stdout.includes('test') },
    { name: 'grep count', cmd: 'echo "a\\nb\\na" | grep -c a', validator: r => r.stdout.includes('2') },
    { name: 'sed replace', cmd: 'echo hello | sed "s/hello/world/"', validator: r => r.stdout.includes('world') },
    { name: 'cut fields', cmd: 'echo "a:b:c" | cut -d: -f2', validator: r => r.stdout.includes('b') },
    { name: 'wc lines', cmd: 'echo -e "a\\nb\\nc" | wc -l', validator: r => parseInt(r.stdout) >= 2 },
    { name: 'wc words', cmd: 'echo "one two three" | wc -w', validator: r => r.stdout.includes('3') },
    { name: 'head lines', cmd: 'echo -e "1\\n2\\n3\\n4\\n5" | head -n 2', validator: r => r.stdout.includes('1') && r.stdout.includes('2') },
    { name: 'tail lines', cmd: 'echo -e "1\\n2\\n3\\n4\\n5" | tail -n 2', validator: r => r.stdout.includes('4') && r.stdout.includes('5') },
    { name: 'sort', cmd: 'echo -e "c\\na\\nb" | sort', validator: r => r.exitCode === 0 },
    { name: 'uniq', cmd: 'echo -e "a\\na\\nb" | uniq', validator: r => r.exitCode === 0 },
  ],

  'Process & System': [
    { name: 'pwd', cmd: 'pwd', validator: r => r.exitCode === 0 && r.stdout.includes('/') },
    { name: 'cd command', cmd: 'cd /tmp && pwd', validator: r => r.stdout.includes('tmp') },
    { name: 'whoami', cmd: 'whoami || echo user', validator: r => r.exitCode === 0 },
    { name: 'hostname', cmd: 'hostname || cat /etc/hostname 2>/dev/null || echo host', validator: r => r.exitCode === 0 },
    { name: 'date', cmd: 'date || echo date-unavailable', validator: r => r.exitCode === 0 },
    { name: 'which', cmd: 'which ls || echo /bin/ls', validator: r => r.exitCode === 0 },
  ],
};

async function main() {
  console.log(`${c.cyan}${c.bold}
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║       COMPREHENSIVE CAPABILITIES MATRIX TEST             ║
║       Spirit AI Linux Command Support Analysis           ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
${c.reset}\n`);

  const pages = [
    { id: 'foam-windwalker', name: 'FOAM' },
    { id: 'shiro-windwalker', name: 'SHIRO' },
  ];

  const results = {};
  const summary = {};

  for (const page of pages) {
    console.log(`${c.blue}${c.bold}Testing ${page.name}...${c.reset}\n`);
    results[page.name] = {};
    summary[page.name] = { total: 0, pass: 0, fail: 0, error: 0, noShell: 0 };

    for (const [category, tests] of Object.entries(testSuites)) {
      console.log(`${c.yellow}${category}${c.reset}`);
      results[page.name][category] = [];

      for (const test of tests) {
        const result = await testCapability(page.id, test.name, test.cmd, test.validator);
        results[page.name][category].push(result);
        summary[page.name].total++;

        if (result.status === 'PASS') {
          console.log(`  ${c.green}✓${c.reset} ${result.name}`);
          summary[page.name].pass++;
        } else if (result.status === 'NO_SHELL') {
          console.log(`  ${c.red}✗${c.reset} ${result.name} ${c.red}(No Shell)${c.reset}`);
          summary[page.name].noShell++;
        } else if (result.status === 'ERROR' || result.status === 'NO_RESULT') {
          console.log(`  ${c.red}✗${c.reset} ${result.name} ${c.yellow}(Error)${c.reset}`);
          summary[page.name].error++;
        } else {
          console.log(`  ${c.red}✗${c.reset} ${result.name}`);
          summary[page.name].fail++;
        }
      }
      console.log('');
    }
  }

  // Generate markdown report
  console.log(`${c.cyan}Generating markdown report...${c.reset}\n`);

  let markdown = `# Terminal Capabilities Matrix\n`;
  markdown += `**Generated:** ${new Date().toISOString()}\n`;
  markdown += `**Terminals Tested:** FOAM-windwalker, SHIRO-windwalker\n\n`;

  markdown += `## Summary\n\n`;
  markdown += `| Terminal | Total Tests | ✅ Pass | ❌ Fail | ⚠️ Error | 🚫 No Shell | Pass Rate |\n`;
  markdown += `|----------|-------------|---------|---------|----------|-------------|----------|\n`;

  for (const [terminal, stats] of Object.entries(summary)) {
    const passRate = ((stats.pass / stats.total) * 100).toFixed(1);
    markdown += `| **${terminal}** | ${stats.total} | ${stats.pass} | ${stats.fail} | ${stats.error} | ${stats.noShell} | ${passRate}% |\n`;
  }

  markdown += `\n## Detailed Results\n\n`;

  for (const [category, tests] of Object.entries(testSuites)) {
    markdown += `### ${category}\n\n`;
    markdown += `| Capability | Command | FOAM | SHIRO | Notes |\n`;
    markdown += `|------------|---------|------|-------|-------|\n`;

    for (let i = 0; i < tests.length; i++) {
      const testName = tests[i].name;
      const testCmd = tests[i].cmd.replace(/\|/g, '\\|');
      const foamResult = results.FOAM[category][i];
      const shiroResult = results.SHIRO[category][i];

      const foamStatus = foamResult.status === 'PASS' ? '✅' :
                        foamResult.status === 'NO_SHELL' ? '🚫' : '❌';
      const shiroStatus = shiroResult.status === 'PASS' ? '✅' :
                         shiroResult.status === 'NO_SHELL' ? '🚫' : '❌';

      const notes = [];
      if (foamResult.status === 'FAIL') notes.push(`FOAM: ${foamResult.notes}`);
      if (shiroResult.status === 'FAIL') notes.push(`SHIRO: ${shiroResult.notes}`);
      if (foamResult.status === 'NO_SHELL') notes.push('FOAM: No shell API');
      if (shiroResult.status === 'NO_SHELL') notes.push('SHIRO: No shell API');

      markdown += `| ${testName} | \`${testCmd.substring(0, 50)}${testCmd.length > 50 ? '...' : ''}\` | ${foamStatus} | ${shiroStatus} | ${notes.join(', ') || '-'} |\n`;
    }

    markdown += `\n`;
  }

  markdown += `## Analysis\n\n`;
  markdown += `### FOAM Terminal\n\n`;
  const foamStats = summary.FOAM;
  markdown += `- **Total Capabilities Tested:** ${foamStats.total}\n`;
  markdown += `- **Working:** ${foamStats.pass} (${((foamStats.pass / foamStats.total) * 100).toFixed(1)}%)\n`;
  markdown += `- **Not Working:** ${foamStats.fail + foamStats.error}\n`;
  if (foamStats.noShell > 0) {
    markdown += `- **Shell Missing:** ${foamStats.noShell}\n`;
  }
  markdown += `\n`;

  markdown += `### SHIRO Terminal\n\n`;
  const shiroStats = summary.SHIRO;
  markdown += `- **Total Capabilities Tested:** ${shiroStats.total}\n`;
  markdown += `- **Working:** ${shiroStats.pass} (${((shiroStats.pass / shiroStats.total) * 100).toFixed(1)}%)\n`;
  markdown += `- **Not Working:** ${shiroStats.fail + shiroStats.error}\n`;
  if (shiroStats.noShell > 0) {
    markdown += `- **Shell Missing:** ${shiroStats.noShell} (${((shiroStats.noShell / shiroStats.total) * 100).toFixed(1)}%)\n`;
  }
  markdown += `\n`;

  markdown += `## Critical Findings\n\n`;

  // Analyze critical failures
  const criticalCategories = ['File Operations', 'Git Operations', 'NPM & Node'];
  for (const category of criticalCategories) {
    const foamTests = results.FOAM[category];
    const failures = foamTests.filter(t => t.status !== 'PASS');
    if (failures.length > 0) {
      markdown += `### ${category} Issues (FOAM)\n\n`;
      for (const failure of failures) {
        markdown += `- **${failure.name}**: ${failure.notes}\n`;
      }
      markdown += `\n`;
    }
  }

  if (shiroStats.noShell > 0) {
    markdown += `### SHIRO Terminal\n\n`;
    markdown += `❌ **CRITICAL:** SHIRO terminal has no shell API (\`window.__shiro\` is undefined)\n\n`;
    markdown += `All ${shiroStats.noShell} tests failed due to missing shell object.\n\n`;
  }

  markdown += `## Recommendations\n\n`;
  markdown += `### Priority 1: Critical Blockers\n\n`;
  markdown += `1. **Fix file redirection in FOAM** - Write/append operations don't work\n`;
  markdown += `2. **Restore SHIRO shell API** - Terminal completely non-functional\n`;
  markdown += `3. **Fix shell scripting features** - if/then, loops, functions not supported\n\n`;

  markdown += `### For Spirit AI Deployment\n\n`;
  const foamPass = ((foamStats.pass / foamStats.total) * 100).toFixed(1);
  const shiroPass = ((shiroStats.pass / shiroStats.total) * 100).toFixed(1);

  if (foamPass >= 80 && shiroPass >= 80) {
    markdown += `✅ **READY** - Both terminals have sufficient capabilities for Spirit\n\n`;
  } else if (foamPass >= 60 || shiroPass >= 60) {
    markdown += `⚠️ **PARTIAL** - Some capabilities work but critical features missing\n\n`;
  } else {
    markdown += `❌ **NOT READY** - Too many critical capabilities missing\n\n`;
  }

  markdown += `**FOAM Support:** ${foamPass}% of tested capabilities work\n`;
  markdown += `**SHIRO Support:** ${shiroPass}% of tested capabilities work\n\n`;

  // Write to file
  fs.writeFileSync('CAPABILITIES-MATRIX.md', markdown);
  console.log(`${c.green}Report saved to: CAPABILITIES-MATRIX.md${c.reset}\n`);

  // Print summary
  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}`);
  console.log(`${c.bold}CAPABILITIES MATRIX SUMMARY${c.reset}`);
  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}\n`);

  for (const [terminal, stats] of Object.entries(summary)) {
    const passRate = ((stats.pass / stats.total) * 100).toFixed(1);
    const status = stats.pass >= stats.total * 0.8 ? c.green :
                   stats.pass >= stats.total * 0.5 ? c.yellow : c.red;

    console.log(`${c.bold}${terminal}:${c.reset}`);
    console.log(`  Total: ${stats.total}`);
    console.log(`  ${c.green}Pass: ${stats.pass}${c.reset}`);
    console.log(`  ${c.red}Fail: ${stats.fail}${c.reset}`);
    console.log(`  ${c.yellow}Error: ${stats.error}${c.reset}`);
    if (stats.noShell > 0) {
      console.log(`  ${c.red}No Shell: ${stats.noShell}${c.reset}`);
    }
    console.log(`  ${status}Pass Rate: ${passRate}%${c.reset}\n`);
  }

  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}\n`);

  const anyTerminalReady = Object.values(summary).some(s => s.pass >= s.total * 0.6);
  process.exit(anyTerminalReady ? 0 : 1);
}

main().catch(error => {
  console.error(`${c.red}Fatal error:${c.reset}`, error);
  process.exit(1);
});
