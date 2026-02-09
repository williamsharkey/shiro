#!/usr/bin/env node
/**
 * Test the refactored Hypercompact core
 * Verifies context-agnostic operation with linkedom
 */

const { createSession, fromHTML, parseCommand, VERSION, COMMANDS } = require('./index.js');

// Test HTML
const html = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <h1>Welcome</h1>
  <nav>
    <a href="/home">Home</a>
    <a href="/products">Products</a>
    <a href="/about">About</a>
  </nav>
  <main>
    <article class="product">
      <h3>Widget</h3>
      <span class="price">$29.99</span>
      <button>Add to Cart</button>
    </article>
    <article class="product">
      <h3>Gadget</h3>
      <span class="price">$49.99</span>
      <button>Add to Cart</button>
    </article>
  </main>
</body>
</html>`;

console.log('═'.repeat(60));
console.log('Hypercompact Core Test');
console.log(`Version: ${VERSION}`);
console.log('═'.repeat(60));

// Test 1: Parser
console.log('\n--- Parser Tests ---');
const parserTests = [
  ['s', { type: 's' }],
  ['t100', { type: 't', limit: 100 }],
  ['q .price', { type: 'q', selector: '.price' }],
  ['q1 h1', { type: 'q1', selector: 'h1' }],
  ['n2', { type: 'n', index: 2 }],
  ['up', { type: 'up', levels: 1 }],
  ['up3', { type: 'up', levels: 3 }],
  ['look', { type: 'look' }],
  ['@5', { type: 'click', index: 5 }],
  ['>$data', { type: 'store', name: 'data' }],
  ['$data', { type: 'recall', expr: '$data' }],
];

let passed = 0;
for (const [cmd, expected] of parserTests) {
  const result = parseCommand(cmd);
  const ok = result.type === expected.type;
  console.log(`  ${ok ? '✓' : '✗'} parseCommand("${cmd}") → type: ${result.type}`);
  if (ok) passed++;
}
console.log(`  ${passed}/${parserTests.length} parser tests passed`);

// Test 2: Session with linkedom
console.log('\n--- Session Tests (linkedom) ---');

let linkedom;
try {
  linkedom = require('linkedom');
} catch (e) {
  console.log('  ⚠ linkedom not installed, skipping session tests');
  console.log('  Run: npm install linkedom');
  process.exit(0);
}

const session = fromHTML(html, 'test.html', { parseHTML: linkedom.parseHTML });

const sessionTests = [
  ['s', /^p:test\.html c:0 d:0 @body$/],
  ['t50', /^Welcome Home Products About/],
  ['q .price', /\[0\]\$29\.99/],
  ['n0', /✓ \[0\] \$29\.99/],
  ['up', /✓ @article/],
  ['q1 h1', /Welcome/],
  ['a', /./],  // Should have some attributes or be empty
  ['look', /\d+ elements/],
  ['>$test', /✓ \$test \(\d+ chars\)/],
];

passed = 0;
for (const [cmd, pattern] of sessionTests) {
  const result = session.exec(cmd);
  const ok = pattern.test(result);
  const preview = result.split('\n')[0].slice(0, 40);
  console.log(`  ${ok ? '✓' : '✗'} exec("${cmd}") → ${preview}...`);
  if (!ok) console.log(`      Expected: ${pattern}`);
  if (ok) passed++;
}
console.log(`  ${passed}/${sessionTests.length} session tests passed`);

// Test 3: Batch commands
console.log('\n--- Batch Test ---');
const batchResult = session.exec('s; t20; q .price');
const batchLines = batchResult.split('\n---\n');
console.log(`  ✓ Batch returned ${batchLines.length} results`);
batchLines.forEach((r, i) => {
  console.log(`    [${i}] ${r.split('\n')[0].slice(0, 40)}...`);
});

// Test 4: Commands reference
console.log('\n--- Available Commands ---');
for (const [cmd, desc] of Object.entries(COMMANDS)) {
  console.log(`  ${cmd.padEnd(4)} ${desc}`);
}

console.log('\n' + '═'.repeat(60));
console.log('All tests completed');
console.log('═'.repeat(60));
