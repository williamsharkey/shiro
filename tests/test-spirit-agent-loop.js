#!/usr/bin/env node

/**
 * Spirit AI Agent Loop Simulation Test
 *
 * Tests the CRITICAL PATH for Spirit to function in the browser:
 * Can Spirit execute a complete agent loop with tool calls?
 *
 * Spirit Agent Loop Steps:
 * 1. Read a file (tool: Read)
 * 2. Process/analyze content
 * 3. Write a new file (tool: Write)
 * 4. Run a command (tool: Bash)
 * 5. Check command output
 * 6. Make decision based on output
 * 7. Execute follow-up action
 *
 * This test simulates what Spirit does in a real interaction.
 */

import http from 'http';
import { URL } from 'url';

const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const TIMEOUT = 20000;

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

  // First check if shell exists
  const checkShell = await execAPI(pageId, `return typeof window.${shellName}`);
  if (checkShell.result === 'undefined' || checkShell.result === '"undefined"') {
    return { error: `Shell object window.${shellName} not found`, exitCode: -1 };
  }

  const resultVar = `spiritLoop_${Date.now()}_${Math.random().toString(36).substring(7)}`;

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

  const initResult = await execAPI(pageId, initCode);
  if (initResult.error) {
    return { error: `Init failed: ${JSON.stringify(initResult.error)}`, exitCode: -1 };
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
        return { error: 'Invalid result JSON', exitCode: -1 };
      }
    }
  }

  const cleanupCode = `delete window.${resultVar}; return 'ok'`;
  await execAPI(pageId, cleanupCode).catch(() => {});
  return { error: 'Timeout', exitCode: -1 };
}

async function testAgentLoop(pageId) {
  const terminalName = pageId.toUpperCase();
  console.log(`\n${c.blue}${c.bold}═══════════════════════════════════════════════════════════`);
  console.log(`  SPIRIT AGENT LOOP TEST: ${terminalName}`);
  console.log(`═══════════════════════════════════════════════════════════${c.reset}\n`);

  const results = {
    terminal: terminalName,
    steps: [],
    totalSteps: 0,
    passedSteps: 0,
    failedSteps: 0,
  };

  function recordStep(name, passed, details) {
    results.steps.push({ name, passed, details });
    results.totalSteps++;
    if (passed) {
      results.passedSteps++;
      console.log(`${c.green}✓${c.reset} ${name}`);
      if (details.output) {
        console.log(`  ${c.cyan}Output:${c.reset} ${details.output.substring(0, 100)}${details.output.length > 100 ? '...' : ''}`);
      }
    } else {
      results.failedSteps++;
      console.log(`${c.red}✗${c.reset} ${name}`);
      console.log(`  ${c.yellow}Error:${c.reset} ${details.error}`);
    }
  }

  // STEP 1: Read a file (simulate Spirit's Read tool)
  console.log(`${c.cyan}Step 1: Read File${c.reset} (Spirit Read tool)`);
  const readResult = await execShellCommand(pageId, 'cat /etc/hostname 2>/dev/null || echo "test-system"');

  if (readResult.error || !readResult.result) {
    recordStep('Read file', false, { error: readResult.error || 'No result' });
  } else {
    const content = readResult.result.stdout || '';
    recordStep('Read file', readResult.result.exitCode === 0 && content.length > 0, {
      output: content.trim(),
      exitCode: readResult.result.exitCode
    });
  }

  // STEP 2: Write a new file (simulate Spirit's Write tool)
  console.log(`\n${c.cyan}Step 2: Write File${c.reset} (Spirit Write tool)`);
  const writeCmd = 'echo "# Spirit AI Test File\nThis file was created by Spirit AI agent loop test.\nTimestamp: $(date)" > /tmp/spirit_test.txt';
  const writeResult = await execShellCommand(pageId, writeCmd);

  recordStep('Write file',
    !writeResult.error && writeResult.result && writeResult.result.exitCode === 0,
    {
      error: writeResult.error,
      exitCode: writeResult.result?.exitCode
    }
  );

  // STEP 3: Verify file was written
  console.log(`\n${c.cyan}Step 3: Verify Write${c.reset} (Spirit validation)`);
  const verifyResult = await execShellCommand(pageId, 'cat /tmp/spirit_test.txt');

  if (verifyResult.error || !verifyResult.result) {
    recordStep('Verify file written', false, { error: verifyResult.error || 'No result' });
  } else {
    const fileContent = verifyResult.result.stdout || '';
    const hasContent = fileContent.includes('Spirit AI Test File');
    recordStep('Verify file written', hasContent, {
      output: hasContent ? 'File contains expected content' : `Got: ${fileContent}`,
      exitCode: verifyResult.result.exitCode
    });
  }

  // STEP 4: Run a command and capture output (simulate Spirit's Bash tool)
  console.log(`\n${c.cyan}Step 4: Run Command${c.reset} (Spirit Bash tool)`);
  const cmdResult = await execShellCommand(pageId, 'ls -la /tmp/spirit_test.txt');

  if (cmdResult.error || !cmdResult.result) {
    recordStep('Run command', false, { error: cmdResult.error || 'No result' });
  } else {
    const output = cmdResult.result.stdout || '';
    recordStep('Run command', cmdResult.result.exitCode === 0 && output.includes('spirit_test.txt'), {
      output: output.trim(),
      exitCode: cmdResult.result.exitCode
    });
  }

  // STEP 5: Process output and make decision (simulate Spirit's logic)
  console.log(`\n${c.cyan}Step 5: Process & Decide${c.reset} (Spirit logic)`);
  const checkResult = await execShellCommand(pageId, 'test -f /tmp/spirit_test.txt && echo "exists" || echo "missing"');

  if (checkResult.error || !checkResult.result) {
    recordStep('Process command output', false, { error: checkResult.error || 'No result' });
  } else {
    const output = (checkResult.result.stdout || '').trim();
    recordStep('Process command output', output === 'exists', {
      output: `File ${output}`,
      exitCode: checkResult.result.exitCode
    });
  }

  // STEP 6: Execute follow-up action based on decision (simulate Spirit's next action)
  console.log(`\n${c.cyan}Step 6: Follow-up Action${c.reset} (Spirit next step)`);
  const followUpResult = await execShellCommand(pageId, 'echo "Follow-up: $(wc -l < /tmp/spirit_test.txt) lines in file"');

  if (followUpResult.error || !followUpResult.result) {
    recordStep('Execute follow-up', false, { error: followUpResult.error || 'No result' });
  } else {
    const output = followUpResult.result.stdout || '';
    recordStep('Execute follow-up', followUpResult.result.exitCode === 0 && output.includes('Follow-up'), {
      output: output.trim(),
      exitCode: followUpResult.result.exitCode
    });
  }

  // STEP 7: Edit existing file (simulate Spirit's Edit tool)
  console.log(`\n${c.cyan}Step 7: Edit File${c.reset} (Spirit Edit tool)`);
  const editCmd = 'echo "\\nAdded by Spirit edit" >> /tmp/spirit_test.txt';
  const editResult = await execShellCommand(pageId, editCmd);

  recordStep('Edit file',
    !editResult.error && editResult.result && editResult.result.exitCode === 0,
    {
      error: editResult.error,
      exitCode: editResult.result?.exitCode
    }
  );

  // STEP 8: Verify edit worked
  console.log(`\n${c.cyan}Step 8: Verify Edit${c.reset} (Spirit validation)`);
  const verifyEditResult = await execShellCommand(pageId, 'grep "Added by Spirit" /tmp/spirit_test.txt');

  if (verifyEditResult.error || !verifyEditResult.result) {
    recordStep('Verify edit', false, { error: verifyEditResult.error || 'No result' });
  } else {
    const found = (verifyEditResult.result.stdout || '').includes('Added by Spirit');
    recordStep('Verify edit', found, {
      output: found ? 'Edit verified' : 'Edit not found',
      exitCode: verifyEditResult.result.exitCode
    });
  }

  // STEP 9: Multi-command sequence (simulate complex Spirit workflow)
  console.log(`\n${c.cyan}Step 9: Multi-command Sequence${c.reset} (Spirit workflow)`);
  const multiCmd = 'cd /tmp && ls spirit_test.txt && echo "Found file in $(pwd)"';
  const multiResult = await execShellCommand(pageId, multiCmd);

  if (multiResult.error || !multiResult.result) {
    recordStep('Multi-command sequence', false, { error: multiResult.error || 'No result' });
  } else {
    const output = multiResult.result.stdout || '';
    recordStep('Multi-command sequence',
      multiResult.result.exitCode === 0 && output.includes('Found file'),
      {
        output: output.trim(),
        exitCode: multiResult.result.exitCode
      }
    );
  }

  // STEP 10: Cleanup (simulate Spirit cleanup)
  console.log(`\n${c.cyan}Step 10: Cleanup${c.reset} (Spirit cleanup)`);
  const cleanupResult = await execShellCommand(pageId, 'rm /tmp/spirit_test.txt');

  recordStep('Cleanup',
    !cleanupResult.error && cleanupResult.result && cleanupResult.result.exitCode === 0,
    {
      error: cleanupResult.error,
      exitCode: cleanupResult.result?.exitCode
    }
  );

  return results;
}

async function main() {
  console.log(`\n${c.cyan}${c.bold}╔═══════════════════════════════════════════════════════════╗`);
  console.log('║                                                           ║');
  console.log('║        SPIRIT AI AGENT LOOP SIMULATION TEST               ║');
  console.log('║        Critical Path: Can Spirit Run in Browser?          ║');
  console.log('║                                                           ║');
  console.log(`╚═══════════════════════════════════════════════════════════╝${c.reset}\n`);

  console.log('This test simulates a complete Spirit AI agent loop:');
  console.log('  1. Read file (Read tool)');
  console.log('  2. Write file (Write tool)');
  console.log('  3. Verify write');
  console.log('  4. Run command (Bash tool)');
  console.log('  5. Process output & decide');
  console.log('  6. Execute follow-up');
  console.log('  7. Edit file (Edit tool)');
  console.log('  8. Verify edit');
  console.log('  9. Multi-command workflow');
  console.log('  10. Cleanup\n');

  const pages = [
    { id: 'foam-windwalker', name: 'FOAM' },
    { id: 'shiro-windwalker', name: 'SHIRO' },
  ];

  const allResults = [];

  for (const page of pages) {
    const results = await testAgentLoop(page.id);
    allResults.push(results);
  }

  // Summary
  console.log(`\n${c.blue}${c.bold}═══════════════════════════════════════════════════════════`);
  console.log('  SUMMARY: SPIRIT AGENT LOOP CAPABILITY');
  console.log(`═══════════════════════════════════════════════════════════${c.reset}\n`);

  for (const results of allResults) {
    const passRate = ((results.passedSteps / results.totalSteps) * 100).toFixed(1);
    const status = results.passedSteps === results.totalSteps ? c.green :
                   results.passedSteps === 0 ? c.red : c.yellow;

    console.log(`${c.bold}${results.terminal}:${c.reset}`);
    console.log(`  Steps: ${results.totalSteps}`);
    console.log(`  ${c.green}Passed: ${results.passedSteps}${c.reset}`);
    console.log(`  ${results.failedSteps > 0 ? c.red : c.reset}Failed: ${results.failedSteps}${c.reset}`);
    console.log(`  ${status}Pass Rate: ${passRate}%${c.reset}`);

    if (results.failedSteps > 0) {
      console.log(`\n  ${c.yellow}Failed Steps:${c.reset}`);
      for (const step of results.steps) {
        if (!step.passed) {
          console.log(`    ${c.red}✗${c.reset} ${step.name}: ${step.details.error}`);
        }
      }
    }
    console.log('');
  }

  // Critical assessment
  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}`);
  console.log(`${c.bold}CRITICAL ASSESSMENT: CAN SPIRIT RUN IN BROWSER?${c.reset}\n`);

  const foamResults = allResults.find(r => r.terminal.includes('FOAM'));
  const shiroResults = allResults.find(r => r.terminal.includes('SHIRO'));

  const foamWorks = foamResults && foamResults.passedSteps >= 7; // At least 70% working
  const shiroWorks = shiroResults && shiroResults.passedSteps >= 7;

  if (foamWorks && shiroWorks) {
    console.log(`${c.green}${c.bold}✓ YES${c.reset} - Both terminals can run Spirit agent loops`);
    console.log(`${c.green}Spirit can execute complete development workflows in browser${c.reset}\n`);
  } else if (foamWorks || shiroWorks) {
    const working = foamWorks ? 'FOAM' : 'SHIRO';
    const broken = foamWorks ? 'SHIRO' : 'FOAM';
    console.log(`${c.yellow}${c.bold}⚠ PARTIAL${c.reset} - Only ${working} terminal works`);
    console.log(`${c.yellow}${broken} terminal cannot run Spirit agent loops${c.reset}`);
    console.log(`${c.yellow}Spirit can work but only in ${working} terminal${c.reset}\n`);
  } else {
    console.log(`${c.red}${c.bold}✗ NO${c.reset} - Neither terminal can run Spirit agent loops`);
    console.log(`${c.red}Spirit CANNOT run in browser with current implementation${c.reset}\n`);
  }

  console.log(`${c.blue}${'═'.repeat(60)}${c.reset}\n`);

  // Exit code based on whether ANY terminal can run Spirit
  const canRunSpirit = foamWorks || shiroWorks;
  process.exit(canRunSpirit ? 0 : 1);
}

main().catch(error => {
  console.error(`${c.red}${c.bold}Fatal error:${c.reset}`, error);
  process.exit(1);
});
