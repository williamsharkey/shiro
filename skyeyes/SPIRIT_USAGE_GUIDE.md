# Spirit Usage Guide - Skyeyes DOM Interaction

This guide demonstrates how Spirit (AI browser automation assistant) can use Skyeyes to interact with browser UIs.

## Overview

Skyeyes provides comprehensive DOM interaction capabilities through the eval API. While the direct message types (`dom_snapshot`, `query_selector`, `element_click`, etc.) require server-side integration, Spirit can immediately use these features through JavaScript eval commands.

## Feature 1: querySelector - Finding Elements

Find elements and extract detailed metadata including tag, id, classes, text content, and attributes.

### Example: Find a specific element

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const el = document.querySelector(\"button\"); return el ? {tag: el.tagName, text: el.textContent.trim(), id: el.id, classes: Array.from(el.classList), rect: el.getBoundingClientRect()} : null"
  }'
```

### Example: Find all elements matching a selector

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const els = document.querySelectorAll(\".item\"); return {count: els.length, elements: Array.from(els).map(e => ({tag: e.tagName, text: e.textContent.trim().substring(0, 50), id: e.id}))}"
  }'
```

### Example: Extract all attributes from an element

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const el = document.querySelector(\"input\"); const attrs = {}; for (const a of el.attributes) attrs[a.name] = a.value; return {element: el.tagName, attributes: attrs}"
  }'
```

## Feature 2: Click - Interact with Elements

Click buttons, links, or any clickable element. Automatically scrolls into view before clicking.

### Example: Click a button

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const el = document.querySelector(\"button\"); if (el) { el.scrollIntoView({behavior: \"smooth\", block: \"center\"}); setTimeout(() => el.click(), 300); return {clicked: true, text: el.textContent.trim()}; } return {error: \"Element not found\"};"
  }'
```

### Example: Click with event dispatch (for custom elements)

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const el = document.querySelector(\".custom-button\"); if (el) { const evt = new MouseEvent(\"click\", {bubbles: true, cancelable: true}); el.dispatchEvent(evt); return {clicked: true}; } return {error: \"Not found\"};"
  }'
```

## Feature 3: Type - Input Text

Type text into input fields, textareas, or contenteditable elements. Triggers proper input/change events.

### Example: Type into an input field

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const el = document.querySelector(\"input[type=text]\"); if (el) { el.focus(); el.value = \"Hello, Spirit!\"; el.dispatchEvent(new Event(\"input\", {bubbles: true})); el.dispatchEvent(new Event(\"change\", {bubbles: true})); return {typed: true, value: el.value}; } return {error: \"Not found\"};"
  }'
```

### Example: Append text (don't clear existing)

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const el = document.querySelector(\"textarea\"); if (el) { el.value += \" Additional text\"; el.dispatchEvent(new Event(\"input\", {bubbles: true})); return {value: el.value}; } return null;"
  }'
```

### Example: Type into contenteditable

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const el = document.querySelector(\"[contenteditable]\"); if (el) { el.focus(); el.textContent = \"New content\"; el.dispatchEvent(new Event(\"input\", {bubbles: true})); return {text: el.textContent}; } return null;"
  }'
```

## Feature 4: Scroll - Navigate the Page

Scroll the window or specific elements. Useful for bringing elements into view or pagination.

### Example: Scroll window vertically

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "window.scrollBy({top: 500, behavior: \"smooth\"}); return {scrollY: window.scrollY, scrollX: window.scrollX}"
  }'
```

### Example: Scroll to bottom of page

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "window.scrollTo({top: document.documentElement.scrollHeight, behavior: \"smooth\"}); return {scrolledTo: document.documentElement.scrollHeight}"
  }'
```

### Example: Scroll element into view

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const el = document.querySelector(\"#target\"); if (el) { el.scrollIntoView({behavior: \"smooth\", block: \"center\"}); return {scrolled: true, rect: el.getBoundingClientRect()}; } return null;"
  }'
```

### Example: Scroll a scrollable container

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const el = document.querySelector(\".scrollable\"); if (el) { el.scrollBy({top: 100, behavior: \"smooth\"}); return {scrollTop: el.scrollTop}; } return null;"
  }'
```

## Advanced Techniques

### 1. Check Element Visibility

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const el = document.querySelector(\".target\"); if (!el) return {error: \"Not found\"}; const style = window.getComputedStyle(el); const rect = el.getBoundingClientRect(); return {visible: style.display !== \"none\" && style.visibility !== \"hidden\" && rect.width > 0 && rect.height > 0};"
  }'
```

### 2. Wait for Element to Appear

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "return new Promise(resolve => { const check = () => { const el = document.querySelector(\".dynamic-element\"); if (el) resolve({found: true, text: el.textContent}); else setTimeout(check, 100); }; check(); })",
    "timeout": 5000
  }'
```

### 3. Extract Form Data

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const form = document.querySelector(\"form\"); if (!form) return null; const data = {}; new FormData(form).forEach((v, k) => data[k] = v); return data;"
  }'
```

### 4. Generate CSS Selector for Element

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "function genSelector(el) { if (el.id) return \"#\" + el.id; const path = []; let curr = el; while (curr && curr.nodeType === 1) { let sel = curr.tagName.toLowerCase(); if (curr.className) { const cls = Array.from(curr.classList).filter(c => c).slice(0, 2); if (cls.length) sel += \".\" + cls.join(\".\"); } if (curr.parentElement) { const idx = Array.from(curr.parentElement.children).indexOf(curr); if (curr.parentElement.children.length > 1) sel += \":nth-child(\" + (idx + 1) + \")\"; } path.unshift(sel); curr = curr.parentElement; if (path.length >= 5) break; } return path.join(\" > \"); } const el = document.querySelector(\".target\"); return {selector: genSelector(el)};"
  }'
```

### 5. Take DOM Snapshot

```bash
curl -X POST http://localhost:7777/api/skyeyes/shiro-skyeyes/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "return {html: document.documentElement.outerHTML.substring(0, 5000), viewport: {width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY}, title: document.title, url: location.href, elementCount: document.querySelectorAll(\"*\").length}"
  }'
```

## Best Practices for Spirit

1. **Always check if element exists before interacting**
   ```javascript
   const el = document.querySelector(selector);
   if (!el) return {error: "Element not found"};
   ```

2. **Scroll into view before clicking**
   ```javascript
   el.scrollIntoView({behavior: "smooth", block: "center"});
   setTimeout(() => el.click(), 300); // Wait for scroll
   ```

3. **Trigger proper events when typing**
   ```javascript
   el.dispatchEvent(new Event("input", {bubbles: true}));
   el.dispatchEvent(new Event("change", {bubbles: true}));
   ```

4. **Check visibility before interaction**
   ```javascript
   const style = window.getComputedStyle(el);
   const rect = el.getBoundingClientRect();
   const visible = style.display !== "none" && rect.width > 0;
   ```

5. **Use timeouts for async operations**
   ```javascript
   // Set timeout parameter for operations that might take time
   {"code": "...", "timeout": 10000}
   ```

6. **Extract comprehensive element info**
   ```javascript
   return {
     tag: el.tagName,
     text: el.textContent.trim(),
     id: el.id,
     classes: Array.from(el.classList),
     attributes: Object.fromEntries(
       Array.from(el.attributes).map(a => [a.name, a.value])
     ),
     rect: el.getBoundingClientRect(),
     visible: isVisible(el)
   };
   ```

## Testing Your Implementations

Run the test suites to verify functionality:

```bash
# Core functionality
./test-skyeyes.sh

# Spirit integration features
./test-spirit-integration.sh
```

Both test suites should pass with 15/15 tests each.

## Troubleshooting

### Element not found
- Verify selector syntax
- Check if element is in iframe
- Try `document.querySelectorAll("*")` to see all elements

### Click not working
- Ensure element is visible
- Try `el.dispatchEvent(new MouseEvent("click", {bubbles: true}))`
- Check if element has pointer-events: none

### Type not updating
- Verify element is input/textarea/contenteditable
- Ensure you're triggering input/change events
- Check if element is readonly or disabled

### Timeout errors
- Increase timeout parameter
- Break operation into smaller steps
- Check browser console for errors

## Example: Complete Automation Flow

```javascript
// 1. Find login form
const form = document.querySelector("form.login");
if (!form) return {error: "Login form not found"};

// 2. Fill username
const username = form.querySelector("input[name=username]");
username.value = "testuser";
username.dispatchEvent(new Event("input", {bubbles: true}));

// 3. Fill password
const password = form.querySelector("input[name=password]");
password.value = "testpass";
password.dispatchEvent(new Event("input", {bubbles: true}));

// 4. Click submit
const submit = form.querySelector("button[type=submit]");
submit.scrollIntoView({behavior: "smooth", block: "center"});
setTimeout(() => submit.click(), 300);

return {success: true, submitted: true};
```

This demonstrates how Spirit can perform complex browser automation tasks using Skyeyes!
