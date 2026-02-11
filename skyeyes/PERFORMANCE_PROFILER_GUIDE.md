# Performance Profiler Guide

The skyeyes performance profiler uses the PerformanceObserver API to measure page load times, resource loading, layout shifts, and long tasks. This enables performance monitoring and regression testing for Spirit and other AI agents.

## Overview

The performance profiler system:
- **Monitors real-time performance** using PerformanceObserver API
- **Tracks multiple metric types** (navigation, resource, paint, layout-shift, LCP, longtask)
- **Stores metrics in a ring buffer** (max 500 entries, FIFO)
- **Provides summary statistics** (page load, CLS, long tasks, paint timing)
- **Enables performance regression testing** by comparing metrics over time

## API Commands

### Start Performance Monitoring: `performance_start`

Start observing performance metrics.

**Request:**
```json
{
  "type": "performance_start",
  "id": "req-123",
  "options": {
    "types": ["navigation", "resource", "paint", "layout-shift", "largest-contentful-paint", "longtask"]
  }
}
```

**Response:**
```json
{
  "id": "req-123",
  "result": {
    "started": true,
    "observing": ["navigation", "resource", "paint", "layout-shift", "largest-contentful-paint", "longtask"],
    "timestamp": 1706543210123
  },
  "error": null
}
```

### Stop Performance Monitoring: `performance_stop`

Stop observing performance metrics.

**Request:**
```json
{
  "type": "performance_stop",
  "id": "req-124"
}
```

**Response:**
```json
{
  "id": "req-124",
  "result": {
    "stopped": true,
    "capturedEntries": 127,
    "timestamp": 1706543220456
  },
  "error": null
}
```

### Get Performance Metrics: `performance_metrics`

Retrieve captured performance metrics with summary statistics.

**Request:**
```json
{
  "type": "performance_metrics",
  "id": "req-125",
  "options": {
    "type": "longtask",  // Filter by type (optional)
    "limit": 50,         // Max entries to return
    "offset": 0          // Skip first N entries
  }
}
```

**Response:**
```json
{
  "id": "req-125",
  "result": {
    "entries": [
      {
        "type": "navigation",
        "name": "https://example.com",
        "startTime": 0,
        "duration": 1234.5,
        "entryType": "navigation",
        "timestamp": 1706543210123,
        "details": {
          "domContentLoadedEventStart": 456.2,
          "domContentLoadedEventEnd": 478.1,
          "loadEventStart": 1200.0,
          "loadEventEnd": 1234.5,
          "domInteractive": 420.3,
          "domComplete": 1190.2,
          "transferSize": 45678,
          "encodedBodySize": 12345,
          "decodedBodySize": 12345,
          "redirectCount": 0
        }
      },
      {
        "type": "longtask",
        "name": "self",
        "startTime": 567.8,
        "duration": 123.4,
        "entryType": "longtask",
        "timestamp": 1706543210690,
        "details": {
          "attribution": [
            {
              "name": "unknown",
              "entryType": "taskattribution",
              "containerType": "window",
              "containerName": ""
            }
          ]
        }
      }
    ],
    "total": 127,
    "offset": 0,
    "limit": 50,
    "monitoringActive": true,
    "summary": {
      "total": 127,
      "byType": {
        "navigation": 1,
        "resource": 45,
        "paint": 2,
        "layout-shift": 12,
        "largest-contentful-paint": 1,
        "longtask": 5
      },
      "navigation": {
        "domContentLoaded": 21.9,
        "loadComplete": 34.5,
        "domInteractive": 420.3,
        "domComplete": 1190.2,
        "transferSize": 45678,
        "encodedBodySize": 12345,
        "decodedBodySize": 12345
      },
      "paint": {
        "first-paint": 234.5,
        "first-contentful-paint": 256.7
      },
      "layoutShifts": {
        "count": 12,
        "cumulativeScore": 0.145,
        "averageScore": 0.012
      },
      "longTasks": {
        "count": 5,
        "totalDuration": 687.3,
        "averageDuration": 137.5,
        "maxDuration": 234.2
      }
    }
  },
  "error": null
}
```

### Clear Performance Log: `performance_clear`

Clear all captured performance metrics.

**Request:**
```json
{
  "type": "performance_clear",
  "id": "req-126"
}
```

**Response:**
```json
{
  "id": "req-126",
  "result": {
    "cleared": 127,
    "remaining": 0,
    "monitoringActive": true
  },
  "error": null
}
```

### Get Performance Snapshot: `performance_snapshot`

Get current performance timing snapshot (from performance.timing).

**Request:**
```json
{
  "type": "performance_snapshot",
  "id": "req-127"
}
```

**Response:**
```json
{
  "id": "req-127",
  "result": {
    "timestamp": 1706543210123,
    "timing": {
      "navigationStart": 0,
      "domContentLoadedEventEnd": 478.1,
      "loadEventEnd": 1234.5,
      "domInteractive": 420.3,
      "domComplete": 1190.2,
      "responseEnd": 156.7,
      "requestStart": 12.3
    },
    "navigation": {
      "type": 0,
      "redirectCount": 0
    },
    "memory": {
      "usedJSHeapSize": 12345678,
      "totalJSHeapSize": 20000000,
      "jsHeapSizeLimit": 2172649472
    },
    "resources": 45,
    "marks": 0,
    "measures": 0
  },
  "error": null
}
```

## Performance Metric Types

### Navigation

Page navigation and load timing.

**Key metrics:**
- `domContentLoadedEventEnd` - DOM ready time
- `loadEventEnd` - Full page load time
- `domInteractive` - Time to interactive DOM
- `domComplete` - DOM parsing complete
- `transferSize` - Total bytes transferred
- `redirectCount` - Number of redirects

### Resource

Individual resource loading (scripts, stylesheets, images, etc.).

**Key metrics:**
- `initiatorType` - Type of resource (script, link, img, etc.)
- `transferSize` - Bytes transferred
- `duration` - Load duration
- `responseEnd` - When response completed

### Paint

Paint timing events.

**Types:**
- `first-paint` (FP) - First pixel painted
- `first-contentful-paint` (FCP) - First content painted

### Layout Shift

Cumulative Layout Shift (CLS) score for visual stability.

**Key metrics:**
- `value` - Layout shift score
- `hadRecentInput` - Whether caused by user input
- `cumulativeScore` - Total CLS across all shifts

**Scoring:**
- Good: < 0.1
- Needs improvement: 0.1 - 0.25
- Poor: > 0.25

### Largest Contentful Paint (LCP)

Largest content element paint time.

**Key metrics:**
- `renderTime` - When element was rendered
- `loadTime` - When element finished loading
- `size` - Size of element
- `elementType` - Type of element (img, div, etc.)

**Scoring:**
- Good: < 2.5s
- Needs improvement: 2.5s - 4.0s
- Poor: > 4.0s

### Long Task

Tasks that block the main thread for >50ms.

**Key metrics:**
- `duration` - Task duration
- `attribution` - What caused the task

**Impact:**
- Can cause jank and slow responsiveness
- Should be minimized for good user experience

## Spirit Integration

### Basic Performance Monitoring

```javascript
// Start monitoring
await spirit.eval(`
  await window.skyeyes.send({
    type: 'performance_start'
  });
`);

// Wait for page activity
await sleep(5000);

// Get metrics
const metrics = await spirit.eval(`
  await window.skyeyes.send({
    type: 'performance_metrics'
  });
`);

console.log('Page load time:', metrics.result.summary.navigation.loadComplete);
console.log('CLS score:', metrics.result.summary.layoutShifts.cumulativeScore);
console.log('Long tasks:', metrics.result.summary.longTasks.count);

// Stop monitoring
await spirit.eval(`
  await window.skyeyes.send({ type: 'performance_stop' });
`);
```

### Performance Regression Testing

```javascript
async function checkPerformance(url, thresholds) {
  await spirit.goto(url);

  // Clear and start monitoring
  await spirit.eval(`
    await window.skyeyes.send({ type: 'performance_clear' });
    await window.skyeyes.send({ type: 'performance_start' });
  `);

  // Wait for page to fully load
  await sleep(10000);

  // Get metrics
  const result = await spirit.eval(`
    await window.skyeyes.send({ type: 'performance_metrics' });
  `);

  const summary = result.result.summary;

  // Check thresholds
  const issues = [];

  if (summary.navigation && summary.navigation.loadComplete > thresholds.loadTime) {
    issues.push(`Load time ${summary.navigation.loadComplete}ms exceeds ${thresholds.loadTime}ms`);
  }

  if (summary.layoutShifts && summary.layoutShifts.cumulativeScore > thresholds.cls) {
    issues.push(`CLS ${summary.layoutShifts.cumulativeScore} exceeds ${thresholds.cls}`);
  }

  if (summary.longTasks && summary.longTasks.count > thresholds.longTasks) {
    issues.push(`${summary.longTasks.count} long tasks exceeds ${thresholds.longTasks}`);
  }

  return {
    passed: issues.length === 0,
    issues,
    metrics: summary
  };
}

// Usage
const result = await checkPerformance('https://example.com', {
  loadTime: 3000,  // 3 seconds
  cls: 0.1,        // Good CLS score
  longTasks: 5     // Max 5 long tasks
});

console.log('Performance test:', result.passed ? 'PASSED' : 'FAILED');
if (!result.passed) {
  console.log('Issues:', result.issues);
}
```

### Monitor Specific Metrics

```javascript
// Only monitor long tasks and layout shifts
await spirit.eval(`
  await window.skyeyes.send({
    type: 'performance_start',
    options: {
      types: ['longtask', 'layout-shift']
    }
  });
`);

// Get only long tasks
const longTasks = await spirit.eval(`
  await window.skyeyes.send({
    type: 'performance_metrics',
    options: { type: 'longtask' }
  });
`);

console.log('Long tasks detected:', longTasks.result.entries.length);
```

### Detect Performance Issues

```javascript
async function detectPerformanceIssues() {
  await spirit.eval(`
    await window.skyeyes.send({ type: 'performance_start' });
  `);

  await sleep(5000);

  const result = await spirit.eval(`
    await window.skyeyes.send({ type: 'performance_metrics' });
  `);

  const summary = result.result.summary;
  const issues = [];

  // Check CLS
  if (summary.layoutShifts) {
    if (summary.layoutShifts.cumulativeScore > 0.25) {
      issues.push({
        type: 'cls',
        severity: 'high',
        message: `Poor CLS: ${summary.layoutShifts.cumulativeScore}`,
        count: summary.layoutShifts.count
      });
    } else if (summary.layoutShifts.cumulativeScore > 0.1) {
      issues.push({
        type: 'cls',
        severity: 'medium',
        message: `Needs improvement CLS: ${summary.layoutShifts.cumulativeScore}`
      });
    }
  }

  // Check long tasks
  if (summary.longTasks && summary.longTasks.count > 0) {
    if (summary.longTasks.maxDuration > 200) {
      issues.push({
        type: 'longtask',
        severity: 'high',
        message: `Very long task: ${summary.longTasks.maxDuration}ms`
      });
    }
    if (summary.longTasks.count > 10) {
      issues.push({
        type: 'longtask',
        severity: 'medium',
        message: `Many long tasks: ${summary.longTasks.count}`
      });
    }
  }

  return issues;
}

const issues = await detectPerformanceIssues();
if (issues.length > 0) {
  console.log('Performance issues detected:');
  issues.forEach(issue => {
    console.log(`[${issue.severity.toUpperCase()}] ${issue.message}`);
  });
}
```

## Best Practices

1. **Clear metrics before testing** to get clean measurements
2. **Wait for page stability** before collecting metrics
3. **Use type filters** to focus on specific metrics
4. **Set realistic thresholds** based on your application
5. **Monitor over time** to detect regressions
6. **Stop monitoring** when done to free resources

## Performance Considerations

- **Log size limit:** Max 500 entries (FIFO)
- **Observer overhead:** Minimal, uses native PerformanceObserver API
- **Memory usage:** Metrics are lightweight, ~1KB per entry
- **Clear regularly:** Prevent hitting size limits during long sessions

## Browser Support

Requires browsers with PerformanceObserver support:
- Chrome/Edge 52+
- Firefox 57+
- Safari 11+

Some metric types may not be available in all browsers (e.g., layout-shift, longtask).

## Quick Reference

| Command | Purpose |
|---------|---------|
| `performance_start` | Start observing metrics |
| `performance_stop` | Stop observing |
| `performance_metrics` | Get captured metrics + summary |
| `performance_clear` | Clear metric log |
| `performance_snapshot` | Get current timing snapshot |

**Key Metrics:**
- Load time (navigation)
- CLS (layout-shift)
- LCP (largest-contentful-paint)
- Long tasks (longtask)
- Paint timing (paint)

**Summary Statistics:**
- By type counts
- Navigation timing
- Paint timing
- CLS score
- Long task analysis
