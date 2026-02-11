# Keyboard and Clipboard Integration Guide

This guide covers clipboard paste, keyboard event simulation, and focus management in skyeyes - essential features for Spirit to interact with terminal UIs and editors.

## Table of Contents

1. [Overview](#overview)
2. [Clipboard Operations](#clipboard-operations)
3. [Keyboard Event Simulation](#keyboard-event-simulation)
4. [Focus Management](#focus-management)
5. [Common Patterns](#common-patterns)
6. [Terminal UI Interaction](#terminal-ui-interaction)
7. [Advanced Usage](#advanced-usage)

## Overview

The keyboard and clipboard integration provides three core capabilities:

- **Paste**: Insert text into input fields, textareas, and contenteditable elements
- **Keypress**: Simulate keyboard events (Enter, Tab, Ctrl+C, arrow keys, etc.)
- **Focus**: Programmatically focus elements by CSS selector

These features enable Spirit to interact with complex terminal UIs, code editors, and interactive web applications.

## Clipboard Operations

### Basic Paste

Paste text into an element:

```javascript
{
  type: "element_paste",
  id: "paste-1",
  selector: "input[type=text]",
  text: "Hello World"
}
```

**Response:**
```javascript
{
  type: "skyeyes_result",
  id: "paste-1",
  result: {
    success: true,
    selector: "input[type=text]",
    pastedText: "Hello World",
    pastedLength: 11,
    element: {
      tag: "input",
      id: "username",
      value: "Hello World"
    }
  }
}
```

### Paste into Textarea

Paste multiline text:

```javascript
{
  type: "element_paste",
  id: "paste-2",
  selector: "textarea#code-editor",
  text: "function hello() {\n  console.log('Hello');\n}"
}
```

### Paste into Contenteditable

Paste into contenteditable elements (like rich text editors):

```javascript
{
  type: "element_paste",
  id: "paste-3",
  selector: "[contenteditable=true]",
  text: "Rich text content"
}
```

### Paste into Focused Element

Paste without a selector uses the currently focused element:

```javascript
{
  type: "element_paste",
  id: "paste-4",
  text: "Quick paste"
}
```

**Note:** If no element is focused, returns an error: `"No focused element to paste into"`

### Cursor Position Handling

The paste operation:
- Inserts text at the current cursor position
- Replaces selected text if there is a selection
- Moves cursor to the end of pasted text
- Triggers `input` and `change` events

Example with existing content:

```javascript
// Input has: "Hello |World" (cursor at |)
{
  type: "element_paste",
  selector: "input",
  text: "Beautiful "
}
// Result: "Hello Beautiful World"
```

## Keyboard Event Simulation

### Basic Keypress

Simulate a single key press:

```javascript
{
  type: "element_keypress",
  id: "key-1",
  selector: "input",
  key: "Enter"
}
```

**Response:**
```javascript
{
  type: "skyeyes_result",
  id: "key-1",
  result: {
    success: true,
    selector: "input",
    key: "Enter",
    modifiers: {
      ctrl: false,
      shift: false,
      alt: false,
      meta: false
    },
    element: {
      tag: "input",
      id: "search"
    }
  }
}
```

### Supported Special Keys

The following special keys are supported:

- **Navigation**: `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`
- **Editing**: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`
- **Function**: `F1` through `F12`

### Key Combinations

Simulate key combinations with modifiers:

```javascript
// Ctrl+C (copy)
{
  type: "element_keypress",
  selector: "textarea",
  key: "Ctrl+C"
}

// Shift+Enter (new line in some apps)
{
  type: "element_keypress",
  selector: "textarea",
  key: "Shift+Enter"
}

// Ctrl+Shift+K (custom shortcut)
{
  type: "element_keypress",
  selector: "input",
  key: "Ctrl+Shift+K"
}

// Alt+F4 (close window - may not work in browser sandbox)
{
  type: "element_keypress",
  key: "Alt+F4"
}
```

### Modifier Options

You can also specify modifiers separately:

```javascript
{
  type: "element_keypress",
  selector: "input",
  key: "C",
  options: {
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false
  }
}
```

### Character Keys

Simulate typing single characters:

```javascript
{
  type: "element_keypress",
  selector: "input",
  key: "a"
}

{
  type: "element_keypress",
  selector: "input",
  key: "X"  // Capital X (may need Shift modifier)
}
```

### Keypress without Selector

Use the currently focused element:

```javascript
{
  type: "element_keypress",
  id: "key-2",
  key: "Tab"
}
```

## Focus Management

### Focus by Selector

Focus an element by CSS selector:

```javascript
{
  type: "element_focus",
  id: "focus-1",
  selector: "input#username"
}
```

**Response:**
```javascript
{
  type: "skyeyes_result",
  id: "focus-1",
  result: {
    success: true,
    selector: "input#username",
    focused: true,
    element: {
      tag: "input",
      id: "username",
      classes: ["form-control"],
      focusable: true
    },
    previousFocus: {
      tag: "button",
      id: "submit"
    }
  }
}
```

### Focus Features

- **Auto-scroll**: Element is scrolled into view before focusing
- **Focus tracking**: Previous focused element is returned
- **Focusable detection**: Indicates if element can receive focus

### Focus Chain

Build a focus chain for navigation:

```javascript
// Focus first input
await focus("input#username");

// Tab to next field
await keypress(null, "Tab");

// Or explicitly focus next field
await focus("input#password");

// Tab to submit button
await keypress(null, "Tab");
```

## Common Patterns

### Form Filling

```javascript
// Focus username field
await focus("input#username");
await paste("input#username", "john.doe");

// Move to password
await keypress(null, "Tab");
await paste("input#password", "secure123");

// Submit form
await keypress(null, "Tab");  // Focus submit button
await keypress(null, "Enter");
```

### Terminal Command Entry

```javascript
// Focus terminal input
await focus(".terminal-input");

// Type command
await paste(".terminal-input", "ls -la");

// Submit command
await keypress(".terminal-input", "Enter");
```

### Code Editor Interaction

```javascript
// Focus editor
await focus(".code-editor");

// Paste code
await paste(".code-editor", "function test() {\n  return true;\n}");

// Navigate in editor
await keypress(null, "Home");      // Start of line
await keypress(null, "End");       // End of line
await keypress(null, "Ctrl+Home"); // Start of document
await keypress(null, "Ctrl+End");  // End of document
```

### Multi-line Text Entry

```javascript
// Focus textarea
await focus("textarea#description");

// Paste multi-line content
await paste("textarea#description",
  "Line 1\nLine 2\nLine 3"
);

// Add more content
await keypress(null, "End");
await keypress(null, "Enter");
await paste(null, "Line 4");
```

## Terminal UI Interaction

### xterm.js Terminal

Interact with xterm.js terminals:

```javascript
// Focus terminal
await focus(".xterm-helper-textarea");

// Send command
await paste(".xterm-helper-textarea", "npm install");
await keypress(".xterm-helper-textarea", "Enter");

// Navigate command history
await keypress(".xterm-helper-textarea", "ArrowUp");   // Previous command
await keypress(".xterm-helper-textarea", "ArrowDown"); // Next command

// Cancel running command
await keypress(".xterm-helper-textarea", "Ctrl+C");
```

### Terminal Autocomplete

Trigger autocomplete:

```javascript
// Start typing command
await paste(".terminal", "git sta");

// Trigger autocomplete
await keypress(".terminal", "Tab");

// Or double-tab for options
await keypress(".terminal", "Tab");
await keypress(".terminal", "Tab");
```

### Terminal Navigation

```javascript
// Clear line
await keypress(".terminal", "Ctrl+U");

// Clear screen
await keypress(".terminal", "Ctrl+L");

// Beginning of line
await keypress(".terminal", "Ctrl+A");

// End of line
await keypress(".terminal", "Ctrl+E");

// Delete word
await keypress(".terminal", "Ctrl+W");
```

## Advanced Usage

### Sequence of Operations

Chain operations for complex interactions:

```javascript
// Login flow
await focus("input#username");
await paste(null, "admin");
await keypress(null, "Tab");
await paste(null, "password123");
await keypress(null, "Tab");
await keypress(null, "Enter");
await wait(1000);  // Wait for redirect

// Then interact with app
await focus(".search-input");
await paste(null, "search query");
await keypress(null, "Enter");
```

### Vim-style Editing

Simulate vim commands in editors that support vim mode:

```javascript
// Enter command mode
await keypress(".editor", "Escape");

// Save file (:w)
await keypress(null, "Shift+;");  // Colon
await paste(null, "w");
await keypress(null, "Enter");

// Quit (:q)
await keypress(null, "Shift+;");
await paste(null, "q");
await keypress(null, "Enter");
```

### Rich Text Editor

Interact with rich text editors:

```javascript
// Focus editor
await focus("[contenteditable]");

// Bold text
await paste(null, "Important text");
await keypress(null, "Ctrl+A");  // Select all
await keypress(null, "Ctrl+B");  // Bold

// Add new line
await keypress(null, "End");
await keypress(null, "Enter");

// Italic text
await paste(null, "Emphasized text");
await keypress(null, "Ctrl+A");
await keypress(null, "Ctrl+I");  // Italic
```

### Dropdown Navigation

Navigate dropdown menus:

```javascript
// Open dropdown
await focus(".dropdown-toggle");
await keypress(null, "Enter");

// Navigate options
await keypress(null, "ArrowDown");
await keypress(null, "ArrowDown");

// Select option
await keypress(null, "Enter");
```

### Modal Dialogs

Interact with modals:

```javascript
// Close modal with Escape
await keypress(".modal", "Escape");

// Or tab through modal controls
await focus(".modal input");
await keypress(null, "Tab");
await keypress(null, "Tab");
await keypress(null, "Enter");  // Submit
```

## Error Handling

### Element Not Found

If selector doesn't match:

```javascript
{
  error: {
    message: "Element not found: .nonexistent",
    name: "Error",
    stack: "...",
    type: "Error",
    timestamp: 1234567890
  }
}
```

### Not Editable

If element cannot receive text:

```javascript
{
  error: {
    message: "Element is not editable",
    ...
  }
}
```

### No Focused Element

If no selector provided and no element focused:

```javascript
{
  error: {
    message: "No focused element for keypress",
    ...
  }
}
```

## Best Practices

1. **Always focus first**: Before pasting or pressing keys, focus the target element explicitly
2. **Wait after focus**: Use small delays (50-300ms) after focus before interacting
3. **Use selectors**: Prefer specific selectors over relying on activeElement
4. **Test keyboard events**: Some apps may not respond to simulated events
5. **Handle modals**: Modal dialogs may capture focus - close or interact with them first
6. **Verify state**: Check element state after operations to ensure they succeeded
7. **Escape sequences**: Be careful with special characters in pasted text

## Platform Differences

### Shiro vs Foam

Terminal interactions may differ:

```javascript
// Shiro terminal
await focus(".shiro-terminal .xterm-helper-textarea");

// Foam terminal
await focus(".foam-shell .terminal-input");
```

### Browser Limitations

Some keyboard shortcuts may not work in browser context:

- `Ctrl+W` (close tab) - blocked by browser
- `Ctrl+T` (new tab) - blocked by browser
- `F11` (fullscreen) - may be blocked
- `Alt+F4` (close window) - blocked by browser

These work within sandboxed apps but not on browser chrome.

## Integration with Spirit

Spirit can use these features for complex automation:

```javascript
// Spirit workflow: Edit file in terminal editor
async function editFileInTerminal(filename, content) {
  // Open file in vim
  await focus(".terminal-input");
  await paste(null, `vim ${filename}`);
  await keypress(null, "Enter");
  await wait(500);

  // Enter insert mode
  await keypress(".terminal", "i");

  // Paste content
  await paste(null, content);

  // Save and quit
  await keypress(null, "Escape");
  await paste(null, ":wq");
  await keypress(null, "Enter");
}
```

## Debugging

Enable verbose logging to see keyboard events:

```javascript
// In browser console
window.addEventListener('keydown', e => {
  console.log('Key:', e.key, 'Code:', e.code, 'Ctrl:', e.ctrlKey);
}, true);
```

Check focus state:

```javascript
// See what's focused
console.log('Focused:', document.activeElement);

// Check if element can receive focus
const el = document.querySelector('.my-input');
console.log('Focusable:', el.tabIndex >= 0 || ['INPUT', 'TEXTAREA'].includes(el.tagName));
```

## Summary

The keyboard and clipboard integration provides:

- ✅ Paste text into input fields, textareas, and contenteditable elements
- ✅ Simulate keyboard events with full modifier support
- ✅ Focus management with auto-scroll and state tracking
- ✅ Terminal UI interaction (command entry, shortcuts, navigation)
- ✅ Rich text editor support
- ✅ Form automation and complex workflows

These features enable Spirit to interact with any web-based terminal UI or editor, making it possible to automate complex tasks that require keyboard input.
