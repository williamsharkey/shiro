# Hypercompact Token Efficiency Study

## Study Design

**Objective**: Measure token usage difference between "normal" HTML reading and Hypercompact REPL navigation on real web pages.

**Key constraint**: Both approaches must start BLIND - no prior knowledge of page structure. Must discover layout through exploration.

## Test Pages

| Page | File | Size | Type |
|------|------|------|------|
| 1 | wikipedia.html | 231KB | Reference article (large) |
| 2 | hn.html | 34KB | News aggregator (list) |
| 3 | bookstore.html | 50KB | E-commerce catalog |
| 4 | article1.html | 44KB | Blog post (Wallace & Gromit font) |
| 5 | article3.html | 21KB | Technical blog (WiFi/rain) |

## Tasks

### Task 1: Wikipedia - Extract Summary
**Goal**: Find the first paragraph summary of the article about Claude (language model).
**Requires**: Navigating past infoboxes, finding main content area.

### Task 2: Hacker News - Find Top Story Details
**Goal**: Get the #1 story's title, URL, points, author, and comment count.
**Requires**: Understanding HN's table-based structure.

### Task 3: Bookstore - Find 3rd Book Price
**Goal**: Find the title and price of the 3rd book displayed.
**Requires**: Navigating product grid, extracting specific item.

### Task 4: Article - Extract Heading and First Paragraph
**Goal**: Get the main h1 heading and the first paragraph of body text.
**Requires**: Skipping nav/header, finding content area.

### Task 5: Technical Blog - Find All Code Snippets
**Goal**: List all code/pre blocks in the article.
**Requires**: Scanning document structure, extracting code.

## Methodology

### "Normal" Approach
1. Read full HTML into context
2. Claude parses and extracts information
3. Measure: tokens sent (HTML size) + tokens received (response)

### "Hypercompact" Approach
1. Start with text summary (`t` command)
2. Progressive zoom (`z.keyword`) to find relevant sections
3. Query selectors (`q selector`) for structured extraction
4. Measure: sum of all command/response tokens

## Token Counting

Using approximation: 1 token ≈ 4 characters (conservative estimate for HTML)

For each approach, measure:
- **Input tokens**: What Claude receives (HTML or REPL responses)
- **Output tokens**: What Claude generates (analysis or commands)
- **Total tokens**: Input + Output

## Success Criteria

Task is successful if correct information is extracted.
Both approaches must achieve same result for fair comparison.
