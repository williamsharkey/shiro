# Network Interception Guide

This guide covers the network interception layer that captures HTTP requests made by the page, enabling Spirit to observe fetch and XHR calls with full request/response details.

## Table of Contents

1. [Overview](#overview)
2. [Basic Usage](#basic-usage)
3. [Network Log Entry Structure](#network-log-entry-structure)
4. [Retrieving Network Logs](#retrieving-network-logs)
5. [Filtering](#filtering)
6. [Summary Statistics](#summary-statistics)
7. [Use Cases](#use-cases)
8. [Advanced Patterns](#advanced-patterns)
9. [Best Practices](#best-practices)

## Overview

The network interception layer automatically captures:

- **fetch() calls** - Modern Promise-based HTTP requests
- **XMLHttpRequest (XHR)** - Traditional AJAX requests
- **Request details** - URL, method, headers, body
- **Response details** - Status, headers, body (truncated)
- **Timing** - Duration of each request
- **Errors** - Network errors, timeouts

All requests are logged automatically in the background. Spirit can retrieve logs at any time to understand what network activity the page is performing.

## Basic Usage

### Retrieve Network Log

```javascript
// Get recent requests (default: last 50)
{
  type: "network_log",
  id: "net-1"
}

// Get with options
{
  type: "network_log",
  id: "net-2",
  options: {
    limit: 100,
    offset: 0,
    filter: {
      method: "POST",
      status: 200,
      url: "/api/"
    }
  }
}
```

### Clear Network Log

```javascript
{
  type: "network_clear",
  id: "clear-1"
}
```

## Network Log Entry Structure

Each captured request contains:

```javascript
{
  id: 1,                        // Sequential ID
  type: "fetch",                // "fetch" or "xhr"
  url: "https://api.example.com/users",
  method: "POST",
  timestamp: 1234567890,        // Request start time
  status: 200,                  // HTTP status code
  statusText: "OK",             // Status text
  duration: 245,                // Request duration in ms
  requestHeaders: {
    "content-type": "application/json",
    "authorization": "Bearer ..."
  },
  responseHeaders: {
    "content-type": "application/json",
    "content-length": "1234"
  },
  requestBody: '{"name":"John"}',  // Truncated to 1KB
  responseBody: '{"id":123,"name":"John"}',  // Truncated to 1KB
  error: null                   // Error message if failed
}
```

### Request Types

- **fetch**: Modern fetch() API calls
- **xhr**: XMLHttpRequest (AJAX) calls

### Status Values

- **HTTP codes**: 200, 404, 500, etc.
- **null**: Request in progress or failed before response
- **pending**: Listed in summary for incomplete requests

## Retrieving Network Logs

### Default Retrieval

```javascript
{
  type: "network_log",
  id: "net-1"
}
```

**Response:**
```javascript
{
  total: 125,              // Total requests in log
  filtered: 125,           // After filtering
  returned: 50,            // In this response
  offset: 0,
  limit: 50,
  entries: [
    {
      id: 125,
      type: "fetch",
      url: "https://api.example.com/data",
      method: "GET",
      status: 200,
      duration: 156,
      ...
    },
    ...
  ],
  summary: {
    totalRequests: 125,
    byMethod: {
      GET: 85,
      POST: 30,
      PUT: 7,
      DELETE: 3
    },
    byStatus: {
      200: 110,
      404: 10,
      500: 5
    },
    byType: {
      fetch: 95,
      xhr: 30
    },
    avgDuration: 234
  }
}
```

### Pagination

```javascript
// First page
{
  type: "network_log",
  options: { limit: 20, offset: 0 }
}

// Second page
{
  type: "network_log",
  options: { limit: 20, offset: 20 }
}

// Third page
{
  type: "network_log",
  options: { limit: 20, offset: 40 }
}
```

## Filtering

### Filter by Method

```javascript
{
  type: "network_log",
  options: {
    filter: { method: "POST" }
  }
}
```

### Filter by Status

```javascript
{
  type: "network_log",
  options: {
    filter: { status: 404 }
  }
}
```

### Filter by URL

```javascript
{
  type: "network_log",
  options: {
    filter: { url: "/api/" }
  }
}
```

### Filter by Type

```javascript
{
  type: "network_log",
  options: {
    filter: { type: "fetch" }
  }
}
```

### Combine Filters

```javascript
{
  type: "network_log",
  options: {
    filter: {
      method: "POST",
      status: 200,
      url: "/api/users"
    }
  }
}
```

## Summary Statistics

Every response includes a summary:

```javascript
summary: {
  totalRequests: 125,

  byMethod: {
    GET: 85,
    POST: 30,
    PUT: 7,
    DELETE: 3
  },

  byStatus: {
    200: 110,
    404: 10,
    500: 5
  },

  byType: {
    fetch: 95,
    xhr: 30
  },

  avgDuration: 234  // Average request duration in ms
}
```

## Use Cases

### 1. Monitor API Calls

```javascript
const log = await getNetworkLog();

console.log(`Total API calls: ${log.total}`);
console.log(`Average duration: ${log.summary.avgDuration}ms`);

// Find slow requests
const slowRequests = log.entries.filter(e => e.duration > 1000);
console.log(`Slow requests (>1s): ${slowRequests.length}`);
```

### 2. Detect Failed Requests

```javascript
const log = await getNetworkLog({ filter: { status: 500 } });

console.log(`Server errors: ${log.filtered}`);
for (const entry of log.entries) {
  console.log(`- ${entry.method} ${entry.url}: ${entry.statusText}`);
}
```

### 3. Track Form Submissions

```javascript
// Before submitting form
await clearNetworkLog();

// Submit form
await elementClick("button[type=submit]");
await wait(1000);

// Check what was sent
const log = await getNetworkLog({ filter: { method: "POST" } });

for (const entry of log.entries) {
  console.log(`Posted to: ${entry.url}`);
  console.log(`Body: ${entry.requestBody}`);
  console.log(`Response: ${entry.status} ${entry.statusText}`);
}
```

### 4. Debug AJAX Issues

```javascript
// Watch for failed AJAX calls
const log = await getNetworkLog();

const failed = log.entries.filter(e => e.error || e.status >= 400);

console.log(`Failed requests: ${failed.length}`);
for (const req of failed) {
  console.log(`- ${req.method} ${req.url}`);
  console.log(`  Status: ${req.status || 'error'}`);
  console.log(`  Error: ${req.error || req.statusText}`);
}
```

### 5. Verify API Integration

```javascript
// Check if specific API was called
const log = await getNetworkLog({ filter: { url: "/api/users" } });

if (log.filtered > 0) {
  console.log("Users API was called");
  const entry = log.entries[0];
  console.log(`Method: ${entry.method}`);
  console.log(`Status: ${entry.status}`);
  console.log(`Response: ${entry.responseBody}`);
} else {
  console.log("Users API was NOT called");
}
```

### 6. Track Request Headers

```javascript
const log = await getNetworkLog();

// Check for authentication headers
for (const entry of log.entries) {
  if (entry.requestHeaders.authorization) {
    console.log(`${entry.url} has auth header`);
  }
}

// Check content types
const jsonRequests = log.entries.filter(e =>
  e.requestHeaders['content-type']?.includes('application/json')
);
console.log(`JSON requests: ${jsonRequests.length}`);
```

## Advanced Patterns

### Track Requests During Action

```javascript
async function trackRequestsDuring(action, description) {
  // Clear log
  await clearNetworkLog();

  // Perform action
  await action();

  // Wait for requests to complete
  await wait(1000);

  // Get log
  const log = await getNetworkLog();

  console.log(`${description}:`);
  console.log(`  Total requests: ${log.total}`);
  console.log(`  By method:`, log.summary.byMethod);
  console.log(`  By status:`, log.summary.byStatus);
  console.log(`  Avg duration: ${log.summary.avgDuration}ms`);

  return log;
}

// Use it
await trackRequestsDuring(
  () => elementClick("#load-data"),
  "Load Data Button"
);
```

### Find API Endpoints

```javascript
function extractEndpoints(log) {
  const endpoints = new Set();

  for (const entry of log.entries) {
    try {
      const url = new URL(entry.url);
      endpoints.add(url.pathname);
    } catch (e) {
      // Relative URL
      endpoints.add(entry.url);
    }
  }

  return Array.from(endpoints);
}

const log = await getNetworkLog();
const endpoints = extractEndpoints(log);
console.log("API endpoints:", endpoints);
```

### Monitor Request Rate

```javascript
function analyzeRequestRate(log) {
  const requests = log.entries.slice().sort((a, b) => a.timestamp - b.timestamp);

  if (requests.length < 2) return null;

  const first = requests[0].timestamp;
  const last = requests[requests.length - 1].timestamp;
  const duration = last - first;

  return {
    totalRequests: requests.length,
    durationMs: duration,
    requestsPerSecond: (requests.length / (duration / 1000)).toFixed(2),
  };
}

const log = await getNetworkLog();
const rate = analyzeRequestRate(log);
console.log(`Request rate: ${rate.requestsPerSecond} req/s`);
```

### Check for Errors

```javascript
function checkForErrors(log) {
  const errors = {
    networkErrors: [],
    clientErrors: [],
    serverErrors: [],
  };

  for (const entry of log.entries) {
    if (entry.error) {
      errors.networkErrors.push(entry);
    } else if (entry.status >= 400 && entry.status < 500) {
      errors.clientErrors.push(entry);
    } else if (entry.status >= 500) {
      errors.serverErrors.push(entry);
    }
  }

  return errors;
}

const log = await getNetworkLog();
const errors = checkForErrors(log);
console.log(`Network errors: ${errors.networkErrors.length}`);
console.log(`Client errors (4xx): ${errors.clientErrors.length}`);
console.log(`Server errors (5xx): ${errors.serverErrors.length}`);
```

### Spirit Integration

```javascript
async function executeAndCheckAPI(command, expectedEndpoint) {
  // Clear log
  await clearNetworkLog();

  // Execute command
  await executeTerminalCommand(command);
  await wait(1000);

  // Check if expected API was called
  const log = await getNetworkLog({ filter: { url: expectedEndpoint } });

  if (log.filtered > 0) {
    const entry = log.entries[0];
    return {
      success: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      response: entry.responseBody,
    };
  } else {
    return {
      success: false,
      error: "Expected API endpoint was not called",
    };
  }
}
```

## Best Practices

1. **Clear before tracking**: Clear log before specific actions to isolate requests
2. **Wait after actions**: Allow time for async requests to complete
3. **Check summary first**: Use summary stats for quick overview
4. **Filter for relevance**: Use filters to focus on specific requests
5. **Monitor errors**: Regularly check for failed requests
6. **Truncation aware**: Bodies are truncated to 1KB, full data may not be available
7. **Log size limit**: Only last 100 requests are kept, older ones are dropped

## Limitations

- **Body truncation**: Request and response bodies truncated to 1KB
- **Log size**: Maximum 100 requests stored (FIFO)
- **Binary data**: Binary request/response bodies may not be readable
- **Timing**: Duration measured on JavaScript side, doesn't include network latency
- **Headers**: Only headers accessible to JavaScript are captured
- **CORS**: Cross-origin requests may have limited header access

## Configuration

Network interception is automatically enabled. Configuration constants:

- `MAX_NETWORK_LOG_SIZE`: 100 (maximum requests stored)
- `MAX_BODY_LENGTH`: 1000 (maximum body length in bytes)

## Debugging

### View All Requests

```javascript
const log = await getNetworkLog({ limit: 100 });
for (const entry of log.entries) {
  console.log(`[${entry.id}] ${entry.method} ${entry.url} - ${entry.status}`);
}
```

### Find Specific Request

```javascript
const log = await getNetworkLog();
const entry = log.entries.find(e => e.url.includes('/login'));

if (entry) {
  console.log("Login request:");
  console.log("  URL:", entry.url);
  console.log("  Method:", entry.method);
  console.log("  Status:", entry.status);
  console.log("  Request:", entry.requestBody);
  console.log("  Response:", entry.responseBody);
}
```

### Monitor During Development

```javascript
// Start monitoring
setInterval(async () => {
  const log = await getNetworkLog({ limit: 10 });
  console.clear();
  console.log("=== Recent Network Activity ===");
  console.log(`Total: ${log.total} requests`);
  console.log(`Avg duration: ${log.summary.avgDuration}ms`);
  console.log("\nRecent requests:");
  for (const entry of log.entries) {
    console.log(`  ${entry.method} ${entry.url} - ${entry.status} (${entry.duration}ms)`);
  }
}, 2000);
```

## Summary

The network interception layer provides:

✅ **Automatic capture** - All fetch/XHR calls logged automatically
✅ **Request details** - URL, method, headers, body (truncated)
✅ **Response details** - Status, headers, body (truncated)
✅ **Timing** - Duration tracking for each request
✅ **Error tracking** - Capture network errors and timeouts
✅ **Filtering** - Filter by method, status, URL, type
✅ **Summary stats** - Request counts by method, status, type
✅ **Pagination** - Retrieve logs in chunks with offset/limit

This enables Spirit to observe all network activity on the page, understand API interactions, debug failed requests, and verify expected behavior.
