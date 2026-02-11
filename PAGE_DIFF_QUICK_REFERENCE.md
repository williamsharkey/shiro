# Page State Diffing Quick Reference

Copy-paste ready code for page state diffing and change tracking.

## Basic Workflow

```javascript
// 1. Capture before state
{
  type: "snapshot_capture",
  id: "cap-1",
  snapshotId: "before"
}

// 2. Execute action
// ... (click, type, etc.) ...

// 3. Capture after state
{
  type: "snapshot_capture",
  id: "cap-2",
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

## Capture Snapshot

```javascript
// Auto-generate ID
{
  type: "snapshot_capture",
  id: "cap-1"
}

// Custom ID
{
  type: "snapshot_capture",
  id: "cap-2",
  snapshotId: "my-snapshot"
}

// With options
{
  type: "snapshot_capture",
  id: "cap-3",
  snapshotId: "detailed",
  options: {
    includeText: true,
    includeAttributes: true,
    maxElements: 500
  }
}
```

## Compute Diff

```javascript
{
  type: "snapshot_diff",
  id: "diff-1",
  beforeId: "before",
  afterId: "after"
}
```

## Diff Response

```javascript
{
  beforeId: "before",
  afterId: "after",
  beforeTimestamp: 1234567800,
  afterTimestamp: 1234567850,
  timeDelta: 50,

  added: [
    {
      path: "div#content > div.message:nth-child(3)",
      tag: "div",
      classes: ["message", "success"],
      text: "Success!"
    }
  ],

  removed: [
    {
      path: "div#content > div.loading",
      tag: "div",
      classes: ["loading"]
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
        }
      ]
    }
  ],

  unchanged: 242,

  summary: {
    totalChanges: 3,
    addedCount: 1,
    removedCount: 1,
    modifiedCount: 1,
    unchangedCount: 242
  }
}
```

## Snapshot Management

```javascript
// List all snapshots
{
  type: "snapshot_list",
  id: "list-1"
}

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

## Common Patterns

### Form Submission Tracking

```javascript
// Before submit
await send({ type: "snapshot_capture", snapshotId: "before-submit" });

// Submit
await send({ type: "element_click", selector: "button[type=submit]" });
await wait(500);

// After submit
await send({ type: "snapshot_capture", snapshotId: "after-submit" });

// Check changes
const diff = await send({
  type: "snapshot_diff",
  beforeId: "before-submit",
  afterId: "after-submit"
});

// Look for success/error messages
const hasSuccess = diff.result.added.some(el =>
  el.classes.includes('success')
);
```

### Button Click Effects

```javascript
await send({ type: "snapshot_capture", snapshotId: "before" });
await send({ type: "element_click", selector: "#my-button" });
await wait(300);
await send({ type: "snapshot_capture", snapshotId: "after" });

const diff = await send({
  type: "snapshot_diff",
  beforeId: "before",
  afterId: "after"
});

console.log("Changes:", diff.result.summary.totalChanges);
```

### Content Loading Detection

```javascript
await send({ type: "snapshot_capture", snapshotId: "before-load" });

// Trigger load
await send({ type: "element_scroll", y: 1000 });
await wait(1000);

await send({ type: "snapshot_capture", snapshotId: "after-load" });

const diff = await send({
  type: "snapshot_diff",
  beforeId: "before-load",
  afterId: "after-load"
});

console.log("New elements:", diff.result.added.length);
```

### Validation Tracking

```javascript
await send({ type: "snapshot_capture", snapshotId: "before" });
await send({ type: "element_type", selector: "#email", text: "invalid" });
await send({ type: "element_keypress", selector: "#email", key: "Tab" });
await wait(200);
await send({ type: "snapshot_capture", snapshotId: "after" });

const diff = await send({
  type: "snapshot_diff",
  beforeId: "before",
  afterId: "after"
});

const errors = diff.result.added.filter(el =>
  el.classes.includes('error')
);
```

## Change Analysis

```javascript
function analyzeChanges(diff) {
  return {
    hasErrors: diff.added.some(el =>
      el.classes.some(c => c.includes('error'))
    ),
    hasSuccess: diff.added.some(el =>
      el.classes.some(c => c.includes('success'))
    ),
    hasLoading: diff.added.some(el =>
      el.classes.some(c => c.includes('loading'))
    ),
    contentAdded: diff.added.length > 0,
    formChanged: diff.modified.some(el =>
      ['input', 'textarea', 'select'].includes(el.tag)
    )
  };
}
```

## Execute and Track

```javascript
async function executeAndTrack(action, description) {
  await send({ type: "snapshot_capture", snapshotId: "before" });
  await action();
  await wait(500);
  await send({ type: "snapshot_capture", snapshotId: "after" });

  const diff = await send({
    type: "snapshot_diff",
    beforeId: "before",
    afterId: "after"
  });

  console.log(`${description}:`);
  console.log(`  Total changes: ${diff.result.summary.totalChanges}`);
  console.log(`  Added: ${diff.result.summary.addedCount}`);
  console.log(`  Removed: ${diff.result.summary.removedCount}`);

  return diff;
}
```

## Debug Diff

```javascript
function debugDiff(diff) {
  console.log("=== Diff Summary ===");
  console.log(`Total: ${diff.summary.totalChanges}`);
  console.log(`Time: ${diff.timeDelta}ms`);

  console.log("\n=== Added ===");
  diff.added.forEach(el => {
    console.log(`+ ${el.path}`);
    console.log(`  ${el.tag} [${el.classes.join(', ')}]`);
  });

  console.log("\n=== Removed ===");
  diff.removed.forEach(el => {
    console.log(`- ${el.path}`);
  });

  console.log("\n=== Modified ===");
  diff.modified.forEach(el => {
    console.log(`~ ${el.path}`);
    el.changes.forEach(c => {
      console.log(`  ${c.field}: ${JSON.stringify(c)}`);
    });
  });
}
```

## Best Practices

1. Use meaningful snapshot IDs
2. Wait after actions (300-500ms)
3. Clear snapshots when done
4. Check summary before details
5. Combine with visual snapshots for layout
