# Screenshot Capability Guide

The skyeyes screenshot system captures visual representations of page elements or the entire viewport for visual regression testing. This enables AI agents like Spirit to detect visual changes and verify UI state.

## Overview

The screenshot system:
- **Captures screenshots** of specific elements or full viewport
- **Stores in cache** (max 10 screenshots, FIFO)
- **Supports multiple formats** (PNG, JPEG)
- **Provides base64 data URLs** for easy transmission
- **Enables visual comparison** between screenshots
- **Canvas-based rendering** (no external dependencies)

## API Commands

### Capture Screenshot: `screenshot_capture`

Capture a screenshot of an element or viewport.

**Request:**
```json
{
  "type": "screenshot_capture",
  "id": "req-123",
  "options": {
    "selector": "#main-content",  // Element selector (default: viewport)
    "fullPage": false,             // Capture full page scroll height
    "quality": 0.92,               // JPEG quality 0-1 (default: 0.92)
    "format": "png",               // "png" or "jpeg" (default: "png")
    "screenshotId": "before",      // ID for caching (auto-generated if omitted)
    "returnData": false            // Include dataUrl in response
  }
}
```

**Response:**
```json
{
  "id": "req-123",
  "result": {
    "screenshotId": "before",
    "width": 1200,
    "height": 800,
    "format": "png",
    "size": 245678,
    "sizeKB": 240,
    "cached": true,
    "dataUrl": "data:image/png;base64,iVBORw0KGgo..."  // If returnData: true
  },
  "error": null
}
```

### Get Screenshot: `screenshot_get`

Retrieve a cached screenshot.

**Request:**
```json
{
  "type": "screenshot_get",
  "id": "req-124",
  "screenshotId": "before"
}
```

**Response:**
```json
{
  "id": "req-124",
  "result": {
    "id": "before",
    "dataUrl": "data:image/png;base64,iVBORw0KGgo...",
    "width": 1200,
    "height": 800,
    "format": "png",
    "size": 245678,
    "timestamp": 1706543210123,
    "selector": "#main-content",
    "fullPage": false
  },
  "error": null
}
```

### List Screenshots: `screenshot_list`

List all cached screenshots.

**Request:**
```json
{
  "type": "screenshot_list",
  "id": "req-125"
}
```

**Response:**
```json
{
  "id": "req-125",
  "result": {
    "count": 3,
    "screenshots": [
      {
        "id": "before",
        "timestamp": 1706543210123,
        "width": 1200,
        "height": 800,
        "format": "png",
        "sizeKB": 240,
        "selector": "#main-content",
        "fullPage": false
      },
      {
        "id": "after",
        "timestamp": 1706543215456,
        "width": 1200,
        "height": 900,
        "format": "png",
        "sizeKB": 256,
        "selector": "#main-content",
        "fullPage": false
      }
    ],
    "maxScreenshots": 10
  },
  "error": null
}
```

### Clear Screenshots: `screenshot_clear`

Clear cached screenshots.

**Request:**
```json
{
  "type": "screenshot_clear",
  "id": "req-126",
  "screenshotId": "before"  // Omit to clear all
}
```

**Response:**
```json
{
  "id": "req-126",
  "result": {
    "cleared": 1,
    "remaining": 2
  },
  "error": null
}
```

### Compare Screenshots: `screenshot_compare`

Compare two screenshots.

**Request:**
```json
{
  "type": "screenshot_compare",
  "id": "req-127",
  "screenshot1Id": "before",
  "screenshot2Id": "after"
}
```

**Response:**
```json
{
  "id": "req-127",
  "result": {
    "screenshot1": "before",
    "screenshot2": "after",
    "dimensionsMatch": true,
    "identical": false,
    "sizeDiff": 16384,
    "sizeDiffKB": 16
  },
  "error": null
}
```

## Use Cases

### 1. Visual Regression Testing

```javascript
// Capture baseline
await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_capture',
    options: {
      selector: '#dashboard',
      screenshotId: 'baseline'
    }
  });
`);

// Make changes
await spirit.click('button#toggle-theme');
await sleep(1000);

// Capture after changes
await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_capture',
    options: {
      selector: '#dashboard',
      screenshotId: 'after-change'
    }
  });
`);

// Compare
const comparison = await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_compare',
    screenshot1Id: 'baseline',
    screenshot2Id: 'after-change'
  });
`);

console.log('Visual changes detected:', !comparison.result.identical);
```

### 2. UI State Verification

```javascript
async function verifyUIState(selector, expectedScreenshotId) {
  // Capture current state
  await spirit.eval(`
    await window.skyeyes.send({
      type: 'screenshot_capture',
      options: {
        selector: '${selector}',
        screenshotId: 'current'
      }
    });
  `);

  // Compare with expected
  const comparison = await spirit.eval(`
    await window.skyeyes.send({
      type: 'screenshot_compare',
      screenshot1Id: '${expectedScreenshotId}',
      screenshot2Id: 'current'
    });
  `);

  return comparison.result.identical;
}

const matches = await verifyUIState('#login-form', 'expected-login-form');
console.log('UI matches expected state:', matches);
```

### 3. Full Page Screenshots

```javascript
// Capture entire page
await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_capture',
    options: {
      fullPage: true,
      screenshotId: 'full-page',
      format: 'jpeg',
      quality: 0.85
    }
  });
`);

// Download screenshot data
const screenshot = await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_get',
    screenshotId: 'full-page'
  });
`);

// screenshot.result.dataUrl contains base64 image
```

### 4. Responsive Design Testing

```javascript
async function captureAtBreakpoints(selector) {
  const breakpoints = [
    { name: 'mobile', width: 375 },
    { name: 'tablet', width: 768 },
    { name: 'desktop', width: 1920 }
  ];

  const screenshots = {};

  for (const bp of breakpoints) {
    // Resize viewport
    await spirit.eval(`
      window.resizeTo(${bp.width}, 1080);
    `);

    await sleep(500);

    // Capture screenshot
    await spirit.eval(`
      await window.skyeyes.send({
        type: 'screenshot_capture',
        options: {
          selector: '${selector}',
          screenshotId: '${bp.name}'
        }
      });
    `);

    screenshots[bp.name] = bp.width;
  }

  return screenshots;
}

await captureAtBreakpoints('#responsive-layout');
```

### 5. Animation/Transition Testing

```javascript
// Capture before animation
await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_capture',
    options: {
      selector: '#animated-element',
      screenshotId: 'before-animation'
    }
  });
`);

// Trigger animation
await spirit.click('button#animate');

// Wait for animation to complete
await sleep(2000);

// Capture after animation
await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_capture',
    options: {
      selector: '#animated-element',
      screenshotId: 'after-animation'
    }
  });
`);

// Compare
const comparison = await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_compare',
    screenshot1Id: 'before-animation',
    screenshot2Id: 'after-animation'
  });
`);

console.log('Animation changed element:', !comparison.result.identical);
```

## Comparison Strategies

### Basic Comparison (Built-in)

The built-in `screenshot_compare` provides:
- Dimension matching
- Exact data URL comparison (pixel-perfect)
- Size difference calculation

```javascript
const result = await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_compare',
    screenshot1Id: 'img1',
    screenshot2Id: 'img2'
  });
`);

console.log('Identical:', result.result.identical);
console.log('Dimensions match:', result.result.dimensionsMatch);
```

### Advanced Comparison (External)

For more sophisticated comparison (pixel diff, tolerance, etc.), retrieve data URLs and use external tools:

```javascript
// Get both screenshots
const s1 = await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_get',
    screenshotId: 'img1'
  });
`);

const s2 = await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_get',
    screenshotId: 'img2'
  });
`);

// Use external tool like pixelmatch, looks-same, etc.
const diff = await compareImages(s1.result.dataUrl, s2.result.dataUrl);
```

## Format Comparison

### PNG vs JPEG

**PNG (default):**
- Lossless compression
- Larger file sizes
- Perfect for exact comparisons
- Supports transparency

**JPEG:**
- Lossy compression
- Smaller file sizes (~30-50% smaller)
- Good for visual comparisons where exact pixel matching isn't required
- No transparency support

```javascript
// PNG - exact comparison
await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_capture',
    options: {
      format: 'png',
      screenshotId: 'precise'
    }
  });
`);

// JPEG - smaller size
await spirit.eval(`
  await window.skyeyes.send({
    type: 'screenshot_capture',
    options: {
      format: 'jpeg',
      quality: 0.85,
      screenshotId: 'compact'
    }
  });
`);
```

## Limitations

### Canvas-Based Rendering

The screenshot system uses HTML5 Canvas with SVG foreignObject:

**Works well for:**
- Static HTML content
- Text and typography
- Basic CSS styling
- Most DOM elements

**May have issues with:**
- External resources (CORS-protected images)
- Complex CSS (some advanced filters, blend modes)
- WebGL/Canvas elements
- Video elements
- Iframes

**Workarounds:**
- Ensure CORS headers for external resources
- Use simpler CSS for screenshot elements
- Capture static frames of dynamic content

### Size Limits

- **Cache limit:** 10 screenshots maximum (FIFO)
- **Data URL size:** Can be large (1-5MB per screenshot)
- **Memory usage:** Keep cache small for long sessions

## Performance Tips

1. **Use JPEG for large screenshots** to reduce size
2. **Clear cache regularly** when taking many screenshots
3. **Capture specific elements** instead of full page when possible
4. **Use lower quality settings** for non-critical comparisons
5. **Limit screenshot dimensions** by targeting smaller elements

## Error Handling

```javascript
try {
  const result = await spirit.eval(`
    await window.skyeyes.send({
      type: 'screenshot_capture',
      options: {
        selector: '#nonexistent'
      }
    });
  `);

  if (result.error) {
    console.error('Screenshot error:', result.error.message);
  }
} catch (err) {
  console.error('Failed to capture screenshot:', err);
}
```

## Best Practices

1. **Use meaningful IDs** for screenshots (e.g., "login-form-baseline")
2. **Clear old screenshots** before new test runs
3. **Wait for rendering** before capturing (animations, images, fonts)
4. **Capture specific elements** for focused comparisons
5. **Store baseline screenshots** externally for long-term regression testing
6. **Use consistent viewport sizes** for fair comparisons

## Quick Reference

| Command | Purpose |
|---------|---------|
| `screenshot_capture` | Capture element or viewport |
| `screenshot_get` | Retrieve cached screenshot |
| `screenshot_list` | List all cached screenshots |
| `screenshot_clear` | Clear cache |
| `screenshot_compare` | Compare two screenshots |

**Key Options:**
- `selector` - Element to capture (default: viewport)
- `fullPage` - Capture full scroll height
- `format` - "png" or "jpeg"
- `quality` - JPEG quality (0-1)
- `returnData` - Include dataUrl in response

**Comparison Results:**
- `dimensionsMatch` - Same width/height
- `identical` - Exact pixel match
- `sizeDiff` - Size difference in bytes
