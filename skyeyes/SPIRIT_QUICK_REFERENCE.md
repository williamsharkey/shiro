# Spirit Quick Reference - Skyeyes DOM Interaction

## Common Patterns (Copy-Paste Ready)

### Find Element
```javascript
const el = document.querySelector("SELECTOR");
return el ? {
  tag: el.tagName,
  text: el.textContent.trim(),
  id: el.id,
  classes: Array.from(el.classList),
  rect: el.getBoundingClientRect()
} : {error: "Not found"};
```

### Find All Elements
```javascript
const els = document.querySelectorAll("SELECTOR");
return {
  count: els.length,
  elements: Array.from(els).map(e => ({
    tag: e.tagName,
    text: e.textContent.trim().substring(0, 100),
    id: e.id
  }))
};
```

### Click Element
```javascript
const el = document.querySelector("SELECTOR");
if (!el) return {error: "Not found"};
el.scrollIntoView({behavior: "smooth", block: "center"});
setTimeout(() => el.click(), 300);
return {clicked: true, text: el.textContent.trim()};
```

### Type Text
```javascript
const el = document.querySelector("SELECTOR");
if (!el) return {error: "Not found"};
el.focus();
el.value = "TEXT_HERE";
el.dispatchEvent(new Event("input", {bubbles: true}));
el.dispatchEvent(new Event("change", {bubbles: true}));
return {typed: true, value: el.value};
```

### Scroll Window
```javascript
window.scrollBy({top: 500, behavior: "smooth"});
return {scrollY: window.scrollY};
```

### Scroll Element Into View
```javascript
const el = document.querySelector("SELECTOR");
if (!el) return {error: "Not found"};
el.scrollIntoView({behavior: "smooth", block: "center"});
return {scrolled: true, rect: el.getBoundingClientRect()};
```

### Check Visibility
```javascript
const el = document.querySelector("SELECTOR");
if (!el) return {error: "Not found"};
const style = window.getComputedStyle(el);
const rect = el.getBoundingClientRect();
return {
  visible: style.display !== "none" &&
           style.visibility !== "hidden" &&
           style.opacity !== "0" &&
           rect.width > 0 && rect.height > 0
};
```

### Get All Attributes
```javascript
const el = document.querySelector("SELECTOR");
if (!el) return {error: "Not found"};
const attrs = {};
for (const a of el.attributes) attrs[a.name] = a.value;
return {element: el.tagName, attributes: attrs};
```

### Extract Form Data
```javascript
const form = document.querySelector("form");
if (!form) return {error: "Form not found"};
const data = {};
new FormData(form).forEach((v, k) => data[k] = v);
return data;
```

### DOM Snapshot
```javascript
return {
  html: document.documentElement.outerHTML.substring(0, 5000),
  viewport: {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  },
  title: document.title,
  url: location.href,
  elementCount: document.querySelectorAll("*").length
};
```

## cURL Command Template

```bash
curl -s -X POST http://localhost:7777/api/skyeyes/PAGE_ID/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"JAVASCRIPT_CODE_HERE"}' | python3 -m json.tool
```

Replace:
- `PAGE_ID` with `shiro-skyeyes` or `foam-skyeyes`
- `JAVASCRIPT_CODE_HERE` with one of the patterns above

## Async Operations Template

For operations that take time (waiting for elements, animations, etc.):

```bash
curl -s -X POST http://localhost:7777/api/skyeyes/PAGE_ID/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"return new Promise(resolve => { /* async code */ });", "timeout": 10000}'
```

## Common Selectors

| Selector | Meaning |
|----------|---------|
| `button` | All buttons |
| `input[type=text]` | Text inputs |
| `input[type=password]` | Password inputs |
| `.class-name` | Elements with class |
| `#element-id` | Element with ID |
| `form.login` | Form with class "login" |
| `div > p` | Direct child paragraphs |
| `a[href*=login]` | Links containing "login" |
| `[data-test=submit]` | Element with data-test attribute |

## Debugging Tips

### See all elements on page
```javascript
return Array.from(document.querySelectorAll("*")).map(e => e.tagName);
```

### Find elements by text content
```javascript
return Array.from(document.querySelectorAll("*"))
  .filter(e => e.textContent.includes("Search"))
  .map(e => ({tag: e.tagName, text: e.textContent.trim().substring(0, 50)}));
```

### Check what's in an iframe
```javascript
const iframe = document.querySelector("iframe");
return iframe ? {
  src: iframe.src,
  loaded: !!iframe.contentDocument
} : {error: "No iframe"};
```

### Get current page state
```javascript
return {
  url: location.href,
  title: document.title,
  readyState: document.readyState,
  elements: document.querySelectorAll("*").length,
  scrollY: window.scrollY
};
```
