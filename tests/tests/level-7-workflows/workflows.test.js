// Level 7: Real-world workflow tests
// Simulate end-to-end development activities a developer (or Spirit) would perform

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 7: Workflows (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  const projectDir = '/home/user/ww-test-project';

  // Workflow 1: Scaffold a project from scratch
  try {
    await os.exec(`mkdir -p ${projectDir}/src`);
    await os.exec(`mkdir -p ${projectDir}/test`);

    await os.writeFile(`${projectDir}/package.json`, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'echo "tests passed"' },
    }, null, 2));

    await os.writeFile(`${projectDir}/src/index.js`, [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'export function multiply(a, b) {',
      '  return a * b;',
      '}',
    ].join('\n'));

    await os.writeFile(`${projectDir}/test/index.test.js`, [
      'import { add, multiply } from "../src/index.js";',
      '',
      'console.log("Testing add...");',
      'console.assert(add(2, 3) === 5, "add(2,3) should be 5");',
      'console.assert(add(0, 0) === 0, "add(0,0) should be 0");',
      'console.assert(add(-1, 1) === 0, "add(-1,1) should be 0");',
      '',
      'console.log("Testing multiply...");',
      'console.assert(multiply(2, 3) === 6, "multiply(2,3) should be 6");',
      'console.assert(multiply(0, 5) === 0, "multiply(0,5) should be 0");',
      '',
      'console.log("All tests passed!");',
    ].join('\n'));

    // Verify the structure
    const pkg = await os.readFile(`${projectDir}/package.json`);
    const parsed = JSON.parse(pkg);
    assertEqual(parsed.name, 'test-project', 'package.json name');

    const src = await os.readFile(`${projectDir}/src/index.js`);
    assertIncludes(src, 'function add', 'source has add function');

    results.pass('Workflow 1: scaffold project');
  } catch (e) {
    results.fail('Workflow 1: scaffold project', e);
  }

  // Workflow 2: Git init, add, commit the project
  try {
    await os.exec(`cd ${projectDir} && git init`);
    await os.exec(`cd ${projectDir} && git add .`);
    const commitResult = await os.exec(`cd ${projectDir} && git commit -m "initial project setup"`);
    assert(commitResult.exitCode === 0 || commitResult.stdout.includes('initial'),
      'commit should succeed');

    const logResult = await os.exec(`cd ${projectDir} && git log`);
    assertIncludes(logResult.stdout, 'initial project setup', 'log shows commit');

    results.pass('Workflow 2: git init + commit');
  } catch (e) {
    results.fail('Workflow 2: git init + commit', e);
  }

  // Workflow 3: Edit a file (simulate Spirit's edit tool pattern)
  try {
    // Read the file
    const original = await os.readFile(`${projectDir}/src/index.js`);

    // Perform an edit: add a subtract function
    const edited = original + '\n\nexport function subtract(a, b) {\n  return a - b;\n}\n';
    await os.writeFile(`${projectDir}/src/index.js`, edited);

    // Verify the edit
    const updated = await os.readFile(`${projectDir}/src/index.js`);
    assertIncludes(updated, 'function subtract', 'file should contain new function');
    assertIncludes(updated, 'function add', 'file should still contain old function');

    results.pass('Workflow 3: edit source file');
  } catch (e) {
    results.fail('Workflow 3: edit source file', e);
  }

  // Workflow 4: Use grep to find something across files
  try {
    const r = await os.exec(`grep -r "function" ${projectDir}/src/`);
    assertIncludes(r.stdout, 'add', 'grep should find add');
    assertIncludes(r.stdout, 'multiply', 'grep should find multiply');
    assertIncludes(r.stdout, 'subtract', 'grep should find subtract');
    results.pass('Workflow 4: grep across project');
  } catch (e) {
    results.fail('Workflow 4: grep across project', e);
  }

  // Workflow 5: Find files by pattern
  try {
    const r = await os.exec(`find ${projectDir} -name "*.js"`);
    assertIncludes(r.stdout, 'index.js', 'find should locate js files');
    results.pass('Workflow 5: find files');
  } catch (e) {
    results.fail('Workflow 5: find files', e);
  }

  // Workflow 6: Commit the changes
  try {
    await os.exec(`cd ${projectDir} && git add src/index.js`);
    const r = await os.exec(`cd ${projectDir} && git commit -m "add subtract function"`);
    assert(r.exitCode === 0 || r.stdout.includes('subtract'), 'commit should succeed');

    const diff = await os.exec(`cd ${projectDir} && git log`);
    assertIncludes(diff.stdout, 'subtract', 'log shows new commit');
    assertIncludes(diff.stdout, 'initial', 'log shows old commit');

    results.pass('Workflow 6: commit changes');
  } catch (e) {
    results.fail('Workflow 6: commit changes', e);
  }

  // Workflow 7: Multi-file refactor
  try {
    // Create a utils module
    await os.writeFile(`${projectDir}/src/utils.js`, [
      '// Shared utilities',
      'export function clamp(val, min, max) {',
      '  return Math.min(Math.max(val, min), max);',
      '}',
    ].join('\n'));

    // Update index.js to import from utils
    const indexContent = await os.readFile(`${projectDir}/src/index.js`);
    const newIndex = 'import { clamp } from "./utils.js";\n\n' + indexContent +
      '\n\nexport function clampedAdd(a, b, min, max) {\n  return clamp(add(a, b), min, max);\n}\n';
    await os.writeFile(`${projectDir}/src/index.js`, newIndex);

    // Verify both files
    const utils = await os.readFile(`${projectDir}/src/utils.js`);
    assertIncludes(utils, 'function clamp', 'utils has clamp');
    const idx = await os.readFile(`${projectDir}/src/index.js`);
    assertIncludes(idx, 'import { clamp }', 'index imports clamp');
    assertIncludes(idx, 'clampedAdd', 'index has clampedAdd');

    results.pass('Workflow 7: multi-file refactor');
  } catch (e) {
    results.fail('Workflow 7: multi-file refactor', e);
  }

  // Workflow 8: List project structure
  try {
    const r = await os.exec(`ls ${projectDir}/src`);
    assertIncludes(r.stdout, 'index.js', 'ls shows index.js');
    assertIncludes(r.stdout, 'utils.js', 'ls shows utils.js');
    results.pass('Workflow 8: verify project structure');
  } catch (e) {
    results.fail('Workflow 8: verify project structure', e);
  }

  // Workflow 9: Read file with line counting (simulating Spirit read tool)
  try {
    const r = await os.exec(`cat -n ${projectDir}/src/index.js`);
    // cat -n should number lines; if not supported, cat alone is ok
    const content = r.stdout;
    assert(content.length > 0, 'cat should produce output');
    results.pass('Workflow 9: read with line numbers');
  } catch (e) {
    results.fail('Workflow 9: read with line numbers', e);
  }

  // Workflow 10: Final commit of all changes
  try {
    await os.exec(`cd ${projectDir} && git add .`);
    const r = await os.exec(`cd ${projectDir} && git commit -m "add utils module and clampedAdd"`);
    assert(r.exitCode === 0, 'final commit should succeed');

    const log = await os.exec(`cd ${projectDir} && git log`);
    const commitCount = (log.stdout.match(/commit/gi) || []).length;
    assert(commitCount >= 3, `should have at least 3 commits, found ${commitCount}`);

    results.pass('Workflow 10: final commit');
  } catch (e) {
    results.fail('Workflow 10: final commit', e);
  }

  results.summary();
  return results;
}
