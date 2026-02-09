# Hypercompact Study Results

## Executive Summary

**Token reduction achieved: 99.3%** (with MCP overhead)
**Token reduction with batching: 99.6%**

## Test Setup

5 real web pages, 5 blind discovery tasks:

| Page | Size | Task |
|------|------|------|
| Hacker News | 34KB | Extract #1 story details |
| Wikipedia | 231KB | Get article summary |
| Books to Scrape | 50KB | Find 3rd book price |
| Blog Article | 44KB | Extract heading + first paragraph |
| Technical Blog | 21KB | List all code blocks |

## Results Table

| Task | Normal | HC (content) | HC (total) | Reduction |
|------|--------|--------------|------------|-----------|
| HN Top Story | 8,678 | 34 | 169 | 98.1% |
| Wikipedia Summary | 59,129 | 57 | 147 | 99.8% |
| Bookstore 3rd Book | 12,861 | 18 | 108 | 99.2% |
| Article Heading | 11,184 | 56 | 191 | 98.3% |
| Code Blocks | 5,479 | 3 | 48 | 99.1% |
| **TOTAL** | **97,331** | **168** | **663** | **99.3%** |

## Methodology

### "Normal" Approach
1. Read entire HTML file (simulating `cat` or `Read` tool)
2. Claude parses full document to find answer
3. Token count = full HTML + Claude's response

### Hypercompact Approach
1. Use terse REPL commands: `t`, `q selector`, `z.keyword`
2. Progressive discovery - start blind, zoom in
3. Token count = all command/response content + MCP overhead (45 tokens/call)

## Key Insights

### The MCP overhead is NOT the bottleneck

```
Content tokens:    168 (0.17%)
MCP overhead:      495 (0.51%)  ← 11 tool calls × 45 tokens
Total HC:          663 (0.68%)
Normal approach: 97,331 (100%)
```

Even with 45 tokens per MCP call, the **content reduction dominates**.

### Batching further reduces overhead

With 1 batched call per task (5 calls total):
- Content: 168 tokens
- Overhead: 225 tokens (5 × 45)
- Total: 393 tokens
- **Reduction: 99.6%**

### Wikipedia shows the extreme case

- Normal: 59,129 tokens (231KB of HTML)
- Hypercompact: 147 tokens (2 commands)
- **400x reduction**

The larger the page, the greater the savings.

## Breakdown by Task

### Task 1: Hacker News Top Story
```
Normal: Read 34KB HTML → parse → answer
HC: q .titleline → q .score → q .hnuser
    3 commands, 169 tokens total
```

### Task 2: Wikipedia Summary
```
Normal: Read 231KB HTML → find lead paragraph
HC: t500 → q1 .mw-parser-output > p
    2 commands, 147 tokens total
```

### Task 3: Bookstore 3rd Book
```
Normal: Read 50KB HTML → find product grid → extract
HC: q article.product_pod h3 a → q .price_color
    2 commands, 108 tokens total
```

### Task 4: Article Heading
```
Normal: Read 44KB HTML → find h1 and paragraph
HC: t200 → q1 h1 → q1 main p
    3 commands, 191 tokens total
```

### Task 5: Code Blocks
```
Normal: Read 21KB HTML → find all pre/code
HC: q pre, code
    1 command, 48 tokens total
```

## Theoretical vs Achieved

| Metric | Theoretical | Achieved |
|--------|-------------|----------|
| Content reduction | 99%+ | 99.8% |
| With MCP overhead | 95-98% | 99.3% |
| With batching | 98-99% | 99.6% |

We exceeded theoretical predictions because:
1. Real pages have massive HTML bloat (CSS, scripts, metadata)
2. Terse selectors are extremely efficient
3. Text content normalization eliminates whitespace

## Implications

### Cost Savings
At $3/1M tokens (Claude Sonnet input):
- Normal: 97,331 tokens = $0.29
- Hypercompact: 663 tokens = $0.002
- **Savings: $0.29 per 5-task session**

For 1000 sessions/day:
- Normal: $290/day
- Hypercompact: $2/day
- **Annual savings: ~$105,000**

### Latency Reduction
Fewer tokens = faster responses.
- Normal: ~97K tokens to process
- Hypercompact: ~663 tokens to process
- **~150x less data to process**

## Reproduction

```bash
cd study
npm install
node run_study_realistic.js
```

## Conclusion

Hypercompact REPL navigation achieves **99.3% token reduction** on real web pages with real tasks requiring blind discovery. The MCP overhead (45 tokens/call) is negligible compared to the content savings.

Batching pushes this to **99.6%**, approaching the theoretical maximum.
