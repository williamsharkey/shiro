# Mutation Observer Guide

The skyeyes mutation observer integration provides real-time DOM change tracking for AI agents like Spirit. This allows agents to observe and react to dynamic page updates without polling.

## Overview

The mutation observer system:
- **Monitors live DOM changes** (elements added/removed, attributes modified, text content changed)
- **Queues mutations** in a log for Spirit to review
- **Filters by type** (childList, attributes, characterData)
- **Configurable observation** (target element, subtree, attribute filters)
- **Automatic size limiting** (max 200 mutations, FIFO)

## API Commands

### Start Observing: `mutation_start`

Start monitoring DOM changes.

**Request:**
```json
{
  "type": "mutation_start",
  "id": "req-123",
  "options": {
    "target": "body",          // CSS selector or element (default: document.body)
    "childList": true,          // Watch for node additions/removals
    "attributes": true,         // Watch for attribute changes
    "characterData": true,      // Watch for text content changes
    "subtree": true,            // Observe all descendants
    "attributeOldValue": false, // Include old attribute values
    "characterDataOldValue": false, // Include old text values
    "attributeFilter": ["class", "id"] // Only watch specific attributes
  }
}
```

**Response:**
```json
{
  "id": "req-123",
  "result": {
    "started": true,
    "target": "body",
    "options": {
      "childList": true,
      "attributes": true,
      "characterData": true,
      "subtree": true,
      "attributeOldValue": false,
      "characterDataOldValue": false
    },
    "timestamp": 1706543210123
  },
  "error": null
}
```

### Stop Observing: `mutation_stop`

Stop monitoring DOM changes.

**Request:**
```json
{
  "type": "mutation_stop",
  "id": "req-124"
}
```

**Response:**
```json
{
  "id": "req-124",
  "result": {
    "stopped": true,
    "wasActive": true,
    "capturedMutations": 47,
    "timestamp": 1706543220456
  },
  "error": null
}
```

### Get Mutation Log: `mutation_log`

Retrieve captured mutations.

**Request:**
```json
{
  "type": "mutation_log",
  "id": "req-125",
  "options": {
    "limit": 50,         // Max mutations to return
    "offset": 0,         // Skip first N mutations
    "type": "childList", // Filter by mutation type (optional)
    "target": "#main"    // Filter by target selector substring (optional)
  }
}
```

**Response:**
```json
{
  "id": "req-125",
  "result": {
    "mutations": [
      {
        "id": 1,
        "timestamp": 1706543210500,
        "type": "childList",
        "target": "body",
        "targetTag": "body",
        "addedNodes": [
          {
            "type": 1,
            "tag": "div",
            "selector": "div.container",
            "text": null
          }
        ],
        "removedNodes": []
      },
      {
        "id": 2,
        "timestamp": 1706543210650,
        "type": "attributes",
        "target": "div.container",
        "targetTag": "div",
        "attributeName": "class",
        "oldValue": "container",
        "newValue": "container active"
      },
      {
        "id": 3,
        "timestamp": 1706543210800,
        "type": "characterData",
        "target": "#text",
        "targetTag": undefined,
        "oldValue": "Loading...",
        "newValue": "Content loaded successfully!"
      }
    ],
    "total": 47,
    "offset": 0,
    "limit": 50,
    "observerActive": true,
    "filters": {
      "type": "childList",
      "target": null
    }
  },
  "error": null
}
```

### Clear Mutation Log: `mutation_clear`

Clear all captured mutations from the log.

**Request:**
```json
{
  "type": "mutation_clear",
  "id": "req-126"
}
```

**Response:**
```json
{
  "id": "req-126",
  "result": {
    "cleared": 47,
    "remaining": 0,
    "observerActive": true
  },
  "error": null
}
```

## Mutation Types

### childList

Triggered when child nodes are added or removed.

```json
{
  "type": "childList",
  "target": "div#container",
  "targetTag": "div",
  "addedNodes": [
    {
      "type": 1,              // 1=Element, 3=Text
      "tag": "button",
      "selector": "button.primary",
      "text": null
    }
  ],
  "removedNodes": [
    {
      "type": 1,
      "tag": "span",
      "selector": "span.old-content",
      "text": null
    }
  ]
}
```

### attributes

Triggered when element attributes change.

```json
{
  "type": "attributes",
  "target": "button.primary",
  "targetTag": "button",
  "attributeName": "disabled",
  "oldValue": null,           // If attributeOldValue enabled
  "newValue": "true"
}
```

### characterData

Triggered when text content changes.

```json
{
  "type": "characterData",
  "target": "p",
  "targetTag": "p",
  "oldValue": "Old text",     // If characterDataOldValue enabled
  "newValue": "New text content here"
}
```

## Spirit Integration

### Polling Pattern

```javascript
// Start observer when Spirit begins task
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: { childList: true, attributes: true }
  });
`);

// Periodically check for mutations
while (taskInProgress) {
  const mutations = await spirit.eval(`
    await window.skyeyes.send({
      type: 'mutation_log',
      options: { limit: 50 }
    });
  `);

  if (mutations.result.total > 0) {
    console.log('Detected DOM changes:', mutations.result.mutations);
    // React to changes...

    // Clear processed mutations
    await spirit.eval(`
      await window.skyeyes.send({ type: 'mutation_clear' });
    `);
  }

  await sleep(1000);
}

// Stop observer when done
await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_stop' });
`);
```

### Event-Driven Pattern

```javascript
// Monitor for specific element appearance
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: {
      target: '#app',
      childList: true,
      subtree: true
    }
  });
`);

// Check mutations
const mutations = await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_log' });
`);

const targetFound = mutations.result.mutations.some(m =>
  m.type === 'childList' &&
  m.addedNodes.some(n => n.selector?.includes('modal'))
);

if (targetFound) {
  console.log('Modal appeared! Taking action...');
}
```

## Use Cases

### 1. Wait for Dynamic Content

```javascript
// Wait for AJAX-loaded content
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: { target: '#content', childList: true }
  });
`);

let contentLoaded = false;
while (!contentLoaded) {
  const log = await spirit.eval(`
    await window.skyeyes.send({ type: 'mutation_log' });
  `);

  contentLoaded = log.result.mutations.some(m =>
    m.addedNodes?.some(n => n.selector?.includes('data-loaded'))
  );

  await sleep(500);
}
```

### 2. Track Form Validation

```javascript
// Monitor form validation state
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: {
      target: 'form',
      attributes: true,
      attributeFilter: ['class', 'aria-invalid']
    }
  });
`);

// Check for validation errors
const log = await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_log' });
`);

const hasErrors = log.result.mutations.some(m =>
  m.type === 'attributes' &&
  m.newValue?.includes('error')
);
```

### 3. Detect Page State Changes

```javascript
// Monitor app state
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: {
      target: 'body',
      attributes: true,
      attributeFilter: ['data-state']
    }
  });
`);

// React to state transitions
const log = await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_log' });
`);

const stateChange = log.result.mutations.find(m =>
  m.attributeName === 'data-state'
);

if (stateChange?.newValue === 'loading') {
  console.log('App entered loading state, waiting...');
}
```

## Performance Considerations

### Log Size Limit

The mutation log has a **maximum size of 200 entries**. When full, oldest mutations are removed (FIFO).

**Best practice:** Regularly clear the log after processing:

```javascript
// Process mutations
const log = await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_log' });
`);

// Handle mutations...

// Clear to prevent overflow
await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_clear' });
`);
```

### Filtering

Use filters to reduce noise:

```javascript
// Only watch specific attributes
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: {
      attributes: true,
      attributeFilter: ['class', 'data-state'], // Ignore other attributes
      childList: false, // Don't track DOM additions
      characterData: false // Don't track text changes
    }
  });
`);
```

### Selective Observation

Target specific elements instead of observing the entire DOM:

```javascript
// Only watch modal container
await spirit.eval(`
  await window.skyeyes.send({
    type: 'mutation_start',
    options: {
      target: '#modal-container',
      subtree: true
    }
  });
`);
```

## Error Handling

```javascript
try {
  const result = await spirit.eval(`
    await window.skyeyes.send({
      type: 'mutation_start',
      options: { target: '#nonexistent' }
    });
  `);

  if (result.error) {
    console.error('Observer error:', result.error.message);
  }
} catch (err) {
  console.error('Failed to start observer:', err);
}
```

## Cleanup

Always stop the observer when done to prevent memory leaks:

```javascript
// Stop observer
await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_stop' });
`);

// Clear log
await spirit.eval(`
  await window.skyeyes.send({ type: 'mutation_clear' });
`);
```

The observer is automatically stopped on page unload.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `mutation_start` | Start observing DOM changes |
| `mutation_stop` | Stop observing |
| `mutation_log` | Get captured mutations |
| `mutation_clear` | Clear mutation log |

**Key Options:**
- `target`: Element to observe (default: `document.body`)
- `childList`: Watch node additions/removals
- `attributes`: Watch attribute changes
- `characterData`: Watch text changes
- `subtree`: Observe all descendants
- `attributeFilter`: Only specific attributes

**Mutation Types:**
- `childList`: Nodes added or removed
- `attributes`: Attributes changed
- `characterData`: Text content changed

**Best Practices:**
- Clear log regularly to prevent overflow (200 max)
- Use filters to reduce noise
- Target specific elements when possible
- Always stop observer when done
