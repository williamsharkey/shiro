# Hypercompact: Token-Efficient Web Navigation

You have access to `hc`, a REPL for navigating web pages with minimal tokens.

**Why this matters**: Reading a 50KB page costs ~12,500 tokens. The same information via `hc` costs ~100 tokens. That's **99% savings**.

## Quick Start

```
hc> s                    # Where am I?
p:amazon.html c:0 d:0 @body

hc> t100                 # What's on the page? (first 100 chars)
Shop Electronics Books Fashion Home... Add to Cart $29.99...

hc> q .price             # Find all prices
[0]$29.99
[1]$49.99
[2]$12.99

hc> n1                   # Select the 2nd one
✓ [1] $49.99 Prime delivery...

hc> a                    # What are its attributes?
class=price data-item=B08X...
```

**That's it.** Five commands, ~200 tokens total, vs ~12,500 to read the HTML.

## Command Reference

### State & Overview

| Command | Output | Use When |
|---------|--------|----------|
| `s` | `p:file c:3 d:5 @div` | Check where you are |
| `t` | Full text content | Need all text |
| `t100` | First ~100 chars | Quick peek |

**Example:**
```
hc> s
p:hn.html c:30 d:2 @table    # In hn.html, 30 results cached, depth 2, at <table>
```

### Query Elements

| Command | Output | Use When |
|---------|--------|----------|
| `q .class` | `[0]text [1]text...` | Find multiple elements |
| `q1 .class` | Element text | Find one, make it current |

**Selectors work like CSS:**
- `q button` - all buttons
- `q .price` - elements with class "price"
- `q #main` - element with id "main"
- `q article h3 a` - links inside h3 inside article

**Example - Find products:**
```
hc> q article.product
[0]iPhone 15 Pro $999 Add to Cart
[1]Samsung Galaxy $899 Add to Cart
[2]Pixel 8 $699 Add to Cart

hc> q .price
[0]$999
[1]$899
[2]$699
```

### Navigate Results

| Command | Output | Use When |
|---------|--------|----------|
| `n2` | `✓ [2] content...` | Select 3rd result |
| `up` | `✓ @parent-tag` | Go to parent |
| `up3` | `✓ @ancestor` | Go up 3 levels |
| `ch` | `[0]<div>... [1]<span>...` | See children |

**Example - Drill into a product:**
```
hc> q article.product
[0]iPhone 15 Pro...
[1]Samsung Galaxy...

hc> n0                    # Select first product
✓ [0] iPhone 15 Pro $999 Add to Cart

hc> ch                    # What's inside?
[0]<img>
[1]<h3>iPhone 15 Pro
[2]<span.price>$999
[3]<button>Add to Cart

hc> a                     # Attributes of current
class=product data-sku=IP15PRO
```

### Find Text (Grep)

| Command | Output | Use When |
|---------|--------|----------|
| `g pattern` | `L23: matching line...` | Find text with line numbers |

**Example:**
```
hc> g price
L45: price: $29.99
L67: price: $49.99
L89: price: $12.99

hc> g Einstein
L24: by Albert Einstein
L60: by Albert Einstein
```

### Interactive Elements

| Command | Output | Use When |
|---------|--------|----------|
| `look` | `@0 <a> "Home"...` | List clickable things |
| `@3` | `✓ clicked "Submit"` | Click element #3 |

**Example - Find and click:**
```
hc> look
12 elements
@0 <a> "Home" →/
@1 <a> "Products" →/products
@2 <a> "Cart" →/cart
@3 <button> "Sign In"
@4 <button> "Search"

hc> @3
✓ clicked "Sign In"
```

### Attributes & HTML

| Command | Output | Use When |
|---------|--------|----------|
| `a` | `href=/page class=btn` | Get attributes |
| `h` | `<div class="x">...</div>` | Get full HTML |
| `h200` | First ~200 chars of HTML | Peek at structure |

### Variables (Blind Operations)

| Command | Output | Use When |
|---------|--------|----------|
| `>$name` | `✓ $name (1234 chars)` | Save without seeing |
| `$name` | Content of variable | Retrieve later |

**Example - Capture now, filter later:**
```
hc> q1 .product-description
[huge amount of text you don't want to see yet]

hc> >$desc              # Save it blindly
✓ $desc (4523 chars)

hc> $desc |grep warranty
30-day money-back warranty included
```

## Real-World Examples

### Example 1: Hacker News - Get Top Story

**Task:** Find the #1 story's title, points, and author.

```
hc> s
p:hn.html c:0 d:0 @body

hc> q .titleline
[0]Show HN: AI-powered code review
[1]Why Rust is taking over...
[2]The future of web browsers

hc> q .score
[0]423 points
[1]256 points
[2]189 points

hc> q .hnuser
[0]pg
[1]tptacek
[2]dang
```

**Result:** "Show HN: AI-powered code review" by pg, 423 points.
**Tokens:** ~150 total vs ~8,600 reading full HTML.

### Example 2: E-commerce - Find Product Price

**Task:** Find the 3rd product's name and price.

```
hc> q article h3
[0]Wireless Mouse
[1]Mechanical Keyboard
[2]USB-C Hub
[3]Monitor Stand

hc> q .price
[0]$29.99
[1]$89.99
[2]$45.99
[3]$34.99
```

**Result:** USB-C Hub, $45.99 (index 2).
**Tokens:** ~80 total.

### Example 3: Wikipedia - Get Summary

**Task:** Get the article title and first paragraph.

```
hc> q1 #firstHeading
Claude (language model)

hc> q1 .mw-parser-output > p
Claude is a family of large language models developed by Anthropic...
```

**Result:** Title and summary in 2 commands.
**Tokens:** ~100 total vs ~59,000 reading full HTML.

### Example 4: Form - Find Inputs

**Task:** List all form fields.

```
hc> q input, select, textarea
[0]<input> name
[1]<input> email
[2]<select> country
[3]<textarea> message
[4]<button> Submit

hc> look
5 elements
@0 <input> "name"
@1 <input> "email"
@2 <select> "country"
@3 <textarea> "message"
@4 <button> "Submit"
```

### Example 5: Navigation - Find Links

**Task:** List main navigation links.

```
hc> q nav a
[0]Home
[1]Products
[2]About
[3]Contact

hc> n1
✓ [1] Products

hc> a
href=/products class=nav-link
```

## Patterns for Common Tasks

### Pattern: Explore → Query → Select → Inspect

```
s              # 1. Where am I?
t100           # 2. What's here?
q .relevant    # 3. Find what I need
n0             # 4. Select one
a              # 5. Get details
```

### Pattern: Find and Click

```
look           # 1. List clickable elements
@N             # 2. Click the one you want
```

### Pattern: Blind Capture

```
q1 .huge-content
>$data         # Save without seeing (just "✓ $data (N chars)")
$data |grep keyword    # See only matching lines
```

### Pattern: Structural Discovery

```
q1 main        # Go to main content
ch             # See children
n2             # Select interesting child
ch             # Go deeper
```

## Token Budget

| Operation | Tokens |
|-----------|--------|
| Simple command (`s`, `t100`) | ~50 |
| Query (`q .class`) | ~50 + results |
| Full page read (traditional) | 5,000-60,000 |

**Rule of thumb:** 5-10 `hc` commands = same info as reading entire HTML, at 1% of the cost.

## Anti-Patterns

**DON'T** read full HTML first:
```
# Bad - 12,000 tokens
Read entire page, then search for price

# Good - 100 tokens
hc> q .price
[0]$29.99
```

**DON'T** use complex selectors when simple ones work:
```
# Unnecessary
q div.container > section.products > article.item > span.price

# Better
q .price
```

**DON'T** forget to use `n` to select:
```
# After q, results are indexed but not selected
hc> q .item
[0]First [1]Second [2]Third

# Now select one to inspect further
hc> n1
✓ [1] Second
hc> a
class=item data-id=123
```

## Summary

1. **Start with `s`** - know where you are
2. **Use `t100`** - quick text peek
3. **Use `q`** - find elements by CSS selector
4. **Use `n`** - select from results
5. **Use `look`/`@`** - for clicking
6. **Use `g`** - for text search
7. **Use `>$var`** - to capture without seeing

**Every command returns terse output.** No JSON, no verbose confirmations. Just the data you need.

Token savings: **99%+** vs reading full HTML.

---

## Integration with Foam/Shiro (Browser OS)

Hypercompact is being integrated into the nimbus-land ecosystem to provide token-efficient DOM navigation across multiple contexts.

### The Philosophy: "One DSL, Many Contexts"

The same HC command syntax works regardless of:
- Where the AI runs (external Claude Code, or inside Foam/Shiro)
- What DOM it navigates (external HTML file, live page, iframe)
- How it got there (skyeyes, shell command, JS API)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     NAVIGATION CONTEXTS                              │
├─────────────────────────────────────────────────────────────────────┤
│  CONTEXT A: External AI → Browser (via skyeyes)                     │
│  CONTEXT B: AI inside browser → External HTML file (detached DOM)   │
│  CONTEXT C: AI inside browser → Same page DOM (dangerous!)          │
│  CONTEXT D: AI inside browser → iframe/sandbox (isolated)           │
└─────────────────────────────────────────────────────────────────────┘
```

### Target Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │   Skyeyes   │  │ Foam Shell  │  │ Shiro Shell │            │
│  │  (remote)   │  │  (local)    │  │  (local)    │            │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘            │
└─────────┼────────────────┼────────────────┼───────────────────┘
          │                │                │
          ▼                ▼                ▼
┌───────────────────────────────────────────────────────────────┐
│                    HYPERCOMPACT LAYER                          │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  hc/core.js - Context-agnostic DSL implementation       │  │
│  │  • Command parser (s, t, q, n, look, @, etc.)           │  │
│  │  • Session state (current element, results, vars)       │  │
│  │  • Works with any Document object                       │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌───────────────────────────────────────────────────────────────┐
│                      DOM LAYER                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │  linkedom   │  │  DOMParser  │  │   Native    │            │
│  │  (Node.js)  │  │  (browser)  │  │  (browser)  │            │
│  │             │  │  for files  │  │  live DOM   │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
└───────────────────────────────────────────────────────────────┘
```

### Shell Command Interface (Target)

```bash
# In Foam/Shiro shell:
hc open /home/user/page.html    # Parse file into detached DOM
hc q .price                      # Query prices
hc n0                            # Select first result
hc a                             # Get attributes

hc live                          # Attach to live page DOM (careful!)
hc iframe #preview               # Attach to iframe
```

### Related Repos

- **nimbus** - Orchestrator, see issue #6 for full RFC
- **foam** - Browser OS (plain JS) - will get `hc` command
- **shiro** - Browser OS (TypeScript) - will get `hc` command
- **fluffycoreutils** - Shared Unix commands, may consume HC
- **skyeyes** - Remote JS execution bridge

### Implementation Phases

1. **Phase 1**: Extract core.js - context-agnostic HC implementation ✓
2. **Phase 2**: Add `hc` command to Foam/Shiro shells ✓
3. **Phase 3**: Skyeyes bridge (`__hc` global + MCP tools) ✓
4. **Phase 4**: Documentation unification

---

## API Reference

### Node.js Usage

```javascript
const { createSession, fromHTML } = require('hypercompact');
const { parseHTML } = require('linkedom');

// From HTML string
const session = fromHTML(htmlString, 'page.html', { parseHTML });
console.log(session.exec('q .price'));

// From Document object
const { document } = parseHTML(htmlString);
const session2 = createSession(document, 'page.html');
```

### Browser Usage (Foam/Shiro Shell)

```bash
# In Foam or Shiro terminal:
hc open /home/user/page.html
✓ opened page.html (12345 chars)

hc t100
Welcome to the store...

hc q .price
[0]$29.99
[1]$49.99

hc n0
✓ [0] $29.99

hc a
class=price data-sku=ABC123
```

### Skyeyes MCP Tools

Four dedicated MCP tools for token-efficient remote navigation:

```
hc_open   - Load HTML file from browser OS filesystem
hc_live   - Attach to live page DOM
hc_exec   - Execute HC command (returns terse output)
hc_status - Check session state
```

**Example workflow via MCP:**

```javascript
// 1. Open a file
hc_open(page="foam", file="/home/user/page.html")
// → "✓ opened page.html (12345 chars)"

// 2. Query elements
hc_exec(page="foam", cmd="q .price")
// → "[0]$29.99\n[1]$49.99\n[2]$12.99"

// 3. Select and inspect
hc_exec(page="foam", cmd="n1")
// → "✓ [1] $49.99"

hc_exec(page="foam", cmd="a")
// → "class=price data-sku=XYZ789"
```

### Direct JS Access (via skyeyes_eval)

The `window.hc()` function is also available for ad-hoc queries:

```javascript
skyeyes_eval(page="foam", code="hc('q .price')")
// → "[0]$29.99\n[1]$49.99"
```

### Global Objects

Both Foam and Shiro expose:
- `window.__hc.session` - Current HCSession instance
- `window.__hc.HCSession` - HCSession class
- `window.hc(cmd)` - Shorthand for `__hc.session.exec(cmd)`

### CLI Usage

```bash
# Single command
hc page.html "q .price"

# Interactive REPL
hc page.html -i
```

---

## File Structure

```
hypercompact/
├── src/
│   ├── index.js      # Main entry (Node.js)
│   ├── core.js       # HCSession class
│   ├── parser.js     # Command parser
│   ├── browser.js    # Browser bundle
│   ├── cli.js        # CLI tool
│   └── test.js       # Tests
├── study/
│   ├── pages/        # Test HTML files
│   ├── run_study_v2.js
│   └── hc_tool_v2.js # Legacy (uses jsdom)
├── CLAUDE.md         # This file
└── package.json
```
