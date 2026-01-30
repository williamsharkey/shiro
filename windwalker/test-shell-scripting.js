#!/usr/bin/env node

/**
 * Shell Scripting Features Test
 * Tests if/then, for loops, source command, and other shell scripting features
 */

import http from 'http';
import { URL } from 'url';

const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const TIMEOUT = 20000;

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
  const shell = '__foam';  // Only foam works
  const resultVar = `shellTest_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const escapedCmd = command
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  const initCode = `
    window.${shell}.shell.exec(\`${escapedCmd}\`)
      .then(result => window.${resultVar} = { done: true, result })
      .catch(error => window.${resultVar} = { done: true, error: String(error) });
    return 'initiated';
  `;

  const initResult = await execAPI(pageId, initCode);
  if (initResult.error) {
    return { error: `Init failed: ${JSON.stringify(initResult.error)}` };
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, 500));

    const checkCode = `return window.${resultVar} ? JSON.stringify(window.${resultVar}) : null`;
    const checkResult = await execAPI(pageId, checkCode);

    if (checkResult.result && checkResult.result !== 'null') {
      const cleanupCode = `delete window.${resultVar}; return 'ok'`;
      await execAPI(pageId, cleanupCode).catch(() => {});

      try {
        const parsed = JSON.parse(checkResult.result);
        if (parsed.done) {
          return parsed;
        }
      } catch (e) {
        return { error: 'Invalid result JSON' };
      }
    }
  }

  const cleanupCode = `delete window.${resultVar}; return 'ok'`;
  await execAPI(pageId, cleanupCode).catch(() => {});
  return { error: 'Timeout' };
}

function check(result, expectedPattern) {
  if (result.error) {
    return { pass: false, reason: result.error };
  }
  if (!result.result) {
    return { pass: false, reason: 'No result' };
  }

  const pattern = expectedPattern instanceof RegExp ? expectedPattern : new RegExp(expectedPattern);
  const output = String(result.result.stdout || '');
  const pass = result.result.exitCode === 0 && pattern.test(output);

  return {
    pass,
    reason: pass ? 'OK' : `exitCode=${result.result.exitCode}, stdout="${output}", pattern=${expectedPattern}`,
    stdout: output,
    stderr: result.result.stderr,
    exitCode: result.result.exitCode
  };
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║     SHELL SCRIPTING FEATURES TEST (foam-windwalker)       ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const page = 'foam-windwalker';
  let passed = 0;
  let failed = 0;

  const tests = [
    {
      category: 'Basic Shell Features',
      tests: [
        { name: 'Simple echo', cmd: 'echo "test"', expect: /test/ },
        { name: 'Command substitution', cmd: 'echo "Result: $(echo nested)"', expect: /Result: nested/ },
        { name: 'Variable expansion', cmd: 'VAR=hello; echo $VAR', expect: /hello/ },
        { name: 'Pipe chain', cmd: 'echo "line1\\nline2" | wc -l', expect: /2/ },
        { name: 'Redirect output', cmd: 'echo "redir" > /tmp/redir.txt; cat /tmp/redir.txt', expect: /redir/ },
      ]
    },
    {
      category: 'Conditional Statements (if/then)',
      tests: [
        { name: 'if true', cmd: 'if true; then echo "yes"; fi', expect: /yes/ },
        { name: 'if false with else', cmd: 'if false; then echo "no"; else echo "yes"; fi', expect: /yes/ },
        { name: 'if with test -f', cmd: 'echo "x" > /tmp/iftest.txt; if test -f /tmp/iftest.txt; then echo "found"; fi', expect: /found/ },
        { name: 'if with [ ]', cmd: 'if [ "a" = "a" ]; then echo "equal"; fi', expect: /equal/ },
        { name: 'if/elif/else', cmd: 'X=2; if [ "$X" = "1" ]; then echo "one"; elif [ "$X" = "2" ]; then echo "two"; else echo "other"; fi', expect: /two/ },
      ]
    },
    {
      category: 'Loops',
      tests: [
        { name: 'for loop with list', cmd: 'for i in 1 2 3; do echo $i; done', expect: /1.*2.*3/s },
        { name: 'for loop with range', cmd: 'for i in a b c; do echo "item:$i"; done', expect: /item:a.*item:b.*item:c/s },
        { name: 'while loop', cmd: 'X=0; while [ $X -lt 3 ]; do echo $X; X=$((X+1)); done', expect: /0.*1.*2/s },
      ]
    },
    {
      category: 'Shell Script Files (source command)',
      tests: [
        { name: 'Create script file', cmd: 'echo "echo sourced" > /tmp/test.sh', expect: /^$/ },
        { name: 'Source script', cmd: 'echo "echo sourced" > /tmp/source.sh; . /tmp/source.sh', expect: /sourced/ },
        { name: 'Source with variables', cmd: 'echo "MYVAR=value123" > /tmp/vars.sh; . /tmp/vars.sh; echo $MYVAR', expect: /value123/ },
      ]
    },
    {
      category: 'Functions',
      tests: [
        { name: 'Define and call function', cmd: 'myfunc() { echo "in function"; }; myfunc', expect: /in function/ },
        { name: 'Function with arguments', cmd: 'greet() { echo "Hello $1"; }; greet World', expect: /Hello World/ },
        { name: 'Function with return', cmd: 'check() { return 42; }; check; echo $?', expect: /42/ },
      ]
    },
    {
      category: 'Advanced Features',
      tests: [
        { name: 'Arithmetic expansion', cmd: 'echo $((5 + 3))', expect: /8/ },
        { name: 'Exit code capture', cmd: 'true; echo $?', expect: /0/ },
        { name: 'Logic operators &&', cmd: 'true && echo "ok"', expect: /ok/ },
        { name: 'Logic operators ||', cmd: 'false || echo "ok"', expect: /ok/ },
        { name: 'Subshell', cmd: '(cd /tmp; pwd)', expect: /tmp/ },
      ]
    },
  ];

  for (const category of tests) {
    console.log(`\n${category.category}:`);

    for (const test of category.tests) {
      const result = await execShellCommand(page, test.cmd);
      const checkResult = check(result, test.expect);

      if (checkResult.pass) {
        console.log(`  ✓ ${test.name}`);
        passed++;
      } else {
        console.log(`  ✗ ${test.name}`);
        console.log(`    Reason: ${checkResult.reason}`);
        failed++;
      }
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Pass Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  console.log('═'.repeat(60) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
