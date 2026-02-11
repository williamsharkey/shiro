# Storage Monitoring Guide

The skyeyes storage monitoring system tracks localStorage and sessionStorage usage, changes, and provides APIs for Spirit to read, write, and monitor browser storage.

## Overview

The storage monitoring system:
- **Tracks storage usage** (size, item count, quota, percentage used)
- **Monitors changes** in real-time (set, remove, clear operations)
- **Provides storage APIs** for reading, writing, and managing storage
- **Change log with filtering** (by storage type, change type, key)
- **Ring buffer storage** (max 200 change entries, FIFO)
- **Performance-optimized** with configurable polling interval

## API Commands

### Get Storage Usage: `storage_usage`

Get current localStorage and sessionStorage usage statistics.

**Request:**
```json
{
  "type": "storage_usage",
  "id": "req-123"
}
```

**Response:**
```json
{
  "id": "req-123",
  "result": {
    "timestamp": 1706543210123,
    "localStorage": {
      "itemCount": 5,
      "sizeBytes": 12345,
      "sizeKB": 12,
      "quota": 5242880,
      "percentUsed": 0.24,
      "items": [
        {
          "key": "user-preferences",
          "sizeBytes": 5678,
          "sizeKB": 6,
          "valueLength": 2839
        },
        {
          "key": "auth-token",
          "sizeBytes": 3456,
          "sizeKB": 3,
          "valueLength": 1728
        }
      ]
    },
    "sessionStorage": {
      "itemCount": 2,
      "sizeBytes": 4567,
      "sizeKB": 4,
      "quota": 5242880,
      "percentUsed": 0.09,
      "items": [
        {
          "key": "temp-data",
          "sizeBytes": 2345,
          "sizeKB": 2,
          "valueLength": 1172
        }
      ]
    },
    "monitoringActive": false
  },
  "error": null
}
```

### Start Storage Monitoring: `storage_start`

Start monitoring storage changes.

**Request:**
```json
{
  "type": "storage_start",
  "id": "req-124",
  "options": {
    "interval": 1000,        // Polling interval in ms (default: 1000)
    "trackChanges": true     // Track changes to storage (default: true)
  }
}
```

**Response:**
```json
{
  "id": "req-124",
  "result": {
    "started": true,
    "interval": 1000,
    "trackChanges": true,
    "timestamp": 1706543210123
  },
  "error": null
}
```

### Stop Storage Monitoring: `storage_stop`

Stop monitoring storage changes.

**Request:**
```json
{
  "type": "storage_stop",
  "id": "req-125"
}
```

**Response:**
```json
{
  "id": "req-125",
  "result": {
    "stopped": true,
    "capturedChanges": 47,
    "timestamp": 1706543215456
  },
  "error": null
}
```

### Get Storage Change Log: `storage_log`

Retrieve captured storage changes.

**Request:**
```json
{
  "type": "storage_log",
  "id": "req-126",
  "options": {
    "storageType": "localStorage",  // Filter: "localStorage" or "sessionStorage"
    "changeType": "set",             // Filter: "set", "remove", "clear"
    "key": "user",                   // Filter: key substring match
    "limit": 50,                     // Max changes to return
    "offset": 0                      // Skip first N changes
  }
}
```

**Response:**
```json
{
  "id": "req-126",
  "result": {
    "changes": [
      {
        "storageType": "localStorage",
        "changeType": "set",
        "key": "user-preferences",
        "oldValue": null,
        "newValue": "{\"theme\":\"dark\",\"language\":\"en\"}",
        "valueLength": 35,
        "timestamp": 1706543210123
      },
      {
        "storageType": "localStorage",
        "changeType": "set",
        "key": "user-preferences",
        "oldValue": "{\"theme\":\"dark\",\"language\":\"en\"}",
        "newValue": "{\"theme\":\"light\",\"language\":\"en\"}",
        "valueLength": 36,
        "timestamp": 1706543212456
      },
      {
        "storageType": "sessionStorage",
        "changeType": "remove",
        "key": "temp-token",
        "oldValue": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        "newValue": null,
        "timestamp": 1706543214789
      }
    ],
    "total": 47,
    "offset": 0,
    "limit": 50,
    "monitoringActive": true
  },
  "error": null
}
```

### Clear Storage Log: `storage_clear_log`

Clear the storage change log.

**Request:**
```json
{
  "type": "storage_clear_log",
  "id": "req-127"
}
```

**Response:**
```json
{
  "id": "req-127",
  "result": {
    "cleared": 47,
    "remaining": 0,
    "monitoringActive": true
  },
  "error": null
}
```

### Set Storage Item: `storage_set`

Set a localStorage or sessionStorage item.

**Request:**
```json
{
  "type": "storage_set",
  "id": "req-128",
  "storageType": "localStorage",
  "key": "user-preferences",
  "value": "{\"theme\":\"dark\"}"
}
```

**Response:**
```json
{
  "id": "req-128",
  "result": {
    "success": true,
    "storageType": "localStorage",
    "key": "user-preferences",
    "valueLength": 16,
    "newSize": 12345
  },
  "error": null
}
```

### Get Storage Item: `storage_get`

Get a localStorage or sessionStorage item.

**Request:**
```json
{
  "type": "storage_get",
  "id": "req-129",
  "storageType": "localStorage",
  "key": "user-preferences"
}
```

**Response:**
```json
{
  "id": "req-129",
  "result": {
    "key": "user-preferences",
    "value": "{\"theme\":\"dark\"}",
    "exists": true,
    "valueLength": 16
  },
  "error": null
}
```

### Remove Storage Item: `storage_remove`

Remove a localStorage or sessionStorage item.

**Request:**
```json
{
  "type": "storage_remove",
  "id": "req-130",
  "storageType": "localStorage",
  "key": "user-preferences"
}
```

**Response:**
```json
{
  "id": "req-130",
  "result": {
    "success": true,
    "storageType": "localStorage",
    "key": "user-preferences",
    "existed": true,
    "newSize": 8765
  },
  "error": null
}
```

### Clear Storage: `storage_clear`

Clear all items from localStorage or sessionStorage.

**Request:**
```json
{
  "type": "storage_clear",
  "id": "req-131",
  "storageType": "localStorage"
}
```

**Response:**
```json
{
  "id": "req-131",
  "result": {
    "success": true,
    "storageType": "localStorage",
    "clearedItems": 5,
    "newSize": 0
  },
  "error": null
}
```

## Spirit Integration

### Monitor Storage Changes

```javascript
// Start monitoring
await spirit.eval(`
  await window.skyeyes.send({
    type: 'storage_start',
    options: { interval: 500 }
  });
`);

// Wait for some activity
await sleep(5000);

// Check changes
const log = await spirit.eval(`
  await window.skyeyes.send({ type: 'storage_log' });
`);

console.log('Storage changes:', log.result.changes);

// Stop monitoring
await spirit.eval(`
  await window.skyeyes.send({ type: 'storage_stop' });
`);
```

### Check Storage Usage

```javascript
const usage = await spirit.eval(`
  await window.skyeyes.send({ type: 'storage_usage' });
`);

console.log('localStorage usage:', usage.result.localStorage.sizeKB, 'KB');
console.log('sessionStorage usage:', usage.result.sessionStorage.sizeKB, 'KB');

// Check if nearing quota
if (usage.result.localStorage.percentUsed > 80) {
  console.warn('localStorage nearly full!');
}
```

### Set and Get Storage Items

```javascript
// Set item
await spirit.eval(`
  await window.skyeyes.send({
    type: 'storage_set',
    storageType: 'localStorage',
    key: 'test-data',
    value: JSON.stringify({ foo: 'bar' })
  });
`);

// Get item
const item = await spirit.eval(`
  await window.skyeyes.send({
    type: 'storage_get',
    storageType: 'localStorage',
    key: 'test-data'
  });
`);

console.log('Stored value:', item.result.value);
```

### Detect When Storage Changes

```javascript
async function waitForStorageChange(key) {
  await spirit.eval(`
    await window.skyeyes.send({ type: 'storage_start' });
    await window.skyeyes.send({ type: 'storage_clear_log' });
  `);

  let changed = false;
  while (!changed) {
    const log = await spirit.eval(`
      await window.skyeyes.send({ type: 'storage_log' });
    `);

    changed = log.result.changes.some(c => c.key === key);
    await sleep(500);
  }

  await spirit.eval(`
    await window.skyeyes.send({ type: 'storage_stop' });
  `);

  console.log(`Storage key '${key}' changed!`);
}

// Usage
await waitForStorageChange('user-preferences');
```

### Clear Storage After Test

```javascript
// Clear localStorage
await spirit.eval(`
  await window.skyeyes.send({
    type: 'storage_clear',
    storageType: 'localStorage'
  });
`);

// Clear sessionStorage
await spirit.eval(`
  await window.skyeyes.send({
    type: 'storage_clear',
    storageType: 'sessionStorage'
  });
`);
```

### Monitor Storage for Authentication

```javascript
// Watch for auth token changes
await spirit.eval(`
  await window.skyeyes.send({
    type: 'storage_start',
    options: { interval: 500 }
  });
  await window.skyeyes.send({ type: 'storage_clear_log' });
`);

// Perform login
await spirit.type('#username', 'testuser');
await spirit.type('#password', 'password123');
await spirit.click('button[type="submit"]');

// Wait for token to be stored
let tokenStored = false;
while (!tokenStored) {
  const log = await spirit.eval(`
    await window.skyeyes.send({ type: 'storage_log' });
  `);

  tokenStored = log.result.changes.some(c =>
    c.key.includes('token') && c.changeType === 'set'
  );

  await sleep(500);
}

console.log('Auth token stored, login successful!');
```

## Use Cases

### 1. Storage Quota Monitoring

```javascript
async function checkStorageQuota() {
  const usage = await spirit.eval(`
    await window.skyeyes.send({ type: 'storage_usage' });
  `);

  const localStorage = usage.result.localStorage;
  const sessionStorage = usage.result.sessionStorage;

  return {
    localStorage: {
      used: localStorage.sizeKB,
      total: Math.round(localStorage.quota / 1024),
      percent: localStorage.percentUsed,
      warning: localStorage.percentUsed > 80
    },
    sessionStorage: {
      used: sessionStorage.sizeKB,
      total: Math.round(sessionStorage.quota / 1024),
      percent: sessionStorage.percentUsed,
      warning: sessionStorage.percentUsed > 80
    }
  };
}

const quota = await checkStorageQuota();
if (quota.localStorage.warning) {
  console.warn(`localStorage at ${quota.localStorage.percent}%!`);
}
```

### 2. Detect Storage Leaks

```javascript
// Monitor storage growth over time
await spirit.eval(`
  await window.skyeyes.send({ type: 'storage_start' });
`);

const samples = [];
for (let i = 0; i < 10; i++) {
  await sleep(2000);

  const usage = await spirit.eval(`
    await window.skyeyes.send({ type: 'storage_usage' });
  `);

  samples.push({
    time: Date.now(),
    size: usage.result.localStorage.sizeKB
  });
}

// Check for growth
const growth = samples[samples.length - 1].size - samples[0].size;
if (growth > 100) {
  console.warn(`Storage grew by ${growth}KB - possible leak!`);
}
```

### 3. Verify Data Persistence

```javascript
// Set data
await spirit.eval(`
  await window.skyeyes.send({
    type: 'storage_set',
    storageType: 'localStorage',
    key: 'persist-test',
    value: 'test-data'
  });
`);

// Reload page
await spirit.reload();
await sleep(1000);

// Verify data persisted
const item = await spirit.eval(`
  await window.skyeyes.send({
    type: 'storage_get',
    storageType: 'localStorage',
    key: 'persist-test'
  });
`);

console.log('Data persisted:', item.result.exists);
```

### 4. Track User Preferences

```javascript
// Monitor preference changes
await spirit.eval(`
  await window.skyeyes.send({
    type: 'storage_start',
    options: { interval: 500 }
  });
  await window.skyeyes.send({ type: 'storage_clear_log' });
`);

// User changes theme
await spirit.click('button#toggle-theme');
await sleep(1000);

// Check what changed
const log = await spirit.eval(`
  await window.skyeyes.send({
    type: 'storage_log',
    options: { key: 'preferences' }
  });
`);

const prefChange = log.result.changes.find(c => c.key.includes('preferences'));
console.log('Preferences changed from:', prefChange.oldValue);
console.log('Preferences changed to:', prefChange.newValue);
```

## Change Types

### set

Item was added or modified.

```json
{
  "changeType": "set",
  "key": "user-data",
  "oldValue": null,            // null if new item
  "newValue": "{\"name\":\"Alice\"}",
  "valueLength": 17
}
```

### remove

Item was deleted.

```json
{
  "changeType": "remove",
  "key": "temp-token",
  "oldValue": "abc123",
  "newValue": null
}
```

## Performance Considerations

- **Polling interval:** Default 1 second, adjust based on needs
- **Log size limit:** Max 200 entries (FIFO)
- **Value truncation:** Change log values truncated to 200 chars
- **Clear regularly:** Prevent hitting size limits during long sessions

## Browser Compatibility

- **localStorage:** All modern browsers
- **sessionStorage:** All modern browsers
- **Quota:** Typically 5-10MB, varies by browser
- **UTF-16 encoding:** Size calculations use 2 bytes per character

## Limitations

### Quota Estimation

The `quota` field is an estimate (5MB). Actual quota varies:
- Chrome: ~10MB
- Firefox: ~10MB
- Safari: ~5MB
- Edge: ~10MB

### Change Detection

Changes made directly via `localStorage.setItem()` in the page are detected via polling. For immediate detection, use the `storage_set` API.

### Storage Events

Native `storage` events only fire in other tabs/windows. This system uses polling to detect changes in the same tab.

## Best Practices

1. **Use appropriate polling interval** (1-2 seconds for most cases)
2. **Clear log regularly** to prevent hitting size limits
3. **Stop monitoring** when not needed to save resources
4. **Check quota** before storing large data
5. **Use sessionStorage** for temporary data
6. **Clear storage** after tests to avoid pollution

## Quick Reference

| Command | Purpose |
|---------|---------|
| `storage_usage` | Get current usage stats |
| `storage_start` | Start monitoring changes |
| `storage_stop` | Stop monitoring |
| `storage_log` | Get change log |
| `storage_clear_log` | Clear change log |
| `storage_set` | Set item |
| `storage_get` | Get item |
| `storage_remove` | Remove item |
| `storage_clear` | Clear all items |

**Change Types:**
- `set` - Item added or modified
- `remove` - Item deleted

**Filters:**
- By storage type (localStorage/sessionStorage)
- By change type (set/remove)
- By key (substring match)
