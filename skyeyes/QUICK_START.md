# Skyeyes Quick Start Guide

Quick reference for using the new network interception and mutation observer features.

---

## Network Interception

Monitor all HTTP traffic (fetch + XHR) made by the page.

### Basic Usage

```javascript
// Get all network activity
const result = await spirit.eval(`
  await window.skyeyes.send({ type: 'network_log' });
`);

console.log('Total requests:', result.result.total);
console.log('Entries:', result.result.entries);
console.log('Summary:', result.result.summary);
```

### Filter by Method

```javascript
// Get only POST requests
const posts = await spirit.eval(`
  await window.skyeyes.send({
    type: 'network_log',
    options: { method: 'POST' }
  });
`);
```

### Filter by Status

```javascript
// Get failed requests (4xx, 5xx)
const errors = await spirit.eval(`
  await window.skyeyes.send({
    type: 'network_log',
    options: { status: 404 }
  });
`);
```

### Filter by URL

```javascript
// Get API calls only
const apiCalls = await spirit.eval(`
  await window.skyeyes.send({
    type: 'network_log',
    options: { url: '/api/' }
  });
`);
```

### Clear Network Log

```javascript
await spirit.eval(`
  await window.skyeyes.send({ type: 'network_clear' });
`);
```

### Example: Wait for API Call

```javascript
// Clear log before action
await spirit.eval(`
  await window.skyeyes.send({ type: 'network_clear' });
`);

// Perform action that triggers API call
await spirit.click('button#submit');

// Wait for API response
let apiComplete = false;
while (!apiComplete) {
  const log = await spirit.eval(`
    await window.skyeyes.send({
      type: 'network_log',
      options: { url: '/api/submit' }
    });
  `);

  apiComplete = log.result.total > 0 && log.result.entries[0].status !== null;
  await sleep(500);
}

console.log('API call completed!');
```

---

## Mutation Observer

Watch for DOM changes in real-time.

### Basic Usage

```javascript
// Start observing DOM changes
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: {
      childList: true,
      attributes: true,
      characterData: true
    }
  });
`);

// Get mutations
const mutations = await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_log' });
`);

console.log('Mutations:', mutations.result.mutations);

// Stop observing
await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_stop' });
`);
```

### Watch Specific Element

```javascript
// Watch only a specific container
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: {
      target: '#content',
      childList: true,
      subtree: true
    }
  });
`);
```

### Filter Mutations

```javascript
// Get only childList mutations
const additions = await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_log',
    options: { type: 'childList' }
  });
`);

// Get only attribute changes
const attrChanges = await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_log',
    options: { type: 'attributes' }
  });
`);
```

### Clear Mutation Log

```javascript
await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_clear' });
`);
```

### Example: Wait for Dynamic Content

```javascript
// Start observing
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: { target: '#app', childList: true }
  });
`);

// Clear existing mutations
await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_clear' });
`);

// Trigger content load (e.g., click a tab)
await spirit.click('button#load-data');

// Wait for new content
let contentLoaded = false;
while (!contentLoaded) {
  const log = await spirit.eval(`
    await window.skyeyes.send({ type: 'mutation_log' });
  `);

  // Check if elements were added
  contentLoaded = log.result.mutations.some(m =>
    m.type === 'childList' && m.addedNodes.length > 0
  );

  await sleep(500);
}

console.log('Content loaded!');

// Stop observing
await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_stop' });
`);
```

### Example: Detect Validation Errors

```javascript
// Watch for class changes (e.g., 'error' class added)
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: {
      target: 'form',
      attributes: true,
      attributeFilter: ['class'],
      subtree: true
    }
  });
`);

await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_clear' });
`);

// Submit form
await spirit.click('button[type="submit"]');

// Wait a bit for validation
await sleep(1000);

// Check for error classes
const log = await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_log' });
`);

const hasErrors = log.result.mutations.some(m =>
  m.type === 'attributes' &&
  m.attributeName === 'class' &&
  m.newValue?.includes('error')
);

console.log('Form has errors:', hasErrors);
```

---

## Combined Example: Form Submission with Validation

```javascript
async function submitFormWithValidation(formSelector, submitButton) {
  // Start monitoring both network and DOM
  await spirit.eval(`
    await window.skyeyes.send({ type: 'mutation_start' });
    await window.skyeyes.send({ type: 'network_clear' });
  `);

  // Clear logs
  await spirit.eval(`
    await window.skyeyes.send({ type: 'mutation_clear' });
  `);

  // Click submit button
  await spirit.click(submitButton);

  // Wait for either validation errors or network request
  let outcome = null;
  let attempts = 0;

  while (!outcome && attempts < 20) { // 10 second timeout
    // Check for validation errors (DOM changes)
    const mutations = await spirit.eval(`
      await window.skyeyes.send({ type: 'mutation_log' });
    `);

    const hasValidationError = mutations.result.mutations.some(m =>
      m.type === 'attributes' && m.newValue?.includes('error')
    );

    if (hasValidationError) {
      outcome = 'validation_error';
      break;
    }

    // Check for network request
    const network = await spirit.eval(`
      await window.skyeyes.send({ type: 'network_log' });
    `);

    if (network.result.total > 0) {
      const request = network.result.entries[0];
      if (request.status !== null) {
        outcome = request.status >= 200 && request.status < 300
          ? 'success'
          : 'network_error';
        break;
      }
    }

    await sleep(500);
    attempts++;
  }

  // Stop monitoring
  await spirit.eval(`
    await window.skyeyes.send({ type: 'mutation_stop' });
  `);

  return outcome || 'timeout';
}

// Usage
const result = await submitFormWithValidation('#login-form', 'button[type="submit"]');
console.log('Form submission result:', result);
```

---

## API Reference Summary

### Network Interception

| Command | Purpose |
|---------|---------|
| `network_log` | Get captured HTTP requests |
| `network_clear` | Clear network log |

**Options for `network_log`:**
- `method` - Filter by HTTP method (GET, POST, etc.)
- `status` - Filter by status code
- `url` - Filter by URL substring
- `type` - Filter by type (fetch/xhr)
- `limit` - Max entries to return
- `offset` - Skip first N entries

### Mutation Observer

| Command | Purpose |
|---------|---------|
| `mutation_start` | Start observing DOM changes |
| `mutation_stop` | Stop observing |
| `mutation_log` | Get captured mutations |
| `mutation_clear` | Clear mutation log |

**Options for `mutation_start`:**
- `target` - Element to observe (default: document.body)
- `childList` - Watch node additions/removals (default: true)
- `attributes` - Watch attribute changes (default: true)
- `characterData` - Watch text changes (default: true)
- `subtree` - Observe all descendants (default: true)
- `attributeFilter` - Only watch specific attributes
- `attributeOldValue` - Include old values (default: false)
- `characterDataOldValue` - Include old text (default: false)

**Options for `mutation_log`:**
- `type` - Filter by mutation type (childList/attributes/characterData)
- `target` - Filter by target selector substring
- `limit` - Max mutations to return
- `offset` - Skip first N mutations

---

## Troubleshooting

### Network log is empty
- Make sure the page is making HTTP requests
- Network log only captures requests made **after** skyeyes loads
- Log has max 100 entries (FIFO) - old requests are dropped

### Mutation observer not capturing changes
- Make sure you called `mutation_start` before the changes occur
- Check if changes are happening to the target element (default: document.body)
- Mutation log has max 200 entries (FIFO) - clear regularly

### High memory usage
- Clear logs regularly using `network_clear` and `mutation_clear`
- Use filters to reduce noise
- Stop mutation observer when not needed
- Request bodies are auto-truncated to 1KB

---

## Performance Tips

1. **Clear logs regularly** to prevent hitting size limits
2. **Use filters** to reduce the amount of data returned
3. **Stop observers** when not actively monitoring
4. **Target specific elements** instead of observing entire document
5. **Use attributeFilter** to only watch specific attributes

---

## See Also

- `NETWORK_INTERCEPTION_GUIDE.md` - Full network API documentation
- `MUTATION_OBSERVER_GUIDE.md` - Full mutation observer documentation
- `SPIRIT.md` - Spirit integration patterns
- `CLAUDE.md` - Full skyeyes capabilities

---

**Quick start complete! You're ready to use network interception and mutation observers.**
