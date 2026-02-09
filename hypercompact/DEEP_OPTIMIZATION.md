# Deep Optimization: Escaping the Overhead

## The Architectural Constraint

Claude Code's execution model is turn-based:

```
User Input → Claude Generates → Tool Call → Tool Executes → Claude Continues
                                    ↑              ↑
                               PreToolUse    PostToolUse
```

**There is no mid-generation injection point.** Hooks fire at discrete moments, not during token streaming.

The dream of `(nav:document.title;)` triggering inline execution is **impossible** with current architecture.

## Strategy 1: Batch Amortization

The single biggest win. Send multiple commands in one tool call:

```javascript
// MCP Tool: "hc"
// Input: { "c": "t;z.apple;click 1;$_" }

// Server parses and executes sequentially:
const commands = input.c.split(';');
const results = [];
for (const cmd of commands) {
  results.push(await execute(cmd));
}
return results.join('\n---\n');
```

### Token Math

| Batch Size | Fixed Overhead | Content | Per-Command |
|------------|---------------|---------|-------------|
| 1 | 90 | N | 90 + N |
| 5 | 90 | 5N | 18 + N |
| 10 | 90 | 10N | **9 + N** |
| 20 | 90 | 20N | **4.5 + N** |

With 10-command batches, we approach **<10 tokens overhead per command**.

### Batch Syntax

```
hc> t; z.apple; click 1
["text content here...", "5(apple) $3.99 [Add]", "clicked"]

hc> t | z.apple | click 1
Same, pipe syntax

hc> {t; z.apple; click 1}
Explicit batch grouping
```

## Strategy 2: Server-Side State (Blind Operations)

The MCP server maintains session state. Claude doesn't see intermediate values.

```
hc> silent t >$page
ok (0 tokens of content)

hc> $page.length
48293 (Claude sees only the count)

hc> $page |grep -o 'price="[^"]*"' |head 5
price="$5.99"
price="$12.99"
price="$3.49"
(Claude sees only grep output)
```

### Implementation

```javascript
class HypercompactSession {
  variables = new Map();
  lastResult = null;

  execute(cmd) {
    if (cmd.startsWith('silent ')) {
      const actualCmd = cmd.slice(7);
      const [op, varName] = this.parseRedirect(actualCmd);
      this.lastResult = this.run(op);
      if (varName) this.variables.set(varName, this.lastResult);
      return 'ok';  // Claude sees only this
    }
    // ...
  }
}
```

### Variable Operations

| Syntax | Meaning |
|--------|---------|
| `>$x` | Store last result in $x |
| `$x` | Retrieve $x (Claude now sees it) |
| `$x.length` | Property access |
| `$x.slice(0,100)` | JS expression |
| `$_` | Last result (implicit variable) |
| `silent cmd` | Execute, suppress output |

## Strategy 3: Piping and Filtering

All filtering happens **before** constructing MCP response.

### JavaScript-Side Filtering

```
hc> t |jsgrep price
Filters in browser JS, only matching text crosses WebSocket

hc> q .product |map .textContent |filter /\$\d+/
Query → Map → Filter all in browser
```

### Server-Side Filtering

```
hc> h |servergrep 'class="price"'
Full HTML sent to server, grep there, only matches returned to Claude
```

### File Sink (Zero Token)

```
hc> h |> /tmp/page.html
Full HTML written to file, Claude sees: "saved 48293 bytes"

hc> t |> /tmp/text.txt; wc -w /tmp/text.txt
"saved; 1847 words"
```

## Strategy 4: Connection Persistence

WebSocket stays open across commands:

```
┌─────────────────────────────────────────────────────┐
│ MCP Server                                          │
│  ┌─────────────────────────────────────────────┐   │
│  │ Session Pool                                 │   │
│  │  session_abc → WebSocket → Browser Tab 1    │   │
│  │  session_def → WebSocket → Browser Tab 2    │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

First command: establish connection (~50ms)
Subsequent: reuse (~5ms)

```
hc> open https://amazon.com
session: abc123

hc> t
(uses existing session_abc123 WebSocket)

hc> close
(tears down WebSocket)
```

## Strategy 5: Compression Codecs

When Claude must see HTML, compress it.

### LZ-String (Reversible)

```
hc> h |lz
"N4IgDgTgpgwg..." (base64 LZ-compressed)

hc> unlz "N4IgDgTgpgwg..."
<html>...</html>
```

~40% token reduction for HTML.

### Vocabulary Learning

For repeated elements:

```javascript
const vocab = {
  'div class="product-card"': 'P',
  'span class="price"': '$',
  'button class="add-to-cart"': 'B',
};
// <div class="product-card"><span class="price">$5</span></div>
// becomes: P$5$/P
```

~60% reduction on structured pages.

### Structural Shorthand

```
hc> h |struct
P{$5.99 B"Add"}
P{$12.99 B"Add"}
P{$3.49 B"Add"}

// Instead of:
<div class="product-card"><span class="price">$5.99</span><button>Add</button></div>
...
```

## Strategy 6: Speculative Execution

Predict what Claude will ask next:

```
hc> t
"apple banana carrot..."
_prefetch: {
  "z.apple": "3(apple) $5 [Add]",
  "z.banana": "3(banana) $3 [Add]",
  "z.carrot": "3(carrot) $2 [Add]"
}
```

On `z.apple`, return from cache. **Zero network latency.**

### Implementation

```javascript
execute(cmd) {
  if (cmd === 't') {
    const text = this.getText();
    const words = this.extractKeywords(text);

    // Prefetch zoom for top 5 words
    this.prefetchCache = {};
    for (const word of words.slice(0, 5)) {
      this.prefetchCache[`z.${word}`] = this.zoom(word);
    }

    return text;
  }

  if (this.prefetchCache[cmd]) {
    return this.prefetchCache[cmd];  // Instant
  }
}
```

## The Numbers

### Scenario: Navigate to product, get price, add to cart

**Traditional MCP (3 tools):**
```
fetch_page: 45 + 15000 = 15045 tokens
search:     45 + 200   = 245 tokens
click:      45 + 50    = 95 tokens
TOTAL: 15,385 tokens
```

**Hypercompact (1 batched call):**
```
"t; z.Wireless Mouse; click 0":
  overhead: 90 tokens
  t response: 100 tokens (filtered)
  z response: 30 tokens
  click response: 10 tokens
TOTAL: 230 tokens
```

**Reduction: 98.5%**

### Scenario: Scrape 50 products

**Traditional:**
```
fetch_page: 15000 tokens
50x extract: 50 * 95 = 4750 tokens
TOTAL: 19,750 tokens
```

**Hypercompact (batched + blind):**
```
"t; silent q .product >$p; $p |map .price |join ','"
  overhead: 90 tokens
  t: 100 tokens
  ok: 2 tokens
  prices: 150 tokens (just the prices)
TOTAL: 342 tokens
```

**Reduction: 98.3%**

## The Dream vs Reality Table

| Approach | Per-Cmd Overhead | Content Efficiency | Total |
|----------|------------------|-------------------|-------|
| Raw MCP | 90 tokens | 0% (sees all) | Baseline |
| Single tool | 90 tokens | 50% (terse responses) | 55% better |
| Batched ×10 | 9 tokens | 50% | 85% better |
| + Blind ops | 9 tokens | 90% (filtered) | 95% better |
| + Compression | 9 tokens | 95% | **98% better** |
| Raw protocol | ~0 tokens | 95% | **99% better** |

The raw protocol dream requires Claude Code architectural changes. Everything else is achievable today.

## Implementation Priority

1. **Batch commands** - Biggest single win
2. **Server-side variables** - Enables blind operations
3. **Pipe filtering** - JS-side and server-side
4. **Connection pooling** - Reduces latency
5. **Compression** - When raw HTML needed
6. **Prefetching** - Nice-to-have optimization

## Future: Protocol Changes

If we could lobby for Claude Code changes:

1. **Raw REPL transport** - Skip JSON-RPC for trusted tools
2. **Streaming tool results** - Incremental responses
3. **Inline execution markers** - `{{hc:t}}` triggers during generation
4. **Persistent tool context** - Tool remembers across calls without MCP state

These would get us from 98% to 99%+ reduction.
