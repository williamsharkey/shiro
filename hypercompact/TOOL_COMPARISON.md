# Tool Comparison: FunctionServer, Nimbus, and Hypercompact

## Overview

Three systems for AI-to-browser communication, each with different goals:

| System | Primary Goal | Transport | Token Efficiency |
|--------|-------------|-----------|------------------|
| **FunctionServer** | Full IDE in browser | WebSocket | Medium (Lens optimizes) |
| **Nimbus/Skyeyes** | Multi-worker orchestration | HTTP + WebSocket | Low (raw JS eval) |
| **Hypercompact** | Minimal token navigation | MCP/WebSocket | High (DSL) |

## FunctionServer Tools

### Eye Bridge (~25ms latency)
WebSocket connection from Go backend to browser ALGO.bridge.

```go
// go/main.go
type EyeConnection struct {
    Conn     *websocket.Conn
    Username string
}

// Send command, wait for response
func (bc *BrowserConnection) SendCommand(cmd map[string]interface{}) (string, error) {
    // ... sends MCP_CMD:{"code":"..."} to browser
    // ... waits for response with 30s timeout
}
```

```javascript
// Browser-side: core/algo-os.html
ALGO.bridge = {
    eval: function(code) {
        try {
            const result = eval(code);
            return { success: true, result: result };
        } catch(e) {
            return { success: false, error: e.message };
        }
    },
    query: function(selector) { /* ... */ },
    queryAll: function(selector) { /* ... */ }
}
```

**Usage**: `eye 'document.title'` → "FunctionServer"

### Lens API (Token-Efficient IDE)
High-level API wrapping low-level operations:

```javascript
ALGO.lens = {
    // State queries (minimal tokens)
    state: () => "w:Studio|Shell e:0 u:william",
    dash: () => "[Studio|Shell] 🎮📁💻",

    // Code viewing (line numbers)
    code: (start, count) => "1: function foo() {\n2:   return 1;\n3: }",
    line: (n, count) => "42: const x = 1;",
    grep: (pattern) => "12: match1\n45: match2",

    // Surgical editing
    setLine: (n, code) => "✓ L42",
    insertLine: (n, code) => "✓ +L5",
    deleteLine: (n) => "✓ -L10",

    // Git integration
    commit: async (msg) => "✓ committed",
    push: async () => "✓ pushed",
    diff: async () => "2 files changed",

    // Visual grid navigation
    look: (selector) => "15 elements\n  0123456789...\n 0│[Save] [Run]...",
    at: (row, col) => 'BUTTON:"Save" [click]',
    click: (row, col) => '✓ clicked "Save"'
}
```

**Key insight**: `Lens.setLine(42, "fixed")` returns just "✓ L42" (5 tokens) instead of reading entire file.

### AI Eyes (Visual Feedback)
Shows humans what AI is doing:

```javascript
ALGO.eyes = {
    look: (el) => /* purple highlight box, 0.5s */,
    edit: (el) => /* green flash */,
    evaporate: (el) => /* fade-out ghost */,
    codeRegion: (line, count) => /* highlight editor lines */
}
```

No token cost - visual effects only.

## Nimbus/Skyeyes Tools

### Skyeyes MCP Tools

```typescript
// src/mcp/skyeyes-tools.ts
tools: [
    tool("skyeyes_eval", "Execute JS in browser", {
        page: z.string(),
        code: z.string()
    }, async (args) => {
        return await evalViaHttp(port, args.page, args.code);
    }),

    tool("skyeyes_status", "Check connected bridges", {}, ...),
    tool("skyeyes_reload", "Reload iframe", { page }, ...),

    // Terminal operations (browser OS shell)
    tool("terminal_exec", "Run shell command", { page, command }, ...),
    tool("terminal_read", "Read terminal screen", { page }, ...),
    tool("terminal_status", "Check terminal state", { page }, ...)
]
```

### Terminal Code Templates
Inject JS that detects OS and executes shell commands:

```javascript
function terminalExecCode(command) {
    return `return (async () => {
        if (window.__shiro) {
            // Echo + execute in Shiro
            const term = window.__shiro.terminal.term;
            let stdout = '', stderr = '';
            const exitCode = await window.__shiro.shell.execute(cmd,
                s => { stdout += s; term.write(s); },
                s => { stderr += s; });
            return JSON.stringify({ stdout, stderr, exitCode });
        } else if (window.__foam) {
            // Execute in Foam
            const r = await window.__foam.shell.exec(cmd);
            return JSON.stringify(r);
        }
    })()`;
}
```

## Comparative Analysis

### Token Efficiency

| Operation | FunctionServer | Nimbus | Hypercompact |
|-----------|---------------|--------|--------------|
| Get page text | `eye 'document.body.textContent'` (~15 tokens cmd) | `skyeyes_eval(...textContent)` (~25 tokens) | `t` (~45 tokens w/overhead) |
| Find element | `Lens.grep("pattern")` (~8 tokens) | `skyeyes_eval("$('.x')")` (~20 tokens) | `q .x` (~47 tokens) |
| Edit code | `Lens.setLine(42, "x")` (~12 tokens) | N/A | N/A |
| Click button | `Lens.click(3, 5)` (~10 tokens) | `skyeyes_eval("$('btn').click()")` (~25 tokens) | `click 3` (~47 tokens) |

**Winner**: FunctionServer's Lens (lowest overhead for IDE operations)

### Latency

| System | Transport | Typical Latency |
|--------|-----------|-----------------|
| FunctionServer Eye | WebSocket | ~25ms |
| Nimbus Skyeyes | HTTP POST | ~50-100ms |
| Hypercompact (proposed) | WebSocket | ~25ms |

### Architecture Comparison

```
FunctionServer:
┌─────────────┐    WebSocket    ┌─────────────┐
│ Claude Code │◄───────────────►│   Browser   │
│  (eye CLI)  │    25ms RTT     │  ALGO.bridge│
└─────────────┘                 └─────────────┘

Nimbus:
┌─────────────┐    MCP Tool     ┌─────────────┐    HTTP    ┌─────────────┐
│ Claude Agent│───────────────►│ Nimbus Server│─────────►│   Browser   │
│   SDK       │                 │  (Express)   │◄─────────│  Skyeyes.js │
└─────────────┘                 └─────────────┘   WS      └─────────────┘

Hypercompact (proposed):
┌─────────────┐    MCP Tool     ┌─────────────┐  WebSocket ┌─────────────┐
│ Claude Code │───────────────►│  HC Server   │◄──────────►│   Browser   │
│             │   45 tok/cmd    │  (REPL)      │   ~25ms   │  HC Agent   │
└─────────────┘                 └─────────────┘            └─────────────┘
```

## Shared Techniques

### 1. Visual Feedback Without Tokens
FunctionServer's AI Eyes pattern - visual effects don't consume tokens:

```javascript
// Could adopt in Hypercompact
ALGO.eyes.look(element);  // Purple highlight
ALGO.eyes.edit(element);  // Green flash
```

### 2. Terse Return Values
Lens returns minimal confirmations:

```javascript
setLine(42, "code") → "✓ L42"    // 5 chars
commit("msg")       → "✓ committed"  // 11 chars
grep("x")           → "12:match\n45:match"  // Just line:content
```

Hypercompact should adopt similar terseness.

### 3. Grid-Based Navigation
Lens.look() renders DOM as text grid:

```
15 elements
  0123456789012345678901234567890
 0│    [Save]    [Run]    [Help]
 1│
 2│  function foo() {
 3│    return x + 1;
 4│  }
```

Then: `Lens.click(0, 5)` → "✓ clicked Save"

This is more token-efficient than CSS selectors for visual UIs.

### 4. State Compression
Lens.state() returns dense status:

```javascript
state() → "w:Studio|Shell e:0 u:william"
// Decoded: windows=[Studio, Shell], errors=0, user=william
```

Single line, ~35 chars, full context.

## Optimization Opportunities

### For Hypercompact

1. **Adopt Lens-style return values**
   - `z.apple` → `3(apple) $5` not `{"depth":3,"text":"apple","price":"$5"}`

2. **Add visual feedback layer**
   - Browser-side highlights without token cost
   - Human observers see what Claude is "looking at"

3. **Grid navigation mode**
   - `look` → render visible elements as text grid
   - `click 3,5` → click at row 3, col 5
   - More intuitive than CSS selectors for visual UIs

4. **State compression**
   - `s` → `p:/products n:47 v:grid` (path, count, view mode)

### For FunctionServer/Nimbus

1. **Batch operations**
   - Lens already has `batch()` but not widely used
   - Nimbus could batch multiple skyeyes calls

2. **Blind operations**
   - FunctionServer could add `silent` modifier: `Lens.silent.grep("x") >$var`
   - Store results without Claude seeing them

3. **Token budgets**
   - Auto-truncate responses to N tokens
   - `Lens.code(1, 100, {maxTokens: 200})`

## Proposed Unified Protocol

Combining best ideas from all three:

```javascript
// Hypercompact + Lens + Skyeyes unified commands
hc> t                    // textContent (from HC)
hc> g pattern            // grep (from Lens)
hc> L42                  // view line 42 (from Lens)
hc> L42 = "new code"     // set line (from Lens)
hc> look                 // grid view (from Lens)
hc> @3,5                 // click at position (from Lens)
hc> exec "git status"    // terminal exec (from Skyeyes)
hc> s                    // state (from Lens)
hc> silent t >$page      // blind capture (from HC)
hc> $page |g price       // piped grep (from HC)
```

All commands return terse results:
- Success: `✓` + minimal info
- Data: compressed format
- Errors: `✗` + message

## Conclusion

| Aspect | Best Implementation |
|--------|---------------------|
| IDE operations | FunctionServer Lens |
| Token efficiency | Hypercompact batching |
| Multi-browser | Nimbus Skyeyes |
| Visual feedback | FunctionServer AI Eyes |
| Grid navigation | FunctionServer Lens.look() |
| State queries | FunctionServer Lens.state() |

**Recommendation**: Hypercompact should incorporate:
1. Lens-style terse returns (`✓ L42` not `{"success":true,"line":42}`)
2. Grid navigation (`look`, `@row,col`)
3. AI Eyes visual feedback
4. State compression (`s` → dense status line)

This would combine HC's token efficiency with FS's ergonomics.
