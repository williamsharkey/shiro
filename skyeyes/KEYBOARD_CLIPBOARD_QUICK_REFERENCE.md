# Keyboard & Clipboard Quick Reference

Copy-paste ready code for clipboard paste, keyboard simulation, and focus management.

## Paste Text

```javascript
// Paste into input field
{
  type: "element_paste",
  id: "paste-1",
  selector: "input#username",
  text: "john.doe"
}

// Paste into textarea
{
  type: "element_paste",
  id: "paste-2",
  selector: "textarea",
  text: "Multi\nline\ntext"
}

// Paste into focused element
{
  type: "element_paste",
  id: "paste-3",
  text: "Quick paste"
}

// Paste into contenteditable
{
  type: "element_paste",
  id: "paste-4",
  selector: "[contenteditable]",
  text: "Rich text"
}
```

## Simulate Keys

```javascript
// Enter key
{
  type: "element_keypress",
  id: "key-1",
  selector: "input",
  key: "Enter"
}

// Tab key
{
  type: "element_keypress",
  id: "key-2",
  selector: "input",
  key: "Tab"
}

// Escape key
{
  type: "element_keypress",
  id: "key-3",
  key: "Escape"
}

// Arrow keys
{
  type: "element_keypress",
  id: "key-4",
  key: "ArrowUp"
}

// Ctrl+C
{
  type: "element_keypress",
  id: "key-5",
  selector: "textarea",
  key: "Ctrl+C"
}

// Shift+Enter
{
  type: "element_keypress",
  id: "key-6",
  selector: "textarea",
  key: "Shift+Enter"
}

// Backspace
{
  type: "element_keypress",
  id: "key-7",
  key: "Backspace"
}

// Delete
{
  type: "element_keypress",
  id: "key-8",
  key: "Delete"
}
```

## Focus Management

```javascript
// Focus by selector
{
  type: "element_focus",
  id: "focus-1",
  selector: "input#username"
}

// Response includes focus state
{
  result: {
    success: true,
    focused: true,
    element: {
      tag: "input",
      id: "username",
      focusable: true
    },
    previousFocus: {
      tag: "button",
      id: "submit"
    }
  }
}
```

## Terminal Interaction

```javascript
// Send command to terminal
async function sendTerminalCommand(cmd) {
  // Focus terminal
  await send({
    type: "element_focus",
    selector: ".terminal-input"
  });

  // Paste command
  await send({
    type: "element_paste",
    text: cmd
  });

  // Press Enter
  await send({
    type: "element_keypress",
    key: "Enter"
  });
}

// Navigate command history
await send({
  type: "element_keypress",
  selector: ".terminal",
  key: "ArrowUp"  // Previous command
});

// Cancel command
await send({
  type: "element_keypress",
  selector: ".terminal",
  key: "Ctrl+C"
});

// Clear line
await send({
  type: "element_keypress",
  selector: ".terminal",
  key: "Ctrl+U"
});
```

## Form Filling

```javascript
// Complete form flow
async function fillForm() {
  // Focus username
  await send({
    type: "element_focus",
    selector: "input#username"
  });

  // Enter username
  await send({
    type: "element_paste",
    text: "admin"
  });

  // Tab to password
  await send({
    type: "element_keypress",
    key: "Tab"
  });

  // Enter password
  await send({
    type: "element_paste",
    text: "secure123"
  });

  // Submit (Tab to button, then Enter)
  await send({
    type: "element_keypress",
    key: "Tab"
  });

  await send({
    type: "element_keypress",
    key: "Enter"
  });
}
```

## Code Editor

```javascript
// Edit code
async function editCode(code) {
  // Focus editor
  await send({
    type: "element_focus",
    selector: ".code-editor"
  });

  // Paste code
  await send({
    type: "element_paste",
    text: code
  });

  // Navigate
  await send({
    type: "element_keypress",
    key: "Ctrl+Home"  // Start of document
  });

  // Save (if supported)
  await send({
    type: "element_keypress",
    key: "Ctrl+S"
  });
}
```

## Special Keys Reference

```
Navigation:
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight
  Home, End, PageUp, PageDown

Editing:
  Enter, Tab, Escape, Backspace, Delete, Space

Function:
  F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12

Modifiers:
  Ctrl+<key>
  Shift+<key>
  Alt+<key>
  Meta+<key> (Command on Mac)
  Ctrl+Shift+<key>
  Ctrl+Alt+<key>
```

## Vim Commands

```javascript
// Enter command mode
await send({
  type: "element_keypress",
  selector: ".editor",
  key: "Escape"
});

// Save (:w)
await send({ type: "element_keypress", key: "Shift+;" });
await send({ type: "element_paste", text: "w" });
await send({ type: "element_keypress", key: "Enter" });

// Quit (:q)
await send({ type: "element_keypress", key: "Shift+;" });
await send({ type: "element_paste", text: "q" });
await send({ type: "element_keypress", key: "Enter" });
```

## Common Patterns

```javascript
// Clear input and paste
await send({ type: "element_focus", selector: "input" });
await send({ type: "element_keypress", key: "Ctrl+A" });
await send({ type: "element_paste", text: "new value" });

// Select all and delete
await send({ type: "element_keypress", key: "Ctrl+A" });
await send({ type: "element_keypress", key: "Delete" });

// Move cursor to end and append
await send({ type: "element_keypress", key: "End" });
await send({ type: "element_paste", text: " appended" });

// Insert at beginning
await send({ type: "element_keypress", key: "Home" });
await send({ type: "element_paste", text: "prefix " });

// New line in textarea
await send({ type: "element_keypress", key: "Enter" });

// Soft new line (Shift+Enter)
await send({ type: "element_keypress", key: "Shift+Enter" });
```

## Error Handling

```javascript
// Check for errors in response
const result = await send({
  type: "element_paste",
  selector: ".nonexistent",
  text: "test"
});

if (result.error) {
  console.error("Paste failed:", result.error.message);
  // "Element not found: .nonexistent"
}

// Check focus state
const focusResult = await send({
  type: "element_focus",
  selector: "input"
});

if (focusResult.result.focused) {
  console.log("Element successfully focused");
} else {
  console.log("Element could not be focused");
}
```

## Performance Tips

1. **Focus first**: Always focus before pasting or pressing keys
2. **Use specific selectors**: Avoid relying on activeElement
3. **Wait after focus**: Small delay (50-300ms) may be needed
4. **Batch operations**: Chain related operations together
5. **Error checking**: Always check result.error for failures
