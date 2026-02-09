// Level 10: Hypercompact tests
// Verify token-efficient DOM navigation for LLM agents
// "One DSL, Many Contexts"

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

// Sample HTML for testing
const TEST_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <header>
    <nav>
      <a href="/">Home</a>
      <a href="/products">Products</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main>
    <h1>Welcome</h1>
    <article class="product" data-sku="ABC123">
      <h3>Widget Pro</h3>
      <span class="price">$29.99</span>
      <p class="description">A fantastic widget for all your needs.</p>
      <button>Add to Cart</button>
    </article>
    <article class="product" data-sku="XYZ789">
      <h3>Gadget Plus</h3>
      <span class="price">$49.99</span>
      <p class="description">The ultimate gadget experience.</p>
      <button>Add to Cart</button>
    </article>
    <article class="product" data-sku="DEF456">
      <h3>Gizmo Ultra</h3>
      <span class="price">$19.99</span>
      <p class="description">Compact and powerful gizmo.</p>
      <button>Add to Cart</button>
    </article>
  </main>
  <footer>
    <p>Copyright 2024</p>
  </footer>
</body>
</html>`;

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 10: Hypercompact (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  // Setup: Create test HTML file
  const testFile = '/tmp/hc-test-page.html';
  try {
    await os.writeFile(testFile, TEST_HTML);
  } catch (e) {
    results.fail('setup: create test file', e);
    results.summary();
    return results;
  }

  // Test: hc help (no args)
  try {
    const r = await os.exec('hc');
    assertIncludes(r.stdout, 'Hypercompact', 'help should mention Hypercompact');
    assertIncludes(r.stdout, 'open', 'help should mention open command');
    results.pass('hc help');
  } catch (e) {
    results.fail('hc help', e);
  }

  // Test: hc open (load HTML file)
  try {
    const r = await os.exec(`hc open ${testFile}`);
    assertIncludes(r.stdout, '✓', 'open should succeed');
    assertIncludes(r.stdout, 'opened', 'should say opened');
    results.pass('hc open');
  } catch (e) {
    results.fail('hc open', e);
  }

  // Test: hc s (status)
  try {
    const r = await os.exec('hc s');
    assertIncludes(r.stdout, 'p:', 'status should show page');
    assertIncludes(r.stdout, 'c:', 'status should show count');
    assertIncludes(r.stdout, 'd:', 'status should show depth');
    assertIncludes(r.stdout, '@', 'status should show current element');
    results.pass('hc s (status)');
  } catch (e) {
    results.fail('hc s (status)', e);
  }

  // Test: hc t (full text)
  try {
    const r = await os.exec('hc t');
    assertIncludes(r.stdout, 'Welcome', 'text should include h1');
    assertIncludes(r.stdout, 'Widget Pro', 'text should include product name');
    results.pass('hc t (full text)');
  } catch (e) {
    results.fail('hc t (full text)', e);
  }

  // Test: hc t100 (limited text)
  try {
    const r = await os.exec('hc t100');
    assert(r.stdout.length <= 150, 't100 should limit output length');
    results.pass('hc t100 (limited text)');
  } catch (e) {
    results.fail('hc t100 (limited text)', e);
  }

  // Test: hc q .price (query multiple)
  try {
    const r = await os.exec('hc q .price');
    assertIncludes(r.stdout, '[0]', 'query should show indexed results');
    assertIncludes(r.stdout, '$29.99', 'should find first price');
    assertIncludes(r.stdout, '$49.99', 'should find second price');
    assertIncludes(r.stdout, '$19.99', 'should find third price');
    results.pass('hc q .price (query multiple)');
  } catch (e) {
    results.fail('hc q .price (query multiple)', e);
  }

  // Test: hc q1 h1 (query single)
  try {
    const r = await os.exec('hc q1 h1');
    assertIncludes(r.stdout, 'Welcome', 'q1 should return element text');
    results.pass('hc q1 h1 (query single)');
  } catch (e) {
    results.fail('hc q1 h1 (query single)', e);
  }

  // Test: hc q article.product (query with compound selector)
  try {
    const r = await os.exec('hc q article.product');
    assertIncludes(r.stdout, '[0]', 'should have first result');
    assertIncludes(r.stdout, '[1]', 'should have second result');
    assertIncludes(r.stdout, '[2]', 'should have third result');
    assertIncludes(r.stdout, 'Widget Pro', 'first product name');
    results.pass('hc q article.product');
  } catch (e) {
    results.fail('hc q article.product', e);
  }

  // Test: hc n0 (select from results)
  try {
    await os.exec('hc q .price');  // Re-query to set results
    const r = await os.exec('hc n0');
    assertIncludes(r.stdout, '✓', 'select should succeed');
    assertIncludes(r.stdout, '[0]', 'should show index');
    assertIncludes(r.stdout, '$29.99', 'should show selected element');
    results.pass('hc n0 (select from results)');
  } catch (e) {
    results.fail('hc n0 (select from results)', e);
  }

  // Test: hc a (attributes of current)
  try {
    await os.exec('hc q1 article.product');  // Select first product
    const r = await os.exec('hc a');
    assertIncludes(r.stdout, 'class=', 'should show class attribute');
    assertIncludes(r.stdout, 'data-sku=', 'should show data attribute');
    assertIncludes(r.stdout, 'ABC123', 'should show SKU value');
    results.pass('hc a (attributes)');
  } catch (e) {
    results.fail('hc a (attributes)', e);
  }

  // Test: hc up (go to parent)
  try {
    await os.exec('hc q1 h3');  // Select an h3
    const r = await os.exec('hc up');
    assertIncludes(r.stdout, '✓', 'up should succeed');
    assertIncludes(r.stdout, '@', 'should show new element');
    results.pass('hc up (parent)');
  } catch (e) {
    results.fail('hc up (parent)', e);
  }

  // Test: hc ch (children)
  try {
    await os.exec('hc q1 article.product');  // Select first product
    const r = await os.exec('hc ch');
    assertIncludes(r.stdout, '[0]', 'should show first child');
    assertIncludes(r.stdout, '<h3>', 'should show h3 tag');
    results.pass('hc ch (children)');
  } catch (e) {
    results.fail('hc ch (children)', e);
  }

  // Test: hc g (grep text)
  try {
    await os.exec('hc q1 body');  // Reset to body
    const r = await os.exec('hc g price');
    // grep searches text content for pattern
    assert(r.stdout.includes('L') || r.stdout.includes('∅'), 'grep should show line numbers or empty');
    results.pass('hc g (grep)');
  } catch (e) {
    results.fail('hc g (grep)', e);
  }

  // Test: hc look (interactive elements)
  try {
    await os.exec('hc q1 body');
    const r = await os.exec('hc look');
    assertIncludes(r.stdout, '@', 'look should show indexed interactive elements');
    assertIncludes(r.stdout, '<a>', 'should find links');
    assertIncludes(r.stdout, '<button>', 'should find buttons');
    results.pass('hc look (interactive elements)');
  } catch (e) {
    results.fail('hc look (interactive elements)', e);
  }

  // Test: hc @0 (click)
  try {
    await os.exec('hc q1 main');  // Go to main
    await os.exec('hc look');     // Index interactive elements
    const r = await os.exec('hc @0');
    assertIncludes(r.stdout, '✓', 'click should succeed');
    assertIncludes(r.stdout, 'clicked', 'should say clicked');
    results.pass('hc @0 (click)');
  } catch (e) {
    results.fail('hc @0 (click)', e);
  }

  // Test: hc h (HTML)
  try {
    await os.exec('hc q1 .price');
    const r = await os.exec('hc h');
    assertIncludes(r.stdout, '<span', 'should show opening tag');
    assertIncludes(r.stdout, 'class=', 'should show attributes in HTML');
    assertIncludes(r.stdout, '$29.99', 'should show content');
    results.pass('hc h (HTML)');
  } catch (e) {
    results.fail('hc h (HTML)', e);
  }

  // Test: hc h50 (limited HTML)
  try {
    await os.exec('hc q1 article.product');
    const r = await os.exec('hc h50');
    assert(r.stdout.length <= 100, 'h50 should limit output');
    assertIncludes(r.stdout, 'truncated', 'should indicate truncation');
    results.pass('hc h50 (limited HTML)');
  } catch (e) {
    results.fail('hc h50 (limited HTML)', e);
  }

  // Test: hc >$var (store)
  try {
    await os.exec('hc q1 .description');
    // Use single quotes to prevent shell from interpreting > and $
    const r = await os.exec("hc '>$desc'");
    assertIncludes(r.stdout, '✓', 'store should succeed');
    assertIncludes(r.stdout, '$desc', 'should show variable name');
    assertIncludes(r.stdout, 'chars', 'should show character count');
    results.pass('hc >$var (store)');
  } catch (e) {
    results.fail('hc >$var (store)', e);
  }

  // Test: hc $var (recall)
  try {
    // Use single quotes to prevent shell from interpreting $
    const r = await os.exec("hc '$desc'");
    assertIncludes(r.stdout, 'fantastic widget', 'should recall stored content');
    results.pass('hc $var (recall)');
  } catch (e) {
    results.fail('hc $var (recall)', e);
  }

  // Test: hc q with empty results
  try {
    const r = await os.exec('hc q .nonexistent');
    assertIncludes(r.stdout, '∅', 'empty query should return ∅');
    results.pass('hc q (empty results)');
  } catch (e) {
    results.fail('hc q (empty results)', e);
  }

  // Test: hc n with out of range index
  try {
    await os.exec('hc q .price');  // 3 results
    const r = await os.exec('hc n99');
    assertIncludes(r.stdout, '✗', 'out of range should fail');
    assertIncludes(r.stdout, 'range', 'should mention range');
    results.pass('hc n (out of range)');
  } catch (e) {
    results.fail('hc n (out of range)', e);
  }

  // Test: hc close
  try {
    const r = await os.exec('hc close');
    assertIncludes(r.stdout, '✓', 'close should succeed');
    results.pass('hc close');
  } catch (e) {
    results.fail('hc close', e);
  }

  // Test: hc command without session
  try {
    const r = await os.exec('hc s');
    assertIncludes(r.stderr || r.stdout, 'no session', 'should require session');
    results.pass('hc (no session error)');
  } catch (e) {
    results.fail('hc (no session error)', e);
  }

  // Test: Workflow - Find product prices (real-world example)
  try {
    await os.exec(`hc open ${testFile}`);
    const prices = await os.exec('hc q .price');
    assertIncludes(prices.stdout, '$29.99', 'workflow: find prices');

    await os.exec('hc n1');  // Select second price
    const attrs = await os.exec('hc a');
    assertIncludes(attrs.stdout, 'class=price', 'workflow: check attributes');

    await os.exec('hc up');  // Go to parent article
    const sku = await os.exec('hc a');
    assertIncludes(sku.stdout, 'data-sku=XYZ789', 'workflow: get SKU');

    results.pass('workflow: find product info');
  } catch (e) {
    results.fail('workflow: find product info', e);
  }

  // Test: Workflow - Navigate and click (real-world example)
  try {
    await os.exec(`hc open ${testFile}`);
    await os.exec('hc q1 nav');
    const nav = await os.exec('hc look');
    assertIncludes(nav.stdout, 'Home', 'workflow: find nav links');
    assertIncludes(nav.stdout, 'Products', 'workflow: find products link');

    await os.exec('hc @1');  // Click second link (Products)
    results.pass('workflow: navigate and click');
  } catch (e) {
    results.fail('workflow: navigate and click', e);
  }

  // Cleanup
  try {
    await os.exec('hc close');
    await os.unlink(testFile);
  } catch {
    // Ignore cleanup errors
  }

  results.summary();
  return results;
}
