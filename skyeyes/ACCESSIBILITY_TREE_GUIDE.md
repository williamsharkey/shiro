# Accessibility Tree Guide

This guide covers the accessibility tree extraction feature that provides a simplified, AI-friendly representation of page structure - more useful than raw DOM for navigation and understanding.

## Table of Contents

1. [Overview](#overview)
2. [Basic Usage](#basic-usage)
3. [Response Structure](#response-structure)
4. [Accessibility Tree](#accessibility-tree)
5. [Landmarks](#landmarks)
6. [Headings](#headings)
7. [Interactive Elements](#interactive-elements)
8. [Forms](#forms)
9. [Navigation](#navigation)
10. [Use Cases](#use-cases)
11. [Advanced Patterns](#advanced-patterns)

## Overview

The accessibility tree provides a semantic, AI-friendly view of the page including:

- **Accessibility tree** - Hierarchical structure with roles, names, and states
- **Landmarks** - Page regions (banner, navigation, main, complementary, contentinfo)
- **Headings** - Document outline with heading levels
- **Interactive elements** - Buttons, links, inputs with their roles and states
- **Forms** - Form fields organized by form with labels and types
- **Navigation** - Navigation menus with links

This is much more useful than raw DOM for AI agents because it focuses on semantic meaning and user-facing functionality rather than implementation details.

## Basic Usage

```javascript
// Simple extraction
{
  type: "accessibility_tree",
  id: "a11y-1"
}

// With options
{
  type: "accessibility_tree",
  id: "a11y-2",
  options: {
    maxDepth: 15,
    includeHidden: false,
    includePositions: true
  }
}
```

## Response Structure

```javascript
{
  type: "skyeyes_result",
  id: "a11y-1",
  result: {
    tree: {
      role: "generic",
      name: null,
      tag: "body",
      depth: 0,
      visible: true,
      children: [...]
    },

    landmarks: [
      {
        role: "banner",
        name: "Site Header",
        tag: "header",
        selector: "header.site-header",
        rect: { x: 0, y: 0, width: 1920, height: 80 }
      },
      {
        role: "navigation",
        name: "Main Navigation",
        tag: "nav",
        selector: "nav#main-nav",
        rect: { x: 0, y: 80, width: 1920, height: 60 }
      },
      {
        role: "main",
        name: null,
        tag: "main",
        selector: "main",
        rect: { x: 0, y: 140, width: 1920, height: 2000 }
      }
    ],

    headings: [
      {
        level: 1,
        text: "Welcome to Example Site",
        tag: "h1",
        selector: "h1.page-title",
        rect: { x: 100, y: 200 }
      },
      {
        level: 2,
        text: "Getting Started",
        tag: "h2",
        selector: "h2#getting-started",
        rect: { x: 100, y: 350 }
      }
    ],

    interactive: [
      {
        role: "button",
        name: "Submit Form",
        tag: "button",
        states: { disabled: false },
        selector: "button#submit",
        focusable: true
      },
      {
        role: "link",
        name: "Learn More",
        tag: "a",
        states: {},
        selector: "a.learn-more",
        focusable: true
      }
    ],

    forms: [
      {
        name: "Contact Form",
        action: "/submit",
        method: "post",
        fieldCount: 3,
        fields: [
          {
            role: "textbox",
            name: "Your Name",
            tag: "input",
            type: "text",
            value: "",
            placeholder: "Enter your name",
            required: true,
            selector: "input#name"
          }
        ],
        selector: "form#contact"
      }
    ],

    navigation: [
      {
        name: "Main Menu",
        linkCount: 5,
        links: [
          {
            text: "Home",
            href: "/",
            current: "page",
            selector: "nav a:nth-child(1)"
          },
          {
            text: "About",
            href: "/about",
            current: null,
            selector: "nav a:nth-child(2)"
          }
        ],
        selector: "nav#main-nav"
      }
    ],

    metadata: {
      title: "Example Site",
      url: "https://example.com",
      lang: "en",
      dir: "ltr"
    }
  }
}
```

## Accessibility Tree

The tree provides a hierarchical view of page structure with semantic roles:

### Tree Node Structure

```javascript
{
  role: "button",              // ARIA role or implicit role
  name: "Submit Form",         // Accessible name (aria-label, label, text, etc.)
  tag: "button",              // HTML tag
  depth: 3,                   // Depth in tree
  visible: true,              // Is element visible?
  description: null,          // aria-describedby or aria-description
  states: {                   // ARIA states and properties
    disabled: false,
    pressed: false,
    expanded: false
  },
  rect: {                     // Position (if includePositions: true)
    x: 200,
    y: 500,
    width: 120,
    height: 40
  },
  interactive: true,          // Is element interactive?
  focusable: true,           // Can receive focus?
  value: null,               // Value for form elements
  inputType: null,           // Type for input elements
  href: null,                // href for links
  level: null,               // Level for headings (1-6)
  id: "submit-btn",          // Element ID
  classes: ["btn", "primary"], // CSS classes (max 3)
  selector: "#submit-btn",   // Generated CSS selector
  children: [...],           // Child nodes
  childCount: 0              // Number of children
}
```

### Roles

Automatically detected roles include:

**Landmarks:**
- `banner` (header)
- `navigation` (nav)
- `main` (main)
- `complementary` (aside)
- `contentinfo` (footer)
- `region` (section with label)
- `form`
- `search`

**Interactive:**
- `button`
- `link`
- `textbox`
- `checkbox`
- `radio`
- `combobox` (select)
- `slider`
- `spinbutton`

**Structure:**
- `heading` (h1-h6)
- `list` (ul, ol)
- `listitem` (li)
- `table`, `row`, `cell`
- `article`

**Media:**
- `img`

### States

Common ARIA states tracked:

```javascript
states: {
  expanded: true,        // For expandable elements
  selected: false,       // For selectable items
  checked: true,         // For checkboxes/radios
  pressed: false,        // For toggle buttons
  disabled: false,       // Disabled state
  readonly: false,       // Read-only inputs
  required: true,        // Required form fields
  invalid: false,        // Invalid inputs
  hidden: false,         // aria-hidden
  current: "page",       // Current page/location
  live: "polite",        // Live regions
  haspopup: "menu",      // Has popup
  level: 2,              // Heading level
  valuemin: 0,           // Min value
  valuemax: 100,         // Max value
  valuenow: 50,          // Current value
  valuetext: "50%"       // Value text
}
```

## Landmarks

Page regions that aid navigation:

```javascript
landmarks: [
  {
    role: "banner",
    name: "Site Header",
    tag: "header",
    selector: "header.site-header",
    rect: { x: 0, y: 0, width: 1920, height: 80 }
  },
  {
    role: "navigation",
    name: "Main Navigation",
    tag: "nav",
    selector: "nav#main-nav",
    rect: { x: 0, y: 80, width: 1920, height: 60 }
  },
  {
    role: "main",
    name: null,
    tag: "main",
    selector: "main",
    rect: { x: 0, y: 140, width: 1920, height: 2000 }
  },
  {
    role: "complementary",
    name: "Sidebar",
    tag: "aside",
    selector: "aside.sidebar",
    rect: { x: 1600, y: 140, width: 320, height: 1500 }
  },
  {
    role: "contentinfo",
    name: null,
    tag: "footer",
    selector: "footer",
    rect: { x: 0, y: 2140, width: 1920, height: 200 }
  }
]
```

## Headings

Document outline with heading hierarchy:

```javascript
headings: [
  { level: 1, text: "Welcome to Example Site", tag: "h1", selector: "h1.title", rect: { x: 100, y: 200 } },
  { level: 2, text: "Getting Started", tag: "h2", selector: "h2#started", rect: { x: 100, y: 350 } },
  { level: 3, text: "Step 1: Sign Up", tag: "h3", selector: "h3:nth-child(1)", rect: { x: 120, y: 400 } },
  { level: 3, text: "Step 2: Configure", tag: "h3", selector: "h3:nth-child(2)", rect: { x: 120, y: 550 } },
  { level: 2, text: "Advanced Topics", tag: "h2", selector: "h2#advanced", rect: { x: 100, y: 700 } }
]
```

## Interactive Elements

All interactive elements with their roles and states:

```javascript
interactive: [
  {
    role: "button",
    name: "Submit Form",
    tag: "button",
    states: { disabled: false, pressed: false },
    selector: "button#submit",
    focusable: true
  },
  {
    role: "link",
    name: "Learn More",
    tag: "a",
    states: { current: "page" },
    selector: "a.learn-more",
    focusable: true
  },
  {
    role: "checkbox",
    name: "Accept Terms",
    tag: "input",
    states: { checked: false, required: true },
    selector: "input#terms",
    focusable: true
  },
  {
    role: "textbox",
    name: "Email Address",
    tag: "input",
    states: { required: true, invalid: false },
    selector: "input#email",
    focusable: true
  }
]
```

## Forms

Form fields organized by form:

```javascript
forms: [
  {
    name: "Contact Form",
    action: "/submit",
    method: "post",
    fieldCount: 4,
    fields: [
      {
        role: "textbox",
        name: "Your Name",
        tag: "input",
        type: "text",
        value: "",
        placeholder: "Enter your name",
        required: true,
        selector: "input#name"
      },
      {
        role: "textbox",
        name: "Email Address",
        tag: "input",
        type: "email",
        value: "",
        placeholder: "your@email.com",
        required: true,
        selector: "input#email"
      },
      {
        role: "textbox",
        name: "Message",
        tag: "textarea",
        type: null,
        value: "",
        placeholder: "Your message...",
        required: true,
        selector: "textarea#message"
      },
      {
        role: "button",
        name: "Submit",
        tag: "button",
        type: "submit",
        value: null,
        placeholder: null,
        required: false,
        selector: "button[type=submit]"
      }
    ],
    selector: "form#contact"
  }
]
```

## Navigation

Navigation menus with links:

```javascript
navigation: [
  {
    name: "Main Navigation",
    linkCount: 5,
    links: [
      { text: "Home", href: "/", current: "page", selector: "nav a:nth-child(1)" },
      { text: "About", href: "/about", current: null, selector: "nav a:nth-child(2)" },
      { text: "Services", href: "/services", current: null, selector: "nav a:nth-child(3)" },
      { text: "Contact", href: "/contact", current: null, selector: "nav a:nth-child(4)" },
      { text: "Blog", href: "/blog", current: null, selector: "nav a:nth-child(5)" }
    ],
    selector: "nav#main-nav"
  },
  {
    name: "Footer Links",
    linkCount: 3,
    links: [
      { text: "Privacy Policy", href: "/privacy", current: null, selector: "footer nav a:nth-child(1)" },
      { text: "Terms of Service", href: "/terms", current: null, selector: "footer nav a:nth-child(2)" },
      { text: "Help", href: "/help", current: null, selector: "footer nav a:nth-child(3)" }
    ],
    selector: "footer nav"
  }
]
```

## Use Cases

### 1. Understanding Page Structure

```javascript
const a11y = await getAccessibilityTree();

// Find main content area
const mainLandmark = a11y.landmarks.find(l => l.role === 'main');
console.log("Main content at:", mainLandmark.rect);

// Get document outline
console.log("Page outline:");
for (const heading of a11y.headings) {
  const indent = '  '.repeat(heading.level - 1);
  console.log(`${indent}${heading.level}. ${heading.text}`);
}

// Find navigation
const navs = a11y.landmarks.filter(l => l.role === 'navigation');
console.log(`Found ${navs.length} navigation regions`);
```

### 2. Filling Forms

```javascript
const a11y = await getAccessibilityTree();

// Find form
const form = a11y.forms.find(f => f.name?.includes('Contact'));

console.log(`Form has ${form.fieldCount} fields:`);
for (const field of form.fields) {
  console.log(`- ${field.name} (${field.role})`);
  if (field.required) console.log(`  Required: yes`);
  if (field.placeholder) console.log(`  Placeholder: ${field.placeholder}`);
}

// Fill form fields
for (const field of form.fields) {
  if (field.role === 'textbox' && field.name.includes('Name')) {
    await elementType(field.selector, "John Doe");
  }
  if (field.role === 'textbox' && field.name.includes('Email')) {
    await elementType(field.selector, "john@example.com");
  }
}

// Submit
const submitButton = form.fields.find(f => f.type === 'submit');
await elementClick(submitButton.selector);
```

### 3. Navigation Planning

```javascript
const a11y = await getAccessibilityTree();

// Get all navigation menus
for (const nav of a11y.navigation) {
  console.log(`\n${nav.name}:`);
  for (const link of nav.links) {
    const current = link.current ? ' [CURRENT]' : '';
    console.log(`  - ${link.text}: ${link.href}${current}`);
  }
}

// Find specific page link
const aboutLink = a11y.navigation
  .flatMap(n => n.links)
  .find(l => l.text.includes('About'));

if (aboutLink) {
  console.log("About page:", aboutLink.href);
  await elementClick(aboutLink.selector);
}
```

### 4. Interactive Element Discovery

```javascript
const a11y = await getAccessibilityTree();

// Find all buttons
const buttons = a11y.interactive.filter(el => el.role === 'button');
console.log(`Found ${buttons.length} buttons:`);
for (const btn of buttons) {
  console.log(`- ${btn.name} (${btn.selector})`);
}

// Find specific button
const submitBtn = buttons.find(b => b.name?.includes('Submit'));
await elementClick(submitBtn.selector);

// Find checkboxes
const checkboxes = a11y.interactive.filter(el => el.role === 'checkbox');
for (const cb of checkboxes) {
  console.log(`- ${cb.name}: ${cb.states.checked ? 'checked' : 'unchecked'}`);
}
```

### 5. Accessibility Audit

```javascript
const a11y = await getAccessibilityTree();

// Check for main landmark
const hasMain = a11y.landmarks.some(l => l.role === 'main');
console.log(`Has main landmark: ${hasMain ? 'yes' : 'no'}`);

// Check for heading hierarchy
const headingLevels = a11y.headings.map(h => h.level);
const hasH1 = headingLevels.includes(1);
console.log(`Has h1: ${hasH1 ? 'yes' : 'no'}`);

// Check form field labels
for (const form of a11y.forms) {
  for (const field of form.fields) {
    if (!field.name) {
      console.warn(`Unlabeled field: ${field.selector}`);
    }
  }
}

// Check button names
const unnamedButtons = a11y.interactive
  .filter(el => el.role === 'button' && !el.name);
console.log(`Unnamed buttons: ${unnamedButtons.length}`);
```

## Advanced Patterns

### Tree Traversal for Specific Roles

```javascript
function findByRole(tree, targetRole) {
  const results = [];

  function traverse(node) {
    if (node.role === targetRole) {
      results.push(node);
    }
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }

  traverse(tree);
  return results;
}

const a11y = await getAccessibilityTree();
const allButtons = findByRole(a11y.tree, 'button');
console.log(`Found ${allButtons.length} buttons in tree`);
```

### Spirit Integration

```javascript
async function navigateToSection(sectionName) {
  const a11y = await getAccessibilityTree();

  // Find heading with matching text
  const heading = a11y.headings.find(h =>
    h.text.toLowerCase().includes(sectionName.toLowerCase())
  );

  if (heading) {
    // Scroll to heading
    await elementScroll(heading.selector, { intoView: true });
    return true;
  }

  return false;
}

// Use it
await navigateToSection("Getting Started");
```

### Form Analysis

```javascript
function analyzeForm(form) {
  const analysis = {
    name: form.name,
    totalFields: form.fieldCount,
    requiredFields: 0,
    fieldsByType: {},
    missingLabels: [],
  };

  for (const field of form.fields) {
    if (field.required) analysis.requiredFields++;

    const type = field.role || field.type || 'unknown';
    analysis.fieldsByType[type] = (analysis.fieldsByType[type] || 0) + 1;

    if (!field.name) {
      analysis.missingLabels.push(field.selector);
    }
  }

  return analysis;
}
```

## Best Practices

1. **Use landmarks for navigation**: Landmarks provide semantic structure
2. **Follow heading hierarchy**: Use headings to understand content organization
3. **Check interactive element roles**: Understand what elements do from their roles
4. **Use accessible names**: Names provide user-facing labels for elements
5. **Check states**: States tell you current element state (checked, expanded, etc.)
6. **Combine with visual snapshot**: Use accessibility tree for structure, visual snapshot for layout
7. **Prefer semantic selectors**: Use generated selectors from accessibility tree

## Options

### maxDepth (default: 20)

Control tree depth:

```javascript
{
  type: "accessibility_tree",
  options: { maxDepth: 10 }  // Shallower tree
}
```

### includeHidden (default: false)

Include hidden elements:

```javascript
{
  type: "accessibility_tree",
  options: { includeHidden: true }  // Include aria-hidden elements
}
```

### includePositions (default: true)

Include element positions:

```javascript
{
  type: "accessibility_tree",
  options: { includePositions: false }  // Faster, no positions
}
```

## Summary

The accessibility tree provides:

✅ **Semantic structure** - Roles, names, states instead of raw HTML
✅ **Landmarks** - Page regions (banner, main, navigation, etc.)
✅ **Headings** - Document outline with hierarchy
✅ **Interactive elements** - All clickable/focusable elements with roles
✅ **Forms** - Organized form fields with labels and types
✅ **Navigation** - Menu links with current page indication
✅ **AI-friendly** - Designed for agent understanding, not pixel rendering

This is the recommended way for AI agents to understand page structure and navigate web applications semantically.
