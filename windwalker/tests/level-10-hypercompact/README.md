# Level 10: Hypercompact Tests

Tests for Hypercompact - token-efficient DOM navigation for LLM agents.

## What is Hypercompact?

Hypercompact (HC) is a terse command language for navigating HTML documents. It reduces token usage by **99%** compared to reading raw HTML, making it ideal for LLM agents that need to understand web pages.

**Example:** A 50KB page costs ~12,500 tokens to read. The same information via HC costs ~100 tokens.

## Commands Tested

| Command | Description | Example |
|---------|-------------|---------|
| `hc open <file>` | Load HTML file | `hc open /tmp/page.html` |
| `hc live` | Attach to live DOM | `hc live` |
| `hc close` | Close session | `hc close` |
| `hc s` | Status | `p:page.html c:3 d:2 @div` |
| `hc t` | Full text content | All visible text |
| `hc t100` | Limited text | First 100 chars |
| `hc q <sel>` | Query multiple | `[0]text [1]text` |
| `hc q1 <sel>` | Query single | Returns text, sets current |
| `hc n<N>` | Select from results | `✓ [0] selected text` |
| `hc up` | Go to parent | `✓ @parentTag` |
| `hc ch` | Show children | `[0]<tag>text...` |
| `hc g <pat>` | Grep text | `L23: matching line` |
| `hc look` | Interactive elements | `@0 <a> "Home" →/` |
| `hc @<N>` | Click element | `✓ clicked "Button"` |
| `hc a` | Attributes | `class=foo data-x=bar` |
| `hc h` | HTML | Full outer HTML |
| `hc h50` | Limited HTML | First 50 chars |
| `hc >$name` | Store to variable | `✓ $name (123 chars)` |
| `hc $name` | Recall variable | Stored content |

## Test File Structure

```javascript
// hypercompact.test.js
import { createOSHelpers, TestResults } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults('Level 10: Hypercompact');
  const os = createOSHelpers(page, osTarget);

  // Setup: Create test HTML
  await os.writeFile('/tmp/test.html', TEST_HTML);

  // Test hc open
  const r = await os.exec('hc open /tmp/test.html');
  assertIncludes(r.stdout, '✓', 'should succeed');

  // Test hc q (query)
  const prices = await os.exec('hc q .price');
  assertIncludes(prices.stdout, '$29.99', 'should find prices');

  // ... more tests
}
```

## Real-World Workflows

### Find Product Prices
```bash
hc open page.html
hc q .price           # [0]$29.99 [1]$49.99 [2]$19.99
hc n1                 # ✓ [1] $49.99
hc up                 # ✓ @article
hc a                  # class=product data-sku=XYZ789
```

### Navigate and Click
```bash
hc open page.html
hc q1 nav             # Select navigation
hc look               # @0 <a> "Home" @1 <a> "Products"
hc @1                 # ✓ clicked "Products"
```

### Extract and Store Data
```bash
hc open page.html
hc q1 .description
hc >$desc             # ✓ $desc (456 chars)
hc $desc              # Recall stored content
```

## Running Tests

Tests require browser mode (skyeyes):

```bash
# Test Foam
npm run test:skyeyes:foam

# Test Shiro
npm run test:skyeyes:shiro

# Test both
npm run test:skyeyes
```

## Integration

Hypercompact is available in:
- **Foam shell**: `hc` command
- **Shiro shell**: `hc` command
- **Skyeyes MCP tools**: `hc_open`, `hc_exec`, `hc_live`, `hc_status`
- **Node.js**: `require('hypercompact')`

## See Also

- `/nimbus-land/hypercompact/CLAUDE.md` - Full documentation
- `/nimbus-land/foam/src/commands.js` - Foam implementation
- `/nimbus-land/shiro/src/commands/hc.ts` - Shiro implementation
- `/nimbus-land/nimbus/src/mcp/skyeyes-tools.ts` - MCP tools
