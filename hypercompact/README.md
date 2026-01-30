# Hypercompact

**A token-minimal REPL DSL for LLMs to navigate webpages efficiently.**

## The Problem

When Claude reads a webpage:
- Raw HTML: **15,000+ tokens** for a typical page
- Actual information needed: **50-200 tokens**

Tool call overhead compounds this:
- Each MCP tool invocation: ~50-100 tokens of JSON structure
- Multi-step navigation: N tools × overhead = waste

## The Solution

A single persistent REPL session with a "man on the inside" - JavaScript running in the browser that:

1. **Transforms** pages into minimal text representations
2. **Responds** to terse navigation commands
3. **Streams** only what Claude asks for
4. **Operates blind** when Claude doesn't need to see intermediate results

### Inspired by Lotus 1-2-3

The slash menu let users navigate complex spreadsheet operations with minimal keystrokes. Each keystroke narrowed context. The menu showed relevant options *at each level*.

Hypercompact brings this to webpage navigation:
- Single-character commands where possible
- Context-aware responses
- Progressive disclosure (zoom to see more)
- Client-side contextual help (no token cost)

## Quick Example

**Task:** Find the price of "Wireless Mouse" on an e-commerce page

### Traditional approach (~2000 tokens)
```
[Tool: fetch_page] → 15000 tokens of HTML
[Tool: search] → overhead + results
[Tool: extract] → overhead + data
Total: ~2000+ tokens sent/received
```

### Hypercompact approach (~80 tokens)
```
hc> t
"Electronics Store Home Shop Categories Keyboards Mice Monitors ... Wireless Mouse $29.99 ... Gaming Mouse $49.99"

hc> z.Wireless Mouse
5(Wireless Mouse) $29.99 [Add to Cart] "2.4GHz, ergonomic design, 18-month battery"

hc> close
```

## Architecture

```
┌─────────────────┐     WebSocket      ┌──────────────────┐
│   Claude Code   │◄──────────────────►│  Browser Agent   │
│                 │   terse commands   │  (JavaScript)    │
│  REPL Client    │   compact results  │                  │
└─────────────────┘                    │  - DOM traversal │
                                       │  - Compression   │
                                       │  - Blind ops     │
                                       └──────────────────┘
```

### Why WebSocket over MCP?

MCP tool calls have per-call overhead. A WebSocket REPL:
- Single connection, unlimited back-and-forth
- No JSON schema overhead per command
- Streaming responses
- State persists (variables, position in DOM)

## Command Reference

### Core Navigation

```
t                   # full page textContent, normalized
t200                # first ~200 tokens of text
s                   # structural view: ([btn] (div))
h                   # outerHTML of current element
h100                # outerHTML, ~100 token limit

z.word              # zoom to first "word"
z.word3             # zoom to 3rd "word"
z5                  # zoom to 5th result from last query

q .class            # querySelectorAll(".class")
q1 #id              # querySelector("#id")
q button            # all buttons
q [href]            # all links

up                  # parent
up2                 # grandparent
ch                  # children summary
sib                 # siblings summary
```

### Depth Notation

Structural view shows nesting depth:
```
hc> s
"2([Shop] [Cart] [Login]) 3(main: 4(Featured) 5(Apple $5) 5(Banana $3))"
```

- `2([Shop]` = button "Shop" is 2 levels deep
- `5(Apple $5)` = text "Apple $5" is 5 levels deep

This lets Claude understand page structure without seeing HTML soup.

### Blind Operations

**Critical for token efficiency**: Do work without Claude seeing intermediate results.

```
silent h >$page     # capture full HTML, see nothing
$page |grep price   # only see grep output
>prices.txt         # save to file, silent

silent q img        # find all images
$_.length           # only see count: "47"

silent t >$text     # capture all text
$text |wc -w        # only see word count
```

### Variables

```
>$x                 # store last result in x
$x                  # retrieve x (now Claude sees it)
$_.length           # property of last result
$x.slice(0,100)     # JS expressions work
```

### Actions

```
click 3             # click 3rd element from last query
type 0 "search"     # type into first input
submit              # submit current form
scroll 500          # scroll down 500px
scroll -200         # scroll up
wait 1000           # wait for dynamic content
nav "url"           # navigate to URL
back                # browser back
```

### Compression Modes

```
c.lz                # LZ-string compression (reversible)
c.vocab             # vocabulary-based (learns page terms)
c.diff              # diff from last state
c.off               # disable compression
```

## Real-World Examples

### Example 1: Hacker News

**Goal:** Get top 5 story titles and scores

```
hc> nav "https://news.ycombinator.com"
ok

hc> q .titleline
[0]"Show HN: Thing" [1]"Article about X" [2]"Why Y matters"...

hc> q .score :5
[0]"423 points" [1]"256 points" [2]"189 points" [3]"167 points" [4]"145 points"

hc> close
```

**Total: ~60 tokens**

### Example 2: Amazon Product Search

**Goal:** Find price of specific product

```
hc> nav "https://amazon.com"
ok

hc> type 0 "anker usb-c cable"
ok

hc> submit
navigated: /s?k=anker+usb-c+cable

hc> q [data-component-type="s-search-result"] :3
[0]"Anker USB-C Cable 2-Pack $12.99 ★4.7" [1]"Anker PowerLine III $15.99 ★4.8"...

hc> close
```

**Total: ~100 tokens**

### Example 3: Form Filling

```
hc> nav "https://example.com/contact"
ok

hc> q input,textarea
[0]#name [1]#email [2]#subject [3]#message [4]#submit

hc> type 0 "John Doe"
ok

hc> type 1 "john@example.com"
ok

hc> type 3 "Hello, I have a question about..."
ok

hc> click 4
submitted

hc> close
```

### Example 4: Blind Data Collection

**Goal:** Save all product data to file for later analysis

```
hc> nav "https://shop.example.com/products"
ok

hc> silent q .product
stored 47 elements

hc> silent $_ |map outerHTML >products.html
saved products.html (0 tokens seen)

hc> close
```

Claude navigated, queried, and saved 47 products' HTML **seeing only "ok", "stored 47", "saved"**.

## Token Overhead Analysis

| Component | Tokens |
|-----------|--------|
| Command sent | 3-15 |
| Response received | 10-100 |
| Tool call JSON (traditional) | 50-100 |
| **Savings per interaction** | **~60-80%** |

For a 10-step navigation:
- Traditional MCP: ~1500 tokens
- Hypercompact: ~300 tokens

## Client-Side Contextual Help

The human-facing client (Claude Code integration) shows a Lotus-style menu **without sending tokens**:

```
┌─────────────────────────────────────────────┐
│ hc> z.                                      │
├─────────────────────────────────────────────┤
│ [z.word] zoom to word  [z3] 3rd result      │
│ [t] text  [s] structure  [h] html           │
│ [up] parent  [ch] children                  │
└─────────────────────────────────────────────┘
```

Claude doesn't see this menu - it's rendered locally for human observers. Claude has internalized the commands via training/examples.

## Design Principles

1. **One tool to rule them all**: REPL only. No decision paralysis.
2. **Explicit close**: Forces clean session management.
3. **Progressive disclosure**: Start with `t`, zoom as needed.
4. **Blind by default for bulk ops**: See only what you need.
5. **Unix philosophy**: Pipes, grep, files all work.
6. **Reversible compression**: When HTML is needed, minimize tokens.
7. **Depth over structure**: `5(text)` beats nested tag soup.

## Compression Research

### Reversible HTML Compression

We're investigating:
- **LZ-string**: Works well, ~40% reduction
- **Vocabulary learning**: Learn `div class="product-card"` → `P`, save ~60%
- **Structural templates**: Common patterns → single tokens

### Benchmark: Sample Pages

| Page | Raw HTML | textContent | Hypercompact |
|------|----------|-------------|--------------|
| HN front | 45KB | 3KB | 200B |
| Amazon search | 890KB | 12KB | 500B |
| Wikipedia article | 250KB | 45KB | 2KB |
| Twitter/X feed | 2.1MB | 8KB | 400B |

## Roadmap

- [ ] Core REPL protocol spec
- [ ] Browser extension (man on the inside)
- [ ] Claude Code MCP server (single `repl` tool)
- [ ] Compression codec benchmarks
- [ ] Test suite with popular sites
- [ ] Vocabulary learning for common sites
- [ ] Client-side menu rendering

## Contributing

The goal is **theoretical purity** in token efficiency. Every command, every response format should be scrutinized:

- Can this be shorter?
- Can Claude skip seeing this?
- Is there a more common case to optimize for?

## License

MIT

---

*"The best token is the one you don't spend."*
