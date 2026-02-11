# Page State Diffing Guide

This guide covers the page state diffing system that captures DOM snapshots and computes diffs between them - enabling Spirit to understand what changed after executing a command.

## Table of Contents

1. [Overview](#overview)
2. [Basic Workflow](#basic-workflow)
3. [Capturing Snapshots](#capturing-snapshots)
4. [Computing Diffs](#computing-diffs)
5. [Diff Response Structure](#diff-response-structure)
6. [Change Types](#change-types)
7. [Snapshot Management](#snapshot-management)
8. [Use Cases](#use-cases)
9. [Advanced Patterns](#advanced-patterns)
10. [Best Practices](#best-practices)

## Overview

The page state diffing system provides:

- **Snapshot capture** - Store lightweight DOM state at any point in time
- **Diff computation** - Compare two snapshots to find changes
- **Change tracking** - Detect added, removed, and modified elements
- **Structured results** - Get detailed change information for each element
- **Automatic storage** - Keep last 10 snapshots automatically

This enables Spirit to understand exactly what changed on a page after executing commands, clicking buttons, or any other interaction.

## Basic Workflow

```javascript
// 1. Capture "before" snapshot
{
  type: "snapshot_capture",
  id: "capture-1",
  snapshotId: "before"
}

// 2. Execute command or interaction
// ... click button, submit form, etc ...

// 3. Capture "after" snapshot
{
  type: "snapshot_capture",
  id: "capture-2",
  snapshotId: "after"
}

// 4. Compute diff
{
  type: "snapshot_diff",
  id: "diff-1",
  beforeId: "before",
  afterId: "after"
}
```

## Capturing Snapshots

### Basic Capture

```javascript
// Auto-generate ID
{
  type: "snapshot_capture",
  id: "capture-1"
}
// Returns: { snapshotId: "snapshot-1", ... }

// Specify custom ID
{
  type: "snapshot_capture",
  id: "capture-2",
  snapshotId: "my-snapshot"
}
```

### Capture Options

```javascript
{
  type: "snapshot_capture",
  id: "capture-3",
  snapshotId: "custom",
  options: {
    includeText: true,        // Include text content (default: true)
    includeAttributes: true,  // Include attributes (default: true)
    maxElements: 500         // Max elements to capture (default: 500)
  }
}
```

### Capture Response

```javascript
{
  type: "skyeyes_result",
  id: "capture-1",
  result: {
    snapshotId: "snapshot-1",
    timestamp: 1234567890,
    elementCount: 245,
    stored: true
  },
  timing: {
    duration: 12,
    timestamp: 1234567890
  }
}
```

## Computing Diffs

### Basic Diff

```javascript
{
  type: "snapshot_diff",
  id: "diff-1",
  beforeId: "before",
  afterId: "after"
}
```

### Diff Response

```javascript
{
  type: "skyeyes_result",
  id: "diff-1",
  result: {
    beforeId: "before",
    afterId: "after",
    beforeTimestamp: 1234567800,
    afterTimestamp: 1234567850,
    timeDelta: 50,

    added: [
      {
        path: "div#content > div.message:nth-child(3)",
        tag: "div",
        id: null,
        classes: ["message", "success"],
        text: "Form submitted successfully!",
        value: null
      }
    ],

    removed: [
      {
        path: "div#content > div.loading:nth-child(2)",
        tag: "div",
        id: null,
        classes: ["loading", "spinner"],
        text: "Loading..."
      }
    ],

    modified: [
      {
        path: "button#submit",
        tag: "button",
        id: "submit",
        changes: [
          {
            field: "text",
            before: "Submit",
            after: "Submitted"
          },
          {
            field: "classes",
            added: ["disabled"],
            removed: []
          },
          {
            field: "attributes",
            changes: [
              { attr: "disabled", before: null, after: "disabled" }
            ]
          }
        ]
      }
    ],

    unchanged: 242,

    viewportChanged: true,
    viewportDiff: {
      before: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 },
      after: { width: 1920, height: 1080, scrollX: 0, scrollY: 350 }
    },

    urlChanged: false,
    titleChanged: false,

    summary: {
      totalChanges: 3,
      addedCount: 1,
      removedCount: 1,
      modifiedCount: 1,
      unchangedCount: 242
    }
  }
}
```

## Change Types

### Added Elements

Elements that exist in "after" but not in "before":

```javascript
{
  path: "div#notifications > div.alert:nth-child(1)",
  tag: "div",
  id: null,
  classes: ["alert", "info"],
  text: "New notification",
  value: null
}
```

### Removed Elements

Elements that exist in "before" but not in "after":

```javascript
{
  path: "div#content > div.error:nth-child(5)",
  tag: "div",
  id: "error-msg",
  classes: ["error", "visible"],
  text: "Error: Invalid input"
}
```

### Modified Elements

Elements that exist in both but have changes:

```javascript
{
  path: "input#username",
  tag: "input",
  id: "username",
  changes: [
    {
      field: "value",
      before: "",
      after: "john.doe"
    },
    {
      field: "classes",
      added: ["valid"],
      removed: ["invalid"]
    },
    {
      field: "attributes",
      changes: [
        { attr: "aria-invalid", before: "true", after: "false" }
      ]
    }
  ]
}
```

## Snapshot Management

### List Snapshots

```javascript
{
  type: "snapshot_list",
  id: "list-1"
}
```

Response:

```javascript
{
  result: {
    count: 3,
    snapshots: [
      {
        id: "before",
        timestamp: 1234567800,
        url: "https://example.com/form",
        title: "Contact Form",
        elementCount: 245,
        viewport: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 }
      },
      {
        id: "after",
        timestamp: 1234567850,
        url: "https://example.com/form",
        title: "Contact Form - Success",
        elementCount: 246,
        viewport: { width: 1920, height: 1080, scrollX: 0, scrollY: 350 }
      }
    ],
    maxSnapshots: 10
  }
}
```

### Clear Snapshots

```javascript
// Clear specific snapshot
{
  type: "snapshot_clear",
  id: "clear-1",
  snapshotId: "before"
}

// Clear all snapshots
{
  type: "snapshot_clear",
  id: "clear-2"
}
```

## Use Cases

### 1. Form Submission Tracking

```javascript
// Before submitting form
await captureSnapshot("before-submit");

// Submit form
await elementClick("button[type=submit]");
await wait(500);

// After submission
await captureSnapshot("after-submit");

// Check what changed
const diff = await computeDiff("before-submit", "after-submit");

if (diff.added.some(el => el.classes.includes('success'))) {
  console.log("Form submitted successfully!");
}

if (diff.added.some(el => el.classes.includes('error'))) {
  console.log("Form submission failed!");
}
```

### 2. Button Click Effects

```javascript
// Before click
await captureSnapshot("before-click");

// Click button
await elementClick("#toggle-button");
await wait(300);

// After click
await captureSnapshot("after-click");

// See what changed
const diff = await computeDiff("before-click", "after-click");

console.log("Changes:", diff.summary.totalChanges);
console.log("Added elements:", diff.added.length);
console.log("Modified elements:", diff.modified.length);
```

### 3. Dynamic Content Loading

```javascript
// Before loading
await captureSnapshot("before-load");

// Trigger load (e.g., scroll to bottom)
await elementScroll(null, { y: 1000 });
await wait(1000);

// After loading
await captureSnapshot("after-load");

// Check for new content
const diff = await computeDiff("before-load", "after-load");

console.log("New elements loaded:", diff.added.length);
for (const el of diff.added) {
  console.log(`  - ${el.tag}.${el.classes.join('.')}: ${el.text}`);
}
```

### 4. Input Validation Tracking

```javascript
// Before input
await captureSnapshot("before-input");

// Type into field
await elementType("input#email", "invalid-email");
await keypress("input#email", "Tab"); // Trigger validation
await wait(200);

// After validation
await captureSnapshot("after-validation");

// Check validation changes
const diff = await computeDiff("before-input", "after-validation");

const validationErrors = diff.added.filter(el =>
  el.classes.includes('error') || el.classes.includes('invalid')
);

console.log("Validation errors:", validationErrors.length);
```

### 5. Modal/Dialog Detection

```javascript
// Before action
await captureSnapshot("before-modal");

// Trigger modal
await elementClick(".open-modal");
await wait(300);

// After modal opens
await captureSnapshot("after-modal");

// Check for modal
const diff = await computeDiff("before-modal", "after-modal");

const modal = diff.added.find(el =>
  el.classes.includes('modal') || el.classes.includes('dialog')
);

if (modal) {
  console.log("Modal opened:", modal.path);
}
```

## Advanced Patterns

### Automated Change Detection

```javascript
async function executeAndDetectChanges(action, description) {
  // Capture before state
  await captureSnapshot("before");

  // Execute action
  await action();

  // Wait for changes to settle
  await wait(500);

  // Capture after state
  await captureSnapshot("after");

  // Compute diff
  const diff = await computeDiff("before", "after");

  console.log(`${description}:`);
  console.log(`  Total changes: ${diff.summary.totalChanges}`);
  console.log(`  Added: ${diff.summary.addedCount}`);
  console.log(`  Removed: ${diff.summary.removedCount}`);
  console.log(`  Modified: ${diff.summary.modifiedCount}`);

  // Clean up
  await clearSnapshot("before");
  await clearSnapshot("after");

  return diff;
}

// Use it
const diff = await executeAndDetectChanges(
  () => elementClick("#load-more"),
  "Load More Button Click"
);
```

### Change Analysis

```javascript
function analyzeChanges(diff) {
  const analysis = {
    hasErrors: false,
    hasSuccess: false,
    hasLoading: false,
    contentAdded: false,
    formChanged: false,
  };

  // Check for error messages
  analysis.hasErrors = diff.added.some(el =>
    el.classes.some(c => c.includes('error') || c.includes('danger'))
  );

  // Check for success messages
  analysis.hasSuccess = diff.added.some(el =>
    el.classes.some(c => c.includes('success') || c.includes('complete'))
  );

  // Check for loading indicators
  analysis.hasLoading = diff.added.some(el =>
    el.classes.some(c => c.includes('loading') || c.includes('spinner'))
  );

  // Check for content additions
  analysis.contentAdded = diff.added.length > 0;

  // Check for form changes
  analysis.formChanged = diff.modified.some(el =>
    ['input', 'textarea', 'select'].includes(el.tag)
  );

  return analysis;
}
```

### Tracking Multi-Step Workflows

```javascript
async function trackWorkflow(steps) {
  const snapshots = [];
  const diffs = [];

  // Capture initial state
  await captureSnapshot("step-0");
  snapshots.push("step-0");

  // Execute each step and capture state
  for (let i = 0; i < steps.length; i++) {
    await steps[i].action();
    await wait(steps[i].waitTime || 500);

    const snapshotId = `step-${i + 1}`;
    await captureSnapshot(snapshotId);
    snapshots.push(snapshotId);

    // Compute diff from previous step
    const diff = await computeDiff(`step-${i}`, snapshotId);
    diffs.push({
      step: steps[i].name,
      diff: diff,
    });

    console.log(`Step ${i + 1}: ${steps[i].name}`);
    console.log(`  Changes: ${diff.summary.totalChanges}`);
  }

  return { snapshots, diffs };
}

// Use it
const workflow = await trackWorkflow([
  { name: "Fill username", action: () => elementType("#username", "admin") },
  { name: "Fill password", action: () => elementType("#password", "pass123") },
  { name: "Submit form", action: () => elementClick("#submit") },
]);
```

### Viewport Change Tracking

```javascript
async function trackScrollEffect(scrollAmount) {
  await captureSnapshot("before-scroll");

  await elementScroll(null, { y: scrollAmount });
  await wait(500);

  await captureSnapshot("after-scroll");

  const diff = await computeDiff("before-scroll", "after-scroll");

  if (diff.viewportChanged) {
    console.log("Viewport changed:");
    console.log(`  ScrollY: ${diff.viewportDiff.before.scrollY} -> ${diff.viewportDiff.after.scrollY}`);
  }

  if (diff.added.length > 0) {
    console.log("New elements visible after scroll:", diff.added.length);
  }

  return diff;
}
```

## Best Practices

1. **Use meaningful snapshot IDs**: Name snapshots to indicate their purpose (e.g., "before-submit", "after-click")

2. **Wait for animations**: Add small delays after actions to let DOM settle before capturing

3. **Clean up snapshots**: Clear snapshots you no longer need to free memory

4. **Limit element count**: Use `maxElements` option for large pages to improve performance

5. **Check summary first**: Look at `diff.summary` before diving into detailed changes

6. **Handle errors**: Always check if snapshots exist before computing diffs

7. **Combine with visual snapshots**: Use page diffs for structure changes, visual snapshots for layout understanding

## Integration with Spirit

Spirit can use page diffs to understand command effects:

```javascript
async function executeCommandAndVerify(command, expectedChange) {
  // Capture before state
  await send({ type: "snapshot_capture", snapshotId: "before" });

  // Execute command
  await executeTerminalCommand(command);

  // Capture after state
  await send({ type: "snapshot_capture", snapshotId: "after" });

  // Compute diff
  const result = await send({
    type: "snapshot_diff",
    beforeId: "before",
    afterId: "after"
  });

  const diff = result.result;

  // Verify expected change
  if (expectedChange.type === "element-added") {
    const found = diff.added.some(el =>
      el.classes.includes(expectedChange.className)
    );
    return found ? "success" : "failed";
  }

  if (expectedChange.type === "text-changed") {
    const found = diff.modified.some(el =>
      el.changes.some(c => c.field === "text")
    );
    return found ? "success" : "failed";
  }

  return "unknown";
}
```

## Limitations

- **Snapshot storage**: Limited to last 10 snapshots (automatically removes oldest)
- **Element limit**: Default 500 elements per snapshot (configurable)
- **Path matching**: Elements identified by path - structure changes may break matching
- **Dynamic content**: Very dynamic pages may have many changes
- **Memory**: Large snapshots consume memory - clear when done

## Debugging

### View Snapshot Details

```javascript
const list = await send({ type: "snapshot_list" });
console.log("Stored snapshots:", list.result.snapshots);

for (const snap of list.result.snapshots) {
  console.log(`${snap.id}: ${snap.elementCount} elements at ${snap.timestamp}`);
}
```

### Analyze Diff Details

```javascript
const diff = await send({
  type: "snapshot_diff",
  beforeId: "before",
  afterId: "after"
});

console.log("=== Diff Summary ===");
console.log(`Total changes: ${diff.result.summary.totalChanges}`);
console.log(`Time delta: ${diff.result.timeDelta}ms`);

console.log("\n=== Added Elements ===");
for (const el of diff.result.added) {
  console.log(`+ ${el.path}`);
  console.log(`  ${el.tag} [${el.classes.join(', ')}]`);
  if (el.text) console.log(`  Text: "${el.text}"`);
}

console.log("\n=== Removed Elements ===");
for (const el of diff.result.removed) {
  console.log(`- ${el.path}`);
}

console.log("\n=== Modified Elements ===");
for (const el of diff.result.modified) {
  console.log(`~ ${el.path}`);
  for (const change of el.changes) {
    console.log(`  ${change.field}: ${JSON.stringify(change)}`);
  }
}
```

## Summary

The page state diffing system provides:

✅ **Snapshot capture** - Store lightweight DOM state at any point
✅ **Diff computation** - Compare snapshots to find changes
✅ **Added elements** - Detect new elements in DOM
✅ **Removed elements** - Detect deleted elements
✅ **Modified elements** - Track changes to text, values, classes, attributes
✅ **Viewport tracking** - Detect scroll and size changes
✅ **Automatic storage** - Keep last 10 snapshots
✅ **Structured output** - Detailed change information for analysis

This enables Spirit to understand exactly what changed after executing commands, making it possible to verify actions, detect errors, and track dynamic content changes.
