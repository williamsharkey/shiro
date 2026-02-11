# Visual Snapshot Quick Reference

Copy-paste ready code for visual page snapshots.

## Basic Snapshot

```javascript
// Simple snapshot
{
  type: "visual_snapshot",
  id: "snap-1"
}

// With options
{
  type: "visual_snapshot",
  id: "snap-2",
  options: {
    maxDepth: 10,
    includeHidden: false,
    includeStyles: true,
    maxElements: 200
  }
}
```

## Response Structure

```javascript
{
  viewport: {
    width: 1920,
    height: 1080,
    scrollX: 0,
    scrollY: 450,
    devicePixelRatio: 2
  },
  document: {
    width: 1920,
    height: 3500,
    title: "Page Title",
    url: "https://example.com",
    readyState: "complete"
  },
  visualTree: {
    tag: "body",
    depth: 0,
    visible: true,
    rect: { x: 0, y: 0, width: 1920, height: 3500 },
    children: [...]
  },
  visibleText: [...],
  interactiveElements: [...],
  layoutZones: {...}
}
```

## Common Patterns

### Find All Buttons

```javascript
const snapshot = await getVisualSnapshot();
const buttons = snapshot.interactiveElements.filter(el =>
  el.tag === 'button' || el.type === 'button'
);
```

### Extract All Text

```javascript
const snapshot = await getVisualSnapshot();
const text = snapshot.visibleText
  .sort((a, b) => a.y - b.y)
  .map(t => t.text)
  .join('\n');
```

### Check Layout

```javascript
const snapshot = await getVisualSnapshot();
const hasHeader = !!snapshot.layoutZones.header;
const hasSidebar = !!snapshot.layoutZones.sidebar;
const mainArea = snapshot.layoutZones.main;
```

### Find Element at Position

```javascript
function findElementAt(snapshot, x, y) {
  for (const el of snapshot.interactiveElements) {
    const r = el.rect;
    if (x >= r.x && x <= r.x + r.width &&
        y >= r.y && y <= r.y + r.height) {
      return el;
    }
  }
  return null;
}

const element = findElementAt(snapshot, 500, 300);
```

### Check if in Viewport

```javascript
function isInViewport(snapshot, element) {
  const vp = snapshot.viewport;
  const r = element.rect;

  return r.x < vp.scrollX + vp.width &&
         r.x + r.width > vp.scrollX &&
         r.y < vp.scrollY + vp.height &&
         r.y + r.height > vp.scrollY;
}
```

### Tree Traversal

```javascript
function traverseTree(node, callback, depth = 0) {
  callback(node, depth);
  if (node.children) {
    for (const child of node.children) {
      traverseTree(child, callback, depth + 1);
    }
  }
}

// Find all headings
const headings = [];
traverseTree(snapshot.visualTree, (node) => {
  if (node.tag?.match(/^h[1-6]$/)) {
    headings.push({ level: node.tag, text: node.text });
  }
});
```

## Options Reference

```javascript
// Fast, minimal
{
  options: {
    maxDepth: 3,
    includeStyles: false,
    maxElements: 50
  }
}

// Comprehensive
{
  options: {
    maxDepth: 15,
    includeStyles: true,
    maxElements: 500
  }
}

// Include hidden elements
{
  options: {
    includeHidden: true
  }
}
```

## Visual Tree Node

```javascript
{
  tag: "div",
  depth: 2,
  visible: true,
  rect: { x: 100, y: 200, width: 500, height: 300 },
  text: "Hello",
  id: "container",
  classes: ["box", "highlight"],
  styles: {
    display: "block",
    position: "relative",
    backgroundColor: "rgb(255, 255, 255)",
    color: "rgb(0, 0, 0)",
    fontSize: "16px"
  },
  children: [...],
  childCount: 3
}
```

## Interactive Element

```javascript
{
  tag: "button",
  type: "button",
  id: "submit",
  classes: ["btn", "primary"],
  text: "Submit",
  rect: { x: 200, y: 500, width: 120, height: 40 },
  selector: "#submit"
}
```

## Layout Zones

```javascript
{
  header: { y: 0, height: 80, width: 1920 },
  sidebar: { x: 0, y: 80, width: 250, height: 3420, position: "left" },
  main: { x: 250, y: 80, width: 1670, height: 3420 },
  footer: { y: 3420, height: 80, width: 1920 }
}
```

## Spirit Integration

```javascript
async function analyzePageStructure() {
  const snapshot = await getVisualSnapshot();

  // Understand layout
  const layout = {
    hasHeader: !!snapshot.layoutZones.header,
    hasSidebar: !!snapshot.layoutZones.sidebar,
    hasFooter: !!snapshot.layoutZones.footer
  };

  // Find navigation
  const navLinks = snapshot.interactiveElements.filter(el =>
    el.tag === 'a' && el.rect.y < 100
  );

  // Get page content
  const content = snapshot.visibleText
    .filter(t => t.y > 100)
    .map(t => t.text)
    .join('\n');

  return { layout, navLinks, content };
}
```

## Performance Tips

1. Use `maxDepth: 5-10` for most cases
2. Set `maxElements: 200` for large pages
3. Use `includeStyles: false` when not needed
4. Cache snapshots and reuse them
5. Filter results to relevant elements only
