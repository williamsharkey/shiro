# Visual Snapshot Guide

This guide covers the visual snapshot capability that captures the current visual state of the page as a structured description - providing Spirit with a way to "see" the page without actual pixel screenshots.

## Table of Contents

1. [Overview](#overview)
2. [Basic Usage](#basic-usage)
3. [Response Structure](#response-structure)
4. [Options](#options)
5. [Visual Tree](#visual-tree)
6. [Visible Text](#visible-text)
7. [Interactive Elements](#interactive-elements)
8. [Layout Zones](#layout-zones)
9. [Use Cases](#use-cases)
10. [Advanced Patterns](#advanced-patterns)

## Overview

The visual snapshot captures the page's visual state as a structured JSON description including:

- **Visual DOM tree** - Hierarchical structure with layout positions
- **Visible text** - All readable text with positions
- **Interactive elements** - Buttons, links, inputs with locations
- **Layout zones** - Header, sidebar, main content, footer detection
- **Viewport info** - Window size, scroll position, device pixel ratio
- **Document info** - Page dimensions, title, URL, ready state

This gives Spirit a comprehensive understanding of what the page looks like without requiring actual pixel screenshots.

## Basic Usage

### Simple Snapshot

```javascript
{
  type: "visual_snapshot",
  id: "snapshot-1"
}
```

### With Options

```javascript
{
  type: "visual_snapshot",
  id: "snapshot-2",
  options: {
    maxDepth: 5,
    includeHidden: false,
    includeStyles: true,
    maxElements: 100
  }
}
```

## Response Structure

```javascript
{
  type: "skyeyes_result",
  id: "snapshot-1",
  result: {
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
      title: "Example Page",
      url: "https://example.com",
      readyState: "complete"
    },
    visualTree: {
      tag: "body",
      depth: 0,
      visible: true,
      rect: { x: 0, y: 0, width: 1920, height: 3500 },
      text: "",
      children: [...]
    },
    visibleText: [
      {
        text: "Welcome to Example",
        tag: "h1",
        x: 100,
        y: 50,
        fontSize: "32px"
      },
      ...
    ],
    interactiveElements: [
      {
        tag: "button",
        type: "button",
        id: "submit-btn",
        classes: ["btn", "btn-primary"],
        text: "Submit",
        rect: { x: 200, y: 500, width: 120, height: 40 },
        selector: "#submit-btn"
      },
      ...
    ],
    layoutZones: {
      header: { y: 0, height: 80, width: 1920 },
      sidebar: { x: 0, y: 80, width: 250, height: 3420, position: "left" },
      main: { x: 250, y: 80, width: 1670, height: 3420 },
      footer: { y: 3420, height: 80, width: 1920 }
    },
    timestamp: 1234567890
  },
  timing: {
    duration: 45,
    timestamp: 1234567890
  }
}
```

## Options

### maxDepth (default: 10)

Maximum depth of the visual tree traversal:

```javascript
{
  type: "visual_snapshot",
  options: { maxDepth: 5 }  // Shallow tree (faster)
}

{
  type: "visual_snapshot",
  options: { maxDepth: 15 }  // Deep tree (more detail)
}
```

### includeHidden (default: false)

Include hidden elements in the visual tree:

```javascript
{
  type: "visual_snapshot",
  options: { includeHidden: true }  // Include display:none elements
}
```

### includeStyles (default: true)

Include computed styles for visible elements:

```javascript
{
  type: "visual_snapshot",
  options: { includeStyles: false }  // Faster, less detail
}
```

### maxElements (default: 200)

Limit number of elements processed:

```javascript
{
  type: "visual_snapshot",
  options: { maxElements: 50 }   // Fast, minimal
}

{
  type: "visual_snapshot",
  options: { maxElements: 500 }  // Comprehensive
}
```

## Visual Tree

The visual tree is a hierarchical representation of visible elements with layout information.

### Tree Node Structure

```javascript
{
  tag: "div",           // Element tag name
  depth: 2,             // Depth in tree (0 = root)
  visible: true,        // Is element visible?
  rect: {               // Position and size
    x: 100,             // Absolute X position (scrolled)
    y: 200,             // Absolute Y position (scrolled)
    width: 500,         // Width in pixels
    height: 300         // Height in pixels
  },
  text: "Hello",        // Direct text content (not children)
  id: "container",      // Element ID (if present)
  classes: ["box", "highlight"],  // CSS classes
  styles: {             // Computed styles (if includeStyles: true)
    display: "block",
    position: "relative",
    zIndex: "auto",
    backgroundColor: "rgb(255, 255, 255)",
    color: "rgb(0, 0, 0)",
    fontSize: "16px",
    fontWeight: "400"
  },
  children: [...],      // Child nodes
  childCount: 3         // Number of children
}
```

### Special Attributes

For interactive elements:

```javascript
// Links
{
  tag: "a",
  href: "https://example.com/page",
  interactive: true,
  ...
}

// Inputs
{
  tag: "input",
  inputType: "text",
  value: "current value",
  placeholder: "Enter text...",
  ...
}

// Buttons
{
  tag: "button",
  interactive: true,
  ...
}

// ARIA roles
{
  tag: "div",
  role: "button",
  interactive: true,
  ...
}
```

## Visible Text

All visible text content with positions:

```javascript
visibleText: [
  {
    text: "Welcome to our site",  // Text content (max 200 chars)
    tag: "h1",                     // Element tag
    x: 100,                        // Absolute X position
    y: 50,                         // Absolute Y position
    fontSize: "32px"               // Font size
  },
  {
    text: "This is a paragraph of text...",
    tag: "p",
    x: 100,
    y: 120,
    fontSize: "16px"
  }
]
```

### Use Cases

- **Text extraction**: Get all readable content
- **Content analysis**: Understand page structure
- **Search**: Find text positions for scrolling
- **Reading order**: Approximate reading flow by Y positions

## Interactive Elements

All clickable, focusable, and interactive elements:

```javascript
interactiveElements: [
  {
    tag: "button",
    type: "button",
    id: "submit",
    classes: ["btn", "btn-primary", "large"],
    text: "Submit Form",
    rect: { x: 200, y: 500, width: 120, height: 40 },
    selector: "#submit"
  },
  {
    tag: "a",
    type: "interactive",
    id: null,
    classes: ["nav-link"],
    text: "Home",
    rect: { x: 50, y: 20, width: 60, height: 30 },
    selector: "a.nav-link:nth-child(1)"
  },
  {
    tag: "input",
    type: "text",
    id: "username",
    classes: ["form-control"],
    text: "",
    rect: { x: 100, y: 200, width: 300, height: 40 },
    selector: "#username"
  }
]
```

### Interactive Element Types

Automatically detected:
- `<button>` elements
- `<a href="...">` links
- `<input>`, `<textarea>`, `<select>` form elements
- Elements with `onclick` handlers
- Elements with `role="button"` or `role="link"`
- Elements with `tabindex` attribute

## Layout Zones

Automatic detection of common layout patterns:

```javascript
layoutZones: {
  header: {
    y: 0,           // Y position
    height: 80,     // Height in pixels
    width: 1920     // Width in pixels
  },
  sidebar: {
    x: 0,           // X position
    y: 80,          // Y position
    width: 250,     // Width in pixels
    height: 3420,   // Height in pixels
    position: "left" // "left" or "right"
  },
  main: {
    x: 250,
    y: 80,
    width: 1670,
    height: 3420
  },
  footer: {
    y: 3420,
    height: 80,
    width: 1920
  }
}
```

### Detection Heuristics

- **Header**: `<header>`, `[role="banner"]`, `<nav>` in top 20% of viewport
- **Footer**: `<footer>`, `[role="contentinfo"]` in bottom 20% of viewport
- **Main**: `<main>`, `[role="main"]`, `<article>` elements
- **Sidebar**: `<aside>`, `[role="complementary"]` less than 30% viewport width

**Note**: Any zone can be `null` if not detected.

## Use Cases

### 1. Understanding Page Layout

```javascript
const snapshot = await getVisualSnapshot();

// Check if page has sidebar
if (snapshot.layoutZones.sidebar) {
  console.log("Sidebar detected on", snapshot.layoutZones.sidebar.position);
}

// Find main content area
const mainArea = snapshot.layoutZones.main;
console.log("Main content is", mainArea.width, "x", mainArea.height);
```

### 2. Finding Visible Buttons

```javascript
const snapshot = await getVisualSnapshot();

// Get all visible buttons
const buttons = snapshot.interactiveElements.filter(el =>
  el.tag === 'button' || el.type === 'button'
);

// Find submit button
const submitBtn = buttons.find(btn =>
  btn.text.toLowerCase().includes('submit')
);

console.log("Submit button at:", submitBtn.rect);
console.log("Selector:", submitBtn.selector);
```

### 3. Extracting All Text

```javascript
const snapshot = await getVisualSnapshot();

// Get all text in reading order (top to bottom)
const textInOrder = snapshot.visibleText
  .sort((a, b) => a.y - b.y)
  .map(block => block.text)
  .join('\n');

console.log("Page content:\n", textInOrder);
```

### 4. Locating Elements by Position

```javascript
const snapshot = await getVisualSnapshot();

// Find element at specific position (e.g., clicked position)
function findElementAt(x, y) {
  for (const el of snapshot.interactiveElements) {
    const r = el.rect;
    if (x >= r.x && x <= r.x + r.width &&
        y >= r.y && y <= r.y + r.height) {
      return el;
    }
  }
  return null;
}

const element = findElementAt(500, 300);
console.log("Element at (500, 300):", element?.selector);
```

### 5. Checking Viewport Coverage

```javascript
const snapshot = await getVisualSnapshot();

// Check if element is in current viewport
function isInViewport(element) {
  const vp = snapshot.viewport;
  const rect = element.rect;

  return rect.x < vp.scrollX + vp.width &&
         rect.x + rect.width > vp.scrollX &&
         rect.y < vp.scrollY + vp.height &&
         rect.y + rect.height > vp.scrollY;
}

// Find buttons in current viewport
const visibleButtons = snapshot.interactiveElements.filter(isInViewport);
console.log(visibleButtons.length, "buttons visible in viewport");
```

## Advanced Patterns

### Tree Traversal

Walk the visual tree to analyze structure:

```javascript
function traverseTree(node, callback, depth = 0) {
  callback(node, depth);

  if (node.children) {
    for (const child of node.children) {
      traverseTree(child, callback, depth + 1);
    }
  }
}

// Example: Find all headings
const headings = [];
traverseTree(snapshot.visualTree, (node) => {
  if (node.tag?.match(/^h[1-6]$/)) {
    headings.push({
      level: node.tag,
      text: node.text,
      position: node.rect
    });
  }
});
```

### Layout Analysis

Analyze page layout patterns:

```javascript
const snapshot = await getVisualSnapshot();

// Detect multi-column layout
function detectColumns() {
  const elements = [];
  traverseTree(snapshot.visualTree, (node) => {
    if (node.rect.width > 200 && node.rect.height > 500) {
      elements.push(node);
    }
  });

  // Group by X position
  const columns = {};
  for (const el of elements) {
    const x = Math.round(el.rect.x / 100) * 100; // Round to 100px
    columns[x] = columns[x] || [];
    columns[x].push(el);
  }

  return Object.keys(columns).length;
}

console.log("Page has", detectColumns(), "columns");
```

### Accessibility Check

Check for accessibility features:

```javascript
const snapshot = await getVisualSnapshot();

// Find elements with ARIA roles
function findAriaElements() {
  const ariaElements = [];
  traverseTree(snapshot.visualTree, (node) => {
    if (node.role) {
      ariaElements.push({
        role: node.role,
        tag: node.tag,
        text: node.text
      });
    }
  });
  return ariaElements;
}

// Check interactive elements for labels
function checkLabels() {
  const unlabeled = snapshot.interactiveElements.filter(el =>
    !el.text && !el.id && el.tag === 'input'
  );
  return unlabeled;
}
```

### Performance-Aware Snapshots

Optimize for large pages:

```javascript
// Minimal snapshot for quick analysis
{
  type: "visual_snapshot",
  options: {
    maxDepth: 3,
    includeStyles: false,
    maxElements: 50
  }
}

// Full snapshot for comprehensive analysis
{
  type: "visual_snapshot",
  options: {
    maxDepth: 15,
    includeStyles: true,
    maxElements: 500
  }
}

// Just interactive elements
{
  type: "visual_snapshot",
  options: {
    maxDepth: 1,
    includeStyles: false,
    maxElements: 200
  }
}
// Then use: snapshot.interactiveElements
```

## Integration with Spirit

Spirit can use visual snapshots to understand pages:

```javascript
async function analyzePageStructure() {
  // Get visual snapshot
  const snapshot = await getVisualSnapshot({
    maxDepth: 10,
    includeStyles: true
  });

  // Understand layout
  const layout = {
    hasHeader: !!snapshot.layoutZones.header,
    hasSidebar: !!snapshot.layoutZones.sidebar,
    hasFooter: !!snapshot.layoutZones.footer,
    mainContentArea: snapshot.layoutZones.main
  };

  // Find navigation
  const navLinks = snapshot.interactiveElements.filter(el =>
    el.tag === 'a' &&
    el.rect.y < 100  // In header area
  );

  // Find forms
  const formInputs = snapshot.interactiveElements.filter(el =>
    el.tag === 'input' || el.tag === 'textarea'
  );

  // Get page content
  const content = snapshot.visibleText
    .filter(text => text.y > 100 && text.y < snapshot.document.height - 100)
    .map(t => t.text)
    .join('\n');

  return {
    layout,
    navigation: navLinks,
    forms: formInputs,
    content
  };
}
```

## Debugging

### Visualize Snapshot

Create a visual representation:

```javascript
function visualizeSnapshot(snapshot) {
  console.log("=== Page Visual Snapshot ===");
  console.log(`Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}`);
  console.log(`Document: ${snapshot.document.width}x${snapshot.document.height}`);
  console.log(`Scroll: (${snapshot.viewport.scrollX}, ${snapshot.viewport.scrollY})`);

  console.log("\nLayout Zones:");
  Object.entries(snapshot.layoutZones).forEach(([zone, rect]) => {
    if (rect) {
      console.log(`  ${zone}:`, rect);
    }
  });

  console.log(`\nVisible Text: ${snapshot.visibleText.length} blocks`);
  console.log(`Interactive Elements: ${snapshot.interactiveElements.length}`);

  console.log("\nTop 5 Interactive Elements:");
  snapshot.interactiveElements.slice(0, 5).forEach(el => {
    console.log(`  ${el.tag}#${el.id || 'no-id'}: "${el.text}" at (${el.rect.x}, ${el.rect.y})`);
  });
}
```

### Compare Snapshots

Detect changes between snapshots:

```javascript
function compareSnapshots(before, after) {
  const changes = {
    viewportChanged: before.viewport.scrollY !== after.viewport.scrollY,
    newElements: after.interactiveElements.length - before.interactiveElements.length,
    textChanged: before.visibleText.length !== after.visibleText.length,
  };

  return changes;
}
```

## Best Practices

1. **Choose appropriate maxDepth**: Deeper trees take longer, use 5-10 for most cases
2. **Limit maxElements**: Large pages can have thousands of elements, limit to 200-500
3. **Skip styles when not needed**: `includeStyles: false` is much faster
4. **Use for understanding, not pixel-perfect**: This is semantic/structural, not visual rendering
5. **Cache snapshots**: Take snapshot once, use multiple times
6. **Filter results**: Focus on relevant elements (interactive, visible text, etc.)
7. **Combine with queries**: Use querySelector for precise element selection

## Limitations

- **No actual pixels**: This is a semantic description, not image data
- **Layout approximation**: Complex CSS layouts may not be perfectly represented
- **Dynamic content**: Snapshot is point-in-time, doesn't track changes
- **Computed styles**: Only captures computed styles, not all CSS rules
- **Hidden elements**: By default excludes `display: none`, `visibility: hidden`
- **Performance**: Large pages with many elements may be slow

## Summary

The visual snapshot provides:

✅ **Structured page representation** - Visual tree with layout positions
✅ **Visible text extraction** - All readable content with positions
✅ **Interactive element detection** - Buttons, links, inputs with selectors
✅ **Layout zone detection** - Header, sidebar, main, footer identification
✅ **Viewport awareness** - Window size, scroll position, device pixel ratio
✅ **Accessibility info** - ARIA roles, interactive attributes

This enables Spirit to "see" and understand web pages without actual screenshot images, making intelligent decisions about navigation, interaction, and content extraction.
