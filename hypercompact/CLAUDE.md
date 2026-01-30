# CLAUDE.md - Hypercompact Navigation Protocol

## Philosophy

**Every token is precious.** This project exists because reading raw HTML is wasteful. A 50KB page becomes ~15K tokens. But the *information* Claude needs is often 50-200 tokens.

The solution: A JavaScript agent ("man on the inside") that transforms pages into minimal representations, with a REPL DSL for zooming/enhancing without tool call overhead.

## Core Principle: Single REPL Session

**There is ONE tool: the REPL.** No dithering over which tool to use. Enter the REPL, navigate, close when done.

```
hc> t                    # textContent, whitespace-normalized
"Shop Cart Login Search Featured Products Apple $5 Banana $3..."

hc> z.Apple              # zoom to first "Apple"
3(Apple) $5 [Add to Cart]

hc> z2                   # zoom to 2nd result from last query
7(Banana) $3 [Add to Cart]

hc> q [Add to Cart]      # querySelectorAll buttons
[0]Add to Cart [1]Add to Cart [2]Checkout

hc> click 2              # click Checkout
navigated: /checkout

hc> close                # explicit close, always required
```

## DSL Quick Reference

### Navigation
| Command | Description |
|---------|-------------|
| `t` | textContent, normalized whitespace |
| `z.word` | zoom to first occurrence of "word" |
| `z.word2` | zoom to 2nd occurrence |
| `z3` | zoom to 3rd result from last query |
| `q selector` | querySelectorAll, returns indexed list |
| `q1 selector` | querySelector, single result |
| `up` | parent element |
| `up3` | 3 ancestors up |
| `ch` | children summary |

### Output Modes
| Command | Description |
|---------|-------------|
| `t` | text only |
| `s` | structural: `([btn] (div (span)))` |
| `h` | outerHTML |
| `h200` | outerHTML, ~200 token limit |
| `more` | continue from limit |
| `more500` | continue ~500 tokens |

### Blind Operations (Claude doesn't see intermediate)
| Command | Description |
|---------|-------------|
| `>$x` | store result in variable x |
| `$x` | recall variable (only then see it) |
| `>file.txt` | save to file, no output |
| `\|grep pattern` | pipe through grep |
| `\|wc` | pipe through wc |
| `silent h >$full` | get full HTML into var, see nothing |

### Actions
| Command | Description |
|---------|-------------|
| `click N` | click Nth element from last query |
| `type N "text"` | type into Nth input |
| `scroll N` | scroll N pixels |
| `wait N` | wait N ms |

### Depth Notation
Elements show nesting depth: `3(Hello)` means "Hello" is 3 levels deep.
```
s
"2([Shop] [Cart]) 4(Featured: 5(Apple) 5(Banana))"
```

## Token Budget Targets

| Operation | Target Tokens |
|-----------|---------------|
| Initial page summary | <100 |
| Zoom result | <50 |
| Query result list | <30 + 5/item |
| Full element HTML | actual + 10% overhead max |

## Anti-Patterns

- Reading full HTML first
- Multiple tool calls when REPL suffices
- Seeing intermediate results you'll pipe/grep anyway
- Forgetting to `close` (wastes connection resources)

## Development Commands

```bash
npm test              # run test suite
npm run compress-test # test compression on sample pages
npm run repl          # interactive REPL for testing DSL
```
