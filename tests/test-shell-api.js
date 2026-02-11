#!/usr/bin/env node

/**
 * Shell API Test - Verify current shell API structure
 * Tests both foam-windwalker and shiro-windwalker
 */

import http from 'http';
import { URL } from 'url';

const SKYEYES_API = 'http://localhost:7777/api/skyeyes';

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
          const parsed = JSON.parse(data);
          resolve(parsed);
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

async function execShellCommand(pageId, command, timeout = 10000) {
  const shell = pageId.includes('shiro') ? '__shiro' : '__foam';
  const resultVar = `shellTest_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const escapedCmd = command
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  // Initiate async exec
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

  // Poll for result
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

  // Cleanup on timeout
  const cleanupCode = `delete window.${resultVar}; return 'ok'`;
  await execAPI(pageId, cleanupCode).catch(() => {});

  return { error: 'Timeout waiting for result' };
}

async function main() {
  console.log('\n=== SHELL API TEST ===\n');

  const pages = ['foam-windwalker', 'shiro-windwalker'];

  for (const page of pages) {
    console.log(`\n--- ${page.toUpperCase()} ---\n`);

    // Check if shell object exists
    const checkShell = pageId => pageId.includes('shiro') ? '__shiro' : '__foam';
    const shellName = checkShell(page);

    const shellCheck = await execAPI(page, `return typeof window.${shellName}`);
    console.log(`  window.${shellName}: ${shellCheck.result || shellCheck.error}`);

    if (shellCheck.result === 'object' || shellCheck.result === '"object"') {
      const propsCheck = await execAPI(page, `return JSON.stringify(Object.keys(window.${shellName}))`);
      console.log(`  Properties: ${propsCheck.result || propsCheck.error}`);

      const shellObjCheck = await execAPI(page, `return typeof window.${shellName}.shell`);
      console.log(`  window.${shellName}.shell: ${shellObjCheck.result || shellObjCheck.error}`);

      if (shellObjCheck.result === 'object' || shellObjCheck.result === '"object"') {
        const methodsCheck = await execAPI(page, `
          return JSON.stringify(
            Object.getOwnPropertyNames(Object.getPrototypeOf(window.${shellName}.shell))
              .filter(p => typeof window.${shellName}.shell[p] === 'function')
          )
        `);
        console.log(`  Shell methods: ${methodsCheck.result || methodsCheck.error}`);

        // Test simple command
        console.log('\n  Testing: echo "hello world"');
        const result = await execShellCommand(page, 'echo "hello world"');

        if (result.error) {
          console.log(`    ✗ Error: ${result.error}`);
        } else if (result.result) {
          console.log(`    ✓ Success`);
          console.log(`    stdout: "${result.result.stdout}"`);
          console.log(`    stderr: "${result.result.stderr}"`);
          console.log(`    exitCode: ${result.result.exitCode}`);
        } else {
          console.log(`    ? Unexpected result:`, result);
        }

        // Test pipe
        console.log('\n  Testing: echo "test" | wc -c');
        const pipeResult = await execShellCommand(page, 'echo "test" | wc -c');

        if (pipeResult.error) {
          console.log(`    ✗ Error: ${pipeResult.error}`);
        } else if (pipeResult.result) {
          console.log(`    ✓ Success`);
          console.log(`    stdout: "${pipeResult.result.stdout}"`);
          console.log(`    exitCode: ${pipeResult.result.exitCode}`);
        }

        // Test file operations
        console.log('\n  Testing: echo "content" > /tmp/test.txt && cat /tmp/test.txt');
        const fileResult = await execShellCommand(page, 'echo "content" > /tmp/test.txt && cat /tmp/test.txt');

        if (fileResult.error) {
          console.log(`    ✗ Error: ${fileResult.error}`);
        } else if (fileResult.result) {
          console.log(`    ✓ Success`);
          console.log(`    stdout: "${fileResult.result.stdout}"`);
          console.log(`    exitCode: ${fileResult.result.exitCode}`);
        }
      }
    } else {
      console.log(`  ✗ Shell object not found on ${page}`);
    }
  }

  console.log('\n');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
