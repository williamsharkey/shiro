# Protocol Reality Check: MCP Overhead Analysis

## The Hard Truth About MCP

**MCP does NOT have a native lightweight REPL mode.** Every interaction requires JSON-RPC 2.0 framing.

### Minimum Overhead Per Tool Call

**Request structure (minimal):**
```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hc","arguments":{"c":"t"}}}
```
**~90 bytes / ~25 tokens** just for the wrapper.

**Response structure (minimal):**
```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"..."}],"isError":false}}
```
**~85 bytes / ~24 tokens** just for the wrapper.

### Total Per-Command Overhead: ~50 tokens

This is the *irreducible* cost in standard MCP. The dream of sending just `t` and getting `apple banana` is **not possible** with vanilla MCP.

## The Workaround: Single-Tool REPL Pattern

Since we can't eliminate JSON-RPC, we minimize it:

### Tool Definition (paid once per session)
```json
{
  "name": "hc",
  "description": "Hypercompact web REPL",
  "inputSchema": {
    "type": "object",
    "properties": {
      "c": {"type": "string", "description": "command"}
    },
    "required": ["c"]
  }
}
```

### Per-Command Cost
```
Request:  {"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"hc","arguments":{"c":"CMD"}}}
Response: {"jsonrpc":"2.0","id":N,"result":{"content":[{"type":"text","text":"RESULT"}]}}
```

| Component | Chars | Tokens |
|-----------|-------|--------|
| Request wrapper | 82 | ~23 |
| Command (avg 5 chars) | 5 | ~2 |
| Response wrapper | 72 | ~20 |
| Result (varies) | N | N/3 |
| **Fixed overhead** | **159** | **~45** |

### Comparison: Traditional Multi-Tool vs Hypercompact

**Scenario: Get page text, zoom to "price", extract value**

**Traditional (3 tool calls):**
| Tool Call | Tokens |
|-----------|--------|
| fetch_page definition | ~150 |
| search definition | ~100 |
| extract definition | ~80 |
| fetch_page call + response | 45 + 15000 |
| search call + response | 45 + 200 |
| extract call + response | 45 + 50 |
| **TOTAL** | **~15,715** |

**Hypercompact (3 REPL commands):**
| Command | Tokens |
|---------|--------|
| hc definition | ~40 |
| `t` call + response | 45 + 100 |
| `z.price` call + response | 45 + 30 |
| `$_` call + response | 45 + 15 |
| **TOTAL** | **~320** |

**Savings: 98% reduction** (matches Anthropic's code-execution findings)

## The REAL Dream: Escaping JSON-RPC

### Option 1: WebSocket Direct Protocol

If Claude Code could speak a custom binary/text protocol over WebSocket:

```
→ t
← apple banana carrot $5.99

→ z.carrot
← 4(carrot) $5.99 [Add]
```

**Overhead: ~0 tokens** (just the command/response content)

This requires Claude Code to support custom transports, which it currently does not.

### Option 2: Batch Commands

Send multiple commands in one MCP call:
```json
{"c": "t; z.price; $_"}
```

Return batched results:
```json
{"r": ["apple banana...", "3(price) $5.99", "$5.99"]}
```

**Amortizes wrapper overhead across commands.**

### Option 3: Streaming/SSE Responses

MCP supports SSE for server→client streaming. A REPL session could:
1. Open SSE connection
2. Send commands as HTTP POST
3. Receive streamed responses

This is *possible* in current MCP but not commonly implemented.

### Option 4: Embedded Code Execution

Anthropic's approach: load tool definitions as code files, execute in sandbox.

```python
# File: hc/repl.py
def hc(cmd: str) -> str:
    """Hypercompact web REPL. Commands: t, z.word, q selector, etc."""
    return execute(cmd)
```

The model reads the code once, then calls it with minimal overhead.

**Result: 98.7% context reduction** (per Anthropic's research)

## Practical Recommendations

### For Now (MCP as-is)
1. **Single `hc` tool** - minimize definition overhead
2. **Terse commands** - `t` not `getTextContent()`
3. **Terse responses** - `5(word)` not `<span depth="5">word</span>`
4. **Batch when possible** - `t; z.x; $_` in one call
5. **Blind operations** - filter server-side before responding

### For Future (Protocol Evolution)
1. Lobby for MCP "raw mode" for trusted REPLs
2. Build WebSocket bridge that Claude Code could use
3. Implement SSE-based streaming REPL server

## Token Efficiency Targets

| Metric | Traditional | Hypercompact MCP | Theoretical Min |
|--------|-------------|------------------|-----------------|
| Per-interaction overhead | ~50 | ~45 | ~0 |
| Typical page fetch | 15000 | 100 | 100 |
| 5-step navigation | 1500 | 400 | 100 |
| **Overall reduction** | baseline | **75%** | **95%** |

## Conclusion

The "pure REPL dream" of zero-overhead command/response is **not achievable** with current MCP. But we can still achieve **75%+ token reduction** through:

1. Single-tool pattern
2. Maximally terse DSL
3. Server-side filtering (blind ops)
4. Batched commands

The remaining 25% overhead is the cost of JSON-RPC. To eliminate it would require protocol changes or custom transports.

## References

- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Anthropic: Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) - 98.7% reduction via code execution
- [MCP Architecture](https://modelcontextprotocol.io/docs/learn/architecture)
