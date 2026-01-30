# Hypercompact

**Token-minimal REPL DSL for LLMs to navigate webpages efficiently.**

## The Problem

Reading HTML is wasteful:
- 50KB page = **12,500 tokens**
- Information needed = **50-200 tokens**

## The Solution

A terse command language that extracts only what you need:

```
hc> t100                              # Get text (first 100 chars)
Shop Electronics Books Fashion Home...

hc> q .price                          # Query all prices
[0]$29.99 [1]$49.99 [2]$12.99

hc> n1                                # Select 2nd result
✓ [1] $49.99

hc> a                                 # Get attributes
class=price data-sku=ABC123
```

**Result: 99.3% token reduction** (645 tokens vs 94,419 reading raw HTML).

## Empirical Study

Tested on 5 real pages (Hacker News, Wikipedia, e-commerce, blogs):

| Task | Normal HTML | Hypercompact | Reduction |
|------|-------------|--------------|-----------|
| HN Top Story | 8,623 | 216 | 97.5% |
| Book Price | 12,819 | 105 | 99.2% |
| Wiki Summary | 59,081 | 152 | 99.7% |
| Article Nav | 11,140 | 106 | 99.0% |
| Text Search | 2,756 | 66 | 97.6% |
| **TOTAL** | **94,419** | **645** | **99.3%** |

## Command Reference

| Command | Example | Output |
|---------|---------|--------|
| `s` | `s` | `p:page.html c:10 d:3 @div` |
| `t`, `t100` | `t100` | First 100 chars of text |
| `q .sel` | `q .price` | `[0]$29 [1]$49 [2]$12` |
| `q1 .sel` | `q1 h1` | `Welcome to Our Store` |
| `n2` | `n2` | `✓ [2] Third item...` |
| `up`, `up3` | `up` | `✓ @parent-tag` |
| `ch` | `ch` | `[0]<div>... [1]<span>...` |
| `g pattern` | `g price` | `L23: price: $29.99` |
| `look` | `look` | `@0 <a> "Home" @1 <button> "Submit"` |
| `@3` | `@3` | `✓ clicked "Submit"` |
| `a` | `a` | `href=/page class=btn` |
| `h`, `h200` | `h200` | First 200 chars of HTML |
| `>$x` | `>$data` | `✓ $data (1234 chars)` |
| `$x` | `$data` | Contents of variable |

## Documentation

See **[CLAUDE.md](CLAUDE.md)** for the full guide with examples. This is designed to be read by Claude instances to learn the tool.

## Key Design Principles

1. **Terse returns**: `✓ L42` not `{"success":true,"line":42}`
2. **Progressive discovery**: Start with `s`, `t100`, then drill down
3. **Blind operations**: `>$var` saves without showing content
4. **CSS selectors**: Familiar syntax (`q .class`, `q #id`, `q tag`)
5. **Indexed results**: `[0]`, `[1]`, `[2]` for easy selection with `n`

## Architecture

```
┌─────────────┐    MCP Tool    ┌─────────────┐   WebSocket   ┌─────────────┐
│ Claude Code │───────────────►│  HC Server  │◄─────────────►│   Browser   │
│             │   ~50 tok/cmd  │   (REPL)    │    ~25ms     │  HC Agent   │
└─────────────┘                └─────────────┘               └─────────────┘
```

## Inspired By

- **[FunctionServer](https://github.com/williamsharkey/functionserver)** - Lens API for terse IDE operations
- **Lotus 1-2-3** - Single-character menu navigation
- **Unix pipes** - Composable, minimal tools

## Repository Structure

```
hypercompact/
├── CLAUDE.md              # Tool documentation for Claude
├── README.md              # This file
├── PROTOCOL_REALITY.md    # MCP overhead analysis
├── DEEP_OPTIMIZATION.md   # Optimization strategies
├── TOOL_COMPARISON.md     # Comparison with FunctionServer/Nimbus
└── study/
    ├── hc_tool_v2.js      # Tool implementation
    ├── pages/             # Real test pages (HN, Wikipedia, etc.)
    ├── results/           # Benchmark data
    └── run_study_v2.js    # Benchmark runner
```

## Running the Study

```bash
cd study
npm install
node run_study_v2.js
```

## License

MIT

---

*"The best token is the one you don't spend."*
